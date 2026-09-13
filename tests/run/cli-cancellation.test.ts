import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { cleanupTempRoots } from "../support/temp-cleanup.ts";
import {
  createCliDependencies,
  createAttemptTracker,
  createCommittedBatch,
} from "../support/cli-dependencies.ts";
import { validConfig, createProject } from "../support/cli-project.ts";
import { executeCli } from "../../src/cli.ts";

test.afterEach(cleanupTempRoots);

test("cancelling a later merge keeps earlier Batch completion credit", async () => {
  const root = await createProject();
  const delivery = createCommittedBatch(9, 10);
  const merged = new Set<number>();
  let maintenanceCreates = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      tracker: {
        ...delivery.tracker,
        async createMaintenanceTicket() {
          maintenanceCreates += 1;
          return { number: 100, state: "open", stateReason: null };
        },
      },
      codeHost: {
        async createPullRequest(input) {
          const ticket = Number(input.branch.split("-").at(-1));
          return {
            number: ticket + 100,
            url: `https://github.com/owner/repo/pull/${ticket + 100}`,
          };
        },
        async getPullRequest(_repository, pullRequest) {
          return {
            headSha: String(pullRequest - 100)
              .at(-1)!
              .repeat(40),
            createdAt: `2026-09-09T00:00:${String(pullRequest - 100).padStart(2, "0")}Z`,
            merged: merged.has(pullRequest),
            mergeFailure: null,
          };
        },
        async requestSquashMerge({ pullRequest }) {
          if (pullRequest === 110) {
            return { outcome: "rejected", error: "merge rejected" };
          }
          merged.add(pullRequest);
          return { outcome: "accepted" };
        },
      },
      operator: {
        async pause() {
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.deepEqual(result.summary.completedTickets, [9]);
  assert.equal(maintenanceCreates, 0);
  assert.deepEqual(
    result.summary.pullRequests?.map(({ number }) => number),
    [109, 110],
  );
});

test("cancelling one concurrent Agent Attempt aborts and settles the others", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9, 10);
  let started = 0;
  let release: (() => void) | undefined;
  let abortedAttemptSettled = false;
  let activePauses = 0;
  let maxActivePauses = 0;
  let pauseCalls = 0;
  const bothStarted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
      },
      agentExecutor: {
        async execute(input) {
          started += 1;
          if (started === 2) release?.();
          await bothStarted;
          if (input.ticket === 9) throw new Error("Sandcastle failed");
          await new Promise<void>((_resolve, reject) => {
            input.signal.addEventListener(
              "abort",
              () => {
                abortedAttemptSettled = true;
                reject(new Error("Agent Attempt aborted"));
              },
              { once: true },
            );
          });
          throw new Error("unreachable");
        },
      },
      operator: {
        async pause() {
          pauseCalls += 1;
          activePauses += 1;
          maxActivePauses = Math.max(maxActivePauses, activePauses);
          await Promise.resolve();
          activePauses -= 1;
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(abortedAttemptSettled, true);
  assert.equal(pauseCalls, 1);
  assert.equal(maxActivePauses, 1);
});

test("Parent cancellation after Worktree preparation starts no Agent and preserves the Reservation", async () => {
  const root = await createProject();
  let worktreeCreated = false;
  let agentCalls = 0;
  let releases = 0;
  const {
    tickets: [child],
    tracker,
  } = createAttemptTracker(9);
  assert.ok(child);
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        ...tracker,
        async getParent() {
          return worktreeCreated
            ? { number: 8, state: "closed", stateReason: "not_planned" }
            : { number: 8, state: "open", stateReason: null };
        },
        async removeLabel() {
          releases += 1;
        },
        async removeAssignee() {
          releases += 1;
        },
      },
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
        async createWorktree() {
          worktreeCreated = true;
        },
      },
      agentExecutor: {
        async execute() {
          agentCalls += 1;
          throw new Error("must not start");
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(agentCalls, 0);
  assert.equal(releases, 0);
  assert.deepEqual(child.labels, ["sandcastle:reserved"]);
  assert.deepEqual(child.assignees, ["runner"]);
});

test("a removed Reservation after Worktree preparation starts no Agent", async () => {
  const root = await createProject();
  let agentCalls = 0;
  const {
    tickets: [child],
    tracker,
  } = createAttemptTracker(9);
  assert.ok(child);
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
        async createWorktree() {
          child.labels.length = 0;
        },
      },
      agentExecutor: {
        async execute() {
          agentCalls += 1;
          throw new Error("must not start");
        },
      },
    }),
  );

  assert.equal(agentCalls, 0);
  assert.ok(
    result.summary.reasons.includes(
      "Delivery Ticket 9 no longer has a complete Reservation",
    ),
  );
});

test("Agent results and trusted overrides are rejected after Parent cancellation", async () => {
  for (const trustedOverride of [false, true]) {
    const root = await createProject();
    let parentCancelled = false;
    const { tracker } = createAttemptTracker(9);
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        tracker: {
          ...tracker,
          async getParent() {
            return parentCancelled
              ? { number: 8, state: "closed", stateReason: "not_planned" }
              : { number: 8, state: "open", stateReason: null };
          },
        },
        gitWorkspace: {
          async fetchTargetBranch() {
            return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
          },
        },
        agentExecutor: {
          async execute() {
            if (trustedOverride) throw new Error("Sandcastle failed");
            parentCancelled = true;
            return {
              outcome: "blocked",
              summary: "waiting",
              commits: [],
              checks: [],
              blocker: "waiting",
              pr_title: "unused",
              pr_body: "unused",
            };
          },
        },
        operator: {
          async pause() {
            parentCancelled = true;
            return JSON.stringify({
              outcome: "committed",
              pr_title: "feat: trusted result",
              pr_body: "Trusted result.",
            });
          },
        },
      }),
    );

    assert.equal(result.summary.outcome, "cancelled");
    assert.deepEqual(result.summary.handoffs, []);
  }
});

test("cancelling boundary revalidation after an Agent result pauses once", async () => {
  const root = await createProject();
  let agentFinished = false;
  let pauseCalls = 0;
  const { tracker } = createAttemptTracker(9);
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        ...tracker,
        async getParent() {
          if (agentFinished) throw new Error("tracker unavailable");
          return { number: 8, state: "open", stateReason: null };
        },
      },
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
      },
      agentExecutor: {
        async execute() {
          agentFinished = true;
          return {
            outcome: "blocked",
            summary: "waiting",
            commits: [],
            checks: [],
            blocker: "waiting",
            pr_title: "unused",
            pr_body: "unused",
          };
        },
      },
      operator: {
        async pause() {
          pauseCalls += 1;
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(pauseCalls, 1);
});

test("unsupported model and effort selections fail before workflow operations", async () => {
  for (const implement of [
    { model: "gpt-not-real", reasoningEffort: "high" },
    { model: "gpt-5.6-sol", reasoningEffort: "ultra" },
  ]) {
    const root = await createProject();
    const config = structuredClone(validConfig);
    config.agents = { ...config.agents, implement };
    await writeFile(
      path.join(root, "projects", "demo", "config.json"),
      JSON.stringify(config),
    );
    let workflowCalls = 0;
    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        tracker: {
          async getParent() {
            workflowCalls += 1;
            throw new Error("must not run");
          },
          async listChildrenPage() {
            workflowCalls += 1;
            throw new Error("must not run");
          },
          async closeParent() {
            workflowCalls += 1;
          },
        },
        codeHost: {
          async resolveTargetBranch() {
            workflowCalls += 1;
            return "main";
          },
        },
        operator: {
          async pause() {
            workflowCalls += 1;
            return "q";
          },
        },
      }),
    );

    assert.equal(result.summary.outcome, "failed");
    assert.match(result.summary.reasons[0] ?? "", /unsupported/u);
    assert.equal(workflowCalls, 0);
  }
});

test("empty input retries a failed audit creation", async () => {
  const root = await createProject();
  const logs = path.join(root, "projects", "demo", "logs");
  await writeFile(logs, "blocks directory creation");
  let pauseCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      operator: {
        async pause() {
          pauseCalls += 1;
          await rm(logs);
          await mkdir(logs);
          return "";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "no_work");
  assert.equal(pauseCalls, 1);
  assert.ok(result.logPath);
  assert.match(await readFile(result.logPath, "utf8"), /read_parent/u);
});

test("a fresh Run ignores existing audit logs", async () => {
  const root = await createProject();
  const logs = path.join(root, "projects", "demo", "logs");
  await mkdir(logs);
  const oldLog = path.join(logs, "earlier.jsonl");
  await writeFile(oldLog, "not valid JSON and not recovery state\n");
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root),
  );

  assert.equal(result.summary.outcome, "no_work");
  assert.ok(result.logPath);
  assert.notEqual(result.logPath, oldLog);
  assert.equal(
    await readFile(oldLog, "utf8"),
    "not valid JSON and not recovery state\n",
  );
});

test("a contradictory Parent read override fails without a second pause", async () => {
  const root = await createProject();
  let parentCalls = 0;
  let pauseCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          parentCalls += 1;
          throw new Error("unavailable");
        },
      },
      operator: {
        async pause() {
          pauseCalls += 1;
          return pauseCalls === 1
            ? '{"state":"closed","stateReason":null}'
            : "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.match(result.summary.reasons[0] ?? "", /closed Parent Ticket/u);
  assert.equal(parentCalls, 5);
  assert.equal(pauseCalls, 1);
});
