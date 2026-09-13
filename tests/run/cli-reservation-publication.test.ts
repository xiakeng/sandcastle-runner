import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { cleanupTempRoots } from "../support/temp-cleanup.ts";
import {
  createCliDependencies,
  createAttemptTracker,
} from "../support/cli-dependencies.ts";
import { createProject } from "../support/cli-project.ts";
import { executeCli } from "../../src/cli.ts";
import type { AgentExecutor } from "../../src/run/contracts.ts";

test.afterEach(cleanupTempRoots);

test("a failed second Reservation marker keeps the partial write", async () => {
  const root = await createProject();
  const writes: string[] = [];
  let assigneeCalls = 0;
  const child = {
    number: 9,
    state: "open" as const,
    stateReason: null,
    repository: "owner/repo",
    assignees: [],
    labels: [],
  };

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          return { children: [child], nextPage: null };
        },
        async getTicket() {
          return child;
        },
        async addLabel() {
          writes.push("add label");
        },
        async addAssignee() {
          assigneeCalls += 1;
          throw new Error("assignee write failed");
        },
        async removeLabel() {
          writes.push("remove label");
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
  assert.equal(assigneeCalls, 1);
  assert.deepEqual(writes, ["add label"]);
});

test("a cross-repository child with the selected number fails revalidation", async () => {
  const root = await createProject();
  let childScans = 0;
  let childWrites = 0;
  const child = {
    number: 9,
    state: "open" as const,
    stateReason: null,
    assignees: [],
    labels: [],
  };

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          childScans += 1;
          return {
            children: [
              {
                ...child,
                repository: childScans === 1 ? "owner/repo" : "another/repo",
              },
            ],
            nextPage: null,
          };
        },
        async getTicket() {
          return { ...child, repository: "owner/repo" };
        },
        async addLabel() {
          childWrites += 1;
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "failed");
  assert.match(result.summary.reasons[0] ?? "", /cross-repository/u);
  assert.equal(childWrites, 0);
});

test("successive revalidation changes cannot hide newly eligible work", async () => {
  const root = await createProject();
  let childScans = 0;
  const ticket = (number: number, assignees: string[] = []) => ({
    number,
    state: "open" as const,
    stateReason: null,
    repository: "owner/repo",
    assignees,
    labels: [],
  });

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          childScans += 1;
          const children =
            childScans === 1
              ? [ticket(9)]
              : childScans < 4
                ? [ticket(9, ["developer"]), ticket(10)]
                : [
                    ticket(9, ["developer"]),
                    ticket(10, ["developer"]),
                    ticket(11),
                  ];
          return { children, nextPage: null };
        },
        async getTicket(_repository, number) {
          return number === 11 ? ticket(11) : ticket(number, ["developer"]);
        },
      },
    }),
  );

  assert.deepEqual(result.summary.batch, [11]);
});

test("the final complete scan closes a now-terminal Parent scope", async () => {
  const root = await createProject();
  let childScans = 0;
  let closeCalls = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async listChildrenPage() {
          childScans += 1;
          return {
            children: [
              {
                number: 9,
                state: childScans === 1 ? "open" : "closed",
                stateReason: childScans === 1 ? null : "completed",
                repository: "owner/repo",
                assignees: [],
                labels: childScans === 1 ? ["sandcastle:reserved"] : [],
              },
            ],
            nextPage: null,
          };
        },
        async closeParent() {
          closeCalls += 1;
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(closeCalls, 1);
});

test("cancelling a failed audit result append pauses exactly once", async () => {
  const root = await createProject();
  const logs = path.join(root, "projects", "demo", "logs");
  let pauseCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          const [filename] = await readdir(logs);
          assert.ok(filename);
          const logPath = path.join(logs, filename);
          await rm(logPath);
          await mkdir(logPath);
          return { number: 8, state: "open", stateReason: null } as const;
        },
        async listChildrenPage() {
          throw new Error("must not scan children");
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

test("a Verified Handoff is published unchanged and becomes CI-ready after check discovery", async () => {
  const root = await createProject();
  const operations: string[] = [];
  let prepared: { worktree: string; branch: string; base: string } | undefined;
  let agentInput: Parameters<AgentExecutor["execute"]>[0] | undefined;
  let gitConfigContents: string | undefined;
  let checkReads = 0;
  const { tracker } = createAttemptTracker(9);

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch(checkout, targetBranch) {
          operations.push(`fetch:${checkout}:${targetBranch}`);
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
        async createWorktree(input) {
          prepared = input;
          operations.push(`create:${input.branch}:${input.base}`);
        },
        async inspect({ worktree, base }) {
          operations.push(`inspect:${base}`);
          assert.ok(prepared);
          return {
            worktree,
            branch: prepared.branch,
            base,
            commits: [
              {
                sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                message: "feat: implement ticket",
              },
            ],
            clean: true,
          };
        },
        async push(worktree, branch) {
          operations.push(`push:${worktree}:${branch}`);
        },
      },
      codeHost: {
        async createPullRequest(input) {
          operations.push(
            `pr:${input.repository}:${input.targetBranch}:${input.branch}:${input.title}:${input.body}`,
          );
          return {
            number: 41,
            url: "https://github.com/owner/repo/pull/41",
          };
        },
        async getRequiredChecks(repository, pullRequest) {
          operations.push(`checks:${repository}:${pullRequest}`);
          checkReads += 1;
          if (checkReads === 1) throw new Error("temporary read failure");
          return [];
        },
      },
      clock: {
        async sleep(milliseconds) {
          operations.push(`sleep:${milliseconds}`);
        },
      },
      agentExecutor: {
        async execute(input) {
          agentInput = input;
          gitConfigContents = await readFile(input.gitConfigGlobal, "utf8");
          operations.push(
            `execute:${input.ticket}:${input.branch}:${input.base}`,
          );
          return {
            outcome: "committed",
            summary: "implemented",
            commits: [
              {
                sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                message: "feat: implement ticket",
              },
            ],
            checks: [{ command: "npm test", status: "passed", details: "ok" }],
            blocker: null,
            pr_title: "feat: implement ticket",
            pr_body: "Implements the Delivery Ticket.",
          };
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.ok(prepared);
  assert.deepEqual(result.summary.handoffs, [
    {
      ticket: 9,
      worktree: prepared.worktree,
      branch: prepared.branch,
      base: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      commits: [
        {
          sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          message: "feat: implement ticket",
        },
      ],
      checks: [{ command: "npm test", status: "passed", details: "ok" }],
      prTitle: "feat: implement ticket",
      prBody: "Implements the Delivery Ticket.",
      verification: "verified",
    },
  ]);
  assert.deepEqual(result.summary.pullRequests, [
    {
      ticket: 9,
      branch: prepared.branch,
      number: 41,
      url: "https://github.com/owner/repo/pull/41",
      readiness: "ready",
      failedChecks: [],
    },
  ]);
  assert.match(prepared.branch, /^sandcastle\/run-[0-9a-f-]+\/ticket-9$/u);
  assert.equal(path.isAbsolute(prepared.worktree), true);
  assert.ok(agentInput);
  assert.equal(
    agentInput.promptFile,
    path.join(root, "projects/demo/prompts/implement.md"),
  );
  assert.deepEqual(agentInput.promptArgs, {
    TICKET_NUMBER: 9,
    TICKET_REFERENCE: "owner/repo#9",
    WORKTREE_PATH: prepared.worktree,
    BASE_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    PROJECT_TARGET_BRANCH: "main",
  });
  assert.equal(agentInput.model, "gpt-5.6-sol");
  assert.equal(agentInput.effort, "high");
  assert.equal(agentInput.timeoutMs, 120 * 60_000);
  assert.equal(gitConfigContents, "");
  await assert.rejects(readFile(agentInput.gitConfigGlobal, "utf8"));
  assert.deepEqual(operations, [
    "fetch:/tmp/repo:main",
    `create:${prepared.branch}:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
    `execute:9:${prepared.branch}:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
    "inspect:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    `push:${prepared.worktree}:${prepared.branch}`,
    `pr:owner/repo:main:${prepared.branch}:feat: implement ticket:Implements the Delivery Ticket.`,
    "sleep:30000",
    "checks:owner/repo:41",
    "sleep:5000",
    "checks:owner/repo:41",
    "fetch:/tmp/repo:main",
  ]);
});

test("a CI-ready Pull Request is delivered only after its merge and completed closure are confirmed", async () => {
  const root = await createProject();
  const operations: string[] = [];
  const commit = {
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    message: "feat: implementation",
  };
  const { tickets, tracker } = createAttemptTracker(9);
  let branch = "";
  let merged = false;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        ...tracker,
        async closeTicket(_repository: string, ticket: number) {
          operations.push(`close:${ticket}`);
          const found = tickets.find(({ number }) => number === ticket)!;
          found.state = "closed";
          found.stateReason = "completed";
        },
        async removeAssignee(_repository, ticket) {
          operations.push(`unassign:${ticket}`);
        },
        async removeLabel(_repository, ticket) {
          operations.push(`unlabel:${ticket}`);
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
          return { worktree, branch, base, commits: [commit], clean: true };
        },
      },
      agentExecutor: {
        async execute() {
          return {
            outcome: "committed",
            summary: "implemented",
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
          operations.push(`observe:${merged}`);
          return {
            headSha: commit.sha,
            createdAt: "2026-09-09T00:00:00Z",
            merged,
            mergeFailure: null,
          };
        },
        async requestSquashMerge(input: {
          pullRequest: number;
          headSha: string;
          admin: boolean;
        }) {
          operations.push(
            `merge:${input.pullRequest}:${input.headSha}:${input.admin}`,
          );
          merged = true;
          return { outcome: "accepted" as const };
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.deepEqual(result.summary.completedTickets, [9]);
  assert.deepEqual(operations, [
    "observe:false",
    "observe:false",
    `merge:1:${commit.sha}:false`,
    "observe:true",
    "close:9",
    "unassign:9",
    "unlabel:9",
  ]);
});
