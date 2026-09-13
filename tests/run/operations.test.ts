import assert from "node:assert/strict";
import test from "node:test";

import type { AuditLog } from "../../src/audit.ts";
import {
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
