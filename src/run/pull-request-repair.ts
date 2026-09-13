import { randomUUID } from "node:crypto";
import {
  runCiRepairAttempt,
  runConflictRepairAttempt,
  type VerifiedHandoff,
} from "./attempt.ts";
import type {
  PullRequestIdentity,
  PullRequestState,
  RequiredCheck,
} from "./contracts.ts";
import { parseRequiredChecks } from "./contracts.ts";
import {
  type DeliveryBoundaryResult,
  revalidateActiveTicket,
} from "./discovery.ts";
import {
  externalRead,
  pauseForOperator,
  recordOperatorOverride,
} from "./operations.ts";
import {
  freshRepairHandoff,
  observePullRequestForIntegration,
  persistedBudget,
  pushRepair,
  repairIntent,
  type PublicationInput,
  type ReadinessInput,
  type PullRequestObservation,
  type RepairBudget,
} from "./pull-request-core.ts";

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

export async function repairRequiredChecks(
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
  const persisted = persistedBudget(input, handoff.ticket, "ci");
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
      await repairIntent(input, handoff.ticket, "ci", {
        consumed: budget.consumed,
        generation: budget.generation,
        attempt: budget.attempts.value + 1,
        base: repairHandoff.base,
        worktree: repairHandoff.worktree,
        branch: repairHandoff.branch,
        attemptId,
        pendingPush: null,
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
      await repairIntent(input, handoff.ticket, "ci", {
        consumed: budget.consumed,
        generation: budget.generation,
        attempt: budget.attempts.value,
        base: repairHandoff.base,
        worktree: repairHandoff.worktree,
        branch: repairHandoff.branch,
        attemptId,
        pendingPush: null,
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
        await repairIntent(input, handoff.ticket, "ci", {
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
      await repairIntent(input, handoff.ticket, "ci", {
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
      await repairIntent(input, handoff.ticket, "ci", {
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

export async function repairMergeConflict(
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
      await repairIntent(input, handoff.ticket, "conflict", {
        consumed: budget.consumed,
        generation: budget.generation,
        attempt: budget.attempts.value + 1,
        base: repairHandoff.base,
        worktree: repairHandoff.worktree,
        branch: repairHandoff.branch,
        attemptId,
        targetBase,
        pendingPush: null,
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
      await repairIntent(input, handoff.ticket, "conflict", {
        consumed: budget.consumed,
        generation: budget.generation,
        attempt: budget.attempts.value,
        base: repairHandoff.base,
        worktree: repairHandoff.worktree,
        branch: repairHandoff.branch,
        attemptId,
        targetBase,
        pendingPush: null,
      });
      if (repair.outcome === "consumed") continue;

      const current = await observePullRequestForIntegration(
        input,
        pullRequest.number,
        "conflict_repair",
      );
      if (current.merged) return { state: current };
      if (repair.outcome === "handoff") {
        await repairIntent(input, handoff.ticket, "conflict", {
          consumed: budget.consumed,
          generation: budget.generation,
          attempt: budget.attempts.value,
          base: repair.handoff.base,
          worktree: repair.handoff.worktree,
          branch: repair.handoff.branch,
          attemptId,
          targetBase,
          ...(repair.handoff.commits.at(-1)?.sha === undefined
            ? {}
            : { pendingPush: repair.handoff.commits.at(-1)!.sha }),
        });
      }
      const boundary = await pushRepair(
        input,
        repair.handoff,
        pullRequest,
        "conflict_repair",
        budget.consumed,
      );
      if (boundary) return boundary;
      await repairIntent(input, handoff.ticket, "conflict", {
        consumed: budget.consumed,
        generation: budget.generation,
        attempt: budget.attempts.value,
        ...(repair.handoff.commits.at(-1)?.sha === undefined
          ? {}
          : { head: repair.handoff.commits.at(-1)!.sha }),
        targetBase,
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
      await repairIntent(input, handoff.ticket, "conflict", {
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
