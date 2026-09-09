import { readFile } from "node:fs/promises";
import path from "node:path";

const promptNames = [
  "implement",
  "ci-repair",
  "conflict-repair",
  "documentation",
] as const;

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
  agents: {
    implement: AgentConfig;
    ciRepair: AgentConfig;
    conflictRepair: AgentConfig;
    documentation: AgentConfig;
  };
  timeouts: {
    agentMinutes: number;
    requiredChecksMinutes: number;
    mergeQueueMinutes: number;
  };
  ticketClosure: "runner" | "code_host";
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

function agent(value: unknown, name: string): AgentConfig {
  const input = record(value, name);
  const model = text(input.model, `${name}.model`);
  if (!/^gpt-[a-z0-9.-]+$/u.test(model))
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
    agents: {
      implement: agent(agents.implement, "agents.implement"),
      ciRepair: agent(agents.ciRepair, "agents.ciRepair"),
      conflictRepair: agent(agents.conflictRepair, "agents.conflictRepair"),
      documentation: agent(agents.documentation, "agents.documentation"),
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
  const trackerToken = env[config.tracker.tokenEnv];
  const codeHostToken = env[config.codeHost.tokenEnv];
  if (!trackerToken)
    throw new Error(`missing credential ${config.tracker.tokenEnv}`);
  if (!codeHostToken)
    throw new Error(`missing credential ${config.codeHost.tokenEnv}`);
  return { config, directory, trackerToken, codeHostToken };
}
