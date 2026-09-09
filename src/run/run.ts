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

function parseTicketOverride(value: unknown): Ticket {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("override is not a ticket");
  }
  const ticket = value as Record<string, unknown>;
  if (!Number.isSafeInteger(ticket.number) || (ticket.number as number) <= 0) {
    throw new Error("override has no ticket number");
  }
  if (ticket.state !== "open" && ticket.state !== "closed") {
    throw new Error("override has no usable ticket state");
  }
  if (
    ticket.stateReason !== null &&
    ticket.stateReason !== "completed" &&
    ticket.stateReason !== "not_planned"
  ) {
    throw new Error("override has no usable closure reason");
  }
  if (
    ticket.repository !== undefined &&
    typeof ticket.repository !== "string"
  ) {
    throw new Error("override has no usable repository");
  }
  return {
    number: ticket.number as number,
    state: ticket.state,
    stateReason: ticket.stateReason,
    ...(ticket.repository === undefined
      ? {}
      : { repository: ticket.repository }),
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
    children: input.children.map(parseTicketOverride),
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
      action: () => input.codeHost.getDefaultBranch(input.repository),
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
      event: event("startup", "read_default_branch", input.repository),
      clock: input.clock,
      operator: input.operator,
    }));
  const parent = await externalRead({
    action: () => input.tracker.getParent(input.repository, input.parentTicket),
    parseOverride: (value) => parseTicketOverride(JSON.parse(value) as unknown),
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
