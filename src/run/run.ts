import type { AuditLog } from "../audit.ts";
import type {
  ChildPage,
  Clock,
  CodeHost,
  OperatorIO,
  Ticket,
  Tracker,
} from "./contracts.ts";
import { externalRead, workflowWrite } from "./operations.ts";

export type RunOutcome =
  "succeeded" | "no_work" | "incomplete" | "cancelled" | "failed";

export interface RunSummary {
  outcome: RunOutcome;
  project: string;
  parentTicket: number;
  targetBranch: string;
  reasons: string[];
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
}

function overrideRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("override is not a ticket");
  }
  return value as Record<string, unknown>;
}

function overrideState(
  ticket: Record<string, unknown>,
): Pick<Ticket, "state" | "stateReason"> {
  if (ticket.state !== "open" && ticket.state !== "closed") {
    throw new Error("override has no usable ticket state");
  }
  if (ticket.state === "open") return { state: "open", stateReason: null };
  if (
    ticket.stateReason !== "completed" &&
    ticket.stateReason !== "not_planned"
  ) {
    throw new Error("override has no usable closure reason");
  }
  return { state: "closed", stateReason: ticket.stateReason };
}

function parseParentOverride(value: string, parentTicket: number): Ticket {
  return {
    number: parentTicket,
    ...overrideState(overrideRecord(JSON.parse(value) as unknown)),
  };
}

function parseChildOverride(value: unknown): Ticket {
  const ticket = overrideRecord(value);
  if (!Number.isSafeInteger(ticket.number) || (ticket.number as number) <= 0) {
    throw new Error("override has no ticket number");
  }
  if (typeof ticket.repository !== "string" || ticket.repository.length === 0) {
    throw new Error("override has no usable repository");
  }
  return {
    number: ticket.number as number,
    ...overrideState(ticket),
    repository: ticket.repository,
  };
}

function parseChildPageOverride(value: string): ChildPage {
  const page = JSON.parse(value) as unknown;
  if (typeof page !== "object" || page === null || Array.isArray(page)) {
    throw new Error("override is not a child page");
  }
  const input = page as Record<string, unknown>;
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
        const parsed = JSON.parse(value) as { defaultBranch?: unknown };
        if (
          typeof parsed.defaultBranch !== "string" ||
          parsed.defaultBranch.length === 0
        ) {
          throw new Error("override has no defaultBranch");
        }
        return parsed.defaultBranch;
      },
      audit: input.audit,
      event: event("startup", "resolve_target_branch", input.repository),
      clock: input.clock,
      operator: input.operator,
    }));
  const parent = await externalRead({
    action: () => input.tracker.getParent(input.repository, input.parentTicket),
    parseOverride: (value) => parseParentOverride(value, input.parentTicket),
    audit: input.audit,
    event: event("discover", "read_parent", `parent:${input.parentTicket}`),
    clock: input.clock,
    operator: input.operator,
  });
  if (parent.state === "closed" && parent.stateReason === "not_planned") {
    return {
      outcome: "cancelled",
      project: input.project,
      parentTicket: input.parentTicket,
      targetBranch,
      reasons: ["Parent Ticket is cancelled"],
    };
  }
  if (parent.state === "closed" && parent.stateReason === null) {
    return {
      outcome: "failed",
      project: input.project,
      parentTicket: input.parentTicket,
      targetBranch,
      reasons: ["closed Parent Ticket has no supported closure reason"],
    };
  }
  const children = [];
  let pageNumber: number | null = 1;
  while (pageNumber !== null) {
    const currentPage = pageNumber;
    const page: ChildPage = await externalRead<ChildPage>({
      action: () =>
        input.tracker.listChildrenPage(
          input.repository,
          input.parentTicket,
          currentPage,
        ),
      parseOverride: parseChildPageOverride,
      audit: input.audit,
      event: event(
        "discover",
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
    (child) =>
      child.repository !== undefined && child.repository !== input.repository,
  );
  if (crossRepositoryChild) {
    return {
      outcome: "failed",
      project: input.project,
      parentTicket: input.parentTicket,
      targetBranch,
      reasons: [
        `cross-repository child ${crossRepositoryChild.repository}#${crossRepositoryChild.number} is unsupported`,
      ],
    };
  }
  if (parent.state === "closed" && parent.stateReason === "completed") {
    const openChildren = children.filter((child) => child.state === "open");
    return {
      outcome: openChildren.length === 0 ? "succeeded" : "failed",
      project: input.project,
      parentTicket: input.parentTicket,
      targetBranch,
      reasons:
        openChildren.length === 0
          ? []
          : [
              `completed Parent Ticket has open children: ${openChildren.map(({ number }) => number).join(", ")}`,
            ],
    };
  }

  if (parent.state === "open" && children.length === 0) {
    return {
      outcome: "no_work",
      project: input.project,
      parentTicket: input.parentTicket,
      targetBranch,
      reasons: [],
    };
  }
  if (
    parent.state === "open" &&
    children.every(
      (child) =>
        child.state === "closed" &&
        (child.stateReason === "completed" ||
          child.stateReason === "not_planned"),
    )
  ) {
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
      reasons: [],
    };
  }
  const openChildren = children.filter((child) => child.state === "open");
  if (openChildren.length > 0) {
    return {
      outcome: "incomplete",
      project: input.project,
      parentTicket: input.parentTicket,
      targetBranch,
      reasons: [
        `open Delivery Tickets: ${openChildren.map(({ number }) => number).join(", ")}`,
      ],
    };
  }
  return {
    outcome: "failed",
    project: input.project,
    parentTicket: input.parentTicket,
    targetBranch,
    reasons: ["Delivery Ticket has an unsupported terminal state"],
  };
}
