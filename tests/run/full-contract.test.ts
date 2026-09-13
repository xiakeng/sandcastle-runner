import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { cleanupTempRoots } from "../support/temp-cleanup.ts";
import { executeCli } from "../../src/cli.ts";
import {
  createProject,
  milestones,
  batchBarriers,
} from "../support/full-contract.ts";
import {
  createFiveTicketScenario,
  type RestartPoint,
} from "../support/full-contract-scenario.ts";

test.afterEach(cleanupTempRoots);

test(
  "five Delivery Tickets complete through both maintenance barriers on the first try",
  { timeout: 5_000 },
  async () => {
    const root = await createProject(false);
    const scenario = createFiveTicketScenario(root, false);

    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      scenario.dependencies,
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.summary.outcome, "succeeded");
    assert.deepEqual(result.summary.batch, [1, 2, 3, 4, 5]);
    assert.deepEqual(result.summary.completedTickets, [1, 2, 3, 4, 5]);
    assert.equal(scenario.maxActiveAgents, 3);
    assert.deepEqual(scenario.maintenanceTickets, [101, 102]);
    assert.deepEqual(milestones(scenario.operations), [
      "merge:1:1",
      "merge:2:1",
      "merge:3:1",
      "maintenance:create:101",
      "merge:101:1",
      "merge:4:1",
      "merge:5:1",
      "maintenance:create:102",
      "merge:102:1",
      "parent:close",
    ]);
    assert.deepEqual(batchBarriers(scenario.operations), [
      "maintenance:create:101",
      "reservation:label:4:1",
      "ticket:close:4",
      "reservation:label:5:1",
      "ticket:close:5",
      "maintenance:create:102",
    ]);
    assert.equal(
      [...scenario.agentCalls.values()].every((attempts) => attempts === 1),
      true,
    );
    assert.equal(
      [...scenario.labelCalls.values()].every((attempts) => attempts === 1),
      true,
    );
    assert.equal(
      [...scenario.checkCalls.values()].every((attempts) => attempts === 1),
      true,
    );
    assert.equal(
      [...scenario.mergeCalls.values()].every((attempts) => attempts === 1),
      true,
    );
    assert.equal(
      scenario.operations.some((value) => value.startsWith("operator:pause:")),
      false,
    );
    assert.equal(scenario.parent.stateReason, "completed");
    assert.equal(
      scenario.maintenanceTickets.every(
        (ticket) => scenario.tickets.get(ticket)?.stateReason === "completed",
      ),
      true,
    );
    assert.ok(result.logPath);
    assert.ok(result.logPath.startsWith(root));
    assert.match(
      await readFile(result.logPath, "utf8"),
      /"phase":"maintenance"/u,
    );
  },
);

test(
  "the five-ticket topology succeeds through the composed recovery path",
  { timeout: 5_000 },
  async () => {
    const root = await createProject(true);
    const scenario = createFiveTicketScenario(root, true);

    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      scenario.dependencies,
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.summary.outcome, "succeeded");
    assert.deepEqual(result.summary.batch, [1, 2, 3, 4, 5]);
    assert.deepEqual(result.summary.completedTickets, [1, 2, 3, 4, 5]);
    assert.equal(scenario.resolveTargetBranchCalls, 5);
    assert.equal(scenario.labelCalls.get(1), 2);
    assert.equal(scenario.agentCalls.get("implement:1"), 2);
    assert.equal(scenario.agentCalls.get("implement:3"), 2);
    assert.equal(scenario.agentCalls.get("implement:4"), 1);
    assert.equal(scenario.correctionSessions, 1);
    assert.deepEqual(
      scenario.operations.filter(
        (operation) =>
          operation.startsWith("agent:malformed:") ||
          operation.startsWith("agent:corrected-in-session:"),
      ),
      ["agent:malformed:2", "agent:corrected-in-session:2"],
    );
    assert.equal(scenario.agentCalls.get("ci:1"), 1);
    assert.equal(scenario.agentCalls.get("conflict:3"), 1);
    assert.equal(scenario.agentCalls.get("ci:101"), 1);
    assert.equal(scenario.agentCalls.get("conflict:101"), 1);
    assert.ok(
      scenario.operations.some(
        (operation) =>
          operation.startsWith("worktree:create:1:") &&
          operation.includes("-ci-repair-"),
      ),
    );
    assert.ok(
      scenario.operations.some(
        (operation) =>
          operation.startsWith("push:1:") && operation.includes("/ticket-1"),
      ),
    );
    assert.equal(
      scenario.operations.filter((operation) =>
        operation.startsWith("checks:2:"),
      ).length,
      5,
    );
    assert.equal(
      result.summary.handoffs?.find(({ ticket }) => ticket === 4)?.verification,
      "operator_override",
    );
    assert.deepEqual(milestones(scenario.operations), [
      "merge:1:1",
      "merge:2:1",
      "merge:3:1",
      "merge:3:2",
      "maintenance:create:101",
      "merge:101:1",
      "merge:101:2",
      "merge:4:1",
      "merge:5:1",
      "maintenance:create:102",
      "merge:102:1",
      "parent:close",
    ]);
    assert.deepEqual(batchBarriers(scenario.operations), [
      "maintenance:create:101",
      "reservation:label:4:1",
      "ticket:close:4",
      "reservation:label:5:1",
      "ticket:close:5",
      "maintenance:create:102",
    ]);
    assert.equal(scenario.parent.stateReason, "completed");
    assert.equal(
      scenario.maintenanceTickets.every(
        (ticket) => scenario.tickets.get(ticket)?.stateReason === "completed",
      ),
      true,
    );
    assert.ok(result.logPath);
    const audit = await readFile(result.logPath, "utf8");
    assert.match(audit, /"result":"operator_override"/u);
    assert.equal(audit.includes("Completes ticket 4."), false);
  },
);

test(
  "repeated CLI invocations retain the composed batch across publication and integration restarts",
  { timeout: 10_000 },
  async () => {
    const root = await createProject(false);
    const restartPoint = { current: "publication" as RestartPoint };
    const scenario = createFiveTicketScenario(root, false, restartPoint);
    const args = ["run", "--project", "demo", "--parent", "8"];

    const first = await executeCli(args, scenario.dependencies);
    assert.equal(first.summary.outcome, "cancelled");
    assert.ok(
      scenario.operations.some(
        (operation) =>
          operation.startsWith("push:1:") && operation.includes("/ticket-1"),
      ),
    );

    scenario.resetInterruption();
    restartPoint.current = "integration";
    const second = await executeCli(args, scenario.dependencies);
    assert.notEqual(second.summary.outcome, "succeeded");

    restartPoint.current = null;
    scenario.resetInterruption();
    const final = await executeCli(args, scenario.dependencies);
    assert.equal(final.summary.outcome, "succeeded");
    assert.deepEqual(final.summary.batch, [1, 2, 3, 4, 5]);
    assert.deepEqual(final.summary.completedTickets, [1, 2, 3, 4, 5]);
    assert.ok(
      new Set(scenario.pullRequestIdentities().map(({ ticket }) => ticket))
        .size > 0,
    );
    assert.deepEqual(scenario.maintenanceTickets, [101, 102]);
    assert.equal(
      scenario.operations.filter((operation) => operation === "parent:close")
        .length,
      1,
    );
  },
);

test("unfinished maintenance is forgotten when disabled and not rediscovered", async () => {
  const root = await createProject(false);
  const restartPoint = { current: "maintenance" as RestartPoint };
  const scenario = createFiveTicketScenario(root, false, restartPoint);
  const args = ["run", "--project", "demo", "--parent", "8"];
  const first = await executeCli(args, scenario.dependencies);
  assert.notEqual(first.summary.outcome, "succeeded");
  const configPath = path.join(root, "projects", "demo", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    workflow: { documentationMaintenance: boolean };
  };
  config.workflow.documentationMaintenance = false;
  await writeFile(configPath, JSON.stringify(config));
  const before = scenario.operations.length;
  await executeCli(args, scenario.dependencies);
  assert.deepEqual(scenario.maintenanceTickets, [101]);
  assert.equal(
    scenario.operations.slice(before).some((op) => op.includes("maintenance")),
    false,
  );
  config.workflow.documentationMaintenance = true;
  await writeFile(configPath, JSON.stringify(config));
  const beforeReenable = scenario.operations.length;
  await executeCli(args, scenario.dependencies);
  assert.deepEqual(scenario.maintenanceTickets, [101]);
  assert.equal(
    scenario.operations
      .slice(beforeReenable)
      .some((op) => op.includes("maintenance")),
    false,
  );
});
