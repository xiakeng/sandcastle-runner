import assert from "node:assert/strict";
import test from "node:test";

import type { AuditLog } from "../../src/audit.ts";
import {
  externalRead,
  workflowWrite,
  type WriteReconciliation,
} from "../../src/run/operations.ts";
import type { Clock, OperatorIO } from "../../src/run/contracts.ts";

function dependencies() {
  const sleeps: number[] = [];
  let now = 0;
  const clock: Clock = {
    now: () => new Date(now),
    async sleep(milliseconds) {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
  };
  const audit = { append: async () => {} } as unknown as AuditLog;
  const pauses: string[] = [];
  const operator: OperatorIO = {
    write() {},
    async pause(message) {
      pauses.push(message);
      return "q";
    },
  };
  return { audit, clock, operator, pauses, sleeps };
}

test("workflowWrite retries directly with bounded exponential backoff", async () => {
  const { audit, clock, operator, pauses, sleeps } = dependencies();
  let calls = 0;

  await workflowWrite({
    action: async () => {
      calls += 1;
      if (calls < 5) throw new Error("502 Bad Gateway");
    },
    audit,
    clock,
    event: (attempt) => ({
      timestamp: new Date().toISOString(),
      runId: "run",
      project: "project",
      parentTicket: 1,
      phase: "test",
      operation: "write",
      target: "target",
      attempt,
    }),
    operator,
    automaticRetry: {},
  });

  assert.equal(calls, 5);
  assert.deepEqual(sleeps, [10_000, 20_000, 40_000, 80_000]);
  assert.deepEqual(pauses, []);
});

test("workflowWrite confirms state before the first write and after failure", async () => {
  const { audit, clock, operator, pauses, sleeps } = dependencies();
  let calls = 0;
  let confirmations = 0;
  const reconciliations: WriteReconciliation<void>[] = [
    { outcome: "pending" },
    { outcome: "completed" },
  ];

  await workflowWrite({
    action: async () => {
      calls += 1;
      throw new Error("write response was not observed");
    },
    audit,
    clock,
    event: (attempt) => ({
      timestamp: new Date().toISOString(),
      runId: "run",
      project: "project",
      parentTicket: 1,
      phase: "test",
      operation: "write",
      target: "target",
      attempt,
    }),
    operator,
    automaticRetry: {
      async reconcile() {
        confirmations += 1;
        return reconciliations.shift()!;
      },
    },
  });

  assert.equal(calls, 1);
  assert.equal(confirmations, 2);
  assert.deepEqual(sleeps, []);
  assert.deepEqual(pauses, []);
});

test("workflowWrite uses configured retry count and clamps the final delay", async () => {
  const { clock, operator, pauses, sleeps, audit } = dependencies();
  let calls = 0;

  await workflowWrite({
    action: async () => {
      calls += 1;
      if (calls < 4) throw new Error("502 Bad Gateway");
    },
    audit,
    clock,
    event: (attempt) => ({
      timestamp: new Date().toISOString(),
      runId: "run",
      project: "project",
      parentTicket: 1,
      phase: "test",
      operation: "write",
      target: "target",
      attempt,
    }),
    operator,
    automaticRetry: {},
    retryPolicy: {
      operationRetry: 3,
      agentRetry: 0,
      operationRetryDelay: [1, 2],
      agentRetryDelay: [1],
    },
  });

  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [1_000, 2_000, 2_000]);
  assert.deepEqual(pauses, []);
});

test("workflowWrite with zero operation retries performs only the initial attempt", async () => {
  const { clock, operator, pauses, sleeps, audit } = dependencies();

  await assert.rejects(
    workflowWrite({
      action: async () => {
        throw new Error("502 Bad Gateway");
      },
      audit,
      clock,
      event: (attempt) => ({
        timestamp: new Date().toISOString(),
        runId: "run",
        project: "project",
        parentTicket: 1,
        phase: "test",
        operation: "write",
        target: "target",
        attempt,
      }),
      operator,
      automaticRetry: {},
      retryPolicy: {
        operationRetry: 0,
        agentRetry: 2,
        operationRetryDelay: [1],
        agentRetryDelay: [1],
      },
    }),
    /operator cancelled/u,
  );
  assert.deepEqual(sleeps, []);
  assert.equal(pauses.length, 1);
});

test("externalRead uses configured retry count and delay clamping", async () => {
  const { audit, clock, operator, pauses, sleeps } = dependencies();
  let calls = 0;
  const result = await externalRead({
    action: async () => {
      calls += 1;
      if (calls < 3) throw new Error("network unavailable");
      return "ok";
    },
    parseOverride: (value) => value,
    audit,
    clock,
    event: (attempt) => ({
      timestamp: new Date().toISOString(),
      runId: "run",
      project: "project",
      parentTicket: 1,
      phase: "test",
      operation: "read",
      target: "target",
      attempt,
    }),
    operator,
    retryPolicy: {
      operationRetry: 2,
      agentRetry: 0,
      operationRetryDelay: [3],
      agentRetryDelay: [1],
    },
  });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [3_000, 3_000]);
  assert.deepEqual(pauses, []);
});
