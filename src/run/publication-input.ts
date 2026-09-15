import type { VerifiedHandoff } from "./attempt.ts";
import type { PublicationIntent } from "../recovery.ts";
import type { PublicationInput } from "./pull-request.ts";
import type { RunInput } from "./run-input.ts";
import type { createEvent } from "./run-input.ts";

export function createPublicationInput(
  input: RunInput,
  targetBranch: string,
  event: ReturnType<typeof createEvent>,
  publicationIntents: Map<number, PublicationIntent>,
  cleanupTerminal: (ticket: number) => Promise<void>,
): (batchHandoffs: VerifiedHandoff[]) => PublicationInput {
  return (batchHandoffs) => ({
    repository: input.repository,
    parentTicket: input.parentTicket,
    ...(input.issueTicket === undefined
      ? {}
      : { standaloneIssue: input.issueTicket }),
    tracker: input.tracker,
    audit: input.audit,
    clock: input.clock,
    operator: input.operator,
    retryPolicy: input.retryPolicy,
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
    publicationIntents,
    handoffs: batchHandoffs,
    gitWorkspace: input.gitWorkspace,
    codeHost: input.codeHost,
    agentExecutor: input.agentExecutor,
    cleanupTerminal,
    ...(input.persistPublication === undefined
      ? {}
      : { persistPublication: input.persistPublication }),
  });
}
