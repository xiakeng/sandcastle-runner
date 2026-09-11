import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentConfig } from "../config.ts";
import {
  runCiRepairAttempt,
  runConflictRepairAttempt,
  type VerifiedHandoff,
} from "./attempt.ts";
import type {
  AgentExecutor,
  CodeHost,
  GitWorkspace,
  MergeRequestResult,
  PullRequestIdentity,
  PullRequestRecord,
  PullRequestState,
  RequiredCheck,
  Ticket,
  TicketClosurePolicy,
} from "./contracts.ts";
import { parseRequiredChecks } from "./contracts.ts";
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
  serializeOperator,
  workflowWrite,
} from "./operations.ts";
import {
  reconcileInitialPush,
  reconcilePullRequest,
  type PublicationIntent,
} from "../recovery.ts";

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

interface RepairBudget {
  consumed: number;
  generation: number;
  attempts: { value: number };
}

function repairIntent(
  input: PublicationInput,
  ticket: number,
  repairState: Omit<
    NonNullable<PublicationIntent["repairState"]>,
    "pendingPush"
  > & { pendingPush?: string | null },
): Promise<void> {
  const current = input.publicationIntents?.get(ticket);
  if (!current || !input.persistPublication) return Promise.resolve();
  repairState = { ...current.repairState, ...repairState };
  if (repairState.pendingPush === null) delete repairState.pendingPush;
  const persistedRepairState = repairState as NonNullable<
    PublicationIntent["repairState"]
  >;
  const next = {
    ...current,
    repairState: persistedRepairState,
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

export interface PublicationResult {
  outcome: "succeeded" | "incomplete" | "cancelled" | "failed";
  reasons: string[];
  pullRequests: PullRequestObservation[];
  published: PublishedHandoff[];
}

export interface RecoveredPublicationResult extends PublicationResult {
  restarted: number[];
}

function remoteHeadOverride(value: string): string | null {
  const parsed = JSON.parse(value) as { headSha?: unknown };
  if (parsed.headSha !== null && typeof parsed.headSha !== "string")
    throw new Error("override has invalid remote branch head");
  return parsed.headSha ?? null;
}

function pullRequestsOverride(value: string): PullRequestRecord[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed))
    throw new Error("override has invalid Pull Requests");
  return parsed.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null)
      throw new Error("override has invalid Pull Request");
    const pullRequest = candidate as Record<string, unknown>;
    if (
      !Number.isSafeInteger(pullRequest.number) ||
      typeof pullRequest.url !== "string" ||
      typeof pullRequest.branch !== "string" ||
      typeof pullRequest.targetBranch !== "string" ||
      typeof pullRequest.headSha !== "string" ||
      !["open", "closed", "merged"].includes(String(pullRequest.state))
    )
      throw new Error("override has invalid Pull Request");
    return pullRequest as unknown as PullRequestRecord;
  });
}

function recoveredHandoff(intent: PublicationIntent): VerifiedHandoff {
  const value = intent.completionEvidence;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(
      `Delivery Ticket ${intent.ticket} has invalid completion evidence`,
    );
  const handoff = value as Partial<VerifiedHandoff>;
  const completedHead =
    handoff.commits?.at(-1)?.sha ??
    (handoff.verification === "operator_override" ? handoff.base : undefined);
  if (
    handoff.ticket !== intent.ticket ||
    handoff.branch !== intent.stableBranch ||
    handoff.base !== intent.originalBase ||
    !Array.isArray(handoff.commits) ||
    completedHead !== intent.intendedHeadSha ||
    handoff.prTitle !== intent.title ||
    handoff.prBody !== intent.body
  )
    throw new Error(
      `Delivery Ticket ${intent.ticket} has inconsistent completion evidence`,
    );
  return handoff as VerifiedHandoff;
}

async function pauseRecoveredPublication(
  input: PublicationInput,
  intent: PublicationIntent,
  reason: string,
): Promise<void> {
  await pauseForOperator(
    input.audit,
    input.event(
      "publication_recovery",
      "inconsistent_remote_state",
      `ticket:${intent.ticket}`,
    )(1),
    input.operator,
    `${reason}. Resolve the remote state, then restart the Run, or q to cancel.`,
  );
}

export async function recoverPublishedHandoffs(
  input: PublicationInput,
  intents: PublicationIntent[],
): Promise<RecoveredPublicationResult> {
  const published: PublishedHandoff[] = [];
  const restarted: number[] = [];
  for (const intent of intents) {
    const handoff = recoveredHandoff(intent);
    if (intent.kind === "maintenance") {
      await pauseRecoveredPublication(
        input,
        intent,
        "unfinished Documentation Maintenance requires maintenance recovery",
      );
      return {
        outcome: "incomplete",
        reasons: ["unfinished Documentation Maintenance is still pending"],
        pullRequests: [],
        published: [],
        restarted,
      };
    }
    if (intent.targetBranch !== input.targetBranch) {
      await pauseRecoveredPublication(
        input,
        intent,
        `persisted Target Branch ${intent.targetBranch} does not match ${input.targetBranch}`,
      );
      return {
        outcome: "incomplete",
        reasons: ["publication recovery requires Operator Pause"],
        pullRequests: published.map(({ observation }) => observation),
        published,
        restarted,
      };
    }
    const boundary = await revalidateActiveTicket(input, intent.ticket);
    if (boundary.outcome !== "ready")
      return { ...stopped(boundary, [], published), restarted };
    const readRemoteHead = () =>
      externalRead({
        action: () =>
          input.codeHost.getRemoteBranchHead(
            input.repository,
            intent.stableBranch,
          ),
        parseOverride: remoteHeadOverride,
        audit: input.audit,
        event: input.event(
          "publication_recovery",
          "remote_branch_head",
          `branch:${intent.stableBranch}`,
        ),
        clock: input.clock,
        operator: input.operator,
      });
    const remoteHead = await readRemoteHead();
    const pendingRepair = intent.repairState?.pendingPush;
    const push =
      pendingRepair === undefined && intent.repairState?.head === undefined
        ? reconcileInitialPush(intent, remoteHead)
        : remoteHead === (pendingRepair ?? intent.repairState?.head) ||
            (pendingRepair !== undefined &&
              remoteHead === intent.repairState?.base)
          ? {
              outcome: "adopt" as const,
              reason: "repair push can be reconciled",
            }
          : {
              outcome: "pause" as const,
              reason: "repair branch advanced while a repair push was pending",
            };
    if (push.outcome === "restart" && intent.phase === "pending_push") {
      await input.persistPublication?.(intent.ticket, null);
      restarted.push(intent.ticket);
      continue;
    }
    if (push.outcome !== "adopt") {
      await pauseRecoveredPublication(input, intent, push.reason);
      return {
        outcome: "incomplete",
        reasons: [push.reason],
        pullRequests: published.map(({ observation }) => observation),
        published,
        restarted,
      };
    }
    let pullRequest: PullRequestIdentity;
    let merged = false;
    if (intent.phase === "pr_created") {
      pullRequest = intent.pullRequest!;
    } else {
      if (intent.phase === "pending_push") {
        await input.persistPublication?.(intent.ticket, {
          ...intent,
          phase: "pushed",
        });
      }
      const candidates = await externalRead({
        action: () => input.codeHost.listPullRequests(input.repository),
        parseOverride: pullRequestsOverride,
        audit: input.audit,
        event: input.event(
          "publication_recovery",
          "list_pull_requests",
          `ticket:${intent.ticket}`,
        ),
        clock: input.clock,
        operator: input.operator,
      });
      const reconciliation = reconcilePullRequest(intent, candidates);
      if (reconciliation.outcome === "restart") {
        if ((await readRemoteHead()) !== intent.intendedHeadSha) {
          await pauseRecoveredPublication(
            input,
            intent,
            "remote branch changed before Pull Request creation",
          );
          return {
            outcome: "incomplete",
            reasons: ["remote branch changed before Pull Request creation"],
            pullRequests: published.map(({ observation }) => observation),
            published,
            restarted,
          };
        }
        await input.persistPublication?.(intent.ticket, {
          ...intent,
          phase: "pending_pr",
        });
        pullRequest = await workflowWrite({
          action: () =>
            input.codeHost.createPullRequest({
              repository: input.repository,
              targetBranch: intent.targetBranch,
              branch: intent.stableBranch,
              title: intent.title,
              body: intent.body,
            }),
          parseOverride: pullRequestOverride,
          audit: input.audit,
          event: () =>
            input.event(
              "publication_recovery",
              "create_pull_request",
              `ticket:${intent.ticket}`,
            )(1),
          operator: input.operator,
        });
      } else if (reconciliation.outcome === "adopt") {
        pullRequest = reconciliation.pullRequest;
        merged = reconciliation.pullRequest.state === "merged";
      } else {
        await pauseRecoveredPublication(input, intent, reconciliation.reason);
        return {
          outcome: "incomplete",
          reasons: [reconciliation.reason],
          pullRequests: published.map(({ observation }) => observation),
          published,
          restarted,
        };
      }
    }
    const recordedHead = intent.repairState?.head ?? intent.intendedHeadSha;
    await input.persistPublication?.(intent.ticket, {
      ...intent,
      phase: "pr_created",
      pullRequest: { ...pullRequest, headSha: recordedHead },
    });
    input.publicationIntents?.set(intent.ticket, {
      ...intent,
      phase: "pr_created",
      pullRequest: { ...pullRequest, headSha: recordedHead },
    });
    if (intent.repairState?.pendingPush) {
      const repairHead = await readRemoteHead();
      if (
        repairHead !== intent.repairState.pendingPush &&
        repairHead !== intent.repairState.base
      ) {
        await pauseRecoveredPublication(
          input,
          intent,
          "repair branch advanced while a repair push was pending",
        );
        return {
          outcome: "incomplete",
          reasons: ["repair push cannot be reconciled automatically"],
          pullRequests: published.map(({ observation }) => observation),
          published,
          restarted,
        };
      }
      if (repairHead === intent.repairState.base) {
        await pauseRecoveredPublication(
          input,
          intent,
          "pending repair push was not observed on the stable branch",
        );
        return {
          outcome: "incomplete",
          reasons: ["pending repair push requires retry"],
          pullRequests: published.map(({ observation }) => observation),
          published,
          restarted,
        };
      }
      const repairState = { ...intent.repairState };
      delete repairState.pendingPush;
      const repairedIntent = {
        ...intent,
        repairState: {
          ...repairState,
          ...(repairHead === intent.repairState.pendingPush
            ? { head: repairHead }
            : {}),
        },
        pullRequest: { ...pullRequest, headSha: repairHead },
      };
      await input.persistPublication?.(intent.ticket, repairedIntent);
      input.publicationIntents?.set(intent.ticket, repairedIntent);
      pullRequest = repairedIntent.pullRequest;
    }
    const readiness = merged
      ? { readiness: "ready" as const, failedChecks: [] }
      : await observeRequiredChecks(input, handoff, pullRequest);
    if ("outcome" in readiness)
      return { ...stopped(readiness, [], published), restarted };
    published.push({
      handoff,
      pullRequest,
      observation: {
        ticket: intent.ticket,
        branch: intent.stableBranch,
        ...pullRequest,
        ...readiness,
      },
    });
  }
  return {
    outcome: "succeeded",
    reasons: [],
    pullRequests: published.map(({ observation }) => observation),
    published,
    restarted,
  };
}

function stopped(
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

async function freshRepairHandoff(
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

async function waitForMerge(
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

class DeliveryBoundaryChanged extends Error {
  readonly boundary: ChangedAfterMerge;

  constructor(boundary: ChangedAfterMerge) {
    super("Delivery Ticket changed before operation retry");
    this.boundary = boundary;
  }
}

class ReservedBoundaryChanged extends Error {
  readonly boundary: Exclude<DeliveryBoundaryResult, { outcome: "ready" }>;

  constructor(boundary: Exclude<DeliveryBoundaryResult, { outcome: "ready" }>) {
    super("Delivery Ticket changed before operation retry");
    this.boundary = boundary;
  }
}

async function pushRepair(
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

async function confirmCompletion(
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

export async function integratePullRequest(
  input: PublicationInput,
  handoff: VerifiedHandoff,
  pullRequest: PullRequestIdentity,
  observed: PullRequestState,
): Promise<
  | { outcome: "completed"; ticket: Ticket }
  | Exclude<DeliveryBoundaryResult, { outcome: "ready" }>
> {
  const conflictBudget = { consumed: 0, generation: 0, attempts: { value: 0 } };
  let current = observed;
  for (;;) {
    const boundary = await revalidateActiveTicket(input, handoff.ticket);
    if (boundary.outcome !== "ready") return boundary;
    if (current.merged) return confirmCompletion(input, handoff);
    let request: MergeRequestResult;
    try {
      request = await workflowWrite<MergeRequestResult>({
        action: async () => {
          const result = await input.codeHost.requestSquashMerge({
            repository: input.repository,
            pullRequest: pullRequest.number,
            headSha: current.headSha,
            admin: input.adminMerge,
          });
          if (result.outcome === "rejected") throw new Error(result.error);
          return result;
        },
        parseOverride: () => ({ outcome: "accepted" }),
        beforeRetry: async () => {
          const changed = await revalidateActiveTicket(input, handoff.ticket);
          if (changed.outcome !== "ready") {
            throw new DeliveryBoundaryChanged(changed);
          }
        },
        audit: input.audit,
        event: () =>
          input.event(
            "merge",
            "request_squash_merge",
            `pull_request:${pullRequest.number}`,
          )(1),
        operator: input.operator,
      });
    } catch (error) {
      if (!(error instanceof DeliveryBoundaryChanged)) throw error;
      return error.boundary.outcome === "terminal"
        ? {
            outcome: "stopped",
            reason: `${input.ticketKind ?? "Delivery Ticket"} ${handoff.ticket} became terminal`,
          }
        : error.boundary;
    }
    if (request.outcome === "conflict") {
      const repair = await repairMergeConflict(
        input,
        handoff,
        pullRequest,
        request.error,
        conflictBudget,
      );
      if ("outcome" in repair) return repair;
      current = repair.state;
      continue;
    }
    const confirmation = await waitForMerge(input, handoff, pullRequest);
    if (confirmation !== "merged") return confirmation;
    return confirmCompletion(input, handoff);
  }
}

function pullRequestOverride(value: string): PullRequestIdentity {
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

function requiredChecksOverride(value: string): RequiredCheck[] {
  return parseRequiredChecks(
    JSON.parse(value) as unknown,
    "override has invalid required-check evidence",
  );
}

function checkResult(
  checks: RequiredCheck[],
):
  | { readiness: "ready"; failedChecks: [] }
  | { readiness: "pending"; failedChecks: [] }
  | { readiness: "failed"; failedChecks: RequiredCheck[] } {
  const failedChecks = checks.filter(
    ({ bucket }) => bucket === "fail" || bucket === "cancel",
  );
  if (failedChecks.length > 0) return { readiness: "failed", failedChecks };
  if (checks.some(({ bucket }) => bucket === "pending"))
    return { readiness: "pending", failedChecks: [] };
  return { readiness: "ready", failedChecks: [] };
}

export async function observeRequiredChecks(
  input: ReadinessInput,
  handoff: VerifiedHandoff,
  pullRequest: PullRequestIdentity,
): Promise<
  | Pick<PullRequestObservation, "readiness" | "failedChecks">
  | Exclude<DeliveryBoundaryResult, { outcome: "ready" }>
> {
  await input.clock.sleep(30_000);
  for (;;) {
    const deadline =
      input.clock.now().getTime() + input.requiredChecksTimeoutMs;
    for (;;) {
      const boundary = await revalidateActiveTicket(input, handoff.ticket);
      if (boundary.outcome !== "ready") return boundary;
      const checks = await externalRead({
        action: () =>
          input.codeHost.getRequiredChecks(
            input.repository,
            pullRequest.number,
          ),
        parseOverride: requiredChecksOverride,
        audit: input.audit,
        event: input.event(
          "ci_wait",
          "required_checks",
          `pull_request:${pullRequest.number}`,
        ),
        clock: input.clock,
        operator: input.operator,
      });
      const result = checkResult(checks);
      if (result.readiness !== "pending") return result;
      const remaining = deadline - input.clock.now().getTime();
      if (remaining <= 0) break;
      await input.clock.sleep(Math.min(10_000, remaining));
    }

    const event = input.event(
      "ci_wait",
      "required_checks_timeout",
      `pull_request:${pullRequest.number}`,
    )(1);
    const response = await pauseForOperator(
      input.audit,
      event,
      input.operator,
      "Required checks timed out. Enter to retry, q to cancel, or acknowledge trusted readiness.",
    );
    if (response === "") continue;
    const boundary = await revalidateActiveTicket(input, handoff.ticket);
    if (boundary.outcome !== "ready") return boundary;
    await recordOperatorOverride(input.audit, event, input.operator);
    return { readiness: "ready", failedChecks: [] };
  }
}

async function repairRequiredChecks(
  input: PublicationInput,
  handoff: VerifiedHandoff,
  pullRequest: PullRequestIdentity,
  initialFailedChecks: RequiredCheck[],
  signal: AbortSignal,
): Promise<
  | Pick<PullRequestObservation, "readiness" | "failedChecks">
  | Exclude<DeliveryBoundaryResult, { outcome: "ready" }>
> {
  let failedChecks = initialFailedChecks;
  const budget = input.ciRepairBudgets.get(handoff.ticket) ?? {
    consumed: 0,
    generation: 0,
    attempts: { value: 0 },
  };
  const persisted = input.publicationIntents?.get(handoff.ticket)?.repairState;
  if (persisted) {
    budget.consumed = persisted.consumed;
    budget.generation = persisted.generation;
    budget.attempts.value = persisted.attempt;
  }
  input.ciRepairBudgets.set(handoff.ticket, budget);
  for (;;) {
    while (budget.consumed < 2) {
      const pullRequestState = await observePullRequestForIntegration(
        input,
        pullRequest.number,
        "ci_repair",
      );
      if (pullRequestState.merged)
        return { readiness: "ready", failedChecks: [] };
      const preparedRepair = await freshRepairHandoff(input, handoff, "ci");
      const repairHandoff =
        preparedRepair === handoff
          ? { ...handoff, base: pullRequestState.headSha }
          : preparedRepair;
      const attemptId = randomUUID();
      await repairIntent(input, handoff.ticket, {
        consumed: budget.consumed,
        generation: budget.generation,
        attempt: budget.attempts.value,
        base: repairHandoff.base,
        worktree: repairHandoff.worktree,
        branch: repairHandoff.branch,
        attemptId,
      });
      const repair = await runCiRepairAttempt({
        ...input,
        handoff: repairHandoff,
        base: repairHandoff.base,
        pullRequest,
        failedChecks,
        promptFile: input.ciRepairPrompt,
        agent: input.ciRepairAgent,
        timeoutMs: input.agentTimeoutMs,
        signal,
        attemptCounter: budget.attempts,
      });
      if (repair.outcome === "boundary") return repair.boundary;
      budget.consumed += 1;
      await repairIntent(input, handoff.ticket, {
        consumed: budget.consumed,
        generation: budget.generation,
        attempt: budget.attempts.value,
        base: repairHandoff.base,
        worktree: repairHandoff.worktree,
        branch: repairHandoff.branch,
        attemptId,
      });
      if (repair.outcome === "consumed") continue;

      const currentPullRequestState = await observePullRequestForIntegration(
        input,
        pullRequest.number,
        "ci_repair",
      );
      if (currentPullRequestState.merged)
        return { readiness: "ready", failedChecks: [] };
      if (repair.outcome === "handoff") {
        await repairIntent(input, handoff.ticket, {
          consumed: budget.consumed,
          generation: budget.generation,
          attempt: budget.attempts.value,
          base: repair.handoff.base,
          worktree: repair.handoff.worktree,
          branch: repair.handoff.branch,
          attemptId,
          ...(repair.handoff.commits.at(-1)?.sha === undefined
            ? {}
            : { pendingPush: repair.handoff.commits.at(-1)!.sha }),
        });
      }
      const boundary = await pushRepair(
        input,
        repair.handoff,
        pullRequest,
        "ci_repair",
        budget.consumed,
      );
      if (boundary) return boundary;
      await repairIntent(input, handoff.ticket, {
        consumed: budget.consumed,
        generation: budget.generation,
        attempt: budget.attempts.value,
        ...(repair.handoff.commits.at(-1)?.sha === undefined
          ? {}
          : { head: repair.handoff.commits.at(-1)!.sha }),
        pendingPush: null,
      });
      const readiness = await observeRequiredChecks(
        input,
        repair.handoff,
        pullRequest,
      );
      if ("outcome" in readiness || readiness.readiness === "ready") {
        return readiness;
      }
      failedChecks = readiness.failedChecks;
    }

    const event = input.event(
      "ci_repair",
      "repair_budget_exhausted",
      `pull_request:${pullRequest.number}`,
    )(budget.consumed);
    const response = await pauseForOperator(
      input.audit,
      event,
      input.operator,
      "CI repair failed after two attempts. Enter to start a fresh repair budget, q to cancel, or acknowledge trusted readiness.",
    );
    if (response === "") {
      budget.consumed = 0;
      budget.generation += 1;
      await repairIntent(input, handoff.ticket, {
        consumed: 0,
        generation: budget.generation,
        attempt: budget.attempts.value,
      });
      continue;
    }
    const boundary = await revalidateActiveTicket(input, handoff.ticket);
    if (boundary.outcome !== "ready") return boundary;
    await recordOperatorOverride(input.audit, event, input.operator);
    return { readiness: "ready", failedChecks: [] };
  }
}

async function repairMergeConflict(
  input: PublicationInput,
  handoff: VerifiedHandoff,
  pullRequest: PullRequestIdentity,
  conflict: string,
  budget: RepairBudget,
): Promise<
  | { state: PullRequestState }
  | Exclude<DeliveryBoundaryResult, { outcome: "ready" }>
> {
  const controller = new AbortController();
  for (;;) {
    while (budget.consumed < 2) {
      const beforeRepair = await revalidateActiveTicket(input, handoff.ticket);
      if (beforeRepair.outcome !== "ready") return beforeRepair;
      const state = await observePullRequestForIntegration(
        input,
        pullRequest.number,
        "conflict_repair",
      );
      if (state.merged) return { state };
      const targetBase = await externalRead({
        action: () =>
          input.gitWorkspace.fetchTargetBranch(
            input.checkout,
            input.targetBranch,
          ),
        parseOverride: (value) => {
          const parsed = JSON.parse(value) as { base?: unknown };
          if (
            typeof parsed.base !== "string" ||
            !/^[0-9a-f]{40,64}$/u.test(parsed.base)
          ) {
            throw new Error("override has no full Target Branch SHA");
          }
          return parsed.base;
        },
        audit: input.audit,
        event: input.event(
          "conflict_repair",
          "fetch_target_branch",
          input.targetBranch,
        ),
        clock: input.clock,
        operator: input.operator,
      });
      const preparedRepair = await freshRepairHandoff(
        input,
        handoff,
        "conflict",
      );
      const repairHandoff =
        preparedRepair === handoff
          ? { ...handoff, base: state.headSha }
          : preparedRepair;
      const attemptId = randomUUID();
      await repairIntent(input, handoff.ticket, {
        consumed: budget.consumed,
        generation: budget.generation,
        attempt: budget.attempts.value,
        base: repairHandoff.base,
        worktree: repairHandoff.worktree,
        branch: repairHandoff.branch,
        attemptId,
      });
      const repair = await runConflictRepairAttempt({
        ...input,
        handoff: repairHandoff,
        base: repairHandoff.base,
        targetBase,
        pullRequest,
        conflict,
        promptFile: input.conflictRepairPrompt,
        agent: input.conflictRepairAgent,
        timeoutMs: input.agentTimeoutMs,
        signal: controller.signal,
        attemptCounter: budget.attempts,
      });
      if (repair.outcome === "boundary") return repair.boundary;
      budget.consumed += 1;
      await repairIntent(input, handoff.ticket, {
        consumed: budget.consumed,
        generation: budget.generation,
        attempt: budget.attempts.value,
        base: repairHandoff.base,
        worktree: repairHandoff.worktree,
        branch: repairHandoff.branch,
        attemptId,
      });
      if (repair.outcome === "consumed") continue;

      const current = await observePullRequestForIntegration(
        input,
        pullRequest.number,
        "conflict_repair",
      );
      if (current.merged) return { state: current };
      const boundary = await pushRepair(
        input,
        repair.handoff,
        pullRequest,
        "conflict_repair",
        budget.consumed,
      );
      if (boundary) return boundary;
      await repairIntent(input, handoff.ticket, {
        consumed: budget.consumed,
        generation: budget.generation,
        attempt: budget.attempts.value,
        ...(repair.handoff.commits.at(-1)?.sha === undefined
          ? {}
          : { head: repair.handoff.commits.at(-1)!.sha }),
        pendingPush: null,
      });
      let readiness = await observeRequiredChecks(
        input,
        repair.handoff,
        pullRequest,
      );
      if (!("outcome" in readiness) && readiness.readiness === "failed") {
        readiness = await repairRequiredChecks(
          input,
          repair.handoff,
          pullRequest,
          readiness.failedChecks,
          controller.signal,
        );
      }
      if ("outcome" in readiness) return readiness;
      if (readiness.readiness === "ready") {
        return {
          state: await observePullRequestForIntegration(
            input,
            pullRequest.number,
            "conflict_repair",
          ),
        };
      }
    }

    const event = input.event(
      "conflict_repair",
      "repair_budget_exhausted",
      `pull_request:${pullRequest.number}`,
    )(budget.consumed);
    const response = await pauseForOperator(
      input.audit,
      event,
      input.operator,
      "Conflict repair failed after two attempts. Enter to start a fresh repair budget, q to cancel, or acknowledge a trusted repair.",
    );
    if (response === "") {
      budget.consumed = 0;
      budget.generation += 1;
      await repairIntent(input, handoff.ticket, {
        consumed: 0,
        generation: budget.generation,
        attempt: budget.attempts.value,
      });
      continue;
    }
    const boundary = await revalidateActiveTicket(input, handoff.ticket);
    if (boundary.outcome !== "ready") return boundary;
    await recordOperatorOverride(input.audit, event, input.operator);
    let readiness = await observeRequiredChecks(input, handoff, pullRequest);
    if (!("outcome" in readiness) && readiness.readiness === "failed") {
      readiness = await repairRequiredChecks(
        input,
        handoff,
        pullRequest,
        readiness.failedChecks,
        controller.signal,
      );
    }
    if ("outcome" in readiness) return readiness;
    return {
      state: await observePullRequestForIntegration(
        input,
        pullRequest.number,
        "conflict_repair",
      ),
    };
  }
}

export async function publishVerifiedHandoffs(
  input: PublicationInput,
): Promise<PublicationResult> {
  const controller = new AbortController();
  const concurrentInput = {
    ...input,
    operator: serializeOperator(input.operator, controller),
  };
  interface PublicationAttempt {
    published?: PublishedHandoff;
    boundary?: Exclude<DeliveryBoundaryResult, { outcome: "ready" }>;
  }
  const publications = input.handoffs.map(
    async (handoff): Promise<PublicationAttempt> => {
      let boundary = await revalidateActiveTicket(
        concurrentInput,
        handoff.ticket,
      );
      if (boundary.outcome !== "ready") return { boundary };
      const intent: PublicationIntent = {
        ticket: handoff.ticket,
        kind:
          input.ticketKind === "Maintenance Ticket"
            ? "maintenance"
            : "delivery",
        originalBase: handoff.base,
        targetBranch: input.targetBranch,
        stableBranch: handoff.branch,
        intendedHeadSha:
          handoff.commits.at(-1)?.sha ??
          handoff.implementationCommits?.at(-1)?.sha ??
          handoff.base,
        title: handoff.prTitle,
        body: handoff.prBody,
        phase: "pending_push",
        implementationEvidence:
          handoff.implementationCommits ?? handoff.commits,
        reviewEvidence: handoff.reviewCommits ?? [],
        completionEvidence: handoff,
      };
      input.publicationIntents?.set(handoff.ticket, intent);
      await input.persistPublication?.(handoff.ticket, intent);
      await workflowWrite({
        action: () => input.gitWorkspace.push(handoff.worktree, handoff.branch),
        audit: input.audit,
        event: () =>
          input.event("publish", "push_branch", `ticket:${handoff.ticket}`)(1),
        operator: concurrentInput.operator,
      });
      await input.persistPublication?.(handoff.ticket, {
        ...intent,
        phase: "pushed",
      });
      input.publicationIntents?.set(handoff.ticket, {
        ...intent,
        phase: "pushed",
      });

      boundary = await revalidateActiveTicket(concurrentInput, handoff.ticket);
      if (boundary.outcome !== "ready") return { boundary };
      await input.persistPublication?.(handoff.ticket, {
        ...intent,
        phase: "pending_pr",
      });
      input.publicationIntents?.set(handoff.ticket, {
        ...intent,
        phase: "pending_pr",
      });
      const pullRequest = await workflowWrite({
        action: () =>
          input.codeHost.createPullRequest({
            repository: input.repository,
            targetBranch: input.targetBranch,
            branch: handoff.branch,
            title: handoff.prTitle,
            body: handoff.prBody,
          }),
        parseOverride: pullRequestOverride,
        audit: input.audit,
        event: () =>
          input.event(
            "publish",
            "create_pull_request",
            `ticket:${handoff.ticket}`,
          )(1),
        operator: concurrentInput.operator,
      });
      await input.persistPublication?.(handoff.ticket, {
        ...intent,
        phase: "pr_created",
        pullRequest: {
          ...pullRequest,
          headSha: intent.intendedHeadSha,
        },
      });
      let readiness = await observeRequiredChecks(
        concurrentInput,
        handoff,
        pullRequest,
      );
      if (!("outcome" in readiness) && readiness.readiness === "failed") {
        readiness = await repairRequiredChecks(
          concurrentInput,
          handoff,
          pullRequest,
          readiness.failedChecks,
          controller.signal,
        );
      }
      if ("outcome" in readiness) {
        return {
          boundary: readiness,
          published: {
            handoff,
            pullRequest,
            observation: {
              ticket: handoff.ticket,
              branch: handoff.branch,
              ...pullRequest,
              readiness: "stopped",
              failedChecks: [],
            },
          },
        };
      }
      return {
        published: {
          handoff,
          pullRequest,
          observation: {
            ticket: handoff.ticket,
            branch: handoff.branch,
            ...pullRequest,
            ...readiness,
          },
        },
      };
    },
  );
  let published: Awaited<(typeof publications)[number]>[];
  try {
    published = await Promise.all(publications);
  } catch (error) {
    controller.abort(error);
    await Promise.allSettled(publications);
    throw error;
  }
  const publishedHandoffs = published.flatMap(({ published }) =>
    published ? [published] : [],
  );
  const pullRequests = publishedHandoffs.map(({ observation }) => observation);
  const changed = published.find(({ boundary }) => boundary)?.boundary;
  if (changed) return stopped(changed, pullRequests, publishedHandoffs);
  const failed = publishedHandoffs.filter(
    ({ observation }) => observation.readiness === "failed",
  );
  return {
    outcome: "succeeded",
    reasons: failed.map(
      ({ observation }) =>
        `Required checks failed for Pull Request ${observation.number}: ${observation.failedChecks
          .map(({ name, state }) => `${name} (${state})`)
          .join(", ")}`,
    ),
    pullRequests,
    published: publishedHandoffs,
  };
}
