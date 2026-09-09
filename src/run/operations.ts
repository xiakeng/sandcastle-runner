import type { AuditEvent, AuditLog } from "../audit.ts";
import type { Clock, OperatorIO } from "./contracts.ts";

export class OperatorCancelled extends Error {}

export async function supervisedAuditWrite(
  action: () => Promise<void>,
  operator: OperatorIO,
): Promise<void> {
  for (;;) {
    try {
      await action();
      return;
    } catch {
      const response = await operator.pause(
        "Audit write failed. Enter to retry, q to cancel, or acknowledge an audit gap.",
      );
      if (response === null || response === "q")
        throw new OperatorCancelled("operator cancelled");
      if (response !== "") return;
    }
  }
}

interface ReadOperation<T> {
  action: () => Promise<T>;
  parseOverride: (value: string) => T;
  audit: AuditLog;
  event: (attempt: number) => Omit<AuditEvent, "result" | "error">;
  clock: Clock;
  operator: OperatorIO;
}

interface WriteOperation {
  action: () => Promise<void>;
  audit: AuditLog;
  event: () => Omit<AuditEvent, "result" | "error">;
  operator: OperatorIO;
}

async function appendPauseEvent(
  audit: AuditLog,
  event: Omit<AuditEvent, "result" | "error">,
  operator: OperatorIO,
  result: string,
): Promise<void> {
  await supervisedAuditWrite(
    () =>
      audit.append({
        ...event,
        operation: "operator_pause",
        result,
        error: null,
      }),
    operator,
  );
}

export async function pauseForOperator(
  audit: AuditLog,
  event: Omit<AuditEvent, "result" | "error">,
  operator: OperatorIO,
  message: string,
): Promise<string> {
  await appendPauseEvent(audit, event, operator, "started");
  const response = await operator.pause(message);
  if (response === null || response === "q") {
    await appendPauseEvent(audit, event, operator, "cancelled");
    throw new OperatorCancelled("operator cancelled");
  }
  if (response === "") await appendPauseEvent(audit, event, operator, "retry");
  return response;
}

export async function externalRead<T>(operation: ReadOperation<T>): Promise<T> {
  for (;;) {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const event = operation.event(attempt);
      await supervisedAuditWrite(
        () =>
          operation.audit.append({ ...event, result: "started", error: null }),
        operation.operator,
      );
      let result: T;
      try {
        result = await operation.action();
      } catch (error) {
        await supervisedAuditWrite(
          () =>
            operation.audit.append({
              ...event,
              result: "failed",
              error:
                error instanceof Error ? error.message : "external read failed",
            }),
          operation.operator,
        );
        if (attempt < 5) await operation.clock.sleep(5000);
        continue;
      }
      await supervisedAuditWrite(
        () =>
          operation.audit.append({
            ...event,
            result: "succeeded",
            error: null,
          }),
        operation.operator,
      );
      return result;
    }

    for (;;) {
      const pauseEvent = operation.event(5);
      const response = await pauseForOperator(
        operation.audit,
        pauseEvent,
        operation.operator,
        "Operation failed. Enter to retry, q to cancel, or supply a trusted result.",
      );
      if (response === "") break;
      let result: T;
      try {
        result = operation.parseOverride(response);
      } catch {
        await appendPauseEvent(
          operation.audit,
          pauseEvent,
          operation.operator,
          "invalid_override",
        );
        // An unusable trusted read result returns to the same Operator Pause.
        continue;
      }
      await appendPauseEvent(
        operation.audit,
        pauseEvent,
        operation.operator,
        "operator_override",
      );
      await supervisedAuditWrite(
        () =>
          operation.audit.append({
            ...operation.event(1),
            result: "operator_override",
            error: null,
          }),
        operation.operator,
      );
      return result;
    }
  }
}

export async function workflowWrite(operation: WriteOperation): Promise<void> {
  for (;;) {
    const event = operation.event();
    await supervisedAuditWrite(
      () =>
        operation.audit.append({ ...event, result: "started", error: null }),
      operation.operator,
    );
    try {
      await operation.action();
    } catch (error) {
      await supervisedAuditWrite(
        () =>
          operation.audit.append({
            ...event,
            result: "failed",
            error:
              error instanceof Error ? error.message : "workflow write failed",
          }),
        operation.operator,
      );
      const response = await pauseForOperator(
        operation.audit,
        event,
        operation.operator,
        "Operation failed. Enter to retry, q to cancel, or acknowledge a trusted successful write.",
      );
      if (response !== "") {
        await appendPauseEvent(
          operation.audit,
          event,
          operation.operator,
          "operator_override",
        );
        await supervisedAuditWrite(
          () =>
            operation.audit.append({
              ...event,
              result: "operator_override",
              error: null,
            }),
          operation.operator,
        );
        return;
      }
      continue;
    }
    await supervisedAuditWrite(
      () =>
        operation.audit.append({ ...event, result: "succeeded", error: null }),
      operation.operator,
    );
    return;
  }
}
