import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AuditEvent } from "../audit.ts";
import type {
  AgentAttemptResult,
  AgentDiagnostics,
  ReviewAttemptResult,
  Ticket,
} from "./contracts.ts";
import {
  externalRead,
  OperatorCancelled,
  pauseForOperator,
} from "./operations.ts";
import {
  agentPauseMessage,
  appendOperation,
  boundary,
  BoundaryStop,
  type AttemptInput,
  type VerifiedHandoff,
} from "./agent-operation.ts";

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
      retryPolicy: input.retryPolicy,
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

export async function reviewHandoff(
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
  let continuationPrompt: string | undefined;
  let attemptNumber!: number;
  let attemptId = "";
  let event!: Omit<AuditEvent, "result" | "error">;
  const logFile = path.join(
    input.projectDirectory,
    "logs",
    `review-${handoff.ticket}-${randomUUID()}.log`,
  );
  for (;;) {
    await boundary(input, handoff.ticket);
    const resumePrompt = continuationPrompt;
    // eslint-disable-next-line no-useless-assignment -- consume the one-shot continuation
    continuationPrompt = undefined;
    if (resumePrompt === undefined) {
      attemptNumber = (attemptNumber || 0) + 1;
      attemptId = randomUUID();
      event = input.event(
        "review",
        "agent_attempt",
        `ticket:${handoff.ticket}`,
      )(attemptNumber);
    }
    await appendOperation(
      input,
      event,
      "started",
      null,
      undefined,
      resumePrompt === undefined ? undefined : "resumed",
    );
    try {
      const [deliveryTicket, governingSpecification, standardsSources] =
        await Promise.all([
          readReviewSnapshot(input, handoff.ticket, false),
          readReviewSnapshot(
            input,
            input.standaloneIssue ?? input.parentTicket,
            input.standaloneIssue === undefined,
          ),
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
          targetBranch: input.targetBranch,
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
          logFile,
          timeoutMs: input.timeoutMs,
          ...(input.retryPolicy === undefined
            ? {}
            : { retryPolicy: input.retryPolicy }),
          signal,
          ...(resumePrompt === undefined ? {} : { resumePrompt }),
        });
      } finally {
        await rm(gitDirectory, { recursive: true, force: true });
      }
      await boundary(input, handoff.ticket);
      if (result.diagnostics) {
        result.diagnostics.agentAttemptId = attemptId;
        result.diagnostics.attemptOrdinal = attemptNumber;
      }
      if (result.outcome === "blocked") {
        await appendOperation(
          input,
          event,
          "blocked",
          null,
          result.diagnostics,
        );
        const response = await pauseForOperator(
          input.audit,
          event,
          input.operator,
          agentPauseMessage(
            "Review Agent Attempt blocked",
            result.diagnostics,
            {
              outcome: result.outcome,
              summary: result.summary,
              blocker: result.blocker,
              commits: [],
              checks: result.checks,
            },
          ),
        );
        continuationPrompt = response === "" ? "continue" : response;
        continue;
      }
      const reviewed = await acceptReview(
        input,
        handoff,
        implementationHead,
        result.checks,
        "verified",
      );
      await appendOperation(
        input,
        event,
        "succeeded",
        null,
        result.diagnostics,
      );
      return reviewed;
    } catch (error) {
      if (error instanceof OperatorCancelled) throw error;
      if (error instanceof BoundaryStop) {
        await appendOperation(input, event, error.result.outcome, null);
        throw error;
      }
      const diagnostics: AgentDiagnostics = {
        error:
          error instanceof Error
            ? error.message
            : "Review Agent Attempt failed",
        errorCategory: "agent_attempt",
        attemptOrdinal: attemptNumber,
        retryable: true,
        agentAttemptId: attemptId,
        diagnosticLogPath: logFile,
      };
      Object.assign(
        diagnostics,
        error instanceof Error && "diagnostics" in error
          ? (error as Error & { diagnostics?: AgentDiagnostics }).diagnostics
          : {},
      );
      await appendOperation(
        input,
        event,
        "failed",
        diagnostics.error!,
        diagnostics,
      );
      for (;;) {
        const response = await pauseForOperator(
          input.audit,
          event,
          input.operator,
          agentPauseMessage("Review Agent Attempt failed", diagnostics),
        );
        continuationPrompt = response === "" ? "continue" : response;
        break;
      }
    }
  }
}
