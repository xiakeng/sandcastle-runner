import type { AuditEvent, AuditLog } from "../audit.ts";
import type {
  BlockerPage,
  ChildPage,
  Clock,
  OperatorIO,
  Ticket,
  Tracker,
} from "./contracts.ts";
import { externalRead, workflowWrite } from "./operations.ts";

export interface DiscoveryInput {
  repository: string;
  parentTicket: number;
  tracker: Tracker;
  audit: AuditLog;
  clock: Clock;
  operator: OperatorIO;
  event: (
    phase: string,
    operation: string,
    target: string,
  ) => (attempt: number) => Omit<AuditEvent, "result" | "error">;
  runnerAccount: string;
  reservationLabel: string;
  hadChildren?: boolean;
}

export type DiscoveryResult =
  | {
      outcome: "succeeded" | "no_work" | "cancelled" | "failed";
      reasons: string[];
    }
  | { outcome: "close_parent"; reasons: [] }
  | { outcome: "incomplete"; reasons: string[]; batch: number[] };

interface Selection {
  batch: Ticket[];
  blocked: number[];
  externallyOwned: number[];
  reservations: string[];
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function parseTicket(
  value: unknown,
  expectedNumber?: number,
  requireRepository = false,
): Ticket {
  const input = record(value, "override is not a ticket");
  const number = expectedNumber ?? input.number;
  if (!Number.isSafeInteger(number) || (number as number) <= 0) {
    throw new Error("override has no ticket number");
  }
  if (input.state !== "open" && input.state !== "closed") {
    throw new Error("override has no usable ticket state");
  }
  if (
    input.state === "closed" &&
    input.stateReason !== null &&
    input.stateReason !== "completed" &&
    input.stateReason !== "not_planned"
  ) {
    throw new Error("override has no usable closure reason");
  }
  for (const field of ["assignees", "labels"] as const) {
    if (
      input[field] !== undefined &&
      (!Array.isArray(input[field]) ||
        input[field].some((item) => typeof item !== "string"))
    ) {
      throw new Error(`override has no usable ${field}`);
    }
  }
  if (
    requireRepository &&
    (typeof input.repository !== "string" || input.repository.length === 0)
  ) {
    throw new Error("override has no usable repository");
  }
  return {
    number: number as number,
    state: input.state,
    stateReason:
      input.state === "open"
        ? null
        : (input.stateReason as "completed" | "not_planned" | null),
    ...(typeof input.repository === "string"
      ? { repository: input.repository }
      : {}),
    ...(input.assignees === undefined
      ? {}
      : { assignees: input.assignees as string[] }),
    ...(input.labels === undefined ? {} : { labels: input.labels as string[] }),
  };
}

function parseChildPageOverride(value: string): ChildPage {
  const input = record(
    JSON.parse(value) as unknown,
    "override is not a child page",
  );
  if (!Array.isArray(input.children))
    throw new Error("override has no children");
  if (input.nextPage !== null && !Number.isSafeInteger(input.nextPage)) {
    throw new Error("override has no usable next page");
  }
  return {
    children: input.children.map((child) =>
      parseTicket(child, undefined, true),
    ),
    nextPage: input.nextPage as number | null,
  };
}

function parseBlockerPageOverride(value: string): BlockerPage {
  const input = record(
    JSON.parse(value) as unknown,
    "override is not a blocker page",
  );
  if (!Array.isArray(input.blockers))
    throw new Error("override has no blockers");
  if (input.nextPage !== null && !Number.isSafeInteger(input.nextPage)) {
    throw new Error("override has no usable next page");
  }
  return {
    blockers: input.blockers.map((blocker) => parseTicket(blocker)),
    nextPage: input.nextPage as number | null,
  };
}

async function readParent(
  input: DiscoveryInput,
  phase = "discover",
): Promise<Ticket> {
  return externalRead({
    action: () => input.tracker.getParent(input.repository, input.parentTicket),
    parseOverride: (value) =>
      parseTicket(JSON.parse(value) as unknown, input.parentTicket),
    audit: input.audit,
    event: input.event(phase, "read_parent", `parent:${input.parentTicket}`),
    clock: input.clock,
    operator: input.operator,
  });
}

async function readChildren(
  input: DiscoveryInput,
  phase: string,
): Promise<Ticket[]> {
  const children: Ticket[] = [];
  let pageNumber: number | null = 1;
  while (pageNumber !== null) {
    const currentPage: number = pageNumber;
    const page: ChildPage = await externalRead<ChildPage>({
      action: () =>
        input.tracker.listChildrenPage(
          input.repository,
          input.parentTicket,
          currentPage,
        ),
      parseOverride: parseChildPageOverride,
      audit: input.audit,
      event: input.event(
        phase,
        "read_children",
        `parent:${input.parentTicket}:page:${currentPage}`,
      ),
      clock: input.clock,
      operator: input.operator,
    });
    children.push(...page.children);
    pageNumber = page.nextPage;
  }
  const crossRepositoryChild = children.find(
    ({ repository }) => repository !== input.repository,
  );
  if (crossRepositoryChild) {
    throw new Error(
      `cross-repository child ${crossRepositoryChild.repository}#${crossRepositoryChild.number} is unsupported`,
    );
  }
  return children;
}

async function readBlockers(
  input: DiscoveryInput,
  ticket: number,
  phase: string,
): Promise<Ticket[]> {
  const blockers: Ticket[] = [];
  let pageNumber: number | null = 1;
  while (pageNumber !== null) {
    const currentPage: number = pageNumber;
    const page: BlockerPage = await externalRead<BlockerPage>({
      action: () =>
        input.tracker.listBlockersPage(input.repository, ticket, currentPage),
      parseOverride: parseBlockerPageOverride,
      audit: input.audit,
      event: input.event(
        phase,
        "read_blockers",
        `ticket:${ticket}:page:${currentPage}`,
      ),
      clock: input.clock,
      operator: input.operator,
    });
    blockers.push(...page.blockers);
    pageNumber = page.nextPage;
  }
  return blockers;
}

async function inspect(
  input: DiscoveryInput,
  children: Ticket[],
  phase: string,
  excluded = new Set<number>(),
): Promise<Selection> {
  const eligible: Ticket[] = [];
  const blocked: number[] = [];
  const externallyOwned: number[] = [];
  const reservations: { number: number; state: string }[] = [];
  for (const child of children) {
    const blockers = await readBlockers(input, child.number, phase);
    const invalidBlocker = blockers.find(
      ({ state, stateReason }) => state === "closed" && stateReason === null,
    );
    if (invalidBlocker) {
      throw new Error(
        `blocker ${invalidBlocker.number} has an unsupported terminal state`,
      );
    }
    if (child.state === "closed" && child.stateReason === null) {
      throw new Error(
        `Delivery Ticket ${child.number} has an unsupported terminal state`,
      );
    }
    if (child.state !== "open") continue;
    const hasRunner = (child.assignees ?? []).includes(input.runnerAccount);
    const hasLabel = (child.labels ?? []).includes(input.reservationLabel);
    const hasExternalOwner = (child.assignees ?? []).some(
      (assignee) => assignee !== input.runnerAccount,
    );
    const hasOpenBlocker = blockers.some(({ state }) => state === "open");
    if (hasExternalOwner) externallyOwned.push(child.number);
    if (hasRunner || hasLabel) {
      reservations.push({
        number: child.number,
        state: hasRunner && hasLabel ? "complete" : "partial",
      });
    }
    if (hasOpenBlocker) blocked.push(child.number);
    if (
      !excluded.has(child.number) &&
      !hasExternalOwner &&
      !hasRunner &&
      !hasLabel &&
      !hasOpenBlocker
    ) {
      eligible.push(child);
    }
  }
  return {
    batch: eligible
      .sort((left, right) => left.number - right.number)
      .slice(0, 3),
    blocked: blocked.sort((left, right) => left - right),
    externallyOwned: externallyOwned.sort((left, right) => left - right),
    reservations: reservations
      .sort((left, right) => left.number - right.number)
      .map(({ number, state }) => `${number} (${state})`),
  };
}

async function revalidateTicket(
  input: DiscoveryInput,
  ticketNumber: number,
): Promise<
  { inScope: false } | { inScope: true; ticket: Ticket; blocked: boolean }
> {
  const children = await readChildren(input, "revalidate");
  if (!children.some(({ number }) => number === ticketNumber)) {
    return { inScope: false };
  }
  const ticket = await externalRead({
    action: () => input.tracker.getTicket(input.repository, ticketNumber),
    parseOverride: (value) =>
      parseTicket(JSON.parse(value) as unknown, ticketNumber),
    audit: input.audit,
    event: input.event("revalidate", "read_ticket", `ticket:${ticketNumber}`),
    clock: input.clock,
    operator: input.operator,
  });
  if (ticket.state === "closed" && ticket.stateReason === null) {
    throw new Error(
      `Delivery Ticket ${ticket.number} has an unsupported terminal state`,
    );
  }
  const blockers = await readBlockers(input, ticketNumber, "revalidate");
  return {
    inScope: true,
    ticket,
    blocked: blockers.some(({ state }) => state === "open"),
  };
}

function boundaryResult(parent: Ticket): DiscoveryResult | null {
  if (parent.state === "open") return null;
  return parent.stateReason === "not_planned"
    ? { outcome: "cancelled", reasons: ["Parent Ticket is cancelled"] }
    : {
        outcome: "failed",
        reasons: ["Parent Ticket changed to a terminal state"],
      };
}

async function releaseReservation(
  input: DiscoveryInput,
  ticket: number,
  removeAssignee: boolean,
  removeLabel: boolean,
): Promise<void> {
  if (removeAssignee) {
    await workflowWrite({
      action: () =>
        input.tracker.removeAssignee(
          input.repository,
          ticket,
          input.runnerAccount,
        ),
      audit: input.audit,
      event: () =>
        input.event("release", "remove_runner_assignee", `ticket:${ticket}`)(1),
      operator: input.operator,
    });
  }
  if (removeLabel) {
    await workflowWrite({
      action: () =>
        input.tracker.removeLabel(
          input.repository,
          ticket,
          input.reservationLabel,
        ),
      audit: input.audit,
      event: () =>
        input.event(
          "release",
          "remove_reservation_label",
          `ticket:${ticket}`,
        )(1),
      operator: input.operator,
    });
  }
}

export type DeliveryBoundaryResult =
  | { outcome: "ready" }
  | { outcome: "cancelled" | "failed" | "stopped"; reason: string };

export type MergedDeliveryBoundaryResult =
  | Exclude<DeliveryBoundaryResult, { outcome: "ready" }>
  | { outcome: "ready"; ticket: Ticket }
  | { outcome: "terminal"; ticket: Ticket };

async function revalidateReserved(
  input: DiscoveryInput,
  ticketNumber: number,
): Promise<MergedDeliveryBoundaryResult> {
  const parentResult = boundaryResult(await readParent(input, "revalidate"));
  if (parentResult) {
    return {
      outcome: parentResult.outcome === "cancelled" ? "cancelled" : "failed",
      reason: parentResult.reasons[0] ?? "Parent Ticket changed",
    };
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
    if (
      !beforeLabel.inScope ||
      beforeLabel.ticket.state !== "open" ||
      beforeLabel.blocked ||
      (beforeLabel.ticket.assignees ?? []).length > 0 ||
      (beforeLabel.ticket.labels ?? []).includes(input.reservationLabel)
    ) {
      continue;
    }
    await workflowWrite({
      action: () =>
        input.tracker.addLabel(
          input.repository,
          candidate.number,
          input.reservationLabel,
        ),
      audit: input.audit,
      event: () =>
        input.event(
          "reserve",
          "add_reservation_label",
          `ticket:${candidate.number}`,
        )(1),
      operator: input.operator,
    });

    const beforeAssigneeParent = boundaryResult(await readParent(input));
    if (beforeAssigneeParent) return beforeAssigneeParent;
    const beforeAssignee = await revalidateTicket(input, candidate.number);
    if (!beforeAssignee.inScope) continue;
    if (beforeAssignee.ticket.state === "closed") {
      await releaseReservation(input, candidate.number, false, true);
      continue;
    }
    if (
      beforeAssignee.blocked ||
      (beforeAssignee.ticket.assignees ?? []).some(
        (assignee) => assignee !== input.runnerAccount,
      ) ||
      (beforeAssignee.ticket.assignees ?? []).includes(input.runnerAccount)
    ) {
      continue;
    }
    await workflowWrite({
      action: () =>
        input.tracker.addAssignee(
          input.repository,
          candidate.number,
          input.runnerAccount,
        ),
      audit: input.audit,
      event: () =>
        input.event(
          "reserve",
          "add_runner_assignee",
          `ticket:${candidate.number}`,
        )(1),
      operator: input.operator,
    });

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
