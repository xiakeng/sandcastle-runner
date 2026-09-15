import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { cleanupTempRoots } from "../support/temp-cleanup.ts";
import {
  createCliDependencies,
  createAttemptTracker,
  createCommittedDelivery,
} from "../support/cli-dependencies.ts";
import { createProject } from "../support/cli-project.ts";
import { executeCli } from "../../src/cli.ts";

test.afterEach(cleanupTempRoots);

test("Parent cancellation during a failed repair push prevents retry", async () => {
  const root = await createProject();
  const {
    tickets: [ticket],
    tracker,
  } = createAttemptTracker(9);
  assert.ok(ticket);
  const implementation = {
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    message: "feat: implementation",
  };
  const repair = {
    sha: "cccccccccccccccccccccccccccccccccccccccc",
    message: "fix: required checks",
  };
  let branch = "";
  let agentCalls = 0;
  let pushCalls = 0;
  let parentCancelled = false;

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
        async createWorktree(input) {
          branch = input.branch;
        },
        async inspect({ worktree, base }) {
          return {
            worktree,
            branch,
            base,
            commits: base === implementation.sha ? [repair] : [implementation],
            clean: true,
          };
        },
        async push() {
          pushCalls += 1;
          if (pushCalls > 1) throw new Error("repair push failed");
        },
      },
      agentExecutor: {
        async execute() {
          agentCalls += 1;
          const commit = agentCalls === 1 ? implementation : repair;
          return {
            outcome: "committed",
            summary: commit.message,
            commits: [commit],
            checks: [],
            blocker: null,
            pr_title: "feat: implementation",
            pr_body: "Implementation body.",
          };
        },
      },
      codeHost: {
        async createPullRequest() {
          return { number: 41, url: "https://github.com/owner/repo/pull/41" };
        },
        async getRequiredChecks() {
          return [
            {
              name: "checks",
              state: "FAILURE",
              link: "https://github.com/owner/repo/actions/runs/1",
              bucket: "fail",
            },
          ];
        },
        async getPullRequest() {
          return {
            headSha: implementation.sha,
            createdAt: "2026-09-09T00:00:00Z",
            merged: false,
            mergeFailure: null,
          };
        },
      },
      operator: {
        async pause() {
          parentCancelled = true;
          return pushCalls === 2 ? "" : "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(pushCalls, 2);
  assert.deepEqual(ticket.labels, ["ready-for-agent", "sandcastle:reserved"]);
  assert.deepEqual(ticket.assignees, ["runner"]);
});

test("blocked CI repairs pause without consuming the repair budget", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  const implementation = {
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    message: "feat: implementation",
  };
  const repair = {
    sha: "cccccccccccccccccccccccccccccccccccccccc",
    message: "fix: required checks",
  };
  const pauses: string[] = [];
  let branch = "";
  let agentCalls = 0;
  let checkReads = 0;
  let pushCalls = 0;
  let merged = false;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
        async createWorktree(input) {
          branch = input.branch;
        },
        async inspect({ worktree, base }) {
          return {
            worktree,
            branch,
            base,
            commits:
              agentCalls === 3
                ? []
                : agentCalls === 4
                  ? [repair]
                  : [implementation],
            clean: true,
          };
        },
        async push() {
          pushCalls += 1;
        },
      },
      agentExecutor: {
        async execute() {
          agentCalls += 1;
          if (agentCalls === 2) {
            return {
              outcome: "blocked",
              summary: "repair needs another attempt",
              commits: [],
              checks: [],
              blocker: "repair incomplete",
              pr_title: "unused",
              pr_body: "unused",
            };
          }
          if (agentCalls === 3) {
            return {
              outcome: "no_change",
              summary: "first budget made no repair",
              commits: [],
              checks: [],
              blocker: null,
              pr_title: "unused",
              pr_body: "unused",
            };
          }
          const commit = agentCalls === 1 ? implementation : repair;
          return {
            outcome: "committed",
            summary: commit.message,
            commits: [commit],
            checks: [],
            blocker: null,
            pr_title: "feat: implementation",
            pr_body: "Implementation body.",
          };
        },
      },
      codeHost: {
        async getRequiredChecks() {
          checkReads += 1;
          return checkReads === 1
            ? [
                {
                  name: "checks",
                  state: "FAILURE",
                  link: "https://github.com/owner/repo/actions/runs/1",
                  bucket: "fail" as const,
                },
              ]
            : [];
        },
        async getPullRequest() {
          return {
            headSha: pushCalls === 2 ? repair.sha : implementation.sha,
            createdAt: "2026-09-09T00:00:00Z",
            merged,
            mergeFailure: null,
          };
        },
        async requestSquashMerge() {
          merged = true;
          return { outcome: "accepted" };
        },
      },
      operator: {
        async pause(message) {
          pauses.push(message);
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(agentCalls, 2);
  assert.equal(pushCalls, 1);
  assert.match(pauses[0]!, /Agent Attempt blocked/u);
  assert.ok(result.logPath);
  const repairAttemptNumbers = (await readFile(result.logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter(
      (event) =>
        event.phase === "ci_repair" &&
        event.operation === "agent_attempt" &&
        event.result === "started",
    )
    .map((event) => event.attempt);
  assert.deepEqual(repairAttemptNumbers, [1]);
});

test("repair execution and invalid handoff failures do not consume the budget", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  const implementation = {
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    message: "feat: implementation",
  };
  const falseClaim = {
    sha: "cccccccccccccccccccccccccccccccccccccccc",
    message: "fix: false claim",
  };
  const pauses: string[] = [];
  const responses = ["", "", "q"];
  let branch = "";
  let agentCalls = 0;
  let pushCalls = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
        async createWorktree(input) {
          branch = input.branch;
        },
        async inspect({ worktree, base }) {
          return {
            worktree,
            branch,
            base,
            commits: agentCalls === 1 ? [implementation] : [],
            clean: true,
          };
        },
        async push() {
          pushCalls += 1;
        },
      },
      agentExecutor: {
        async execute() {
          agentCalls += 1;
          if (agentCalls === 1) {
            return {
              outcome: "committed",
              summary: implementation.message,
              commits: [implementation],
              checks: [],
              blocker: null,
              pr_title: "feat: implementation",
              pr_body: "Implementation body.",
            };
          }
          if (agentCalls === 2) throw new Error("Sandcastle failed");
          if (agentCalls === 3) {
            return {
              outcome: "committed",
              summary: falseClaim.message,
              commits: [falseClaim],
              checks: [],
              blocker: null,
              pr_title: "unused",
              pr_body: "unused",
            };
          }
          if (agentCalls === 4) {
            return {
              outcome: "blocked",
              summary: "repair blocked",
              commits: [],
              checks: [],
              blocker: "repair blocked",
              pr_title: "unused",
              pr_body: "unused",
            };
          }
          return {
            outcome: "no_change",
            summary: "repair made no change",
            commits: [],
            checks: [],
            blocker: null,
            pr_title: "unused",
            pr_body: "unused",
          };
        },
      },
      codeHost: {
        async getRequiredChecks() {
          return [
            {
              name: "checks",
              state: "FAILURE",
              link: "https://github.com/owner/repo/actions/runs/1",
              bucket: "fail",
            },
          ];
        },
        async getPullRequest() {
          return {
            headSha: implementation.sha,
            createdAt: "2026-09-09T00:00:00Z",
            merged: false,
            mergeFailure: null,
          };
        },
      },
      operator: {
        async pause(message) {
          pauses.push(message);
          return responses.shift() ?? "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(agentCalls, 4);
  assert.equal(pushCalls, 1);
  assert.deepEqual(
    pauses.map((message) =>
      message.startsWith("Agent Attempt failed")
        ? "agent failure"
        : "budget exhausted",
    ),
    ["agent failure", "agent failure", "budget exhausted"],
  );
});

test("a trusted repair-budget override continues the existing Pull Request", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery();
  let agentCalls = 0;
  let pushes = 0;
  let merged = false;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async push() {
          pushes += 1;
        },
      },
      agentExecutor: {
        async execute() {
          agentCalls += 1;
          if (agentCalls === 1) {
            return {
              outcome: "committed",
              summary: "implemented",
              commits: [
                {
                  sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                  message: "feat: implementation",
                },
              ],
              checks: [],
              blocker: null,
              pr_title: "feat: implementation",
              pr_body: "Implementation body.",
            };
          }
          throw new Error("CI repair failed");
        },
      },
      codeHost: {
        async getRequiredChecks() {
          return [
            {
              name: "checks",
              state: "FAILURE",
              link: "https://github.com/owner/repo/actions/runs/1",
              bucket: "fail",
            },
          ];
        },
        async getPullRequest() {
          return {
            headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            createdAt: "2026-09-09T00:00:00Z",
            merged,
            mergeFailure: null,
          };
        },
        async requestSquashMerge() {
          merged = true;
          return { outcome: "accepted" };
        },
      },
      operator: {
        async pause() {
          return JSON.stringify({
            outcome: "committed",
            pr_title: "feat: trusted readiness",
            pr_body: "Trusted readiness.",
          });
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(agentCalls, 3);
  assert.equal(pushes, 3);
  assert.ok(result.logPath);
  const audit = await readFile(result.logPath, "utf8");
  assert.match(audit, /operator_override/u);
  assert.equal(audit.includes("trusted CI readiness"), false);
});
