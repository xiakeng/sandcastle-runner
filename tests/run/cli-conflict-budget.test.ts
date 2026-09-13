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

test("cancelling an exhausted conflict budget stops before republishing or remerge", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery();
  let agentCalls = 0;
  let pushes = 0;
  let mergeRequests = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async inspect(input) {
          const evidence = await delivery.gitWorkspace.inspect!(input);
          return {
            ...evidence,
            commits: agentCalls === 3 ? [] : evidence.commits,
          };
        },
        async push() {
          pushes += 1;
        },
      },
      agentExecutor: {
        async execute(input) {
          agentCalls += 1;
          if (agentCalls === 2) {
            return {
              outcome: "blocked",
              summary: "conflict remains",
              commits: [],
              checks: [],
              blocker: "conflict remains",
              pr_title: "unused",
              pr_body: "unused",
            };
          }
          if (agentCalls === 3) {
            return {
              outcome: "no_change",
              summary: "no safe resolution",
              commits: [],
              checks: [],
              blocker: null,
              pr_title: "unused",
              pr_body: "unused",
            };
          }
          return delivery.agentExecutor.execute!(input);
        },
      },
      codeHost: {
        async getPullRequest() {
          return {
            headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            createdAt: "2026-09-09T00:00:00Z",
            merged: false,
            mergeFailure: null,
          };
        },
        async requestSquashMerge() {
          mergeRequests += 1;
          return { outcome: "conflict", error: "merge conflict" };
        },
      },
      operator: {
        async pause(message) {
          assert.match(message, /Conflict repair failed after two attempts/u);
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(agentCalls, 2);
  assert.equal(pushes, 1);
  assert.equal(mergeRequests, 1);
});

test("Parent cancellation after conflict repair verification prevents its first push", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery();
  let parentCancelled = false;
  let pullRequestReads = 0;
  let pushes = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      tracker: {
        ...delivery.tracker,
        async getParent() {
          return parentCancelled
            ? { number: 8, state: "closed", stateReason: "not_planned" }
            : { number: 8, state: "open", stateReason: null };
        },
      },
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async push() {
          pushes += 1;
        },
      },
      codeHost: {
        async getPullRequest() {
          pullRequestReads += 1;
          if (pullRequestReads === 3) parentCancelled = true;
          return {
            headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            createdAt: "2026-09-09T00:00:00Z",
            merged: false,
            mergeFailure: null,
          };
        },
        async requestSquashMerge() {
          return { outcome: "conflict", error: "merge conflict" };
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(pullRequestReads, 3);
  assert.equal(pushes, 1);
});

test("a trusted conflict-repair override repeats required-check discovery", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  const implementation = {
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    message: "feat: implementation",
  };
  let branch = "";
  let agentCalls = 0;
  let checkReads = 0;
  let mergeRequests = 0;
  let merged = false;
  const pauses: string[] = [];

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
            commits: agentCalls === 3 ? [] : [implementation],
            clean: true,
          };
        },
      },
      agentExecutor: {
        async execute() {
          agentCalls += 1;
          if (agentCalls === 2) {
            return {
              outcome: "blocked",
              summary: "conflict remains",
              commits: [],
              checks: [],
              blocker: "conflict remains",
              pr_title: "unused",
              pr_body: "unused",
            };
          }
          if (agentCalls === 3) {
            return {
              outcome: "no_change",
              summary: "no safe resolution",
              commits: [],
              checks: [],
              blocker: null,
              pr_title: "unused",
              pr_body: "unused",
            };
          }
          return {
            outcome: "committed",
            summary: implementation.message,
            commits: [implementation],
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
          return [];
        },
        async getPullRequest() {
          return {
            headSha: implementation.sha,
            createdAt: "2026-09-09T00:00:00Z",
            merged,
            mergeFailure: null,
          };
        },
        async requestSquashMerge() {
          mergeRequests += 1;
          if (mergeRequests === 1) {
            return { outcome: "conflict", error: "merge conflict" };
          }
          merged = true;
          return { outcome: "accepted" };
        },
      },
      operator: {
        async pause(message) {
          pauses.push(message);
          return "trusted repair";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(agentCalls, 4);
  assert.equal(checkReads, 2);
  assert.equal(mergeRequests, 2);
  assert.match(pauses[0]!, /Agent Attempt blocked/u);
});

test("blocked conflict repairs pause without consuming the repair budget", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  const implementation = {
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    message: "feat: implementation",
  };
  const repair = {
    sha: "cccccccccccccccccccccccccccccccccccccccc",
    message: "fix: merge conflict",
  };
  let branch = "";
  let agentCalls = 0;
  let mergeRequests = 0;
  let headSha = implementation.sha;
  let merged = false;
  const pauses: string[] = [];

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
          if (agentCalls === 4) headSha = repair.sha;
        },
      },
      agentExecutor: {
        async execute() {
          agentCalls += 1;
          if (agentCalls === 2) {
            return {
              outcome: "blocked",
              summary: "conflict remains",
              commits: [],
              checks: [],
              blocker: "conflict remains",
              pr_title: "unused",
              pr_body: "unused",
            };
          }
          if (agentCalls === 3) {
            return {
              outcome: "no_change",
              summary: "no safe resolution",
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
        async getPullRequest() {
          return {
            headSha,
            createdAt: "2026-09-09T00:00:00Z",
            merged,
            mergeFailure: null,
          };
        },
        async requestSquashMerge() {
          mergeRequests += 1;
          if (mergeRequests === 1) {
            return { outcome: "conflict", error: "merge conflict" };
          }
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
  assert.equal(mergeRequests, 1);
  assert.match(pauses[0]!, /Agent Attempt blocked/u);
  assert.ok(result.logPath);
  const attempts = (await readFile(result.logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter(
      (event) =>
        event.phase === "conflict_repair" &&
        event.operation === "agent_attempt" &&
        event.result === "started",
    )
    .map((event) => event.attempt);
  assert.deepEqual(attempts, [1]);
});
