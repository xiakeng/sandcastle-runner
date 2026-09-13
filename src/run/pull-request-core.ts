import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentConfig } from "../config.ts";
import type { VerifiedHandoff } from "./attempt.ts";
import type {
  AgentExecutor,
  CodeHost,
  GitWorkspace,
  PullRequestIdentity,
  PullRequestState,
  RequiredCheck,
  Ticket,
  TicketClosurePolicy,
} from "./contracts.ts";
import {
  type DeliveryBoundaryResult,
  type DiscoveryInput,
  type MergedDeliveryBoundaryResult,
  releaseTerminalTicket,
  revalidateActiveTicket,
  revalidateMergedTicket,
} from "./discovery.ts";
import {
  externalRead,
  pauseForOperator,
  recordOperatorOverride,
  workflowWrite,
} from "./operations.ts";
import { type RepairState, type PublicationIntent } from "../recovery.ts";

export interface PullRequestObservation extends PullRequestIdentity {
  ticket: number;
  branch: string;
  readiness: "ready" | "failed" | "stopped";
  failedChecks: RequiredCheck[];
}

export interface PublishedHandoff {
  handoff: VerifiedHandoff;
  pullRequest: PullRequestIdentity;
  observation: PullRequestObservation;
}

export interface ReadinessInput extends DiscoveryInput {
  requiredChecksTimeoutMs: number;
  codeHost: CodeHost;
}

export interface PublicationInput extends ReadinessInput {
  runId: string;
  targetBranch: string;
  checkout: string;
  projectDirectory: string;
  ciRepairPrompt: string;
  ciRepairAgent: AgentConfig;
  conflictRepairPrompt: string;
  conflictRepairAgent: AgentConfig;
  agentTimeoutMs: number;
  handoffs: VerifiedHandoff[];
  gitWorkspace: GitWorkspace;
  agentExecutor: AgentExecutor;
  adminMerge: boolean;
  mergeQueueTimeoutMs: number;
  ticketClosure: TicketClosurePolicy;
  ciRepairBudgets: Map<number, RepairBudget>;
  persistPublication?: (
    ticket: number,
    intent: PublicationIntent | null,
  ) => Promise<void>;
  publicationIntents?: Map<number, PublicationIntent>;
}

export interface RepairBudget {
  consumed: number;
  generation: number;
  attempts: { value: number };
}

type RepairPurpose = "ci" | "conflict";

export function repairIntent(
  input: PublicationInput,
  ticket: number,
  purpose: RepairPurpose,
  repairState: Omit<
    NonNullable<PublicationIntent["repairState"]>,
    "pendingPush"
  > & { pendingPush?: string | null },
): Promise<void> {
  const current = input.publicationIntents?.get(ticket);
  if (!current || !input.persistPublication) return Promise.resolve();
  repairState = {
    ...(current.repairState?.purpose === purpose ? current.repairState : {}),
    ...repairState,
  };
  repairState.purpose = purpose;
  if (repairState.pendingPush === null) delete repairState.pendingPush;
  const persistedRepairState = repairState as NonNullable<
    PublicationIntent["repairState"]
  >;
  const next = {
    ...current,
    repairState: persistedRepairState,
    repairBudgets: {
      ...current.repairBudgets,
      [purpose]: persistedRepairState,
    },
    ...(persistedRepairState.head === undefined ||
    current.pullRequest === undefined
      ? {}
      : {
          pullRequest: {
            ...current.pullRequest,
            headSha: persistedRepairState.head,
          },
        }),
  };
  input.publicationIntents?.set(ticket, next);
  return input.persistPublication(ticket, next);
}

export function persistedBudget(
  input: PublicationInput,
  ticket: number,
  purpose: RepairPurpose,
): RepairState | undefined {
  const intent = input.publicationIntents?.get(ticket);
  return (
    intent?.repairBudgets?.[purpose] ??
    (intent?.repairState?.purpose === purpose ? intent.repairState : undefined)
  );
}

export interface PublicationResult {
  outcome: "succeeded" | "incomplete" | "cancelled" | "failed";
  reasons: string[];
  pullRequests: PullRequestObservation[];
  published: PublishedHandoff[];
}

export interface RecoveredPublicationResult extends PublicationResult {
  restarted: number[];
}

export function remoteHeadOverride(value: string): string | null {
  const parsed = JSON.parse(value) as { headSha?: unknown };
  if (parsed.headSha !== null && typeof parsed.headSha !== "string")
    throw new Error("override has invalid remote branch head");
  return parsed.headSha ?? null;
}

export function stopped(
  result: Exclude<DeliveryBoundaryResult, { outcome: "ready" }>,
  pullRequests: PullRequestObservation[],
  published: PublishedHandoff[],
): PublicationResult {
  return {
    outcome:
      result.outcome === "cancelled"
        ? "cancelled"
        : result.outcome === "failed"
          ? "failed"
          : "incomplete",
    reasons: [result.reason],
    pullRequests,
    published,
  };
}

function pullRequestStateOverride(value: string): PullRequestState {
  const parsed = JSON.parse(value) as Partial<PullRequestState>;
  if (
    typeof parsed.headSha !== "string" ||
    parsed.headSha.length === 0 ||
    typeof parsed.createdAt !== "string" ||
    parsed.createdAt.length === 0 ||
    typeof parsed.merged !== "boolean" ||
    (parsed.mergeFailure !== null && typeof parsed.mergeFailure !== "string")
  ) {
    throw new Error("override has invalid Pull Request state");
  }
  return {
    headSha: parsed.headSha,
    createdAt: parsed.createdAt,
    merged: parsed.merged,
    mergeFailure: parsed.mergeFailure ?? null,
  };
}

export async function freshRepairHandoff(
  input: PublicationInput,
  handoff: VerifiedHandoff,
  purpose: "ci" | "conflict",
): Promise<VerifiedHandoff> {
  if (typeof input.codeHost.getRemoteBranchHead !== "function") return handoff;
  const base = await externalRead({
    action: () =>
      input.codeHost.getRemoteBranchHead(
        input.repository,
        handoff.remoteBranch ?? handoff.branch,
      ),
    parseOverride: remoteHeadOverride,
    audit: input.audit,
    event: input.event(
      `${purpose}_repair`,
      "remote_base_head",
      `ticket:${handoff.ticket}`,
    ),
    clock: input.clock,
    operator: input.operator,
  });
  if (!base) return handoff;
  const id = randomUUID();
  const branch = `sandcastle/run-${input.runId}/ticket-${handoff.ticket}-${purpose}-repair-${id}`;
  const worktree = path.join(
    input.projectDirectory,
    "worktrees",
    input.runId,
    `ticket-${handoff.ticket}-${purpose}-repair-${id}`,
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
        `${purpose}_repair`,
        "create_worktree",
        `ticket:${handoff.ticket}`,
      )(1),
    operator: input.operator,
  });
  return {
    ...handoff,
    worktree,
    branch,
    base,
    commits: [],
    remoteBranch: handoff.remoteBranch ?? handoff.branch,
  };
}

export async function observePullRequestForIntegration(
  input: ReadinessInput,
  pullRequest: number,
  phase = "merge_wait",
): Promise<PullRequestState> {
  return externalRead({
    action: () => input.codeHost.getPullRequest(input.repository, pullRequest),
    parseOverride: pullRequestStateOverride,
    audit: input.audit,
    event: input.event(
      phase,
      "pull_request_state",
      `pull_request:${pullRequest}`,
    ),
    clock: input.clock,
    operator: input.operator,
  });
}

export async function waitForMerge(
  input: PublicationInput,
  handoff: VerifiedHandoff,
  pullRequest: PullRequestIdentity,
): Promise<"merged" | Exclude<DeliveryBoundaryResult, { outcome: "ready" }>> {
  for (;;) {
    const deadline = input.clock.now().getTime() + input.mergeQueueTimeoutMs;
    for (;;) {
      const state = await observePullRequestForIntegration(
        input,
        pullRequest.number,
      );
      if (state.merged) return "merged";
      const boundary = await revalidateActiveTicket(input, handoff.ticket);
      if (boundary.outcome !== "ready") return boundary;
      const remaining = deadline - input.clock.now().getTime();
      if (state.mergeFailure === null && remaining > 0) {
        await input.clock.sleep(Math.min(10_000, remaining));
        continue;
      }

      const event = input.event(
        "merge_wait",
        state.mergeFailure === null ? "merge_timeout" : "merge_failure",
        `pull_request:${pullRequest.number}`,
      )(1);
      const response = await pauseForOperator(
        input.audit,
        event,
        input.operator,
        state.mergeFailure ??
          "Merge confirmation timed out. Enter to retry, q to cancel, or acknowledge a trusted merge.",
      );
      if (response === "") break;
      const afterOverride = await revalidateMergedTicket(input, handoff.ticket);
      if (afterOverride.outcome !== "ready") {
        const changed = await completedOrStopped(input, handoff, afterOverride);
        if (changed.outcome !== "completed") return changed;
      }
      await recordOperatorOverride(input.audit, event, input.operator);
      return "merged";
    }
  }
}

type CompletionResult =
  | { outcome: "completed"; ticket: Ticket }
  | Exclude<DeliveryBoundaryResult, { outcome: "ready" }>;
type ChangedAfterMerge = Exclude<
  MergedDeliveryBoundaryResult,
  { outcome: "ready" }
>;

async function completedOrStopped(
  input: PublicationInput,
  handoff: VerifiedHandoff,
  boundary: ChangedAfterMerge,
): Promise<CompletionResult> {
  if (boundary.outcome !== "terminal") return boundary;
  if (boundary.ticket.stateReason === "completed") {
    return { outcome: "completed", ticket: boundary.ticket };
  }
  await releaseTerminalTicket(input, boundary.ticket);
  return {
    outcome: "stopped",
    reason: `${input.ticketKind ?? "Delivery Ticket"} ${handoff.ticket} was cancelled after merge`,
  };
}

export class DeliveryBoundaryChanged extends Error {
  readonly boundary: ChangedAfterMerge;

  constructor(boundary: ChangedAfterMerge) {
    super("Delivery Ticket changed before operation retry");
    this.boundary = boundary;
  }
}

export class ReservedBoundaryChanged extends Error {
  readonly boundary: Exclude<DeliveryBoundaryResult, { outcome: "ready" }>;

  constructor(boundary: Exclude<DeliveryBoundaryResult, { outcome: "ready" }>) {
    super("Delivery Ticket changed before operation retry");
    this.boundary = boundary;
  }
}

export async function pushRepair(
  input: PublicationInput,
  handoff: VerifiedHandoff,
  pullRequest: PullRequestIdentity,
  phase: "ci_repair" | "conflict_repair",
  attempt: number,
): Promise<Exclude<DeliveryBoundaryResult, { outcome: "ready" }> | null> {
  const boundary = await revalidateActiveTicket(input, handoff.ticket);
  if (boundary.outcome !== "ready") return boundary;
  const remoteBranch = handoff.remoteBranch ?? handoff.branch;
  const remoteHead =
    typeof input.codeHost.getRemoteBranchHead !== "function"
      ? handoff.base
      : await externalRead({
          action: () =>
            input.codeHost.getRemoteBranchHead(input.repository, remoteBranch),
          parseOverride: remoteHeadOverride,
          audit: input.audit,
          event: input.event(
            phase,
            "remote_base_head",
            `branch:${remoteBranch}`,
          ),
          clock: input.clock,
          operator: input.operator,
        });
  if (typeof input.codeHost.getRemoteBranchHead !== "function") return null;
  if (
    handoff.remoteBranch !== undefined &&
    (remoteHead === null || remoteHead !== handoff.base)
  ) {
    await pauseForOperator(
      input.audit,
      input.event(phase, "remote_advance", `branch:${remoteBranch}`)(attempt),
      input.operator,
      `Stable repair branch advanced from ${handoff.base} to ${remoteHead ?? "absent"}. Resolve the remote state, then restart the Run, or q to cancel.`,
    );
    return { outcome: "stopped", reason: "stable repair branch advanced" };
  }
  try {
    await workflowWrite({
      action: () =>
        input.gitWorkspace.push(handoff.worktree, handoff.branch, remoteBranch),
      beforeRetry: async () => {
        const changed = await revalidateActiveTicket(input, handoff.ticket);
        if (changed.outcome !== "ready") {
          throw new ReservedBoundaryChanged(changed);
        }
      },
      audit: input.audit,
      event: () =>
        input.event(
          phase,
          "push_repair",
          `pull_request:${pullRequest.number}`,
        )(attempt),
      operator: input.operator,
    });
    return null;
  } catch (error) {
    if (!(error instanceof ReservedBoundaryChanged)) throw error;
    return error.boundary;
  }
}

export async function confirmCompletion(
  input: PublicationInput,
  handoff: VerifiedHandoff,
): Promise<CompletionResult> {
  for (;;) {
    if (input.ticketClosure === "code_host") await input.clock.sleep(10_000);
    let boundary = await revalidateMergedTicket(input, handoff.ticket);
    if (boundary.outcome !== "ready") {
      return completedOrStopped(input, handoff, boundary);
    }

    if (input.ticketClosure === "runner") {
      try {
        await workflowWrite({
          action: () =>
            input.tracker.closeTicket(input.repository, handoff.ticket),
          beforeRetry: async () => {
            const changed = await revalidateMergedTicket(input, handoff.ticket);
            if (changed.outcome !== "ready") {
              throw new DeliveryBoundaryChanged(changed);
            }
          },
          audit: input.audit,
          event: () =>
            input.event(
              "ticket_closure",
              "close_ticket",
              `ticket:${handoff.ticket}`,
            )(1),
          operator: input.operator,
        });
      } catch (error) {
        if (!(error instanceof DeliveryBoundaryChanged)) throw error;
        return completedOrStopped(input, handoff, error.boundary);
      }
    } else {
      await input.clock.sleep(30_000);
    }

    boundary = await revalidateMergedTicket(input, handoff.ticket);
    if (boundary.outcome !== "ready") {
      return completedOrStopped(input, handoff, boundary);
    }

    const event = input.event(
      "ticket_closure",
      "confirm_completed_ticket",
      `ticket:${handoff.ticket}`,
    )(1);
    const response = await pauseForOperator(
      input.audit,
      event,
      input.operator,
      `Merged ${input.ticketKind ?? "Delivery Ticket"} ${handoff.ticket} is not closed as completed. Enter to retry, q to cancel, or acknowledge trusted completion.`,
    );
    if (response === "") continue;
    boundary = await revalidateMergedTicket(input, handoff.ticket);
    if (boundary.outcome !== "ready") {
      return completedOrStopped(input, handoff, boundary);
    }
    await recordOperatorOverride(input.audit, event, input.operator);
    return {
      outcome: "completed",
      ticket: boundary.ticket,
    };
  }
}

export function pullRequestOverride(value: string): PullRequestIdentity {
  const trimmed = value.trim();
  let number: number;
  let url: string;
  try {
    const parsed = JSON.parse(trimmed) as {
      number?: unknown;
      url?: unknown;
    };
    number = Number(parsed.number);
    url = typeof parsed.url === "string" ? parsed.url : "";
  } catch {
    const match = /\/pull\/(\d+)\/?$/u.exec(trimmed);
    number = Number(match?.[1]);
    url = trimmed;
  }
  if (!Number.isSafeInteger(number) || number <= 0 || url.length === 0)
    throw new Error("override has no Pull Request identity");
  return { number, url };
}
