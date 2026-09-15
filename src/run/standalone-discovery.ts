import { workflowWrite } from "./operations.ts";
import {
  revalidateTicket,
  releaseReservation,
  readyForAgentLabel,
  type DiscoveryInput,
} from "./discovery-state.ts";
import type { DiscoveryResult } from "./discovery.ts";

export async function discoverAndReserveStandalone(
  input: DiscoveryInput & { standaloneIssue: number },
): Promise<DiscoveryResult> {
  const result = await revalidateTicket(input, input.standaloneIssue);
  if (!result.inScope) return { outcome: "no_work", reasons: [] };
  if (result.ticket.state === "closed") {
    return result.ticket.stateReason === "completed" ||
      result.ticket.stateReason === "not_planned"
      ? { outcome: "no_work", reasons: [] }
      : {
          outcome: "failed",
          reasons: [
            `Delivery Ticket ${input.standaloneIssue} has no supported closure reason`,
          ],
        };
  }
  if (!(result.ticket.labels ?? []).includes(readyForAgentLabel)) {
    return {
      outcome: "incomplete",
      batch: [],
      reasons: [
        `Delivery Ticket ${input.standaloneIssue} is missing ready-for-agent`,
      ],
    };
  }
  if (result.blocked) {
    return {
      outcome: "incomplete",
      batch: [],
      reasons: [`blocked Delivery Tickets: ${input.standaloneIssue}`],
    };
  }
  if (
    (result.ticket.assignees ?? []).some(
      (assignee) => assignee !== input.runnerAccount,
    )
  ) {
    return {
      outcome: "incomplete",
      batch: [],
      reasons: [`externally owned Delivery Tickets: ${input.standaloneIssue}`],
    };
  }
  const hasRunner = (result.ticket.assignees ?? []).includes(
    input.runnerAccount,
  );
  const hasReservation = (result.ticket.labels ?? []).includes(
    input.reservationLabel,
  );
  if (hasRunner !== hasReservation) {
    return {
      outcome: "incomplete",
      batch: [],
      reasons: [`existing Reservations: ${input.standaloneIssue} (partial)`],
    };
  }
  if (!hasRunner) {
    await workflowWrite({
      action: () =>
        input.tracker.addLabel(
          input.repository,
          input.standaloneIssue,
          input.reservationLabel,
        ),
      audit: input.audit,
      clock: input.clock,
      automaticRetry: {},
      event: (attempt) =>
        input.event(
          "reserve",
          "add_reservation_label",
          `ticket:${input.standaloneIssue}`,
        )(attempt),
      operator: input.operator,
      retryPolicy: input.retryPolicy,
    });
    await workflowWrite({
      action: () =>
        input.tracker.addAssignee(
          input.repository,
          input.standaloneIssue,
          input.runnerAccount,
        ),
      audit: input.audit,
      clock: input.clock,
      automaticRetry: {},
      event: (attempt) =>
        input.event(
          "reserve",
          "add_runner_assignee",
          `ticket:${input.standaloneIssue}`,
        )(attempt),
      operator: input.operator,
      retryPolicy: input.retryPolicy,
    });
  }
  const checkpoint = await revalidateTicket(input, input.standaloneIssue);
  if (checkpoint.inScope && checkpoint.ticket.state === "closed") {
    await releaseReservation(
      input,
      checkpoint.ticket.number,
      (checkpoint.ticket.assignees ?? []).includes(input.runnerAccount),
      (checkpoint.ticket.labels ?? []).includes(input.reservationLabel),
    );
    await input.cleanupTerminal?.(checkpoint.ticket.number);
    return checkpoint.ticket.stateReason === "completed" ||
      checkpoint.ticket.stateReason === "not_planned"
      ? { outcome: "no_work", reasons: [] }
      : {
          outcome: "failed",
          reasons: [
            `Delivery Ticket ${input.standaloneIssue} has no supported closure reason`,
          ],
        };
  }
  if (
    !checkpoint.inScope ||
    checkpoint.ticket.state !== "open" ||
    checkpoint.blocked ||
    !(checkpoint.ticket.labels ?? []).includes(readyForAgentLabel) ||
    (checkpoint.ticket.assignees ?? []).some(
      (assignee) => assignee !== input.runnerAccount,
    ) ||
    !(checkpoint.ticket.assignees ?? []).includes(input.runnerAccount) ||
    !(checkpoint.ticket.labels ?? []).includes(input.reservationLabel)
  ) {
    return {
      outcome: "incomplete",
      batch: [],
      reasons: [
        `Delivery Ticket ${input.standaloneIssue} changed during reservation`,
      ],
    };
  }
  return {
    outcome: "incomplete",
    batch: [input.standaloneIssue],
    reasons: [`reserved Delivery Tickets: ${input.standaloneIssue}`],
  };
}

export async function discoverAndReserveStandaloneBatch(
  input: DiscoveryInput & { standaloneIssues: number[] },
): Promise<DiscoveryResult> {
  const eligible: number[] = [];
  const reasons: string[] = [];
  for (const issue of input.standaloneIssues) {
    const result = await revalidateTicket(input, issue);
    if (!result.inScope) continue;
    if (result.ticket.state === "closed") {
      if (
        result.ticket.stateReason !== "completed" &&
        result.ticket.stateReason !== "not_planned"
      ) {
        return {
          outcome: "failed",
          reasons: [`Delivery Ticket ${issue} has no supported closure reason`],
        };
      }
      continue;
    }
    if (!(result.ticket.labels ?? []).includes(readyForAgentLabel))
      reasons.push(`Delivery Ticket ${issue} is missing ready-for-agent`);
    else if (result.blocked) reasons.push(`blocked Delivery Tickets: ${issue}`);
    else if (
      (result.ticket.assignees ?? []).some(
        (assignee) => assignee !== input.runnerAccount,
      )
    ) {
      reasons.push(`externally owned Delivery Tickets: ${issue}`);
    } else {
      const hasRunner = (result.ticket.assignees ?? []).includes(
        input.runnerAccount,
      );
      const hasReservation = (result.ticket.labels ?? []).includes(
        input.reservationLabel,
      );
      if (hasRunner !== hasReservation)
        reasons.push(`existing Reservations: ${issue} (partial)`);
      else eligible.push(issue);
    }
  }
  if (reasons.length > 0) return { outcome: "incomplete", batch: [], reasons };
  const reserved: number[] = [];
  for (const issue of eligible.slice(0, 3)) {
    const result = await discoverAndReserveStandalone({
      ...input,
      standaloneIssue: issue,
      standaloneIssues: [issue],
    });
    if (result.outcome !== "incomplete" || result.batch.length === 0) {
      return reserved.length === 0
        ? result
        : {
            outcome: "incomplete",
            batch: reserved,
            reasons: [...reasons, ...result.reasons],
          };
    }
    reserved.push(...result.batch);
  }
  return reserved.length === 0
    ? { outcome: "no_work", reasons: [] }
    : {
        outcome: "incomplete",
        batch: reserved,
        reasons: [`reserved Delivery Tickets: ${reserved.join(", ")}`],
      };
}
