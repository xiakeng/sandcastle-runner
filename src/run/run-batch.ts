import { implementReservedBatch } from "./attempt.ts";
import type { createEvent, RunInput } from "./run-input.ts";

export function implementBatch(
  input: RunInput,
  targetBranch: string,
  event: ReturnType<typeof createEvent>,
  batch: number[],
) {
  return implementReservedBatch({
    repository: input.repository,
    parentTicket: input.parentTicket,
    ...(input.issueTicket === undefined
      ? {}
      : { standaloneIssue: input.issueTicket }),
    ...(input.standaloneIssueList === undefined
      ? {}
      : { standaloneIssues: input.standaloneIssueList }),
    tracker: input.tracker,
    audit: input.audit,
    clock: input.clock,
    operator: input.operator,
    retryPolicy: input.retryPolicy,
    event,
    runnerAccount: input.runnerAccount,
    reservationLabel: input.reservationLabel,
    batch,
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
}
