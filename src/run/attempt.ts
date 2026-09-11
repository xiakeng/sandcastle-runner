import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AuditEvent } from "../audit.ts";
import type { AgentConfig } from "../config.ts";
import type {
  AgentAttemptResult,
  AgentExecutor,
  CommitEvidence,
  GitWorkspace,
  PullRequestIdentity,
  RequiredCheck,
  ReviewAttemptResult,
  Ticket,
} from "./contracts.ts";
import {
  type DeliveryBoundaryResult,
  type DiscoveryInput,
  revalidateActiveTicket,
} from "./discovery.ts";
import {
  externalRead,
  OperatorCancelled,
  pauseForOperator,
  serializeOperator,
  supervisedAuditWrite,
  workflowWrite,
} from "./operations.ts";

export interface VerifiedHandoff {
  ticket: number;
  worktree: string;
  branch: string;
  base: string;
  commits: CommitEvidence[];
  checks: AgentAttemptResult["checks"];
  prTitle: string;
  prBody: string;
  verification: "verified" | "operator_override";
  implementationCommits?: CommitEvidence[];
  reviewCommits?: CommitEvidence[];
  reviewChecks?: AgentAttemptResult["checks"];
  reviewVerification?: "verified" | "operator_override";
  remoteBranch?: string;
}

interface AgentOperationInput extends DiscoveryInput {
  runId: string;
  targetBranch: string;
  projectDirectory: string;
  timeoutMs: number;
  gitWorkspace: GitWorkspace;
  agentExecutor: AgentExecutor;
}

interface AttemptInput extends AgentOperationInput {
  batch: number[];
  checkout: string;
  promptFile: string;
  agent: AgentConfig;
  review: boolean;
  reviewPrompt: string;
  reviewAgent?: AgentConfig;
}

function snapshot(
  ticket: Ticket,
  name: string,
): { source: string; title: string; body: string } {
  if (!ticket.source || !ticket.title || ticket.body === undefined)
    throw new Error(`${name} snapshot is incomplete`);
  return { source: ticket.source, title: ticket.title, body: ticket.body };
}

function parseReviewSnapshot(value: string, number: number): Ticket {
  const input = JSON.parse(value) as Record<string, unknown>;
  if (
    typeof input.title !== "string" ||
    typeof input.body !== "string" ||
    typeof input.source !== "string"
  ) {
    throw new Error("override has no complete ticket snapshot");
  }
  return {
    number,
    state: "open",
    stateReason: null,
    title: input.title,
    body: input.body,
    source: input.source,
  };
}

async function readReviewSnapshot(
  input: AttemptInput,
  ticket: number,
  parent: boolean,
) {
  return snapshot(
    await externalRead({
      action: () =>
        parent
          ? input.tracker.getParent(input.repository, ticket)
          : input.tracker.getTicket(input.repository, ticket),
      parseOverride: (value) => parseReviewSnapshot(value, ticket),
      audit: input.audit,
      event: input.event(
        "review",
        parent ? "read_specification" : "read_ticket_snapshot",
        `${parent ? "parent" : "ticket"}:${ticket}`,
      ),
      clock: input.clock,
      operator: input.operator,
    }),
    parent ? "governing specification" : "Delivery Ticket",
  );
}

async function acceptReview(
  input: AttemptInput,
  handoff: VerifiedHandoff,
  implementationHead: string,
  checks: AgentAttemptResult["checks"],
  verification: "verified" | "operator_override",
): Promise<VerifiedHandoff> {
  const evidence = await input.gitWorkspace.inspectReview({
    worktree: handoff.worktree,
    base: handoff.base,
    implementationHead,
  });
  if (!evidence.clean) throw new Error("Review left a dirty Worktree");
  return {
    ...handoff,
    commits: evidence.deliveryCommits,
    implementationCommits: handoff.commits,
    reviewCommits: evidence.reviewCommits,
    reviewChecks: checks,
    reviewVerification: verification,
  };
}

async function reviewHandoff(
  input: AttemptInput,
  handoff: VerifiedHandoff,
  signal: AbortSignal,
): Promise<VerifiedHandoff> {
  if (handoff.verification !== "verified" || handoff.commits.length === 0)
    throw new Error(
      "Review requires a committed implementation Verified Handoff",
    );
  if (!input.reviewAgent) throw new Error("Review agent is not configured");
  const implementationHead = handoff.commits.at(-1)!.sha;
  let attemptNumber = 0;
  for (;;) {
    await boundary(input, handoff.ticket);
    attemptNumber += 1;
    const event = input.event(
      "review",
      "agent_attempt",
      `ticket:${handoff.ticket}`,
    )(attemptNumber);
    await appendOperation(input, event, "started", null);
    try {
      const [deliveryTicket, governingSpecification, standardsSources] =
        await Promise.all([
          readReviewSnapshot(input, handoff.ticket, false),
          readReviewSnapshot(input, input.parentTicket, true),
          input.gitWorkspace.readReviewStandards(
            handoff.worktree,
            handoff.base,
          ),
        ]);
      const gitDirectory = await mkdtemp(
        path.join(tmpdir(), "sandcastle-runner-git-"),
      );
      let result: ReviewAttemptResult;
      try {
        const gitConfigGlobal = path.join(gitDirectory, "config");
        await writeFile(gitConfigGlobal, "");
        result = await input.agentExecutor.executeReview({
          ticket: handoff.ticket,
          worktree: handoff.worktree,
          branch: handoff.branch,
          base: handoff.base,
          promptFile: input.reviewPrompt,
          promptArgs: {
            REVIEW_HANDOFF: JSON.stringify({
              repository: input.repository,
              projectTargetBranch: input.targetBranch,
              worktree: handoff.worktree,
              deliveryBranch: handoff.branch,
              originalFixedPoint: handoff.base,
              implementationHead,
              deliveryTicket,
              governingSpecification,
              standardsSources,
              acceptedExceptions: [
                "After a passing review, the Runner verifies only Worktree cleanliness and does not compare frozen HEAD, branch, or merge-base values.",
              ],
              implementationReportedChecks: handoff.checks,
            }),
          },
          model: input.reviewAgent.model,
          effort: input.reviewAgent.reasoningEffort,
          gitConfigGlobal,
          logFile: path.join(
            input.projectDirectory,
            "logs",
            `review-${handoff.ticket}-${randomUUID()}.log`,
          ),
          timeoutMs: input.timeoutMs,
          signal,
        });
      } finally {
        await rm(gitDirectory, { recursive: true, force: true });
      }
      await boundary(input, handoff.ticket);
      if (result.outcome === "blocked")
        throw new Error(`Review blocked: ${result.blocker}`);
      const reviewed = await acceptReview(
        input,
        handoff,
        implementationHead,
        result.checks,
        "verified",
      );
      await appendOperation(input, event, "succeeded", null);
      return reviewed;
    } catch (error) {
      if (error instanceof OperatorCancelled) throw error;
      if (error instanceof BoundaryStop) {
        await appendOperation(input, event, error.result.outcome, null);
        throw error;
      }
      await appendOperation(
        input,
        event,
        "failed",
        error instanceof Error ? error.message : "Review Agent Attempt failed",
      );
      for (;;) {
        const response = await pauseForOperator(
          input.audit,
          event,
          input.operator,
          "Review Agent Attempt failed. Enter to retry, q to cancel, or supply a trusted passing result.",
        );
        if (response === "") break;
        await boundary(input, handoff.ticket);
        try {
          const reviewed = await acceptReview(
            input,
            handoff,
            implementationHead,
            [],
            "operator_override",
          );
          await appendOperation(input, event, "operator_override", null);
          return reviewed;
        } catch {
          await appendOperation(input, event, "invalid_override", null);
        }
      }
    }
  }
}

export interface AttemptBatchResult {
  outcome: "incomplete" | "cancelled" | "failed";
  reasons: string[];
  handoffs: VerifiedHandoff[];
}

type AgentStop =
  | { outcome: "blocked"; reason: string }
  | { outcome: "no_change"; reason: string };

export type MaintenanceAttemptResult =
  | { outcome: "committed"; handoff: VerifiedHandoff }
  | AgentStop
  | {
      outcome: "boundary";
      boundary: Exclude<DeliveryBoundaryResult, { outcome: "ready" }>;
    };

class BoundaryStop extends Error {
  readonly result: Exclude<DeliveryBoundaryResult, { outcome: "ready" }>;

  constructor(result: Exclude<DeliveryBoundaryResult, { outcome: "ready" }>) {
    super(result.reason);
    this.result = result;
  }
}

function fullSha(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40,64}$/u.test(value))
    throw new Error("override has no full base SHA");
  return value;
}

async function appendOperation(
  input: AgentOperationInput,
  event: Omit<AuditEvent, "result" | "error">,
  result: string,
  error: string | null,
): Promise<void> {
  await supervisedAuditWrite(
    () => input.audit.append({ ...event, result, error }),
    input.operator,
  );
}

async function boundary(
  input: AgentOperationInput,
  ticket: number,
): Promise<void> {
  const result = await revalidateActiveTicket(input, ticket);
  if (result.outcome !== "ready") throw new BoundaryStop(result);
}

function sameCommits(
  claimed: CommitEvidence[],
  actual: CommitEvidence[],
): boolean {
  return (
    claimed.length === actual.length &&
    claimed.every(
      (commit, index) =>
        commit.sha === actual[index]?.sha &&
        commit.message === actual[index]?.message,
    )
  );
}

function trustedHandoff(
  value: string,
  ticket: number,
  worktree: string,
  branch: string,
  base: string,
  existingPrMetadata?: Pick<VerifiedHandoff, "prTitle" | "prBody">,
): VerifiedHandoff {
  const parsed = existingPrMetadata
    ? null
    : (JSON.parse(value) as Record<string, unknown>);
  if (
    parsed &&
    (parsed.outcome !== "committed" ||
      typeof parsed.pr_title !== "string" ||
      parsed.pr_title.trim() === "" ||
      typeof parsed.pr_body !== "string" ||
      parsed.pr_body.trim() === "")
  )
    throw new Error("override has no downstream PR metadata");
  return {
    ticket,
    worktree,
    branch,
    base,
    commits: [],
    checks: [],
    prTitle: existingPrMetadata?.prTitle ?? (parsed?.pr_title as string),
    prBody: existingPrMetadata?.prBody ?? (parsed?.pr_body as string),
    verification: "operator_override",
  };
}

async function runAgentOperation(
  input: AgentOperationInput,
  operation: {
    phase: "implement" | "ci_repair" | "conflict_repair" | "maintenance";
    ticket: number;
    worktree: string;
    branch: string;
    base: string;
    requiredAncestor?: string;
    promptFile: string;
    promptArgs: Record<string, string | number>;
    pullRequestMetadata: "required" | "required_for_committed" | "ignored";
    existingPrMetadata?: Pick<VerifiedHandoff, "prTitle" | "prBody">;
    agent: AgentConfig;
    signal: AbortSignal;
    attemptCounter: { value: number };
  },
): Promise<VerifiedHandoff | AgentStop> {
  for (;;) {
    await boundary(input, operation.ticket);
    operation.attemptCounter.value += 1;
    const attemptNumber = operation.attemptCounter.value;
    const attemptId = randomUUID();
    const event = input.event(
      operation.phase,
      "agent_attempt",
      `ticket:${operation.ticket}`,
    )(attemptNumber);
    await appendOperation(input, event, "started", null);
    try {
      const gitDirectory = await mkdtemp(
        path.join(tmpdir(), "sandcastle-runner-git-"),
      );
      let result: AgentAttemptResult;
      try {
        const gitConfigGlobal = path.join(gitDirectory, "config");
        await writeFile(gitConfigGlobal, "");
        result = await input.agentExecutor.execute({
          ticket: operation.ticket,
          worktree: operation.worktree,
          branch: operation.branch,
          base: operation.base,
          promptFile: operation.promptFile,
          promptArgs: operation.promptArgs,
          pullRequestMetadata: operation.pullRequestMetadata,
          model: operation.agent.model,
          effort: operation.agent.reasoningEffort,
          gitConfigGlobal,
          logFile: path.join(
            input.projectDirectory,
            "logs",
            `agent-${operation.ticket}-${attemptId}.log`,
          ),
          timeoutMs: input.timeoutMs,
          signal: operation.signal,
        });
      } finally {
        await rm(gitDirectory, { recursive: true, force: true });
      }

      await boundary(input, operation.ticket);
      if (result.outcome === "blocked") {
        await appendOperation(input, event, "blocked", null);
        return {
          outcome: "blocked",
          reason: `${input.ticketKind ?? "Delivery Ticket"} ${operation.ticket} blocked: ${result.blocker}`,
        };
      }
      const observed = await input.gitWorkspace.inspect({
        worktree: operation.worktree,
        base: operation.base,
        ...(operation.requiredAncestor === undefined
          ? {}
          : { requiredAncestor: operation.requiredAncestor }),
      });
      if (
        observed.worktree !== path.resolve(operation.worktree) ||
        observed.branch !== operation.branch ||
        observed.base !== operation.base ||
        !observed.clean
      ) {
        throw new Error("Agent Attempt left mismatched or dirty Git state");
      }
      if (result.outcome === "no_change") {
        if (observed.commits.length !== 0)
          throw new Error("no_change left new commits");
        await appendOperation(input, event, "no_change", null);
        return {
          outcome: "no_change",
          reason: `${input.ticketKind ?? "Delivery Ticket"} ${operation.ticket} no_change: ${result.summary}`,
        };
      }
      if (
        observed.commits.length === 0 ||
        !sameCommits(result.commits, observed.commits)
      ) {
        throw new Error("Agent commit claims do not match Git evidence");
      }
      const prTitle = result.pr_title ?? operation.existingPrMetadata?.prTitle;
      const prBody = result.pr_body ?? operation.existingPrMetadata?.prBody;
      if (!prTitle || !prBody)
        throw new Error("Agent Attempt result has no downstream PR metadata");
      const handoff: VerifiedHandoff = {
        ticket: operation.ticket,
        worktree: operation.worktree,
        branch: operation.branch,
        base: operation.base,
        commits: observed.commits,
        checks: result.checks,
        prTitle,
        prBody,
        verification: "verified",
      };
      await appendOperation(input, event, "succeeded", null);
      return handoff;
    } catch (error) {
      if (error instanceof OperatorCancelled) throw error;
      if (error instanceof BoundaryStop) {
        await appendOperation(input, event, error.result.outcome, null);
        throw error;
      }
      await appendOperation(
        input,
        event,
        "failed",
        error instanceof Error ? error.message : "Agent Attempt failed",
      );
      for (;;) {
        const response = await pauseForOperator(
          input.audit,
          event,
          input.operator,
          "Agent Attempt failed. Enter to retry, q to cancel, or supply a trusted committed result.",
        );
        if (response === "") break;
        let handoff: VerifiedHandoff;
        try {
          handoff = trustedHandoff(
            response,
            operation.ticket,
            operation.worktree,
            operation.branch,
            operation.base,
            operation.existingPrMetadata,
          );
        } catch {
          await appendOperation(input, event, "invalid_override", null);
          continue;
        }
        await boundary(input, operation.ticket);
        await appendOperation(input, event, "operator_override", null);
        return handoff;
      }
    }
  }
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
        IMPLEMENT_SKILL: "$implement",
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
        IMPLEMENT_SKILL: "$implement",
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
          handoff: { ...result, remoteBranch: input.handoff.remoteBranch },
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
        IMPLEMENT_SKILL: "$implement",
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
          handoff: { ...result, remoteBranch: input.handoff.remoteBranch },
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
