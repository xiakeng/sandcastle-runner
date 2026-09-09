import type { AuditEvent, AuditLog } from "../audit.ts";
import type {
  BlockerPage,
  ChildPage,
  Clock,
  OperatorIO,
  Ticket,
  Tracker,
} from "./contracts.ts";
import { externalRead } from "./operations.ts";

interface SelectionInput {
  repository: string;
  children: Ticket[];
  tracker: Tracker;
  audit: AuditLog;
  clock: Clock;
  operator: OperatorIO;
  event: (
    operation: string,
    target: string,
  ) => (attempt: number) => Omit<AuditEvent, "result" | "error">;
  runnerAccount: string;
  reservationLabel: string;
}

type RevalidationInput = Omit<SelectionInput, "children"> & {
  parentTicket: number;
  ticket: number;
};

export interface Selection {
  batch: Ticket[];
  blocked: number[];
  externallyOwned: number[];
  reservations: string[];
}

function parseBlocker(value: unknown): Ticket {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("override blocker is not a ticket");
  }
  const blocker = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(blocker.number) ||
    (blocker.number as number) <= 0
  ) {
    throw new Error("override blocker has no ticket number");
  }
  if (blocker.state !== "open" && blocker.state !== "closed") {
    throw new Error("override blocker has no usable ticket state");
  }
  if (
    blocker.state === "closed" &&
    blocker.stateReason !== "completed" &&
    blocker.stateReason !== "not_planned"
  ) {
    throw new Error("override blocker has no usable closure reason");
  }
  return {
    number: blocker.number as number,
    state: blocker.state,
    stateReason:
      blocker.state === "open"
        ? null
        : (blocker.stateReason as "completed" | "not_planned"),
  };
}

function parseBlockerPageOverride(value: string): BlockerPage {
  const input = JSON.parse(value) as Partial<BlockerPage>;
  if (!Array.isArray(input.blockers))
    throw new Error("override has no blockers");
  if (input.nextPage !== null && !Number.isSafeInteger(input.nextPage)) {
    throw new Error("override has no usable next page");
  }
  return {
    blockers: input.blockers.map(parseBlocker),
    nextPage: input.nextPage as number | null,
  };
}

function parseTicketOverride(value: string, ticket: number): Ticket {
  const input = JSON.parse(value) as Record<string, unknown>;
  if (input.state !== "open" && input.state !== "closed") {
    throw new Error("override has no usable ticket state");
  }
  if (
    input.state === "closed" &&
    input.stateReason !== "completed" &&
    input.stateReason !== "not_planned"
  ) {
    throw new Error("override has no usable closure reason");
  }
  if (
    input.assignees !== undefined &&
    (!Array.isArray(input.assignees) ||
      input.assignees.some((assignee) => typeof assignee !== "string"))
  ) {
    throw new Error("override has no usable assignees");
  }
  if (
    input.labels !== undefined &&
    (!Array.isArray(input.labels) ||
      input.labels.some((label) => typeof label !== "string"))
  ) {
    throw new Error("override has no usable labels");
  }
  return {
    number: ticket,
    state: input.state,
    stateReason:
      input.state === "open"
        ? null
        : (input.stateReason as "completed" | "not_planned"),
    ...(input.assignees === undefined
      ? {}
      : { assignees: input.assignees as string[] }),
    ...(input.labels === undefined ? {} : { labels: input.labels as string[] }),
  };
}

function parseChildOverride(value: unknown): Ticket {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("override child is not a ticket");
  }
  const child = value as Record<string, unknown>;
  if (!Number.isSafeInteger(child.number) || (child.number as number) <= 0) {
    throw new Error("override child has no ticket number");
  }
  if (typeof child.repository !== "string" || child.repository.length === 0) {
    throw new Error("override child has no usable repository");
  }
  return {
    ...parseTicketOverride(JSON.stringify(child), child.number as number),
    repository: child.repository,
  };
}

function parseChildPageOverride(value: string): ChildPage {
  const input = JSON.parse(value) as Record<string, unknown>;
  if (!Array.isArray(input.children))
    throw new Error("override has no children");
  if (input.nextPage !== null && !Number.isSafeInteger(input.nextPage)) {
    throw new Error("override has no usable next page");
  }
  return {
    children: input.children.map(parseChildOverride),
    nextPage: input.nextPage as number | null,
  };
}

export async function readChildren(
  input: Omit<SelectionInput, "children"> & { parentTicket: number },
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
        "read_children",
        `parent:${input.parentTicket}:page:${currentPage}`,
      ),
      clock: input.clock,
      operator: input.operator,
    });
    children.push(...page.children);
    pageNumber = page.nextPage;
  }
  return children;
}

async function readBlockers(
  input: Omit<SelectionInput, "children">,
  ticket: number,
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
        "read_blockers",
        `ticket:${ticket}:page:${currentPage}`,
      ),
      clock: input.clock,
      operator: input.operator,
    });
    blockers.push(...page.blockers);
    pageNumber = page.nextPage;
  }
  const invalidBlocker = blockers.find(
    (blocker) =>
      blocker.state === "closed" &&
      blocker.stateReason !== "completed" &&
      blocker.stateReason !== "not_planned",
  );
  if (invalidBlocker)
    throw new Error(
      `blocker ${invalidBlocker.number} has an unsupported terminal state`,
    );
  return blockers;
}

export async function revalidateTicket(
  input: RevalidationInput,
): Promise<
  { inScope: false } | { inScope: true; ticket: Ticket; blocked: boolean }
> {
  const children = await readChildren(input);
  if (!children.some(({ number }) => number === input.ticket)) {
    return { inScope: false };
  }
  const ticket = await externalRead({
    action: () => input.tracker.getTicket(input.repository, input.ticket),
    parseOverride: (value) => parseTicketOverride(value, input.ticket),
    audit: input.audit,
    event: input.event("read_ticket", `ticket:${input.ticket}`),
    clock: input.clock,
    operator: input.operator,
  });
  const blockers = await readBlockers(input, input.ticket);
  return {
    inScope: true,
    ticket,
    blocked: blockers.some((blocker) => blocker.state === "open"),
  };
}

export async function selectBatch(input: SelectionInput): Promise<Selection> {
  const eligible: Ticket[] = [];
  const blocked: number[] = [];
  const externallyOwned: number[] = [];
  const reservations: string[] = [];
  for (const child of input.children) {
    const blockers = await readBlockers(input, child.number);
    if (child.state !== "open") continue;

    const hasRunner = (child.assignees ?? []).includes(input.runnerAccount);
    const hasLabel = (child.labels ?? []).includes(input.reservationLabel);
    const hasExternalOwner = (child.assignees ?? []).some(
      (assignee) => assignee !== input.runnerAccount,
    );
    const hasOpenBlocker = blockers.some((blocker) => blocker.state === "open");
    if (hasExternalOwner) externallyOwned.push(child.number);
    if (hasRunner || hasLabel) {
      reservations.push(
        `${child.number} (${hasRunner && hasLabel ? "complete" : "partial"})`,
      );
    }
    if (hasOpenBlocker) blocked.push(child.number);
    if (!hasExternalOwner && !hasRunner && !hasLabel && !hasOpenBlocker) {
      eligible.push(child);
    }
  }
  return {
    batch: eligible
      .sort((left, right) => left.number - right.number)
      .slice(0, 3),
    blocked: blocked.sort((left, right) => left - right),
    externallyOwned: externallyOwned.sort((left, right) => left - right),
    reservations,
  };
}
