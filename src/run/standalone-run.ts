import type { VerifiedHandoff } from "./attempt.ts";
import {
  discoverAndReserveStandalone,
  discoverAndReserveStandaloneBatch,
} from "./discovery.ts";
import {
  publishVerifiedHandoffs,
  type PublicationInput,
  type PublicationResult,
} from "./pull-request.ts";
import type { RunInput, RunOutcome, RunSummary } from "./run-input.ts";
import type { createEvent } from "./run-input.ts";
import { implementBatch } from "./run-batch.ts";

export interface StandaloneRunContext {
  input: RunInput;
  targetBranch: string;
  event: ReturnType<typeof createEvent>;
  cleanupTerminal: (ticket: number) => Promise<void>;
  publicationInput: (handoffs: VerifiedHandoff[]) => PublicationInput;
  integratePublication: (
    publication: PublicationResult,
    batchComplete: boolean,
    input: PublicationInput,
  ) => Promise<RunOutcome | null>;
  summary: (outcome: RunOutcome, reasons?: string[]) => RunSummary;
  batches: number[];
  handoffs: VerifiedHandoff[];
  completedTickets: number[];
  reasons: string[];
}

export async function runStandaloneIssue(
  context: StandaloneRunContext,
): Promise<RunSummary> {
  const { input } = context;
  const selected = input.standaloneIssueList ?? [input.issueTicket!];
  const discovery = input.standaloneIssueList
    ? await discoverAndReserveStandaloneBatch({
        repository: input.repository,
        parentTicket: input.parentTicket,
        standaloneIssues: selected,
        tracker: input.tracker,
        audit: input.audit,
        clock: input.clock,
        operator: input.operator,
        retryPolicy: input.retryPolicy,
        event: context.event,
        runnerAccount: input.runnerAccount,
        reservationLabel: input.reservationLabel,
        cleanupTerminal: context.cleanupTerminal,
      })
    : await discoverAndReserveStandalone({
        repository: input.repository,
        parentTicket: input.parentTicket,
        standaloneIssue: input.issueTicket!,
        tracker: input.tracker,
        audit: input.audit,
        clock: input.clock,
        operator: input.operator,
        retryPolicy: input.retryPolicy,
        event: context.event,
        runnerAccount: input.runnerAccount,
        reservationLabel: input.reservationLabel,
        cleanupTerminal: context.cleanupTerminal,
      });
  if (discovery.outcome !== "incomplete" || discovery.batch.length === 0)
    return context.summary(
      discovery.outcome === "close_parent" ? "succeeded" : discovery.outcome,
      [...context.reasons, ...discovery.reasons],
    );
  context.batches.push(...discovery.batch);
  await input.persistBatch?.(discovery.batch, context.completedTickets);
  const attempts = await implementBatch(
    input,
    context.targetBranch,
    context.event,
    discovery.batch,
  );
  context.handoffs.push(...attempts.handoffs);
  const batchComplete =
    attempts.handoffs.length === discovery.batch.length &&
    attempts.reasons.length === 0;
  const publicationInputs = context.publicationInput(attempts.handoffs);
  const publication =
    attempts.handoffs.length === 0
      ? null
      : await publishVerifiedHandoffs(publicationInputs);
  context.reasons.push(...discovery.reasons, ...attempts.reasons);
  if (!publication) return context.summary(attempts.outcome);
  const outcome = await context.integratePublication(
    publication,
    batchComplete,
    publicationInputs,
  );
  return context.summary(outcome ?? "succeeded");
}
