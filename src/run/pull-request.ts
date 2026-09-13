import type { VerifiedHandoff } from "./attempt.ts";
import type {
  MergeRequestResult,
  PullRequestIdentity,
  PullRequestState,
  Ticket,
} from "./contracts.ts";
import {
  type DeliveryBoundaryResult,
  revalidateActiveTicket,
} from "./discovery.ts";
import { serializeOperator, workflowWrite } from "./operations.ts";
import { remoteBranchReconciliation } from "./write-reconciliation.ts";
import { type PublicationIntent } from "../recovery.ts";
import { recoverPublishedHandoffs } from "./pull-request-recovery.ts";
import {
  observeRequiredChecks,
  repairRequiredChecks,
  repairMergeConflict,
} from "./pull-request-repair.ts";
import {
  observePullRequestForIntegration,
  waitForMerge,
  confirmCompletion,
  persistedBudget,
  pullRequestOverride,
  stopped,
  DeliveryBoundaryChanged,
  type PublicationInput,
  type PublicationResult,
  type PublishedHandoff,
} from "./pull-request-core.ts";
export type {
  PublicationInput,
  PublicationResult,
  PullRequestObservation,
  PublishedHandoff,
  ReadinessInput,
  RecoveredPublicationResult,
  RepairBudget,
} from "./pull-request-core.ts";
export {
  recoverPublishedHandoffs,
  observeRequiredChecks,
  repairRequiredChecks,
  observePullRequestForIntegration,
};

export async function integratePullRequest(
  input: PublicationInput,
  handoff: VerifiedHandoff,
  pullRequest: PullRequestIdentity,
  observed: PullRequestState,
): Promise<
  | { outcome: "completed"; ticket: Ticket }
  | Exclude<DeliveryBoundaryResult, { outcome: "ready" }>
> {
  const persistedConflict = persistedBudget(input, handoff.ticket, "conflict");
  const conflictBudget = {
    consumed: persistedConflict?.consumed ?? 0,
    generation: persistedConflict?.generation ?? 0,
    attempts: { value: persistedConflict?.attempt ?? 0 },
  };
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
        clock: input.clock,
        automaticRetry: {
          async reconcile() {
            const state = await observePullRequestForIntegration(
              input,
              pullRequest.number,
              "merge",
            );
            return state.merged
              ? {
                  outcome: "completed" as const,
                  result: { outcome: "accepted" as const },
                }
              : { outcome: "pending" as const };
          },
        },
        event: (attempt) =>
          input.event(
            "merge",
            "request_squash_merge",
            `pull_request:${pullRequest.number}`,
          )(attempt),
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
        clock: input.clock,
        automaticRetry: {
          reconcile: remoteBranchReconciliation(
            concurrentInput,
            "publish",
            handoff.branch,
            intent.intendedHeadSha,
            `ticket:${handoff.ticket}`,
          ),
        },
        event: (attempt) =>
          input.event(
            "publish",
            "push_branch",
            `ticket:${handoff.ticket}`,
          )(attempt),
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
        clock: input.clock,
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
