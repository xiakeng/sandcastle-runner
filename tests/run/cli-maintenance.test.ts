import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { cleanupTempRoots } from "../support/temp-cleanup.ts";
import {
  createCliDependencies,
  createCommittedDelivery,
} from "../support/cli-dependencies.ts";
import { validConfig, createProject } from "../support/cli-project.ts";
import { executeCli } from "../../src/cli.ts";
import { readRecoverySnapshot, recoveryPaths } from "../../src/recovery.ts";
import type { Ticket } from "../../src/run/contracts.ts";

test.afterEach(cleanupTempRoots);

test("final closeout credit triggers one clean no_change Maintenance Ticket without a Pull Request", async () => {
  const root = await createProject();
  await writeFile(
    path.join(root, "projects/demo/config.json"),
    JSON.stringify({ ...validConfig, ticketClosure: "code_host" }),
  );
  const delivery = createCommittedDelivery(9);
  const maintenance: Ticket = {
    number: 100,
    state: "open",
    stateReason: null,
    assignees: [],
    labels: ["doc-maintain"],
  };
  let delivered = false;
  let maintenanceBranch = "";
  let maintenanceCreates = 0;
  let maintenanceCloses = 0;
  let parentCloses = 0;
  let pullRequestCreates = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        ...delivery.tracker,
        async createMaintenanceTicket() {
          maintenanceCreates += 1;
          return maintenance;
        },
        async getTicket(repository, ticket) {
          if (ticket === 9 && delivered) {
            return { number: 9, state: "closed", stateReason: "completed" };
          }
          return delivery.tracker.getTicket!(repository, ticket);
        },
        async closeTicket(repository, ticket) {
          if (ticket === maintenance.number) {
            maintenance.state = "closed";
            maintenance.stateReason = "completed";
            maintenanceCloses += 1;
            return;
          }
          await delivery.tracker.closeTicket!(repository, ticket);
        },
        async closeParent() {
          parentCloses += 1;
        },
      },
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async createWorktree(input) {
          if (input.worktree.includes("/maintenance-")) {
            maintenanceBranch = input.branch;
            return;
          }
          await delivery.gitWorkspace.createWorktree!(input);
        },
        async inspect(input) {
          if (input.worktree.includes("/maintenance-")) {
            return {
              worktree: input.worktree,
              branch: maintenanceBranch,
              base: input.base,
              commits: [],
              clean: true,
            };
          }
          return delivery.gitWorkspace.inspect!(input);
        },
      },
      agentExecutor: {
        async execute(input) {
          return input.ticket === maintenance.number
            ? {
                outcome: "no_change",
                summary: "all documentation surfaces are current",
                commits: [],
                checks: [],
                blocker: null,
              }
            : delivery.agentExecutor.execute!(input);
        },
      },
      codeHost: {
        async createPullRequest() {
          pullRequestCreates += 1;
          return { number: 41, url: "https://github.com/owner/repo/pull/41" };
        },
        async getPullRequest() {
          return {
            headSha: "b".repeat(40),
            createdAt: "2026-09-09T00:00:00Z",
            merged: delivered,
            mergeFailure: null,
          };
        },
        async requestSquashMerge() {
          delivered = true;
          delivery.tickets[0]!.state = "closed";
          delivery.tickets[0]!.stateReason = "completed";
          return { outcome: "accepted" };
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.deepEqual(result.summary.completedTickets, [9]);
  assert.equal(maintenanceCreates, 1);
  assert.equal(maintenanceCloses, 1);
  assert.equal(pullRequestCreates, 1);
  assert.equal(parentCloses, 1);
});

test("blocked Documentation Maintenance pauses the live Run", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery(9);
  const maintenance: Ticket = {
    number: 100,
    state: "open",
    stateReason: null,
    assignees: [],
    labels: ["doc-maintain"],
  };
  let parentCloses = 0;
  let maintenanceBranch = "";
  let maintenanceCreates = 0;

  const dependencies = createCliDependencies(root, {
    tracker: {
      ...delivery.tracker,
      async createMaintenanceTicket() {
        maintenanceCreates += 1;
        return maintenance;
      },
      async closeParent() {
        parentCloses += 1;
      },
    },
    gitWorkspace: {
      ...delivery.gitWorkspace,
      async createWorktree(input) {
        if (input.worktree.includes("/maintenance-")) {
          maintenanceBranch = input.branch;
          return;
        }
        await delivery.gitWorkspace.createWorktree!(input);
      },
      async inspect(input) {
        if (input.worktree.includes("/maintenance-")) {
          return {
            worktree: input.worktree,
            branch: maintenanceBranch,
            base: input.base,
            commits: [],
            clean: true,
          };
        }
        return delivery.gitWorkspace.inspect!(input);
      },
    },
    agentExecutor: {
      async execute(input) {
        return input.ticket === maintenance.number
          ? {
              outcome: "blocked",
              summary: "documentation instructions are incomplete",
              commits: [],
              checks: [],
              blocker: "missing Documentation Base",
            }
          : delivery.agentExecutor.execute!(input);
      },
    },
    operator: {
      async pause() {
        return "q";
      },
    },
  });
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    dependencies,
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(maintenance.state, "open");
  assert.equal(parentCloses, 0);
  assert.equal(maintenanceCreates, 1);
  const snapshot = await readRecoverySnapshot(
    recoveryPaths(path.join(root, "projects", "demo"), 8).snapshot,
  );
  assert.deepEqual(snapshot?.maintenance, {
    phase: "attempting",
    ticket: 100,
    credit: 1,
    barrier: true,
  });

  assert.equal(maintenanceCreates, 1);
  assert.equal(parentCloses, 0);
});

test("Maintenance Ticket label reads and writes use normal supervised failure handling", async () => {
  for (const failure of ["read", "label", "ticket"] as const) {
    const root = await createProject();
    const delivery = createCommittedDelivery(9);
    let labelWrites = 0;
    let ticketWrites = 0;
    let labelReads = 0;

    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        tracker: {
          ...delivery.tracker,
          async listLabelsPage() {
            labelReads += 1;
            if (failure === "read") throw new Error("label read failed");
            return {
              labels: failure === "label" ? [] : ["doc-maintain"],
              nextPage: null,
            };
          },
          async createLabel() {
            labelWrites += 1;
            throw new Error("label write failed");
          },
          async createMaintenanceTicket() {
            ticketWrites += 1;
            throw new Error("ticket write failed");
          },
        },
        gitWorkspace: delivery.gitWorkspace,
        agentExecutor: delivery.agentExecutor,
        operator: {
          async pause() {
            return "q";
          },
        },
      }),
    );

    assert.equal(result.summary.outcome, "cancelled");
    assert.equal(
      labelReads,
      failure === "read" ? 5 : failure === "label" ? 2 : 1,
    );
    assert.equal(labelWrites, failure === "label" ? 1 : 0);
    assert.equal(ticketWrites, failure === "ticket" ? 1 : 0);
    assert.deepEqual(result.summary.completedTickets, [9]);
  }
});

test("Documentation Maintenance reuses CI and conflict repair on its original Pull Request", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery(9);
  const base = "a".repeat(40);
  const initial = "c".repeat(40);
  const ciRepair = "d".repeat(40);
  const conflictRepair = "e".repeat(40);
  const maintenance: Ticket = {
    number: 100,
    state: "open",
    stateReason: null,
    assignees: [],
    labels: ["doc-maintain"],
  };
  let maintenanceBranch = "";
  let pendingHead = initial;
  let maintenanceHead = initial;
  let deliveryMerged = false;
  let maintenanceMerged = false;
  let maintenanceMergeRequests = 0;
  let maintenancePullRequests = 0;
  const repairPrompts: string[] = [];

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        ...delivery.tracker,
        async createMaintenanceTicket() {
          return maintenance;
        },
        async closeTicket(repository, ticket) {
          if (ticket === maintenance.number) {
            maintenance.state = "closed";
            maintenance.stateReason = "completed";
            return;
          }
          await delivery.tracker.closeTicket!(repository, ticket);
        },
      },
      gitWorkspace: {
        async fetchTargetBranch() {
          return base;
        },
        async createWorktree(input) {
          if (input.worktree.includes("/maintenance-")) {
            maintenanceBranch = input.branch;
            return;
          }
          await delivery.gitWorkspace.createWorktree!(input);
        },
        async inspect(input) {
          if (!input.worktree.includes("/maintenance-")) {
            return delivery.gitWorkspace.inspect!(input);
          }
          pendingHead =
            input.base === base
              ? initial
              : input.base === initial
                ? ciRepair
                : conflictRepair;
          return {
            worktree: input.worktree,
            branch: maintenanceBranch,
            base: input.base,
            commits: [
              {
                sha: pendingHead,
                message:
                  pendingHead === initial
                    ? "docs: maintain documentation"
                    : pendingHead === ciRepair
                      ? "fix: repair documentation CI"
                      : "fix: repair documentation conflict",
              },
            ],
            clean: true,
          };
        },
        async push(worktree) {
          if (worktree.includes("/maintenance-")) maintenanceHead = pendingHead;
        },
      },
      agentExecutor: {
        async execute(input) {
          if (input.ticket !== maintenance.number)
            return delivery.agentExecutor.execute!(input);
          if (input.promptFile.endsWith("ci-repair.md")) {
            repairPrompts.push("ci");
            return {
              outcome: "committed",
              summary: "repaired documentation CI",
              commits: [
                { sha: ciRepair, message: "fix: repair documentation CI" },
              ],
              checks: [],
              blocker: null,
            };
          }
          if (input.promptFile.endsWith("conflict-repair.md")) {
            repairPrompts.push("conflict");
            return {
              outcome: "committed",
              summary: "repaired documentation conflict",
              commits: [
                {
                  sha: conflictRepair,
                  message: "fix: repair documentation conflict",
                },
              ],
              checks: [],
              blocker: null,
            };
          }
          return {
            outcome: "committed",
            summary: "maintained documentation",
            commits: [
              { sha: initial, message: "docs: maintain documentation" },
            ],
            checks: [],
            blocker: null,
            pr_title: "docs: maintain project documentation",
            pr_body: "Maintain documentation.",
          };
        },
      },
      codeHost: {
        async createPullRequest(input) {
          if (input.branch.includes("/maintenance-")) {
            maintenancePullRequests += 1;
            return {
              number: 200,
              url: "https://github.com/owner/repo/pull/200",
            };
          }
          return { number: 41, url: "https://github.com/owner/repo/pull/41" };
        },
        async getRequiredChecks(_repository, pullRequest) {
          return pullRequest === 200 && maintenanceHead === initial
            ? [
                {
                  name: "checks",
                  state: "FAILURE",
                  link: "https://github.com/owner/repo/actions/runs/1",
                  bucket: "fail",
                },
              ]
            : [];
        },
        async getPullRequest(_repository, pullRequest) {
          return pullRequest === 200
            ? {
                headSha: maintenanceHead,
                createdAt: "2026-09-09T00:00:01Z",
                merged: maintenanceMerged,
                mergeFailure: null,
              }
            : {
                headSha: "b".repeat(40),
                createdAt: "2026-09-09T00:00:00Z",
                merged: deliveryMerged,
                mergeFailure: null,
              };
        },
        async requestSquashMerge({ pullRequest }) {
          if (pullRequest === 200) {
            maintenanceMergeRequests += 1;
            if (maintenanceMergeRequests === 1) {
              return { outcome: "conflict", error: "merge conflict" };
            }
            maintenanceMerged = true;
          } else {
            deliveryMerged = true;
          }
          return { outcome: "accepted" };
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.deepEqual(result.summary.completedTickets, [9]);
  assert.deepEqual(repairPrompts, ["ci", "conflict"]);
  assert.equal(maintenancePullRequests, 1);
  assert.equal(maintenanceMergeRequests, 2);
  assert.equal(maintenance.stateReason, "completed");
});
