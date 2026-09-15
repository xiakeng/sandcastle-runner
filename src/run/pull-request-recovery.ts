import type { VerifiedHandoff } from "./attempt.ts";
import type { PullRequestIdentity, PullRequestRecord } from "./contracts.ts";
import {
  revalidateActiveTicket,
  revalidateStandaloneMaintenanceTicket,
} from "./discovery.ts";
import { externalRead, pauseForOperator, workflowWrite } from "./operations.ts";
import {
  reconcileInitialPush,
  reconcilePullRequest,
  type PublicationIntent,
} from "../recovery.ts";
import { observeRequiredChecks } from "./pull-request-repair.ts";
import {
  pullRequestOverride,
  stopped,
  type PublicationInput,
  type PublishedHandoff,
  type RecoveredPublicationResult,
} from "./pull-request-core.ts";
import { remoteHeadOverride } from "./write-reconciliation.ts";

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
    const boundary = await (intent.kind === "maintenance"
      ? revalidateStandaloneMaintenanceTicket(input, intent.ticket)
      : revalidateActiveTicket(input, intent.ticket));
    if (boundary.outcome === "terminal") {
      if (
        intent.kind === "maintenance" &&
        boundary.ticket.stateReason === "completed"
      ) {
        return {
          outcome: "succeeded",
          reasons: [`Maintenance Ticket ${intent.ticket} is already completed`],
          pullRequests: [],
          published: [],
          restarted,
        };
      }
      return {
        outcome: "incomplete",
        reasons: [`Maintenance Ticket ${intent.ticket} is terminal`],
        pullRequests: [],
        published: [],
        restarted,
      };
    }
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
        retryPolicy: input.retryPolicy,
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
        retryPolicy: input.retryPolicy,
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
          clock: input.clock,
          event: () =>
            input.event(
              "publication_recovery",
              "create_pull_request",
              `ticket:${intent.ticket}`,
            )(1),
          operator: input.operator,
          retryPolicy: input.retryPolicy,
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
