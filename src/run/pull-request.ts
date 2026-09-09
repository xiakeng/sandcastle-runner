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
}

interface RepairBudget {
  consumed: number;
  attempts: { value: number };
}

export interface PublicationResult {
  outcome: "succeeded" | "incomplete" | "cancelled" | "failed";
  reasons: string[];
  pullRequests: PullRequestObservation[];
  published: PublishedHandoff[];
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
  try {
    await workflowWrite({
      action: () => input.gitWorkspace.push(handoff.worktree, handoff.branch),
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
  const conflictBudget = { consumed: 0, attempts: { value: 0 } };
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
    attempts: { value: 0 },
  };
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
      const repair = await runCiRepairAttempt({
        ...input,
        handoff,
        base: pullRequestState.headSha,
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
      if (repair.outcome === "consumed") continue;

      const currentPullRequestState = await observePullRequestForIntegration(
        input,
        pullRequest.number,
        "ci_repair",
      );
      if (currentPullRequestState.merged)
        return { readiness: "ready", failedChecks: [] };
      const boundary = await pushRepair(
        input,
        handoff,
        pullRequest,
        "ci_repair",
        budget.consumed,
      );
      if (boundary) return boundary;
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
      const repair = await runConflictRepairAttempt({
        ...input,
        handoff,
        base: state.headSha,
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
      if (repair.outcome === "consumed") continue;

      const current = await observePullRequestForIntegration(
        input,
        pullRequest.number,
        "conflict_repair",
      );
      if (current.merged) return { state: current };
      const boundary = await pushRepair(
        input,
        handoff,
        pullRequest,
        "conflict_repair",
        budget.consumed,
      );
      if (boundary) return boundary;
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
      await workflowWrite({
        action: () => input.gitWorkspace.push(handoff.worktree, handoff.branch),
        audit: input.audit,
        event: () =>
          input.event("publish", "push_branch", `ticket:${handoff.ticket}`)(1),
        operator: concurrentInput.operator,
      });

      boundary = await revalidateActiveTicket(concurrentInput, handoff.ticket);
      if (boundary.outcome !== "ready") return { boundary };
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
