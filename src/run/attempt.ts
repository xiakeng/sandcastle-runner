import path from "node:path";

import type { AgentConfig } from "../config.ts";
import type { PullRequestIdentity, RequiredCheck } from "./contracts.ts";
import { type DeliveryBoundaryResult } from "./discovery.ts";
import {
  externalRead,
  OperatorCancelled,
  serializeOperator,
  workflowWrite,
} from "./operations.ts";
import {
  runAgentOperation,
  boundary,
  BoundaryStop,
  type AgentOperationInput,
  type AttemptInput,
  type VerifiedHandoff,
  type AttemptBatchResult,
  type MaintenanceAttemptResult,
} from "./agent-operation.ts";
import { reviewHandoff } from "./review-attempt.ts";
export type {
  AttemptBatchResult,
  MaintenanceAttemptResult,
} from "./agent-operation.ts";
export type { VerifiedHandoff } from "./agent-operation.ts";

function fullSha(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40,64}$/u.test(value))
    throw new Error("override has no full base SHA");
  return value;
}

async function implementTicket(
  input: AttemptInput,
  ticket: number,
  base: string,
  controller: AbortController,
): Promise<VerifiedHandoff | string> {
  try {
    await boundary(input, ticket);
    const branch = `sandcastle/run-${input.runId}/ticket-${ticket}`;
    const worktree = path.join(
      input.projectDirectory,
      "worktrees",
      input.runId,
      `ticket-${ticket}`,
    );
    await workflowWrite({
      action: () =>
        input.gitWorkspace.createWorktree({
          checkout: input.checkout,
          worktree,
          branch,
          base,
        }),
      audit: input.audit,
      clock: input.clock,
      event: () =>
        input.event(
          "prepare_worktrees",
          "create_worktree",
          `ticket:${ticket}`,
        )(1),
      operator: input.operator,
    });
    const result = await runAgentOperation(input, {
      phase: "implement",
      ticket,
      worktree,
      branch,
      base,
      promptFile: input.promptFile,
      promptArgs: {
        TICKET_NUMBER: ticket,
        TICKET_REFERENCE: `${input.repository}#${ticket}`,
        WORKTREE_PATH: worktree,
        BASE_SHA: base,
        PROJECT_TARGET_BRANCH: input.targetBranch,
      },
      pullRequestMetadata: "required",
      agent: input.agent,
      signal: controller.signal,
      attemptCounter: { value: 0 },
    });
    if ("reason" in result) return result.reason;
    return input.review
      ? await reviewHandoff(input, result, controller.signal)
      : result;
  } catch (error) {
    if (error instanceof BoundaryStop && error.result.outcome === "stopped")
      return error.result.reason;
    throw error;
  }
}

export async function runCiRepairAttempt(
  input: AgentOperationInput & {
    handoff: VerifiedHandoff;
    base: string;
    pullRequest: PullRequestIdentity;
    failedChecks: RequiredCheck[];
    promptFile: string;
    agent: AgentConfig;
    signal: AbortSignal;
    attemptCounter: { value: number };
  },
): Promise<
  | { outcome: "handoff"; handoff: VerifiedHandoff }
  | { outcome: "consumed"; reason: string }
  | {
      outcome: "boundary";
      boundary: Exclude<DeliveryBoundaryResult, { outcome: "ready" }>;
    }
> {
  try {
    const result = await runAgentOperation(input, {
      phase: "ci_repair",
      ticket: input.handoff.ticket,
      worktree: input.handoff.worktree,
      branch: input.handoff.branch,
      base: input.base,
      promptFile: input.promptFile,
      promptArgs: {
        TICKET_NUMBER: input.handoff.ticket,
        TICKET_REFERENCE: `${input.repository}#${input.handoff.ticket}`,
        WORKTREE_PATH: input.handoff.worktree,
        BASE_SHA: input.base,
        PROJECT_TARGET_BRANCH: input.targetBranch,
        PULL_REQUEST_NUMBER: input.pullRequest.number,
        PULL_REQUEST_URL: input.pullRequest.url,
        FAILED_CHECKS: JSON.stringify(
          input.failedChecks.map(({ name, state, link }) => ({
            name,
            state,
            link,
          })),
        ),
      },
      pullRequestMetadata: "ignored",
      existingPrMetadata: input.handoff,
      agent: input.agent,
      signal: input.signal,
      attemptCounter: input.attemptCounter,
    });
    return "reason" in result
      ? { outcome: "consumed", reason: result.reason }
      : {
          outcome: "handoff",
          handoff: {
            ...result,
            ...(input.handoff.remoteBranch === undefined
              ? {}
              : { remoteBranch: input.handoff.remoteBranch }),
          },
        };
  } catch (error) {
    if (error instanceof BoundaryStop) {
      return { outcome: "boundary", boundary: error.result };
    }
    throw error;
  }
}

export async function runConflictRepairAttempt(
  input: AgentOperationInput & {
    handoff: VerifiedHandoff;
    base: string;
    targetBase: string;
    pullRequest: PullRequestIdentity;
    conflict: string;
    promptFile: string;
    agent: AgentConfig;
    signal: AbortSignal;
    attemptCounter: { value: number };
  },
): Promise<
  | { outcome: "handoff"; handoff: VerifiedHandoff }
  | { outcome: "consumed"; reason: string }
  | {
      outcome: "boundary";
      boundary: Exclude<DeliveryBoundaryResult, { outcome: "ready" }>;
    }
> {
  try {
    const result = await runAgentOperation(input, {
      phase: "conflict_repair",
      ticket: input.handoff.ticket,
      worktree: input.handoff.worktree,
      branch: input.handoff.branch,
      base: input.base,
      requiredAncestor: input.targetBase,
      promptFile: input.promptFile,
      promptArgs: {
        TICKET_NUMBER: input.handoff.ticket,
        TICKET_REFERENCE: `${input.repository}#${input.handoff.ticket}`,
        WORKTREE_PATH: input.handoff.worktree,
        BASE_SHA: input.base,
        PROJECT_TARGET_BRANCH: input.targetBranch,
        TARGET_BRANCH_SHA: input.targetBase,
        PULL_REQUEST_NUMBER: input.pullRequest.number,
        PULL_REQUEST_URL: input.pullRequest.url,
        MERGE_CONFLICT: input.conflict,
      },
      pullRequestMetadata: "ignored",
      existingPrMetadata: input.handoff,
      agent: input.agent,
      signal: input.signal,
      attemptCounter: input.attemptCounter,
    });
    return "reason" in result
      ? { outcome: "consumed", reason: result.reason }
      : {
          outcome: "handoff",
          handoff: {
            ...result,
            ...(input.handoff.remoteBranch === undefined
              ? {}
              : { remoteBranch: input.handoff.remoteBranch }),
          },
        };
  } catch (error) {
    if (error instanceof BoundaryStop) {
      return { outcome: "boundary", boundary: error.result };
    }
    throw error;
  }
}

export async function runMaintenanceAttempt(
  input: AgentOperationInput & {
    checkout: string;
    ticket: number;
    promptFile: string;
    agent: AgentConfig;
  },
): Promise<MaintenanceAttemptResult> {
  try {
    await boundary(input, input.ticket);
    const base = await externalRead({
      action: () =>
        input.gitWorkspace.fetchTargetBranch(
          input.checkout,
          input.targetBranch,
        ),
      parseOverride: (value) => {
        const parsed = JSON.parse(value) as { base?: unknown };
        return fullSha(parsed.base);
      },
      audit: input.audit,
      event: input.event(
        "maintenance",
        "fetch_target_branch",
        input.targetBranch,
      ),
      clock: input.clock,
      operator: input.operator,
    });
    const branch = `sandcastle/run-${input.runId}/maintenance-${input.ticket}`;
    const worktree = path.join(
      input.projectDirectory,
      "worktrees",
      input.runId,
      `maintenance-${input.ticket}`,
    );
    await workflowWrite({
      action: () =>
        input.gitWorkspace.createWorktree({
          checkout: input.checkout,
          worktree,
          branch,
          base,
        }),
      audit: input.audit,
      clock: input.clock,
      event: () =>
        input.event(
          "maintenance",
          "create_worktree",
          `ticket:${input.ticket}`,
        )(1),
      operator: input.operator,
    });
    const result = await runAgentOperation(input, {
      phase: "maintenance",
      ticket: input.ticket,
      worktree,
      branch,
      base,
      promptFile: input.promptFile,
      promptArgs: {
        TICKET_NUMBER: input.ticket,
        TICKET_REFERENCE: `${input.repository}#${input.ticket}`,
        WORKTREE_PATH: worktree,
        BASE_SHA: base,
        PROJECT_TARGET_BRANCH: input.targetBranch,
      },
      pullRequestMetadata: "required_for_committed",
      agent: input.agent,
      signal: new AbortController().signal,
      attemptCounter: { value: 0 },
    });
    return "reason" in result
      ? result
      : { outcome: "committed", handoff: result };
  } catch (error) {
    if (error instanceof BoundaryStop) {
      return { outcome: "boundary", boundary: error.result };
    }
    throw error;
  }
}

export async function implementReservedBatch(
  input: AttemptInput,
): Promise<AttemptBatchResult> {
  const candidates: number[] = [];
  const stopped: string[] = [];
  try {
    for (const ticket of input.batch) {
      try {
        await boundary(input, ticket);
        candidates.push(ticket);
      } catch (error) {
        if (!(error instanceof BoundaryStop)) throw error;
        if (
          error.result.outcome === "cancelled" ||
          error.result.outcome === "failed"
        )
          throw error;
        stopped.push(error.result.reason);
      }
    }
    if (candidates.length === 0)
      return { outcome: "incomplete", reasons: stopped, handoffs: [] };
    const base = await externalRead({
      action: () =>
        input.gitWorkspace.fetchTargetBranch(
          input.checkout,
          input.targetBranch,
        ),
      parseOverride: (value) => {
        const parsed = JSON.parse(value) as { base?: unknown };
        return fullSha(parsed.base);
      },
      audit: input.audit,
      event: input.event(
        "prepare_worktrees",
        "fetch_target_branch",
        input.targetBranch,
      ),
      clock: input.clock,
      operator: input.operator,
    });
    const controller = new AbortController();
    const concurrentInput = {
      ...input,
      operator: serializeOperator(input.operator, controller),
    };
    const attempts = candidates.map((ticket) =>
      implementTicket(concurrentInput, ticket, base, controller),
    );
    try {
      const settled = await Promise.all(attempts);
      const handoffs = settled.filter(
        (result): result is VerifiedHandoff => typeof result !== "string",
      );
      return {
        outcome: "incomplete",
        handoffs,
        reasons: [
          ...stopped,
          ...settled.filter(
            (result): result is string => typeof result === "string",
          ),
        ],
      };
    } catch (error) {
      controller.abort(error);
      await Promise.allSettled(attempts);
      throw error;
    }
  } catch (error) {
    if (error instanceof BoundaryStop) {
      return {
        outcome: error.result.outcome === "cancelled" ? "cancelled" : "failed",
        reasons: [error.result.reason],
        handoffs: [],
      };
    }
    if (error instanceof OperatorCancelled) throw error;
    throw error;
  }
}
