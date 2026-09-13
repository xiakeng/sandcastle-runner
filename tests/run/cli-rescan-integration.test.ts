import assert from "node:assert/strict";
import test from "node:test";

import { cleanupTempRoots } from "../support/temp-cleanup.ts";
import {
  createCliDependencies,
  createAttemptTracker,
  createCommittedBatch,
} from "../support/cli-dependencies.ts";
import { createProject } from "../support/cli-project.ts";
import { executeCli } from "../../src/cli.ts";

test.afterEach(cleanupTempRoots);

test("a successful Batch rescans added work and an emptied scope closes the Parent", async () => {
  const root = await createProject();
  const delivery = createCommittedBatch(9);
  const ticket10 = {
    number: 10,
    state: "open" as const,
    stateReason: null,
    repository: "owner/repo",
    assignees: [] as string[],
    labels: [] as string[],
  };
  const merged = new Set<number>();
  const attempts: number[] = [];
  let removed = false;
  let fetches = 0;
  let parentClosures = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        ...delivery.tracker,
        async listChildrenPage() {
          if (removed) return { children: [], nextPage: null };
          if (
            delivery.tickets[0]!.stateReason === "completed" &&
            !delivery.tickets.includes(ticket10)
          ) {
            delivery.tickets.push(ticket10);
          }
          return { children: delivery.tickets, nextPage: null };
        },
        async getTicket(_repository, ticket) {
          return delivery.tickets.find(({ number }) => number === ticket)!;
        },
        async listBlockersPage(_repository, ticket) {
          return {
            blockers: ticket === 10 ? [delivery.tickets[0]!] : [],
            nextPage: null,
          };
        },
        async removeLabel(repository, ticket, label) {
          await delivery.tracker.removeLabel!(repository, ticket, label);
          if (ticket === 10) removed = true;
        },
        async closeParent() {
          parentClosures += 1;
        },
      },
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async fetchTargetBranch() {
          fetches += 1;
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
      },
      agentExecutor: {
        async execute(input) {
          attempts.push(input.ticket);
          return delivery.agentExecutor.execute(input);
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
          merged.add(pullRequest);
          return { outcome: "accepted" };
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.deepEqual(attempts, [9, 10]);
  assert.deepEqual(result.summary.batch, [9, 10]);
  assert.deepEqual(result.summary.completedTickets, [9, 10]);
  assert.equal(fetches, 3);
  assert.equal(parentClosures, 1);
});

test("an unresolved Agent Attempt blocks integration after other Handoffs publish", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9, 10);
  const branches = new Map<number, string>();
  let pullRequestCreates = 0;
  let mergeRequests = 0;
  let maintenanceCreates = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        ...tracker,
        async createMaintenanceTicket() {
          maintenanceCreates += 1;
          return { number: 100, state: "open", stateReason: null };
        },
      },
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
        async createWorktree(input) {
          branches.set(Number(input.branch.split("-").at(-1)), input.branch);
        },
        async inspect({ worktree, base }) {
          const ticket = Number(worktree.split("-").at(-1));
          return {
            worktree,
            branch: branches.get(ticket)!,
            base,
            commits:
              ticket === 9
                ? [
                    {
                      sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                      message: "feat: ticket 9",
                    },
                  ]
                : [],
            clean: true,
          };
        },
      },
      agentExecutor: {
        async execute(input) {
          return input.ticket === 9
            ? {
                outcome: "committed",
                summary: "implemented 9",
                commits: [
                  {
                    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    message: "feat: ticket 9",
                  },
                ],
                checks: [],
                blocker: null,
                pr_title: "feat: ticket 9",
                pr_body: "Implements ticket 9.",
              }
            : {
                outcome: "no_change",
                summary: "no safe change",
                commits: [],
                checks: [],
                blocker: null,
                pr_title: "unused",
                pr_body: "unused",
              };
        },
      },
      codeHost: {
        async createPullRequest() {
          pullRequestCreates += 1;
          return { number: 41, url: "https://github.com/owner/repo/pull/41" };
        },
        async requestSquashMerge() {
          mergeRequests += 1;
          return { outcome: "accepted" };
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "incomplete");
  assert.equal(pullRequestCreates, 1);
  assert.equal(mergeRequests, 0);
  assert.equal(maintenanceCreates, 0);
  assert.deepEqual(result.summary.completedTickets ?? [], []);
  assert.match(result.summary.reasons.join(" "), /no_change.*Batch barrier/u);
});

test("a boundary stop after PR creation keeps its identity", async () => {
  const root = await createProject();
  const delivery = createCommittedBatch(9);
  let parentCancelled = false;

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
      codeHost: {
        async getRequiredChecks() {
          parentCancelled = true;
          return [
            {
              name: "build",
              state: "IN_PROGRESS",
              link: "https://github.com/owner/repo/actions/runs/1",
              bucket: "pending",
            },
          ];
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.deepEqual(result.summary.pullRequests, [
    {
      ticket: 9,
      branch: result.summary.handoffs![0]!.branch,
      number: 1,
      url: "https://github.com/owner/repo/pull/1",
      readiness: "stopped",
      failedChecks: [],
    },
  ]);
});

test("partial Batch integration keeps credit and ordering through a repaired conflict", async () => {
  const root = await createProject();
  const delivery = createCommittedBatch(9, 10, 11);
  const merged = new Set<number>();
  const mergeRequests: number[] = [];

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
      gitWorkspace: delivery.gitWorkspace,
      agentExecutor: delivery.agentExecutor,
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
          mergeRequests.push(pullRequest);
          if (
            pullRequest === 110 &&
            mergeRequests.filter((number) => number === 110).length === 1
          ) {
            return { outcome: "conflict", error: "conflict in run.ts" };
          }
          merged.add(pullRequest);
          return { outcome: "accepted" };
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.deepEqual(mergeRequests, [109, 110, 110, 111]);
  assert.deepEqual(result.summary.completedTickets, [9, 10, 11]);
  assert.equal(delivery.tickets[0]!.stateReason, "completed");
  assert.equal(delivery.tickets[1]!.stateReason, "completed");
  assert.equal(delivery.tickets[2]!.stateReason, "completed");
});
