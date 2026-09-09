import type { VerifiedHandoff } from "./attempt.ts";
import type {
  CodeHost,
  GitWorkspace,
  PullRequestIdentity,
  RequiredCheck,
} from "./contracts.ts";
import {
  type DeliveryBoundaryResult,
  type DiscoveryInput,
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
}

export interface PublicationResult {
  outcome: "incomplete" | "cancelled" | "failed";
  reasons: string[];
  pullRequests: PullRequestObservation[];
}

function stopped(
  result: Exclude<DeliveryBoundaryResult, { outcome: "ready" }>,
  pullRequests: PullRequestObservation[],
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
  };
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
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed))
    throw new Error("override has no required checks");
  return parsed.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      throw new Error("override has invalid required-check evidence");
    const check = item as Record<string, unknown>;
    if (
      typeof check.name !== "string" ||
      typeof check.state !== "string" ||
      typeof check.link !== "string" ||
      !["pass", "fail", "pending", "skipping", "cancel"].includes(
        String(check.bucket),
      )
    ) {
      throw new Error("override has invalid required-check evidence");
    }
    return {
      name: check.name,
      state: check.state,
      link: check.link,
      bucket: check.bucket as RequiredCheck["bucket"],
    };
  });
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
  for (;;) {
    await input.clock.sleep(30_000);
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
  const reasons: string[] = [];
  for (const handoff of input.handoffs) {
    let boundary = await revalidateReservedDeliveryTicket(
      input,
      handoff.ticket,
    );
    if (boundary.outcome !== "ready") return stopped(boundary, pullRequests);
    await workflowWrite({
      action: () => input.gitWorkspace.push(handoff.worktree, handoff.branch),
      audit: input.audit,
      event: () =>
        input.event("publish", "push_branch", `ticket:${handoff.ticket}`)(1),
      operator: input.operator,
    });

    boundary = await revalidateReservedDeliveryTicket(input, handoff.ticket);
    if (boundary.outcome !== "ready") return stopped(boundary, pullRequests);
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
    if ("outcome" in readiness) return stopped(readiness, pullRequests);
    const observation = {
      ticket: handoff.ticket,
      branch: handoff.branch,
      ...pullRequest,
      ...readiness,
    };
    pullRequests.push(observation);
    reasons.push(
      readiness.readiness === "ready"
        ? `CI-ready Pull Request ${pullRequest.number} for Delivery Ticket ${handoff.ticket}`
        : `Required checks failed for Pull Request ${pullRequest.number}: ${readiness.failedChecks
            .map(({ name, state }) => `${name} (${state})`)
            .join(", ")}`,
    );
  }
  return { outcome: "incomplete", reasons, pullRequests };
}
