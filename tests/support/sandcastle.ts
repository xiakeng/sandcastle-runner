import assert from "node:assert/strict";
import path from "node:path";

import { type RunOptions, type RunResult } from "@ai-hero/sandcastle";

import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import type { AgentAttemptResult } from "../../src/run/contracts.ts";

export function object(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

export const committed: AgentAttemptResult = {
  outcome: "committed",
  summary: "implemented",
  commits: [
    {
      sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      message: "feat: implementation",
    },
  ],
  checks: [{ command: "npm test", status: "passed", details: "ok" }],
  blocker: null,
  pr_title: "feat: implementation",
  pr_body: "Implements the ticket.",
};

export function input() {
  return {
    ticket: 9,
    worktree: "/repo/worktree",
    branch: "sandcastle/run-id/ticket-9",
    base: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    targetBranch: "main",
    promptFile: path.resolve("projects/trickplay-cropper/prompts/implement.md"),
    promptArgs: {
      TICKET_NUMBER: 9,
      WORKTREE_PATH: "/repo/worktree",
      BASE_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      PROJECT_TARGET_BRANCH: "main",
    },
    pullRequestMetadata: "required" as const,
    model: "gpt-5.6-sol",
    effort: "high" as const,
    gitConfigGlobal: "/tmp/attempt/config",
    logFile: "/runner/projects/demo/logs/agent.log",
    timeoutMs: 120_000,
    retryPolicy: {
      operationRetry: 4,
      agentRetry: 4,
      operationRetryDelay: [10, 20, 40, 80],
      agentRetryDelay: [10, 20, 40, 80],
    },
    signal: new AbortController().signal,
  };
}

export function reviewInput() {
  const { pullRequestMetadata, ...review } = input();
  void pullRequestMetadata;
  return {
    ...review,
    promptFile: path.resolve("projects/trickplay-cropper/prompts/review.md"),
    promptArgs: { REVIEW_HANDOFF: "{}" },
  };
}

export type FakeRun = (
  options: RunOptions,
) => Promise<RunResult & { output: unknown }>;

export function createExecutor(run: FakeRun): SandcastleAgentExecutor {
  return new SandcastleAgentExecutor(
    async (options) => {
      if (options.prompt === "Reply with exactly: SESSION_READY") {
        return {
          iterations: [{ sessionId: "probe-session" }],
          stdout: "SESSION_READY",
          commits: [],
          branch: input().branch,
          output: undefined,
        };
      }
      return run(options);
    },
    async () => {},
    async () => {},
    async () => {},
  );
}

export function result(
  stdout: string,
  output: AgentAttemptResult,
): RunResult & { output: AgentAttemptResult } {
  return {
    iterations: [{ sessionId: "session-id" }],
    stdout,
    commits: output.commits,
    branch: "sandcastle/run-id/ticket-9",
    output,
  };
}
