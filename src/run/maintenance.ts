import type { AgentConfig } from "../config.ts";
import { runMaintenanceAttempt, type VerifiedHandoff } from "./attempt.ts";
import type { LabelPage, Ticket } from "./contracts.ts";
import {
  type DeliveryBoundaryResult,
  revalidateParentForOperation,
  revalidateStandaloneMaintenanceTicket,
  type TicketBoundary,
} from "./discovery.ts";
import {
  externalRead,
  pauseForOperator,
  recordOperatorOverride,
  workflowWrite,
} from "./operations.ts";
import {
  integratePullRequest,
  observePullRequestForIntegration,
  type PublicationInput,
  publishVerifiedHandoffs,
  type PullRequestObservation,
} from "./pull-request.ts";

const LABEL = "doc-maintain";
const TITLE = "Maintain project documentation";
const BODY =
  "Run the configured documentation-maintenance prompt for the current Target Branch.";

interface MaintenanceInput extends Omit<
  PublicationInput,
  "ciRepairBudgets" | "handoffs" | "ticketBoundary" | "ticketKind"
> {
  documentationPrompt: string;
  documentationAgent: AgentConfig;
}

export interface MaintenanceResult {
  outcome: "succeeded" | "incomplete" | "cancelled" | "failed";
  reasons: string[];
  ticket?: number;
  handoff?: VerifiedHandoff;
  pullRequest?: PullRequestObservation;
}

function labelPage(value: string): LabelPage {
  const parsed = JSON.parse(value) as Partial<LabelPage>;
  if (
    !Array.isArray(parsed.labels) ||
    parsed.labels.some((label) => typeof label !== "string") ||
    (parsed.nextPage !== null && !Number.isSafeInteger(parsed.nextPage))
  ) {
    throw new Error("override has no usable label page");
  }
  return { labels: parsed.labels, nextPage: parsed.nextPage ?? null };
}

function createdTicket(value: string): Ticket {
  const parsed = JSON.parse(value) as { number?: unknown };
  if (!Number.isSafeInteger(parsed.number) || Number(parsed.number) <= 0) {
    throw new Error("override has no Maintenance Ticket number");
  }
  return {
    number: parsed.number as number,
    state: "open",
    stateReason: null,
    assignees: [],
    labels: [LABEL],
  };
}

function stopped(
  boundary: Exclude<DeliveryBoundaryResult, { outcome: "ready" }>,
  ticket?: number,
): MaintenanceResult {
  return {
    outcome:
      boundary.outcome === "cancelled"
        ? "cancelled"
        : boundary.outcome === "failed"
          ? "failed"
          : "incomplete",
    reasons: [boundary.reason],
    ...(ticket === undefined ? {} : { ticket }),
  };
}

async function ensureLabel(input: MaintenanceInput): Promise<void> {
  let page: number | null = 1;
  while (page !== null) {
    const current: number = page;
    const labels = await externalRead<LabelPage>({
      action: () => input.tracker.listLabelsPage(input.repository, current),
      parseOverride: labelPage,
      audit: input.audit,
      event: input.event("maintenance", "read_labels", `page:${current}`),
      clock: input.clock,
      operator: input.operator,
    });
    if (labels.labels.includes(LABEL)) return;
    page = labels.nextPage;
  }
  await workflowWrite({
    action: () => input.tracker.createLabel(input.repository, LABEL),
    audit: input.audit,
    event: () => input.event("maintenance", "create_label", LABEL)(1),
    operator: input.operator,
  });
}

function boundaryFor(input: MaintenanceInput): TicketBoundary {
  return {
    async beforeOperation(ticket) {
      const result = await revalidateStandaloneMaintenanceTicket(input, ticket);
      return result.outcome === "terminal"
        ? {
            outcome: "stopped",
            reason: `Maintenance Ticket ${ticket} became terminal`,
          }
        : result;
    },
    afterMerge: (ticket) =>
      revalidateStandaloneMaintenanceTicket(input, ticket),
    releaseTerminal: () => Promise.resolve(),
  };
}

async function closeNoChange(
  input: MaintenanceInput,
  boundary: TicketBoundary,
  ticket: number,
): Promise<MaintenanceResult> {
  for (;;) {
    const ready = await boundary.beforeOperation(ticket);
    if (ready.outcome !== "ready") return stopped(ready, ticket);
    await workflowWrite({
      action: () => input.tracker.closeTicket(input.repository, ticket),
      audit: input.audit,
      event: () =>
        input.event("maintenance", "close_no_change", `ticket:${ticket}`)(1),
      operator: input.operator,
    });
    const confirmation = await boundary.afterMerge(ticket);
    if (confirmation.outcome === "terminal") {
      return confirmation.ticket.stateReason === "completed"
        ? {
            outcome: "succeeded",
            reasons: [`Completed Maintenance Ticket ${ticket} with no changes`],
            ticket,
          }
        : {
            outcome: "incomplete",
            reasons: [`Maintenance Ticket ${ticket} was cancelled`],
            ticket,
          };
    }
    if (confirmation.outcome !== "ready") return stopped(confirmation, ticket);
    const event = input.event(
      "maintenance",
      "confirm_no_change_closure",
      `ticket:${ticket}`,
    )(1);
    const response = await pauseForOperator(
      input.audit,
      event,
      input.operator,
      `Maintenance Ticket ${ticket} is not closed as completed. Enter to retry, q to cancel, or acknowledge trusted completion.`,
    );
    if (response === "") continue;
    await recordOperatorOverride(input.audit, event, input.operator);
    return {
      outcome: "succeeded",
      reasons: [`Completed Maintenance Ticket ${ticket} with no changes`],
      ticket,
    };
  }
}

export async function runDocumentationMaintenance(
  input: MaintenanceInput,
): Promise<MaintenanceResult> {
  const parent = await revalidateParentForOperation(input);
  if (parent.outcome !== "ready") return stopped(parent);
  await ensureLabel(input);
  const beforeCreate = await revalidateParentForOperation(input);
  if (beforeCreate.outcome !== "ready") return stopped(beforeCreate);
  const ticket = await workflowWrite({
    action: () =>
      input.tracker.createMaintenanceTicket(
        input.repository,
        TITLE,
        BODY,
        LABEL,
      ),
    parseOverride: createdTicket,
    audit: input.audit,
    event: () => input.event("maintenance", "create_ticket", LABEL)(1),
    operator: input.operator,
  });
  if (
    ticket.state !== "open" ||
    (ticket.assignees ?? []).length !== 0 ||
    !(ticket.labels ?? []).includes(LABEL) ||
    (ticket.labels ?? []).includes(input.reservationLabel)
  ) {
    throw new Error(
      "created Maintenance Ticket is not standalone and labelled",
    );
  }
  const ticketBoundary = boundaryFor(input);
  const operationInput = {
    ...input,
    ticketBoundary,
    ticketKind: "Maintenance Ticket" as const,
  };
  const attempt = await runMaintenanceAttempt({
    ...operationInput,
    checkout: input.checkout,
    ticket: ticket.number,
    promptFile: input.documentationPrompt,
    agent: input.documentationAgent,
    timeoutMs: input.agentTimeoutMs,
  });
  if (attempt.outcome === "boundary")
    return stopped(attempt.boundary, ticket.number);
  if (attempt.outcome === "blocked") {
    return {
      outcome: "incomplete",
      reasons: [attempt.reason],
      ticket: ticket.number,
    };
  }
  if (attempt.outcome === "no_change") {
    return closeNoChange(input, ticketBoundary, ticket.number);
  }

  const publicationInput: PublicationInput = {
    ...operationInput,
    handoffs: [attempt.handoff],
    ciRepairBudgets: new Map(),
  };
  const publication = await publishVerifiedHandoffs(publicationInput);
  const published = publication.published[0];
  if (
    publication.outcome !== "succeeded" ||
    published?.observation.readiness !== "ready"
  ) {
    return {
      outcome:
        publication.outcome === "cancelled"
          ? "cancelled"
          : publication.outcome === "failed"
            ? "failed"
            : "incomplete",
      reasons: publication.reasons,
      ticket: ticket.number,
      handoff: attempt.handoff,
      ...(published ? { pullRequest: published.observation } : {}),
    };
  }
  const state = await observePullRequestForIntegration(
    publicationInput,
    published.pullRequest.number,
  );
  const integration = await integratePullRequest(
    publicationInput,
    attempt.handoff,
    published.pullRequest,
    state,
  );
  return integration.outcome === "completed"
    ? {
        outcome: "succeeded",
        reasons: [`Completed Maintenance Ticket ${ticket.number}`],
        ticket: ticket.number,
        handoff: attempt.handoff,
        pullRequest: published.observation,
      }
    : {
        ...stopped(integration, ticket.number),
        handoff: attempt.handoff,
        pullRequest: published.observation,
      };
}
