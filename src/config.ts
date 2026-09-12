import { readFile } from "node:fs/promises";
import path from "node:path";

import type { TicketClosurePolicy } from "./run/contracts.ts";

const promptNames = ["implement", "ci-repair", "conflict-repair"] as const;
const documentationConfigurationError =
  "Documentation Maintenance is enabled; supply agents.documentation and prompts/documentation.md";
const reviewConfigurationError =
  "Review is enabled; supply agents.review and prompts/review.md";
const supportedModels = new Set([
  "gpt-5.2",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-6-astra",
]);

export interface AgentConfig {
  model: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh";
}

export interface ProjectConfig {
  repository: string;
  checkout: string;
  targetBranch?: string;
  tracker: {
    type: "github";
    tokenEnv: string;
    runnerAccount: string;
    reservationLabel: string;
  };
  codeHost: { type: "github"; tokenEnv: string; adminMerge: boolean };
  workflow: { review: boolean; documentationMaintenance: boolean };
  agents: {
    implement: AgentConfig;
    review?: AgentConfig;
    ciRepair: AgentConfig;
    conflictRepair: AgentConfig;
    documentation?: AgentConfig;
  };
  timeouts: {
    agentMinutes: number;
    requiredChecksMinutes: number;
    mergeQueueMinutes: number;
  };
  ticketClosure: TicketClosurePolicy;
  maintenanceTicket: { title: string; body: string; label: string };
}

export interface LoadedProject {
  config: ProjectConfig;
  directory: string;
  trackerToken: string;
  codeHostToken: string;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${name} must be set`);
  return value;
}

function positive(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function switchValue(value: unknown, name: string): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function agent(value: unknown, name: string): AgentConfig {
  const input = record(value, name);
  const model = text(input.model, `${name}.model`);
  if (!supportedModels.has(model))
    throw new Error(`${name}.model is unsupported`);
  const effort = text(input.reasoningEffort, `${name}.reasoningEffort`);
  if (!["low", "medium", "high", "xhigh"].includes(effort)) {
    throw new Error(`${name}.reasoningEffort is unsupported`);
  }
  return { model, reasoningEffort: effort as AgentConfig["reasoningEffort"] };
}

function parseConfig(value: unknown): ProjectConfig {
  const input = record(value, "config");
  const tracker = record(input.tracker, "tracker");
  const codeHost = record(input.codeHost, "codeHost");
  const agents = record(input.agents, "agents");
  const workflow =
    input.workflow === undefined ? {} : record(input.workflow, "workflow");
  const unknownWorkflowField = Object.keys(workflow).find(
    (name) =>
      !["$comment", "review", "documentationMaintenance"].includes(name),
  );
  if (unknownWorkflowField) {
    throw new Error(`workflow contains unknown field ${unknownWorkflowField}`);
  }
  const timeouts = record(input.timeouts, "timeouts");
  const repository = text(input.repository, "repository");
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository))
    throw new Error("repository must be owner/repo");
  const checkout = text(input.checkout, "checkout");
  if (!path.isAbsolute(checkout)) throw new Error("checkout must be absolute");
  if (tracker.type !== "github" || codeHost.type !== "github") {
    throw new Error("only github adapters are supported");
  }
  if (typeof codeHost.adminMerge !== "boolean")
    throw new Error("codeHost.adminMerge is required");
  if (input.ticketClosure !== "runner" && input.ticketClosure !== "code_host") {
    throw new Error("ticketClosure is unsupported");
  }
  const documentationMaintenance = switchValue(
    workflow.documentationMaintenance,
    "workflow.documentationMaintenance",
  );
  const documentation =
    agents.documentation === undefined
      ? undefined
      : agent(agents.documentation, "agents.documentation");
  const reviewEnabled = switchValue(workflow.review, "workflow.review");
  const review =
    agents.review === undefined
      ? undefined
      : agent(agents.review, "agents.review");
  if (reviewEnabled && review === undefined) {
    throw new Error(reviewConfigurationError);
  }
  if (documentationMaintenance && documentation === undefined) {
    throw new Error(documentationConfigurationError);
  }
  const maintenanceTicket =
    input.maintenanceTicket === undefined
      ? {}
      : record(input.maintenanceTicket, "maintenanceTicket");
  if (documentationMaintenance) {
    text(maintenanceTicket.title, "maintenanceTicket.title");
    text(maintenanceTicket.body, "maintenanceTicket.body");
    text(maintenanceTicket.label, "maintenanceTicket.label");
  }

  return {
    repository,
    checkout,
    ...(input.targetBranch === undefined
      ? {}
      : { targetBranch: text(input.targetBranch, "targetBranch") }),
    tracker: {
      type: "github",
      tokenEnv: text(tracker.tokenEnv, "tracker.tokenEnv"),
      runnerAccount: text(tracker.runnerAccount, "tracker.runnerAccount"),
      reservationLabel: text(
        tracker.reservationLabel,
        "tracker.reservationLabel",
      ),
    },
    codeHost: {
      type: "github",
      tokenEnv: text(codeHost.tokenEnv, "codeHost.tokenEnv"),
      adminMerge: codeHost.adminMerge,
    },
    workflow: {
      review: reviewEnabled,
      documentationMaintenance,
    },
    agents: {
      implement: agent(agents.implement, "agents.implement"),
      ...(review === undefined ? {} : { review }),
      ciRepair: agent(agents.ciRepair, "agents.ciRepair"),
      conflictRepair: agent(agents.conflictRepair, "agents.conflictRepair"),
      ...(documentation === undefined ? {} : { documentation }),
    },
    timeouts: {
      agentMinutes: positive(timeouts.agentMinutes, "timeouts.agentMinutes"),
      requiredChecksMinutes: positive(
        timeouts.requiredChecksMinutes,
        "timeouts.requiredChecksMinutes",
      ),
      mergeQueueMinutes: positive(
        timeouts.mergeQueueMinutes,
        "timeouts.mergeQueueMinutes",
      ),
    },
    ticketClosure: input.ticketClosure,
    maintenanceTicket: {
      title: documentationMaintenance
        ? text(maintenanceTicket.title, "maintenanceTicket.title")
        : "",
      body: documentationMaintenance
        ? text(maintenanceTicket.body, "maintenanceTicket.body")
        : "",
      label: documentationMaintenance
        ? text(maintenanceTicket.label, "maintenanceTicket.label")
        : "",
    },
  };
}

export async function loadProject(
  root: string,
  projectKey: string,
  env: Record<string, string | undefined>,
): Promise<LoadedProject> {
  if (!/^[A-Za-z0-9._-]+$/u.test(projectKey))
    throw new Error("invalid project key");
  const directory = path.join(root, "projects", projectKey);
  const config = parseConfig(
    JSON.parse(await readFile(path.join(directory, "config.json"), "utf8")),
  );
  await Promise.all(
    promptNames.map(async (name) => {
      const filename = `${name}.md`;
      if (
        (
          await readFile(path.join(directory, "prompts", filename), "utf8")
        ).trim() === ""
      ) {
        throw new Error(`${filename} must not be empty`);
      }
    }),
  );
  if (config.workflow.documentationMaintenance) {
    try {
      if (
        (
          await readFile(
            path.join(directory, "prompts", "documentation.md"),
            "utf8",
          )
        ).trim() === ""
      ) {
        throw new Error("empty prompt");
      }
    } catch {
      throw new Error(documentationConfigurationError);
    }
  }
  if (config.workflow.review) {
    try {
      if (
        (
          await readFile(path.join(directory, "prompts", "review.md"), "utf8")
        ).trim() === ""
      ) {
        throw new Error("empty prompt");
      }
    } catch {
      throw new Error(reviewConfigurationError);
    }
  }
  const trackerToken = env[config.tracker.tokenEnv];
  const codeHostToken = env[config.codeHost.tokenEnv];
  if (!trackerToken)
    throw new Error(`missing credential ${config.tracker.tokenEnv}`);
  if (!codeHostToken)
    throw new Error(`missing credential ${config.codeHost.tokenEnv}`);
  return { config, directory, trackerToken, codeHostToken };
}
