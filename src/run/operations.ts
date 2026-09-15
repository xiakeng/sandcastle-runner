import type { AuditEvent, AuditLog } from "../audit.ts";
import type { Clock, OperatorIO, RetryPolicy } from "./contracts.ts";

export class OperatorCancelled extends Error {}

export function serializeOperator(
  operator: OperatorIO,
  controller: AbortController,
): OperatorIO {
  let tail = Promise.resolve();
  return {
    write(message) {
      operator.write(message);
    },
    async pause(message) {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        if (controller.signal.aborted) return null;
        const response = await operator.pause(message);
        if (response === null || response === "q")
          controller.abort(new OperatorCancelled("operator cancelled"));
        return response;
      } finally {
        release();
      }
    },
  };
}

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
  retryPolicy: RetryPolicy;
}

export type WriteReconciliation<T> =
  { outcome: "pending" } | { outcome: "completed"; result?: T };

interface WriteOperation<T> {
  audit: AuditLog;
  clock: Clock;
  event: (attempt: number) => Omit<AuditEvent, "result" | "error">;
  operator: OperatorIO;
  retryPolicy: RetryPolicy;
  beforeRetry?: () => Promise<void>;
  automaticRetry?: {
    reconcile?: () => Promise<WriteReconciliation<T>>;
  };
}

interface VoidWriteOperation extends WriteOperation<void> {
  action: () => Promise<void>;
  parseOverride?: never;
}

interface ResultWriteOperation<T> extends WriteOperation<T> {
  action: () => Promise<T>;
  parseOverride: (value: string) => T;
}

function transientWriteFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:\b5\d{2}\b|bad gateway|gateway timeout|timed? out|econn(?:reset|refused)|socket hang up|network)/iu.test(
    message,
  );
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

export async function recordOperatorOverride(
  audit: AuditLog,
  event: Omit<AuditEvent, "result" | "error">,
  operator: OperatorIO,
): Promise<void> {
  await appendPauseEvent(audit, event, operator, "operator_override");
  await supervisedAuditWrite(
    () => audit.append({ ...event, result: "operator_override", error: null }),
    operator,
  );
}

export async function pauseForOperator(
  audit: AuditLog,
  event: Omit<AuditEvent, "result" | "error">,
  operator: OperatorIO,
  message: string,
): Promise<string> {
  await supervisedAuditWrite(
    () =>
      audit.append({
        ...event,
        operation: "operator_pause",
        result: "started",
        error: null,
        transition: "pause_started",
      }),
    operator,
  );
  const response = await operator.pause(message);
  if (response === null || response === "q") {
    await supervisedAuditWrite(
      () =>
        audit.append({
          ...event,
          operation: "operator_pause",
          result: "cancelled",
          error: null,
          transition: "cancelled",
        }),
      operator,
    );
    throw new OperatorCancelled("operator cancelled");
  }
  await supervisedAuditWrite(
    () =>
      audit.append({
        ...event,
        operation: "operator_pause",
        result: response === "" ? "retry" : "continue",
        error: null,
        transition: response === "" ? "retry" : "operator_prompt",
      }),
    operator,
  );
  return response;
}

export async function externalRead<T>(operation: ReadOperation<T>): Promise<T> {
  const policy = operation.retryPolicy;
  const maxAttempts = policy.operationRetry + 1;
  const delayFor = (retryIndex: number) =>
    policy.operationRetryDelay[
      Math.min(retryIndex, policy.operationRetryDelay.length - 1)
    ]! * 1000;
  for (;;) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
        if (attempt < maxAttempts)
          await operation.clock.sleep(delayFor(attempt - 1));
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
      const pauseEvent = operation.event(maxAttempts);
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

export function workflowWrite(operation: VoidWriteOperation): Promise<void>;
export function workflowWrite<T>(
  operation: ResultWriteOperation<T>,
): Promise<T>;
export async function workflowWrite<T>(
  operation: VoidWriteOperation | ResultWriteOperation<T>,
): Promise<T | void> {
  const policy = operation.retryPolicy;
  const maxAutomaticRetries = policy.operationRetry;
  let attempt = 1;
  for (;;) {
    const event = operation.event(attempt);
    await supervisedAuditWrite(
      () =>
        operation.audit.append({ ...event, result: "started", error: null }),
      operation.operator,
    );
    const reconciliation = operation.automaticRetry?.reconcile;
    if (reconciliation) {
      const state = await reconciliation();
      if (state.outcome === "completed") {
        await supervisedAuditWrite(
          () =>
            operation.audit.append({
              ...event,
              result: "succeeded",
              error: null,
            }),
          operation.operator,
        );
        return state.result;
      }
    }
    let result: T | void;
    try {
      result = await operation.action();
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
      if (reconciliation) {
        const state = await reconciliation();
        if (state.outcome === "completed") {
          await supervisedAuditWrite(
            () =>
              operation.audit.append({
                ...event,
                result: "succeeded",
                error: null,
              }),
            operation.operator,
          );
          return state.result;
        }
      }
      const delay =
        operation.automaticRetry &&
        transientWriteFailure(error) &&
        attempt <= maxAutomaticRetries
          ? policy.operationRetryDelay[
              Math.min(attempt - 1, policy.operationRetryDelay.length - 1)
            ]! * 1000
          : undefined;
      if (delay !== undefined) {
        await operation.clock.sleep(delay);
        attempt += 1;
        continue;
      }
      for (;;) {
        const response = await pauseForOperator(
          operation.audit,
          event,
          operation.operator,
          "Operation failed. Enter to retry, q to cancel, or acknowledge a trusted successful write.",
        );
        if (response === "") {
          await operation.beforeRetry?.();
          attempt = 1;
          break;
        }
        let result: T | void;
        try {
          result = operation.parseOverride
            ? operation.parseOverride(response)
            : undefined;
        } catch {
          await appendPauseEvent(
            operation.audit,
            event,
            operation.operator,
            "invalid_override",
          );
          continue;
        }
        await recordOperatorOverride(
          operation.audit,
          event,
          operation.operator,
        );
        return result;
      }
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
}
