import type { AuditLog } from "../audit.ts";
import type {
  Clock,
  CodeHost,
  OperatorIO,
  Ticket,
  Tracker,
} from "./contracts.ts";
import { readChildren, revalidateTicket, selectBatch } from "./discovery.ts";
import { externalRead, workflowWrite } from "./operations.ts";

export type RunOutcome =
  "succeeded" | "no_work" | "incomplete" | "cancelled" | "failed";

export interface RunSummary {
  outcome: RunOutcome;
  project: string;
  parentTicket: number;
  targetBranch: string;
  reasons: string[];
  batch?: number[];
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
    ticket.stateReason !== null &&
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
  const readParent = () =>
    externalRead({
      action: () =>
        input.tracker.getParent(input.repository, input.parentTicket),
      parseOverride: (value) => parseParentOverride(value, input.parentTicket),
      audit: input.audit,
      event: event("discover", "read_parent", `parent:${input.parentTicket}`),
      clock: input.clock,
      operator: input.operator,
    });
  const releaseReservation = async (
    ticket: number,
    removeAssignee: boolean,
    removeLabel: boolean,
  ) => {
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
          event("release", "remove_runner_assignee", `ticket:${ticket}`)(1),
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
          event("release", "remove_reservation_label", `ticket:${ticket}`)(1),
        operator: input.operator,
      });
    }
  };
  const parent = await readParent();
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
  let children = await readChildren({
    repository: input.repository,
    parentTicket: input.parentTicket,
    tracker: input.tracker,
    audit: input.audit,
    clock: input.clock,
    operator: input.operator,
    event: (operation, target) => event("discover", operation, target),
    runnerAccount: input.runnerAccount,
    reservationLabel: input.reservationLabel,
  });

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
  const inspect = (tickets: Ticket[], phase: string) =>
    selectBatch({
      repository: input.repository,
      children: tickets,
      tracker: input.tracker,
      audit: input.audit,
      clock: input.clock,
      operator: input.operator,
      event: (operation, target) => event(phase, operation, target),
      runnerAccount: input.runnerAccount,
      reservationLabel: input.reservationLabel,
    });
  let selection = await inspect(children, "discover");
  if (
    parent.state === "open" &&
    children.every(
      (child) =>
        child.state === "closed" &&
        (child.stateReason === "completed" ||
          child.stateReason === "not_planned"),
    )
  ) {
    const finalParent = await readParent();
    children = await readChildren({
      repository: input.repository,
      parentTicket: input.parentTicket,
      tracker: input.tracker,
      audit: input.audit,
      clock: input.clock,
      operator: input.operator,
      event: (operation, target) => event("final_scan", operation, target),
      runnerAccount: input.runnerAccount,
      reservationLabel: input.reservationLabel,
    });
    const finalCrossRepositoryChild = children.find(
      (child) => child.repository !== input.repository,
    );
    if (finalCrossRepositoryChild) {
      return {
        outcome: "failed",
        project: input.project,
        parentTicket: input.parentTicket,
        targetBranch,
        reasons: [
          `cross-repository child ${finalCrossRepositoryChild.repository}#${finalCrossRepositoryChild.number} is unsupported`,
        ],
      };
    }
    if (
      finalParent.state === "closed" &&
      finalParent.stateReason === "not_planned"
    ) {
      return {
        outcome: "cancelled",
        project: input.project,
        parentTicket: input.parentTicket,
        targetBranch,
        reasons: ["Parent Ticket is cancelled"],
      };
    }
    selection = await inspect(children, "final_scan");
    if (finalParent.state === "closed") {
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
    if (
      children.some(
        (child) =>
          child.state !== "closed" ||
          (child.stateReason !== "completed" &&
            child.stateReason !== "not_planned"),
      )
    ) {
      // Newly visible work must pass through ordinary selection below.
    } else {
      for (const child of children) {
        await releaseReservation(
          child.number,
          (child.assignees ?? []).includes(input.runnerAccount),
          (child.labels ?? []).includes(input.reservationLabel),
        );
      }
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
  }
  const openChildren = children.filter((child) => child.state === "open");
  if (openChildren.length > 0) {
    if (selection.batch.length === 0) {
      const finalParent = await readParent();
      if (
        finalParent.state === "closed" &&
        finalParent.stateReason === "not_planned"
      ) {
        return {
          outcome: "cancelled",
          project: input.project,
          parentTicket: input.parentTicket,
          targetBranch,
          reasons: ["Parent Ticket is cancelled"],
        };
      }
      if (finalParent.state === "closed") {
        return {
          outcome: "failed",
          project: input.project,
          parentTicket: input.parentTicket,
          targetBranch,
          reasons: ["Parent Ticket changed to a terminal state"],
        };
      }
      const finalChildren = await readChildren({
        repository: input.repository,
        parentTicket: input.parentTicket,
        tracker: input.tracker,
        audit: input.audit,
        clock: input.clock,
        operator: input.operator,
        event: (operation, target) => event("final_scan", operation, target),
        runnerAccount: input.runnerAccount,
        reservationLabel: input.reservationLabel,
      });
      const finalCrossRepositoryChild = finalChildren.find(
        (child) => child.repository !== input.repository,
      );
      if (finalCrossRepositoryChild) {
        return {
          outcome: "failed",
          project: input.project,
          parentTicket: input.parentTicket,
          targetBranch,
          reasons: [
            `cross-repository child ${finalCrossRepositoryChild.repository}#${finalCrossRepositoryChild.number} is unsupported`,
          ],
        };
      }
      selection = await inspect(finalChildren, "final_scan");
    }
    const reservedBatch: number[] = [];
    for (const child of selection.batch) {
      const revalidatedParent = await readParent();
      if (
        revalidatedParent.state === "closed" &&
        revalidatedParent.stateReason === "not_planned"
      ) {
        return {
          outcome: "cancelled",
          project: input.project,
          parentTicket: input.parentTicket,
          targetBranch,
          reasons: ["Parent Ticket is cancelled"],
        };
      }
      if (revalidatedParent.state === "closed") {
        return {
          outcome: "failed",
          project: input.project,
          parentTicket: input.parentTicket,
          targetBranch,
          reasons: ["Parent Ticket changed to a terminal state"],
        };
      }
      const beforeLabel = await revalidateTicket({
        repository: input.repository,
        parentTicket: input.parentTicket,
        ticket: child.number,
        tracker: input.tracker,
        audit: input.audit,
        clock: input.clock,
        operator: input.operator,
        event: (operation, target) => event("revalidate", operation, target),
        runnerAccount: input.runnerAccount,
        reservationLabel: input.reservationLabel,
      });
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
            child.number,
            input.reservationLabel,
          ),
        audit: input.audit,
        event: () =>
          event(
            "reserve",
            "add_reservation_label",
            `ticket:${child.number}`,
          )(1),
        operator: input.operator,
      });
      const parentBeforeAssignee = await readParent();
      if (
        parentBeforeAssignee.state === "closed" &&
        parentBeforeAssignee.stateReason === "not_planned"
      ) {
        return {
          outcome: "cancelled",
          project: input.project,
          parentTicket: input.parentTicket,
          targetBranch,
          reasons: ["Parent Ticket is cancelled"],
        };
      }
      if (parentBeforeAssignee.state === "closed") {
        return {
          outcome: "failed",
          project: input.project,
          parentTicket: input.parentTicket,
          targetBranch,
          reasons: ["Parent Ticket changed to a terminal state"],
        };
      }
      const beforeAssignee = await revalidateTicket({
        repository: input.repository,
        parentTicket: input.parentTicket,
        ticket: child.number,
        tracker: input.tracker,
        audit: input.audit,
        clock: input.clock,
        operator: input.operator,
        event: (operation, target) => event("revalidate", operation, target),
        runnerAccount: input.runnerAccount,
        reservationLabel: input.reservationLabel,
      });
      if (!beforeAssignee.inScope) continue;
      if (beforeAssignee.ticket.state === "closed") {
        await releaseReservation(child.number, false, true);
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
            child.number,
            input.runnerAccount,
          ),
        audit: input.audit,
        event: () =>
          event("reserve", "add_runner_assignee", `ticket:${child.number}`)(1),
        operator: input.operator,
      });
      const parentBeforeCheckpoint = await readParent();
      if (
        parentBeforeCheckpoint.state === "closed" &&
        parentBeforeCheckpoint.stateReason === "not_planned"
      ) {
        return {
          outcome: "cancelled",
          project: input.project,
          parentTicket: input.parentTicket,
          targetBranch,
          reasons: ["Parent Ticket is cancelled"],
        };
      }
      if (parentBeforeCheckpoint.state === "closed") {
        return {
          outcome: "failed",
          project: input.project,
          parentTicket: input.parentTicket,
          targetBranch,
          reasons: ["Parent Ticket changed to a terminal state"],
        };
      }
      const atCheckpoint = await revalidateTicket({
        repository: input.repository,
        parentTicket: input.parentTicket,
        ticket: child.number,
        tracker: input.tracker,
        audit: input.audit,
        clock: input.clock,
        operator: input.operator,
        event: (operation, target) => event("revalidate", operation, target),
        runnerAccount: input.runnerAccount,
        reservationLabel: input.reservationLabel,
      });
      if (!atCheckpoint.inScope) continue;
      if (atCheckpoint.ticket.state === "closed") {
        await releaseReservation(child.number, true, true);
        continue;
      }
      if (
        atCheckpoint.blocked ||
        (atCheckpoint.ticket.assignees ?? []).some(
          (assignee) => assignee !== input.runnerAccount,
        )
      ) {
        continue;
      }
      reservedBatch.push(child.number);
    }
    return {
      outcome: "incomplete",
      project: input.project,
      parentTicket: input.parentTicket,
      targetBranch,
      reasons: [
        ...(reservedBatch.length > 0
          ? [`reserved Delivery Tickets: ${reservedBatch.join(", ")}`]
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
      ],
      batch: reservedBatch,
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
