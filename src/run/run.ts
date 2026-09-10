import type { AuditLog } from "../audit.ts";
import type { AgentConfig } from "../config.ts";
import { implementReservedBatch, type VerifiedHandoff } from "./attempt.ts";
import type {
  AgentExecutor,
  Clock,
  CodeHost,
  GitWorkspace,
  OperatorIO,
  TicketClosurePolicy,
  Tracker,
} from "./contracts.ts";
import { discoverAndReserve, releaseTerminalReservation } from "./discovery.ts";
import {
  externalRead,
  OperatorCancelled,
  workflowWrite,
} from "./operations.ts";
import { runDocumentationMaintenance } from "./maintenance.ts";
import {
  integratePullRequest,
  observePullRequestForIntegration,
  publishVerifiedHandoffs,
  type PullRequestObservation,
} from "./pull-request.ts";
import type { PublicationIntent } from "../recovery.ts";

export type RunOutcome =
  "succeeded" | "no_work" | "incomplete" | "cancelled" | "failed";

export interface RunSummary {
  outcome: RunOutcome;
  project: string;
  parentTicket: number;
  targetBranch: string;
  reasons: string[];
  batch?: number[];
  handoffs?: VerifiedHandoff[];
  pullRequests?: PullRequestObservation[];
  completedTickets?: number[];
}

interface RunInput {
  project: string;
  parentTicket: number;
  repository: string;
  configuredTargetBranch?: string;
  runId: string;
  audit: AuditLog;
  tracker: Tracker;
  codeHost: CodeHost;
  clock: Clock;
  operator: OperatorIO;
  runnerAccount: string;
  reservationLabel: string;
  checkout: string;
  projectDirectory: string;
  implementationPrompt: string;
  implementationAgent: AgentConfig;
  review: boolean;
  reviewPrompt: string;
  reviewAgent?: AgentConfig;
  ciRepairPrompt: string;
  ciRepairAgent: AgentConfig;
  conflictRepairPrompt: string;
  conflictRepairAgent: AgentConfig;
  documentationMaintenance: boolean;
  documentationPrompt: string;
  documentationAgent?: AgentConfig;
  agentTimeoutMs: number;
  requiredChecksTimeoutMs: number;
  mergeQueueTimeoutMs: number;
  adminMerge: boolean;
  ticketClosure: TicketClosurePolicy;
  gitWorkspace: GitWorkspace;
  agentExecutor: AgentExecutor;
  persistPublication?: (intent: PublicationIntent | null) => Promise<void>;
}

export async function runProject(input: RunInput): Promise<RunSummary> {
  const event =
    (phase: string, operation: string, target: string) =>
    (attempt: number) => ({
      timestamp: input.clock.now().toISOString(),
      runId: input.runId,
      project: input.project,
      parentTicket: input.parentTicket,
      phase,
      operation,
      target,
      attempt,
    });
  const targetBranch =
    input.configuredTargetBranch ??
    (await externalRead({
      action: () => input.codeHost.resolveTargetBranch(input.repository),
      parseOverride: (value) => {
        const parsed = JSON.parse(value) as { targetBranch?: unknown };
        if (
          typeof parsed.targetBranch !== "string" ||
          parsed.targetBranch.length === 0
        ) {
          throw new Error("override has no Target Branch");
        }
        return parsed.targetBranch;
      },
      audit: input.audit,
      event: event("startup", "resolve_target_branch", input.repository),
      clock: input.clock,
      operator: input.operator,
    }));

  let hadChildren = false;
  const batches: number[] = [];
  const handoffs: VerifiedHandoff[] = [];
  const pullRequests: PullRequestObservation[] = [];
  const completedTickets: number[] = [];
  const reasons: string[] = [];
  let hasBatchState = false;
  let maintenanceCredit = 0;
  const summary = (
    outcome: RunOutcome,
    finalReasons: string[] = reasons,
  ): RunSummary => ({
    outcome,
    project: input.project,
    parentTicket: input.parentTicket,
    targetBranch,
    reasons: finalReasons,
    ...(!hasBatchState
      ? {}
      : { batch: batches, handoffs, pullRequests, completedTickets }),
  });

  const maintain = async (): Promise<RunOutcome | null> => {
    if (!input.documentationAgent) {
      throw new Error("Documentation Maintenance agent is not configured");
    }
    const result = await runDocumentationMaintenance({
      repository: input.repository,
      parentTicket: input.parentTicket,
      tracker: input.tracker,
      audit: input.audit,
      clock: input.clock,
      operator: input.operator,
      event,
      runnerAccount: input.runnerAccount,
      reservationLabel: input.reservationLabel,
      targetBranch,
      checkout: input.checkout,
      runId: input.runId,
      projectDirectory: input.projectDirectory,
      documentationPrompt: input.documentationPrompt,
      documentationAgent: input.documentationAgent,
      ciRepairPrompt: input.ciRepairPrompt,
      ciRepairAgent: input.ciRepairAgent,
      conflictRepairPrompt: input.conflictRepairPrompt,
      conflictRepairAgent: input.conflictRepairAgent,
      agentTimeoutMs: input.agentTimeoutMs,
      requiredChecksTimeoutMs: input.requiredChecksTimeoutMs,
      mergeQueueTimeoutMs: input.mergeQueueTimeoutMs,
      adminMerge: input.adminMerge,
      ticketClosure: input.ticketClosure,
      gitWorkspace: input.gitWorkspace,
      codeHost: input.codeHost,
      agentExecutor: input.agentExecutor,
    }).catch((error: unknown) => {
      if (!(error instanceof OperatorCancelled)) throw error;
      return null;
    });
    if (!result) {
      reasons.push("operator cancelled");
      return "cancelled";
    }
    reasons.push(...result.reasons);
    if (result.handoff) handoffs.push(result.handoff);
    if (result.pullRequest) pullRequests.push(result.pullRequest);
    if (result.outcome === "succeeded") {
      maintenanceCredit = 0;
      return null;
    }
    return result.outcome;
  };

  for (;;) {
    const discovery = await discoverAndReserve({
      repository: input.repository,
      parentTicket: input.parentTicket,
      tracker: input.tracker,
      audit: input.audit,
      clock: input.clock,
      operator: input.operator,
      event,
      runnerAccount: input.runnerAccount,
      reservationLabel: input.reservationLabel,
      hadChildren,
    });
    if (discovery.outcome === "incomplete") hasBatchState = true;
    if (discovery.outcome === "close_parent") {
      if (input.documentationMaintenance && maintenanceCredit > 0) {
        const outcome = await maintain();
        if (outcome) return summary(outcome);
        continue;
      }
      await workflowWrite({
        action: () =>
          input.tracker.closeParent(input.repository, input.parentTicket),
        audit: input.audit,
        event: () =>
          event(
            "close_parent",
            "close_parent",
            `parent:${input.parentTicket}`,
          )(1),
        operator: input.operator,
      });
      return summary("succeeded");
    }
    if (discovery.outcome !== "incomplete" || discovery.batch.length === 0) {
      return summary(discovery.outcome, [...reasons, ...discovery.reasons]);
    }

    hadChildren = true;
    batches.push(...discovery.batch);
    const attempts = await implementReservedBatch({
      repository: input.repository,
      parentTicket: input.parentTicket,
      tracker: input.tracker,
      audit: input.audit,
      clock: input.clock,
      operator: input.operator,
      event,
      runnerAccount: input.runnerAccount,
      reservationLabel: input.reservationLabel,
      batch: discovery.batch,
      runId: input.runId,
      checkout: input.checkout,
      targetBranch,
      projectDirectory: input.projectDirectory,
      promptFile: input.implementationPrompt,
      agent: input.implementationAgent,
      review: input.review,
      reviewPrompt: input.reviewPrompt,
      ...(input.reviewAgent === undefined
        ? {}
        : { reviewAgent: input.reviewAgent }),
      timeoutMs: input.agentTimeoutMs,
      gitWorkspace: input.gitWorkspace,
      agentExecutor: input.agentExecutor,
    });
    handoffs.push(...attempts.handoffs);
    const batchComplete =
      attempts.handoffs.length === discovery.batch.length &&
      attempts.reasons.length === 0;
    const publicationInput = {
      repository: input.repository,
      parentTicket: input.parentTicket,
      tracker: input.tracker,
      audit: input.audit,
      clock: input.clock,
      operator: input.operator,
      event,
      runnerAccount: input.runnerAccount,
      reservationLabel: input.reservationLabel,
      targetBranch,
      checkout: input.checkout,
      runId: input.runId,
      projectDirectory: input.projectDirectory,
      ciRepairPrompt: input.ciRepairPrompt,
      ciRepairAgent: input.ciRepairAgent,
      conflictRepairPrompt: input.conflictRepairPrompt,
      conflictRepairAgent: input.conflictRepairAgent,
      agentTimeoutMs: input.agentTimeoutMs,
      requiredChecksTimeoutMs: input.requiredChecksTimeoutMs,
      mergeQueueTimeoutMs: input.mergeQueueTimeoutMs,
      adminMerge: input.adminMerge,
      ticketClosure: input.ticketClosure,
      ciRepairBudgets: new Map(),
      handoffs: attempts.handoffs,
      gitWorkspace: input.gitWorkspace,
      codeHost: input.codeHost,
      agentExecutor: input.agentExecutor,
      ...(input.persistPublication === undefined
        ? {}
        : { persistPublication: input.persistPublication }),
    };
    const publication =
      attempts.handoffs.length === 0
        ? null
        : await publishVerifiedHandoffs(publicationInput);
    if (publication) pullRequests.push(...publication.pullRequests);
    reasons.push(
      ...discovery.reasons,
      ...attempts.reasons,
      ...(publication?.reasons ?? []),
    );
    if (!publication) return summary(attempts.outcome);
    const batchReady =
      batchComplete &&
      publication.outcome === "succeeded" &&
      publication.published.every(
        ({ observation }) => observation.readiness === "ready",
      );
    if (!batchReady) {
      if (!batchComplete)
        reasons.push("Batch barrier blocked by unresolved Agent Attempts");
      return summary(
        publication.outcome !== "succeeded"
          ? publication.outcome
          : "incomplete",
      );
    }

    const ordered = await Promise.all(
      publication.published.map(async (published) => ({
        ...published,
        state: await observePullRequestForIntegration(
          publicationInput,
          published.pullRequest.number,
        ),
      })),
    );
    ordered.sort(
      (left, right) =>
        left.state.createdAt.localeCompare(right.state.createdAt) ||
        left.pullRequest.number - right.pullRequest.number,
    );
    for (const { handoff, pullRequest, state } of ordered) {
      let integration: Awaited<ReturnType<typeof integratePullRequest>>;
      try {
        integration = await integratePullRequest(
          publicationInput,
          handoff,
          pullRequest,
          state,
        );
      } catch (error) {
        if (!(error instanceof OperatorCancelled)) throw error;
        reasons.push("operator cancelled");
        return summary("cancelled");
      }
      if (integration.outcome === "completed") {
        await input.persistPublication?.(null);
        completedTickets.push(handoff.ticket);
        if (input.documentationMaintenance) maintenanceCredit += 1;
        reasons.push(
          `Completed Delivery Ticket ${handoff.ticket} through Pull Request ${pullRequest.number}`,
        );
        try {
          await releaseTerminalReservation(
            publicationInput,
            integration.ticket,
          );
        } catch (error) {
          if (!(error instanceof OperatorCancelled)) throw error;
          reasons.push("operator cancelled");
          return summary("cancelled");
        }
        continue;
      }
      reasons.push(integration.reason);
      return summary(
        integration.outcome === "cancelled"
          ? "cancelled"
          : integration.outcome === "failed"
            ? "failed"
            : "incomplete",
      );
    }
    if (input.documentationMaintenance && maintenanceCredit >= 3) {
      const outcome = await maintain();
      if (outcome) return summary(outcome);
    }
  }
}
