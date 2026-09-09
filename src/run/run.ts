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
import { discoverAndReserve } from "./discovery.ts";
import { externalRead, workflowWrite } from "./operations.ts";
import {
  publishVerifiedHandoffs,
  type PullRequestObservation,
} from "./pull-request.ts";

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
  agentTimeoutMs: number;
  requiredChecksTimeoutMs: number;
  mergeQueueTimeoutMs: number;
  adminMerge: boolean;
  ticketClosure: TicketClosurePolicy;
  gitWorkspace: GitWorkspace;
  agentExecutor: AgentExecutor;
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
    if (discovery.outcome === "close_parent") {
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
      return {
        outcome: "succeeded",
        project: input.project,
        parentTicket: input.parentTicket,
        targetBranch,
        reasons,
        ...(batches.length === 0 ? {} : { batch: batches }),
        ...(handoffs.length === 0 ? {} : { handoffs }),
        ...(pullRequests.length === 0 ? {} : { pullRequests }),
        ...(completedTickets.length === 0 ? {} : { completedTickets }),
      };
    }
    if (discovery.outcome !== "incomplete" || discovery.batch.length === 0) {
      return {
        ...discovery,
        project: input.project,
        parentTicket: input.parentTicket,
        targetBranch,
        reasons: [...reasons, ...discovery.reasons],
        ...(batches.length === 0 ? {} : { batch: batches }),
        ...(handoffs.length === 0 ? {} : { handoffs }),
        ...(pullRequests.length === 0 ? {} : { pullRequests }),
        ...(completedTickets.length === 0 ? {} : { completedTickets }),
      };
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
      timeoutMs: input.agentTimeoutMs,
      gitWorkspace: input.gitWorkspace,
      agentExecutor: input.agentExecutor,
    });
    handoffs.push(...attempts.handoffs);
    const batchComplete =
      attempts.handoffs.length === discovery.batch.length &&
      attempts.reasons.length === 0;
    const publication =
      attempts.handoffs.length === 0
        ? null
        : await publishVerifiedHandoffs({
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
            requiredChecksTimeoutMs: input.requiredChecksTimeoutMs,
            mergeQueueTimeoutMs: input.mergeQueueTimeoutMs,
            adminMerge: input.adminMerge,
            ticketClosure: input.ticketClosure,
            batchComplete,
            handoffs: attempts.handoffs,
            gitWorkspace: input.gitWorkspace,
            codeHost: input.codeHost,
          });
    if (publication) {
      pullRequests.push(...publication.pullRequests);
      completedTickets.push(...publication.completedTickets);
    }
    reasons.push(
      ...discovery.reasons,
      ...attempts.reasons,
      ...(publication?.reasons ?? []),
    );
    if (batchComplete && publication?.outcome === "succeeded") continue;
    return {
      outcome: publication?.outcome ?? attempts.outcome,
      project: input.project,
      parentTicket: input.parentTicket,
      targetBranch,
      batch: batches,
      reasons,
      handoffs,
      pullRequests,
      completedTickets,
    };
  }
}
