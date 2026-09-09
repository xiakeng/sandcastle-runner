import type { VerifiedHandoff } from "./attempt.ts";
import type {
  CodeHost,
  GitWorkspace,
  MergeRequestResult,
  PullRequestIdentity,
  PullRequestState,
  RequiredCheck,
} from "./contracts.ts";
import { parseRequiredChecks } from "./contracts.ts";
import {
  type DeliveryBoundaryResult,
  type DiscoveryInput,
  revalidateMergedDeliveryTicket,
  revalidateReservedDeliveryTicket,
} from "./discovery.ts";
import {
  externalRead,
  pauseForOperator,
  recordOperatorOverride,
  workflowWrite,
} from "./operations.ts";

export interface PullRequestObservation extends PullRequestIdentity {
  ticket: number;
  branch: string;
  readiness: "ready" | "failed";
  failedChecks: RequiredCheck[];
}

export interface ReadinessInput extends DiscoveryInput {
  requiredChecksTimeoutMs: number;
  codeHost: CodeHost;
}

interface PublicationInput extends ReadinessInput {
  targetBranch: string;
  handoffs: VerifiedHandoff[];
  gitWorkspace: GitWorkspace;
  adminMerge: boolean;
  mergeQueueTimeoutMs: number;
  ticketClosure: "runner" | "code_host";
}

export interface PublicationResult {
  outcome: "incomplete" | "cancelled" | "failed";
  reasons: string[];
  pullRequests: PullRequestObservation[];
  completedTickets: number[];
}

function stopped(
  result: Exclude<DeliveryBoundaryResult, { outcome: "ready" }>,
  pullRequests: PullRequestObservation[],
  completedTickets: number[],
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
    completedTickets,
  };
}

function pullRequestStateOverride(value: string): PullRequestState {
  const parsed = JSON.parse(value) as Partial<PullRequestState>;
  if (
    typeof parsed.headSha !== "string" ||
    parsed.headSha.length === 0 ||
    typeof parsed.merged !== "boolean" ||
    (parsed.mergeFailure !== null && typeof parsed.mergeFailure !== "string")
  ) {
    throw new Error("override has invalid Pull Request state");
  }
  return {
    headSha: parsed.headSha,
    merged: parsed.merged,
    mergeFailure: parsed.mergeFailure ?? null,
  };
}

async function readPullRequest(
  input: PublicationInput,
  pullRequest: number,
): Promise<PullRequestState> {
  return externalRead({
    action: () => input.codeHost.getPullRequest(input.repository, pullRequest),
    parseOverride: pullRequestStateOverride,
    audit: input.audit,
    event: input.event(
      "merge_wait",
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
): Promise<
  "merged" | "retry" | Exclude<DeliveryBoundaryResult, { outcome: "ready" }>
> {
  const deadline = input.clock.now().getTime() + input.mergeQueueTimeoutMs;
  for (;;) {
    const state = await readPullRequest(input, pullRequest.number);
    if (state.merged) return "merged";
    const boundary = await revalidateReservedDeliveryTicket(
      input,
      handoff.ticket,
    );
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
    if (response === "") return "retry";
    const afterOverride = await revalidateMergedDeliveryTicket(
      input,
      handoff.ticket,
    );
    if (
      afterOverride.outcome !== "ready" &&
      !(
        afterOverride.outcome === "terminal" &&
        afterOverride.stateReason === "completed"
      )
    ) {
      return afterOverride.outcome === "terminal"
        ? {
            outcome: "stopped",
            reason: `Delivery Ticket ${handoff.ticket} was cancelled after merge`,
          }
        : afterOverride;
    }
    await recordOperatorOverride(input.audit, event, input.operator);
    return "merged";
  }
}

async function confirmCompletion(
  input: PublicationInput,
  handoff: VerifiedHandoff,
): Promise<
  "completed" | Exclude<DeliveryBoundaryResult, { outcome: "ready" }>
> {
  for (;;) {
    if (input.ticketClosure === "code_host") await input.clock.sleep(10_000);
    let boundary = await revalidateMergedDeliveryTicket(input, handoff.ticket);
    if (boundary.outcome === "terminal") {
      return boundary.stateReason === "completed"
        ? "completed"
        : {
            outcome: "stopped",
            reason: `Delivery Ticket ${handoff.ticket} was cancelled after merge`,
          };
    }
    if (boundary.outcome !== "ready") return boundary;

    if (input.ticketClosure === "runner") {
      await workflowWrite({
        action: () =>
          input.tracker.closeTicket(input.repository, handoff.ticket),
        audit: input.audit,
        event: () =>
          input.event(
            "ticket_closure",
            "close_ticket",
            `ticket:${handoff.ticket}`,
          )(1),
        operator: input.operator,
      });
    } else {
      await input.clock.sleep(30_000);
    }

    boundary = await revalidateMergedDeliveryTicket(input, handoff.ticket);
    if (boundary.outcome === "terminal") {
      return boundary.stateReason === "completed"
        ? "completed"
        : {
            outcome: "stopped",
            reason: `Delivery Ticket ${handoff.ticket} was cancelled after merge`,
          };
    }
    if (boundary.outcome !== "ready") return boundary;

    const event = input.event(
      "ticket_closure",
      "confirm_completed_ticket",
      `ticket:${handoff.ticket}`,
    )(1);
    const response = await pauseForOperator(
      input.audit,
      event,
      input.operator,
      `Merged Delivery Ticket ${handoff.ticket} is not closed as completed. Enter to retry, q to cancel, or acknowledge trusted completion.`,
    );
    if (response === "") continue;
    await recordOperatorOverride(input.audit, event, input.operator);
    return "completed";
  }
}

async function integratePullRequest(
  input: PublicationInput,
  handoff: VerifiedHandoff,
  pullRequest: PullRequestIdentity,
): Promise<
  | "completed"
  | { outcome: "conflict"; reason: string }
  | Exclude<DeliveryBoundaryResult, { outcome: "ready" }>
> {
  for (;;) {
    const boundary = await revalidateReservedDeliveryTicket(
      input,
      handoff.ticket,
    );
    if (boundary.outcome !== "ready") return boundary;
    const observed = await readPullRequest(input, pullRequest.number);
    if (!observed.merged) {
      const request = await workflowWrite<MergeRequestResult>({
        action: async () => {
          const result = await input.codeHost.requestSquashMerge({
            repository: input.repository,
            pullRequest: pullRequest.number,
            headSha: observed.headSha,
            admin: input.adminMerge,
          });
          if (result.outcome === "rejected") throw new Error(result.error);
          return result;
        },
        parseOverride: () => ({ outcome: "accepted" }),
        audit: input.audit,
        event: () =>
          input.event(
            "merge",
            "request_squash_merge",
            `pull_request:${pullRequest.number}`,
          )(1),
        operator: input.operator,
      });
      if (request.outcome === "conflict") {
        return {
          outcome: "conflict",
          reason: `Pull Request ${pullRequest.number} has merge conflicts: ${request.error}`,
        };
      }
      const confirmation = await waitForMerge(input, handoff, pullRequest);
      if (confirmation === "retry") continue;
      if (confirmation !== "merged") return confirmation;
    }
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
      const boundary = await revalidateReservedDeliveryTicket(
        input,
        handoff.ticket,
      );
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
    const boundary = await revalidateReservedDeliveryTicket(
      input,
      handoff.ticket,
    );
    if (boundary.outcome !== "ready") return boundary;
    await recordOperatorOverride(input.audit, event, input.operator);
    return { readiness: "ready", failedChecks: [] };
  }
}

export async function publishVerifiedHandoffs(
  input: PublicationInput,
): Promise<PublicationResult> {
  const pullRequests: PullRequestObservation[] = [];
  const completedTickets: number[] = [];
  const reasons: string[] = [];
  for (const handoff of input.handoffs) {
    let boundary = await revalidateReservedDeliveryTicket(
      input,
      handoff.ticket,
    );
    if (boundary.outcome !== "ready")
      return stopped(boundary, pullRequests, completedTickets);
    await workflowWrite({
      action: () => input.gitWorkspace.push(handoff.worktree, handoff.branch),
      audit: input.audit,
      event: () =>
        input.event("publish", "push_branch", `ticket:${handoff.ticket}`)(1),
      operator: input.operator,
    });

    boundary = await revalidateReservedDeliveryTicket(input, handoff.ticket);
    if (boundary.outcome !== "ready")
      return stopped(boundary, pullRequests, completedTickets);
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
      operator: input.operator,
    });
    const readiness = await observeRequiredChecks(input, handoff, pullRequest);
    if ("outcome" in readiness)
      return stopped(readiness, pullRequests, completedTickets);
    const observation = {
      ticket: handoff.ticket,
      branch: handoff.branch,
      ...pullRequest,
      ...readiness,
    };
    pullRequests.push(observation);
    if (readiness.readiness === "ready") {
      const integration = await integratePullRequest(
        input,
        handoff,
        pullRequest,
      );
      if (integration === "completed") {
        completedTickets.push(handoff.ticket);
      } else if (integration.outcome === "conflict") {
        return {
          outcome: "incomplete",
          reasons: [integration.reason],
          pullRequests,
          completedTickets,
        };
      } else {
        return stopped(integration, pullRequests, completedTickets);
      }
    }
    reasons.push(
      completedTickets.includes(handoff.ticket)
        ? `Completed Delivery Ticket ${handoff.ticket} through Pull Request ${pullRequest.number}`
        : `Required checks failed for Pull Request ${pullRequest.number}: ${readiness.failedChecks
            .map(({ name, state }) => `${name} (${state})`)
            .join(", ")}`,
    );
  }
  return { outcome: "incomplete", reasons, pullRequests, completedTickets };
}
