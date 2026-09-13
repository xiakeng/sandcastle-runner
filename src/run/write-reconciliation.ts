import type { AuditEvent } from "../audit.ts";
import type { Ticket } from "./contracts.ts";
import {
  externalRead,
  OperatorCancelled,
  type WriteReconciliation,
} from "./operations.ts";
import type { PublicationInput } from "./pull-request-core.ts";
import type { RunInput } from "./run-input.ts";

type EventFactory = (
  phase: string,
  operation: string,
  target: string,
) => (attempt: number) => Omit<AuditEvent, "result" | "error">;

export function parentClosureOverride(value: string): Ticket {
  const parsed = JSON.parse(value) as {
    number?: unknown;
    state?: unknown;
    state_reason?: unknown;
  };
  if (
    !Number.isSafeInteger(parsed.number) ||
    (parsed.state !== "open" && parsed.state !== "closed") ||
    (parsed.state_reason !== null &&
      parsed.state_reason !== "completed" &&
      parsed.state_reason !== "not_planned")
  ) {
    throw new Error("override has invalid Parent Ticket state");
  }
  return {
    number: parsed.number,
    state: parsed.state,
    stateReason: parsed.state_reason,
  } as Ticket;
}

export function parentClosureReconciliation(
  input: RunInput,
  event: EventFactory,
): () => Promise<WriteReconciliation<void>> {
  return async () => {
    const parent = await externalRead({
      action: () =>
        input.tracker.getParent(input.repository, input.parentTicket),
      parseOverride: parentClosureOverride,
      audit: input.audit,
      event: event(
        "close_parent",
        "read_parent_state",
        `parent:${input.parentTicket}`,
      ),
      clock: input.clock,
      operator: input.operator,
    });
    if (parent.state === "closed" && parent.stateReason === "not_planned")
      throw new OperatorCancelled("Parent Ticket is cancelled");
    return parent.state === "closed" && parent.stateReason === "completed"
      ? { outcome: "completed" }
      : { outcome: "pending" };
  };
}

export function remoteHeadOverride(value: string): string | null {
  const parsed = JSON.parse(value) as { headSha?: unknown };
  if (parsed.headSha !== null && typeof parsed.headSha !== "string")
    throw new Error("override has invalid remote branch head");
  return parsed.headSha ?? null;
}

export function remoteBranchReconciliation(
  input: PublicationInput,
  phase: string,
  remoteBranch: string,
  expectedHead: string,
  target: string,
): () => Promise<WriteReconciliation<void>> {
  return async () => {
    const currentHead = await externalRead({
      action: () =>
        input.codeHost.getRemoteBranchHead(input.repository, remoteBranch),
      parseOverride: remoteHeadOverride,
      audit: input.audit,
      event: input.event(phase, "remote_branch_head", target),
      clock: input.clock,
      operator: input.operator,
    });
    return currentHead === expectedHead
      ? { outcome: "completed" }
      : { outcome: "pending" };
  };
}
