import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { registerTempRoot } from "../support/temp-cleanup.ts";

import type {
  AgentAttemptInput,
  CommitEvidence,
} from "../../src/run/contracts.ts";

export function object(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

export async function createProject(recovery: boolean): Promise<string> {
  const root = registerTempRoot(
    await mkdtemp(path.join(tmpdir(), "sandcastle-runner-full-")),
  );
  const project = path.join(root, "projects", "demo");
  await mkdir(path.join(project, "prompts"), { recursive: true });
  const config = {
    repository: "owner/repo",
    checkout: "/tmp/repo",
    issueList: [],
    ...(!recovery && { targetBranch: "main" }),
    tracker: {
      type: "github",
      tokenEnv: "TEST_GH_TOKEN",
      runnerAccount: "runner",
      reservationLabel: "sandcastle:reserved",
    },
    codeHost: {
      type: "github",
      tokenEnv: "TEST_GH_TOKEN",
      adminMerge: false,
    },
    workflow: { review: false, documentationMaintenance: true },
    agents: Object.fromEntries(
      ["implement", "ciRepair", "conflictRepair", "documentation"].map(
        (name) => [name, { model: "gpt-5.6-sol", reasoningEffort: "high" }],
      ),
    ),
    timeouts: {
      agentMinutes: 120,
      requiredChecksMinutes: 60,
      mergeQueueMinutes: 60,
    },
    operationRetry: 4,
    agentRetry: 4,
    operationRetryDelay: [10, 20, 40, 80],
    agentRetryDelay: [10, 20, 40, 80],
    ticketClosure: "runner",
    maintenanceTicket: {
      title: "Maintain project documentation",
      body: "Run the configured documentation-maintenance prompt for the current Target Branch.",
      label: "doc-maintain",
    },
  };
  await writeFile(path.join(project, "config.json"), JSON.stringify(config));
  await Promise.all(
    ["implement", "ci-repair", "conflict-repair", "documentation"].map((name) =>
      writeFile(path.join(project, "prompts", `${name}.md`), `${name} prompt`),
    ),
  );
  return root;
}

export function milestones(operations: string[]): string[] {
  return operations.filter(
    (operation) =>
      operation.startsWith("merge:") ||
      operation.startsWith("maintenance:create:") ||
      operation === "parent:close",
  );
}

export function batchBarriers(operations: string[]): string[] {
  return operations.filter(
    (operation) =>
      operation.startsWith("maintenance:create:") ||
      operation === "reservation:label:4:1" ||
      operation === "ticket:close:4" ||
      operation === "reservation:label:5:1" ||
      operation === "ticket:close:5",
  );
}

export const sha = (value: string): string => value.repeat(40);
export const ticketForBranch = (branch: string): number =>
  Number(/(?:ticket|maintenance)-(\d+)(?:-|$)/u.exec(branch)?.[1]);
export const makeAttemptResult = (
  input: AgentAttemptInput,
  commit: CommitEvidence,
) => ({
  outcome: "committed" as const,
  summary: `completed ${input.promptFile} for ${input.ticket}`,
  commits: [commit],
  checks: [],
  blocker: null,
  pr_title: `feat: ticket ${input.ticket}`,
  pr_body: `Completes ticket ${input.ticket}.`,
});
