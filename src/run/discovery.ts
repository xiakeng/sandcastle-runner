import type { Ticket } from "./contracts.ts";
import { externalRead, workflowWrite } from "./operations.ts";
import {
  inspect,
  parseTicket,
  readBlockers,
  readChildren,
  readParent,
  releaseReservation,
  revalidateTicket,
  readyForAgentLabel,
  type DiscoveryInput,
  type Selection,
  type DeliveryBoundaryResult,
  type MergedDeliveryBoundaryResult,
} from "./discovery-state.ts";
export type {
  DiscoveryInput,
  DeliveryBoundaryResult,
  MergedDeliveryBoundaryResult,
  TicketBoundary,
} from "./discovery-state.ts";
export { discoverAndReserveStandalone } from "./standalone-discovery.ts";

export type DiscoveryResult =
  | {
      outcome: "succeeded" | "no_work" | "cancelled" | "failed";
      reasons: string[];
    }
  | { outcome: "close_parent"; reasons: [] }
  | { outcome: "incomplete"; reasons: string[]; batch: number[] };

function boundaryResult(parent: Ticket): DiscoveryResult | null {
  if (parent.state === "open") return null;
  return parent.stateReason === "not_planned"
    ? { outcome: "cancelled", reasons: ["Parent Ticket is cancelled"] }
    : {
        outcome: "failed",
        reasons: ["Parent Ticket changed to a terminal state"],
      };
}

async function revalidateReserved(
  input: DiscoveryInput,
  ticketNumber: number,
): Promise<MergedDeliveryBoundaryResult> {
  if (input.standaloneIssue === undefined) {
    const parentResult = boundaryResult(await readParent(input, "revalidate"));
    if (parentResult) {
      return {
        outcome: parentResult.outcome === "cancelled" ? "cancelled" : "failed",
        reason: parentResult.reasons[0] ?? "Parent Ticket changed",
      };
    }
  }
  const result = await revalidateTicket(input, ticketNumber);
  if (!result.inScope)
    return {
      outcome: "stopped",
      reason: `Delivery Ticket ${ticketNumber} left Parent scope`,
    };
  if (result.ticket.state === "closed") {
    return { outcome: "terminal", ticket: result.ticket };
  }
  if (result.blocked)
    return {
      outcome: "stopped",
      reason: `Delivery Ticket ${ticketNumber} became blocked`,
    };
  if (
    (result.ticket.assignees ?? []).some(
      (assignee) => assignee !== input.runnerAccount,
    )
  ) {
    return {
      outcome: "stopped",
      reason: `Delivery Ticket ${ticketNumber} became externally owned`,
    };
  }
  if (
    !(result.ticket.labels ?? []).includes(readyForAgentLabel) ||
    !(result.ticket.assignees ?? []).includes(input.runnerAccount) ||
    !(result.ticket.labels ?? []).includes(input.reservationLabel)
  ) {
    return {
      outcome: "stopped",
      reason: `Delivery Ticket ${ticketNumber} no longer has a complete Reservation`,
    };
  }
  return { outcome: "ready", ticket: result.ticket };
}

export async function revalidateReservedDeliveryTicket(
  input: DiscoveryInput,
  ticketNumber: number,
): Promise<DeliveryBoundaryResult> {
  const result = await revalidateReserved(input, ticketNumber);
  if (result.outcome === "terminal") {
    await releaseTerminalReservation(input, result.ticket);
    await input.cleanupTerminal?.(result.ticket.number);
    return {
      outcome: "stopped",
      reason: `Delivery Ticket ${ticketNumber} became terminal`,
    };
  }
  return result.outcome === "ready" ? { outcome: "ready" } : result;
}

export function revalidateMergedDeliveryTicket(
  input: DiscoveryInput,
  ticketNumber: number,
): Promise<MergedDeliveryBoundaryResult> {
  return revalidateReserved(input, ticketNumber);
}

export function releaseTerminalReservation(
  input: DiscoveryInput,
  ticket: Ticket,
): Promise<void> {
  return releaseReservation(
    input,
    ticket.number,
    (ticket.assignees ?? []).includes(input.runnerAccount),
    (ticket.labels ?? []).includes(input.reservationLabel),
  );
}

export function revalidateActiveTicket(
  input: DiscoveryInput,
  ticket: number,
): Promise<DeliveryBoundaryResult> {
  return (
    input.ticketBoundary?.beforeOperation(ticket) ??
    revalidateReservedDeliveryTicket(input, ticket)
  );
}

export function revalidateMergedTicket(
  input: DiscoveryInput,
  ticket: number,
): Promise<MergedDeliveryBoundaryResult> {
  return (
    input.ticketBoundary?.afterMerge(ticket) ??
    revalidateMergedDeliveryTicket(input, ticket)
  );
}

export function releaseTerminalTicket(
  input: DiscoveryInput,
  ticket: Ticket,
): Promise<void> {
  return (
    input.ticketBoundary?.releaseTerminal(ticket) ??
    releaseTerminalReservation(input, ticket)
  );
}

export async function revalidateParentForOperation(
  input: DiscoveryInput,
): Promise<DeliveryBoundaryResult> {
  const result = boundaryResult(await readParent(input, "maintenance"));
  return result
    ? {
        outcome: result.outcome === "cancelled" ? "cancelled" : "failed",
        reason: result.reasons[0] ?? "Parent Ticket changed",
      }
    : { outcome: "ready" };
}

export async function revalidateStandaloneMaintenanceTicket(
  input: DiscoveryInput,
  ticketNumber: number,
): Promise<MergedDeliveryBoundaryResult> {
  const parent = await revalidateParentForOperation(input);
  if (parent.outcome !== "ready") return parent;
  const ticket = await externalRead({
    action: () => input.tracker.getTicket(input.repository, ticketNumber),
    parseOverride: (value) =>
      parseTicket(JSON.parse(value) as unknown, ticketNumber),
    audit: input.audit,
    event: input.event(
      "maintenance",
      "read_maintenance_ticket",
      `ticket:${ticketNumber}`,
    ),
    clock: input.clock,
    operator: input.operator,
  });
  if (ticket.state === "closed") {
    if (
      ticket.stateReason === "completed" ||
      ticket.stateReason === "not_planned"
    ) {
      await input.cleanupTerminal?.(ticket.number);
      return { outcome: "terminal", ticket };
    }
    return {
      outcome: "stopped",
      reason: `Maintenance Ticket ${ticketNumber} has no confirmed terminal reason`,
    };
  }
  const blockers = await readBlockers(input, ticketNumber, "maintenance");
  if (blockers.some(({ state }) => state === "open")) {
    return {
      outcome: "stopped",
      reason: `Maintenance Ticket ${ticketNumber} became blocked`,
    };
  }
  if ((ticket.assignees ?? []).length > 0) {
    return {
      outcome: "stopped",
      reason: `Maintenance Ticket ${ticketNumber} became externally owned`,
    };
  }
  if (
    !(ticket.labels ?? []).includes("doc-maintain") ||
    (ticket.labels ?? []).includes(input.reservationLabel)
  ) {
    return {
      outcome: "stopped",
      reason: `Maintenance Ticket ${ticketNumber} lost its standalone markers`,
    };
  }
  return { outcome: "ready", ticket };
}

function reasons(selection: Selection, batch: number[]): string[] {
  return [
    ...(batch.length > 0
      ? [`reserved Delivery Tickets: ${batch.join(", ")}`]
      : []),
    ...(selection.blocked.length > 0
      ? [`blocked Delivery Tickets: ${selection.blocked.join(", ")}`]
      : []),
    ...(selection.externallyOwned.length > 0
      ? [
          `externally owned Delivery Tickets: ${selection.externallyOwned.join(", ")}`,
        ]
      : []),
    ...(selection.reservations.length > 0
      ? [`existing Reservations: ${selection.reservations.join(", ")}`]
      : []),
  ];
}

async function reserve(
  input: DiscoveryInput,
  selection: Selection,
): Promise<DiscoveryResult | null> {
  const batch: number[] = [];
  for (const candidate of selection.batch) {
    const beforeLabelParent = boundaryResult(await readParent(input));
    if (beforeLabelParent) return beforeLabelParent;
    const beforeLabel = await revalidateTicket(input, candidate.number);
    if (!beforeLabel.inScope) continue;
    const hasRunner = (beforeLabel.ticket.assignees ?? []).includes(
      input.runnerAccount,
    );
    const hasLabel = (beforeLabel.ticket.labels ?? []).includes(
      input.reservationLabel,
    );
    if (
      beforeLabel.ticket.state !== "open" ||
      beforeLabel.blocked ||
      !(beforeLabel.ticket.labels ?? []).includes(readyForAgentLabel) ||
      (beforeLabel.ticket.assignees ?? []).some(
        (assignee) => assignee !== input.runnerAccount,
      ) ||
      hasRunner !== hasLabel
    ) {
      continue;
    }
    const addedLabel = !hasLabel;
    if (addedLabel) {
      await workflowWrite({
        action: () =>
          input.tracker.addLabel(
            input.repository,
            candidate.number,
            input.reservationLabel,
          ),
        audit: input.audit,
        clock: input.clock,
        automaticRetry: {},
        event: (attempt) =>
          input.event(
            "reserve",
            "add_reservation_label",
            `ticket:${candidate.number}`,
          )(attempt),
        operator: input.operator,
      });
    }

    const beforeAssigneeParent = boundaryResult(await readParent(input));
    if (beforeAssigneeParent) return beforeAssigneeParent;
    const beforeAssignee = await revalidateTicket(input, candidate.number);
    if (!beforeAssignee.inScope) continue;
    if (beforeAssignee.ticket.state === "closed") {
      await releaseReservation(
        input,
        candidate.number,
        hasRunner,
        hasLabel ? hasLabel : addedLabel,
      );
      continue;
    }
    if (beforeAssignee.blocked) {
      continue;
    }
    const hasRunnerAfterLabel = (
      beforeAssignee.ticket.assignees ?? []
    ).includes(input.runnerAccount);
    if (!hasRunnerAfterLabel) {
      await workflowWrite({
        action: () =>
          input.tracker.addAssignee(
            input.repository,
            candidate.number,
            input.runnerAccount,
          ),
        audit: input.audit,
        clock: input.clock,
        automaticRetry: {},
        event: (attempt) =>
          input.event(
            "reserve",
            "add_runner_assignee",
            `ticket:${candidate.number}`,
          )(attempt),
        operator: input.operator,
      });
    }

    const checkpointParent = boundaryResult(await readParent(input));
    if (checkpointParent) return checkpointParent;
    const checkpoint = await revalidateTicket(input, candidate.number);
    if (!checkpoint.inScope) continue;
    if (checkpoint.ticket.state === "closed") {
      await releaseReservation(input, candidate.number, true, true);
      continue;
    }
    if (
      checkpoint.blocked ||
      !(checkpoint.ticket.labels ?? []).includes(readyForAgentLabel) ||
      (checkpoint.ticket.assignees ?? []).some(
        (assignee) => assignee !== input.runnerAccount,
      )
    ) {
      continue;
    }
    batch.push(candidate.number);
  }
  return batch.length === 0
    ? null
    : { outcome: "incomplete", batch, reasons: reasons(selection, batch) };
}

async function finalScan(
  input: DiscoveryInput,
  excluded: Set<number>,
): Promise<DiscoveryResult | { outcome: "eligible"; selection: Selection }> {
  const parent = await readParent(input);
  const stopped = boundaryResult(parent);
  if (stopped) return stopped;
  const children = await readChildren(input, "final_scan");
  const selection = await inspect(input, children, "final_scan", excluded);
  if (selection.batch.length > 0) return { outcome: "eligible", selection };
  if (
    children.every(
      (child) =>
        child.state === "closed" &&
        (child.stateReason === "completed" ||
          child.stateReason === "not_planned"),
    )
  ) {
    return { outcome: "close_parent", reasons: [] };
  }
  const remainingReasons = reasons(selection, []);
  return {
    outcome: "incomplete",
    batch: [],
    reasons:
      remainingReasons.length > 0
        ? remainingReasons
        : [
            `Delivery Tickets changed during reservation: ${[...excluded].sort((left, right) => left - right).join(", ")}`,
          ],
  };
}

export async function discoverAndReserve(
  input: DiscoveryInput,
): Promise<DiscoveryResult> {
  const parent = await readParent(input);
  if (parent.state === "closed" && parent.stateReason === "not_planned") {
    return { outcome: "cancelled", reasons: ["Parent Ticket is cancelled"] };
  }
  if (parent.state === "closed" && parent.stateReason === null) {
    return {
      outcome: "failed",
      reasons: ["closed Parent Ticket has no supported closure reason"],
    };
  }
  const children = await readChildren(input, "discover");
  if (parent.state === "closed") {
    const openChildren = children.filter(({ state }) => state === "open");
    return openChildren.length === 0
      ? { outcome: "succeeded", reasons: [] }
      : {
          outcome: "failed",
          reasons: [
            `completed Parent Ticket has open children: ${openChildren.map(({ number }) => number).join(", ")}`,
          ],
        };
  }
  if (children.length === 0)
    return input.hadChildren
      ? { outcome: "close_parent", reasons: [] }
      : { outcome: "no_work", reasons: [] };

  let selection = await inspect(input, children, "discover");
  const attempted = new Set<number>();
  for (;;) {
    if (selection.batch.length > 0) {
      for (const { number } of selection.batch) attempted.add(number);
      const result = await reserve(input, selection);
      if (result) return result;
    }
    const scanned = await finalScan(input, attempted);
    if (scanned.outcome !== "eligible") return scanned;
    selection = scanned.selection;
  }
}
