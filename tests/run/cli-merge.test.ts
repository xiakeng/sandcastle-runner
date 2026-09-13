import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { cleanupTempRoots } from "../support/temp-cleanup.ts";
import {
  createCliDependencies,
  createAttemptTracker,
  createCommittedDelivery,
} from "../support/cli-dependencies.ts";
import { validConfig, createProject } from "../support/cli-project.ts";
import { executeCli } from "../../src/cli.ts";
import type { AgentExecutor } from "../../src/run/contracts.ts";

test.afterEach(cleanupTempRoots);

test("code_host closure waits 10 seconds and then another 30 seconds while leaving closure to GitHub", async () => {
  const root = await createProject();
  await writeFile(
    path.join(root, "projects/demo/config.json"),
    JSON.stringify({ ...validConfig, ticketClosure: "code_host" }),
  );
  const delivery = createCommittedDelivery();
  const sleeps: number[] = [];
  let waitedTen = false;
  let closeCalls = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      tracker: {
        ...delivery.tracker,
        async closeTicket() {
          closeCalls += 1;
        },
      },
      clock: {
        async sleep(milliseconds) {
          sleeps.push(milliseconds);
          if (milliseconds === 10_000) waitedTen = true;
          if (milliseconds === 30_000 && waitedTen) {
            delivery.tickets[0]!.state = "closed";
            delivery.tickets[0]!.stateReason = "completed";
          }
        },
      },
    }),
  );

  assert.deepEqual(result.summary.completedTickets, [9]);
  assert.equal(closeCalls, 0);
  assert.deepEqual(sleeps, [30_000, 10_000, 30_000]);
});

test("a queued merge receives no completion credit until timeout recovery confirms success", async () => {
  const root = await createProject();
  await writeFile(
    path.join(root, "projects/demo/config.json"),
    JSON.stringify({
      ...validConfig,
      timeouts: { ...validConfig.timeouts, mergeQueueMinutes: 1 / 60_000 },
    }),
  );
  const delivery = createCommittedDelivery();
  let elapsed = 0;
  let mergeRequests = 0;
  let closeCalls = 0;
  const responses = ["", "trusted merge"];

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      tracker: {
        ...delivery.tracker,
        async closeTicket(_repository, ticket) {
          closeCalls += 1;
          const found = delivery.tickets.find(
            ({ number }) => number === ticket,
          )!;
          found.state = "closed";
          found.stateReason = "completed";
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
          return { outcome: "accepted" };
        },
      },
      clock: {
        now: () => new Date(elapsed),
        async sleep(milliseconds) {
          elapsed += milliseconds;
        },
      },
      operator: {
        async pause(message) {
          assert.match(message, /Merge confirmation timed out/u);
          return responses.shift() ?? "q";
        },
      },
    }),
  );

  assert.deepEqual(result.summary.completedTickets, [9]);
  assert.equal(mergeRequests, 1);
  assert.equal(closeCalls, 1);
});

test("a non-conflict merge rejection enters Operator Pause without conflict repair", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery();
  const rejection = "GitHub rejected admin bypass";
  let pauses = 0;
  let agentCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      agentExecutor: {
        async execute(input) {
          agentCalls += 1;
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
          return { outcome: "rejected", error: rejection };
        },
      },
      operator: {
        async pause() {
          pauses += 1;
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.deepEqual(result.summary.completedTickets ?? [], []);
  assert.equal(pauses, 1);
  assert.equal(agentCalls, 1);
  assert.ok(result.logPath);
  assert.match(await readFile(result.logPath, "utf8"), new RegExp(rejection));
});

test("a transient merge failure retries after reconciling Pull Request state", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery();
  let mergeRequests = 0;
  let merged = false;
  const sleeps: number[] = [];
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      codeHost: {
        async getPullRequest() {
          return {
            headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            createdAt: "2026-09-09T00:00:00Z",
            merged,
            mergeFailure: null,
          };
        },
        async requestSquashMerge() {
          mergeRequests += 1;
          if (mergeRequests === 1) throw new Error("502 Bad Gateway");
          merged = true;
          return { outcome: "accepted" };
        },
      },
      clock: {
        async sleep(milliseconds) {
          sleeps.push(milliseconds);
        },
      },
    }),
  );

  assert.deepEqual(result.summary.completedTickets, [9]);
  assert.equal(mergeRequests, 2);
  assert.deepEqual(sleeps, [30_000, 10_000]);
});

test("an explicit merge conflict is repaired on the original branch and Pull Request", async () => {
  const root = await createProject();
  await writeFile(
    path.join(root, "projects/demo/config.json"),
    JSON.stringify({
      ...validConfig,
      workflow: { ...validConfig.workflow, review: true },
      agents: {
        ...validConfig.agents,
        conflictRepair: { model: "gpt-5.5", reasoningEffort: "medium" },
      },
    }),
  );
  const { tracker } = createAttemptTracker(9);
  const implementation = {
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    message: "feat: implementation",
  };
  const conflictRepair = {
    sha: "cccccccccccccccccccccccccccccccccccccccc",
    message: "fix: merge conflict",
  };
  const ciRepair = {
    sha: "dddddddddddddddddddddddddddddddddddddddd",
    message: "fix: checks after conflict repair",
  };
  const targetBase = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const conflict = "GitHub reported a merge conflict in src/run.ts";
  const agentInputs: Parameters<AgentExecutor["execute"]>[0][] = [];
  let branch = "";
  let fetches = 0;
  let pushes = 0;
  let pullRequests = 0;
  let checkReads = 0;
  let mergeRequests = 0;
  let headSha = implementation.sha;
  let merged = false;
  let reviewCalls = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          fetches += 1;
          return fetches === 1
            ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            : targetBase;
        },
        async createWorktree(input) {
          branch = input.branch;
        },
        async inspect({ worktree, base, requiredAncestor }) {
          assert.equal(
            requiredAncestor,
            base === implementation.sha ? targetBase : undefined,
          );
          const commits =
            base === implementation.sha
              ? [conflictRepair]
              : base === conflictRepair.sha
                ? [ciRepair]
                : [implementation];
          return { worktree, branch, base, commits, clean: true };
        },
        async readReviewStandards() {
          return [];
        },
        async inspectReview() {
          return {
            clean: true,
            deliveryCommits: [implementation],
            reviewCommits: [],
          };
        },
        async push() {
          pushes += 1;
          if (pushes === 2) headSha = conflictRepair.sha;
          if (pushes === 3) headSha = ciRepair.sha;
        },
      },
      agentExecutor: {
        async execute(input) {
          agentInputs.push(input);
          const commit = [implementation, conflictRepair, ciRepair][
            agentInputs.length - 1
          ]!;
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
        async executeReview() {
          reviewCalls += 1;
          return {
            outcome: "passed",
            summary: "Initial implementation review passed.",
            standards: { verdict: "passed", unresolved_findings: [] },
            spec: { verdict: "passed", unresolved_findings: [] },
            checks: [],
            blocker: null,
          };
        },
      },
      codeHost: {
        async createPullRequest() {
          pullRequests += 1;
          return { number: 41, url: "https://github.com/owner/repo/pull/41" };
        },
        async getRequiredChecks() {
          checkReads += 1;
          return checkReads === 2
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
          if (mergeRequests === 1)
            return { outcome: "conflict", error: conflict };
          merged = true;
          return { outcome: "accepted" };
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.deepEqual(result.summary.completedTickets, [9]);
  assert.equal(fetches, 3);
  assert.equal(pushes, 3);
  assert.equal(pullRequests, 1);
  assert.equal(mergeRequests, 2);
  assert.equal(agentInputs.length, 3);
  assert.equal(reviewCalls, 1);
  assert.equal(
    agentInputs[1]?.promptFile,
    path.join(root, "projects/demo/prompts/conflict-repair.md"),
  );
  assert.equal(agentInputs[1]?.model, "gpt-5.5");
  assert.equal(agentInputs[1]?.effort, "medium");
  assert.equal(agentInputs[1]?.branch, branch);
  assert.equal(agentInputs[1]?.base, implementation.sha);
  assert.deepEqual(agentInputs[1]?.promptArgs, {
    TICKET_NUMBER: 9,
    TICKET_REFERENCE: "owner/repo#9",
    WORKTREE_PATH: agentInputs[0]?.worktree,
    BASE_SHA: implementation.sha,
    PROJECT_TARGET_BRANCH: "main",
    TARGET_BRANCH_SHA: targetBase,
    PULL_REQUEST_NUMBER: 41,
    PULL_REQUEST_URL: "https://github.com/owner/repo/pull/41",
    MERGE_CONFLICT: conflict,
  });
  assert.equal(
    agentInputs[2]?.promptFile,
    path.join(root, "projects/demo/prompts/ci-repair.md"),
  );
  assert.equal(agentInputs[2]?.branch, branch);
  assert.ok(result.logPath);
  const conflictOperations = (await readFile(result.logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.phase === "conflict_repair")
    .map((event) => event.operation);
  assert.ok(conflictOperations.includes("fetch_target_branch"));
  assert.ok(conflictOperations.includes("agent_attempt"));
  assert.ok(conflictOperations.includes("push_repair"));
});

test("CI repairs before and after conflict repair share one ticket budget", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  const implementation = {
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    message: "feat: implementation",
  };
  const initialCiRepair = {
    sha: "cccccccccccccccccccccccccccccccccccccccc",
    message: "fix: initial checks",
  };
  const conflictRepair = {
    sha: "dddddddddddddddddddddddddddddddddddddddd",
    message: "fix: merge conflict",
  };
  let branch = "";
  let agentCalls = 0;
  let checkReads = 0;
  let pushes = 0;
  let mergeRequests = 0;
  let headSha = implementation.sha;

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
          const commits =
            base === implementation.sha
              ? [initialCiRepair]
              : base === initialCiRepair.sha
                ? [conflictRepair]
                : [implementation];
          return { worktree, branch, base, commits, clean: true };
        },
        async push() {
          pushes += 1;
          if (pushes === 2) headSha = initialCiRepair.sha;
          if (pushes === 3) headSha = conflictRepair.sha;
        },
      },
      agentExecutor: {
        async execute() {
          agentCalls += 1;
          if (agentCalls === 4) {
            return {
              outcome: "blocked",
              summary: "checks still failing",
              commits: [],
              checks: [],
              blocker: "checks still failing",
              pr_title: "unused",
              pr_body: "unused",
            };
          }
          const commit = [implementation, initialCiRepair, conflictRepair][
            agentCalls - 1
          ]!;
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
          return checkReads === 2
            ? []
            : [
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
            headSha,
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
          assert.match(message, /CI repair failed after two attempts/u);
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(agentCalls, 4);
  assert.equal(pushes, 3);
  assert.equal(mergeRequests, 1);
});
