import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
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
import { readRecoverySnapshot, recoveryPaths } from "../../src/recovery.ts";

test.afterEach(cleanupTempRoots);

test("empty input starts a fresh Agent Attempt with a new Git configuration", async () => {
  const root = await createProject();
  const gitConfigs: string[] = [];
  let branch = "";
  let attempt = 0;
  const { tracker } = createAttemptTracker(9);
  const commit = {
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    message: "feat: retry succeeds",
  };
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
          return { worktree, branch, base, commits: [commit], clean: true };
        },
      },
      agentExecutor: {
        async execute(input) {
          gitConfigs.push(input.gitConfigGlobal);
          attempt += 1;
          if (attempt === 1) throw new Error("Sandcastle failed");
          return {
            outcome: "committed",
            summary: "retry succeeded",
            commits: [commit],
            checks: [],
            blocker: null,
            pr_title: "feat: retry succeeds",
            pr_body: "Retry implementation.",
          };
        },
      },
      operator: {
        async pause() {
          return "";
        },
      },
    }),
  );

  assert.equal(result.summary.handoffs?.length, 1);
  assert.equal(gitConfigs.length, 2);
  assert.notEqual(gitConfigs[0], gitConfigs[1]);
  await Promise.all(
    gitConfigs.map((filename) => assert.rejects(readFile(filename, "utf8"))),
  );
});

test("a trusted committed override extracts only downstream metadata and bypasses Git verification", async () => {
  const root = await createProject();
  const responses = [
    "not json",
    JSON.stringify({
      outcome: "committed",
      pr_title: "feat: trusted result",
      pr_body: "Operator supplied metadata.",
      ignored: "not copied downstream",
    }),
  ];
  let inspections = 0;
  const { tracker } = createAttemptTracker(9);
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
        async inspect() {
          inspections += 1;
          throw new Error("must be bypassed");
        },
      },
      agentExecutor: {
        async execute() {
          throw new Error("Sandcastle failed");
        },
      },
      operator: {
        async pause() {
          return responses.shift() ?? "q";
        },
      },
    }),
  );

  assert.equal(inspections, 0);
  assert.equal(result.summary.handoffs?.[0]?.verification, "operator_override");
  assert.equal(result.summary.handoffs?.[0]?.prTitle, "feat: trusted result");
  assert.deepEqual(result.summary.handoffs?.[0]?.commits, []);
  assert.ok(result.logPath);
  const audit = await readFile(result.logPath, "utf8");
  assert.match(audit, /operator_override/u);
  assert.equal(audit.includes("not json"), false);
  assert.equal(audit.includes("not copied downstream"), false);
});

test("a reserved Batch runs its Agent Attempts concurrently", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9, 10);
  const branches = new Map<number, string>();
  let active = 0;
  let maxActive = 0;
  let release: (() => void) | undefined;
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
        async createWorktree(input) {
          const ticket = Number(input.branch.split("-").at(-1));
          branches.set(ticket, input.branch);
        },
        async inspect({ worktree, base }) {
          const ticket = Number(worktree.split("-").at(-1));
          const digit = ticket === 9 ? "b" : "c";
          return {
            worktree,
            branch: branches.get(ticket)!,
            base,
            commits: [
              { sha: digit.repeat(40), message: `feat: ticket ${ticket}` },
            ],
            clean: true,
          };
        },
      },
      agentExecutor: {
        async execute(input) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          if (active === 2) release?.();
          await bothStarted;
          active -= 1;
          const digit = input.ticket === 9 ? "b" : "c";
          return {
            outcome: "committed",
            summary: `implemented ${input.ticket}`,
            commits: [
              {
                sha: digit.repeat(40),
                message: `feat: ticket ${input.ticket}`,
              },
            ],
            checks: [],
            blocker: null,
            pr_title: `feat: ticket ${input.ticket}`,
            pr_body: `Implements ticket ${input.ticket}.`,
          };
        },
      },
    }),
  );

  assert.equal(maxActive, 2);
  assert.deepEqual(
    result.summary.handoffs?.map(({ ticket }) => ticket),
    [9, 10],
  );
});

test("a Batch publishes every PR before merging by creation order", async () => {
  const root = await createProject();
  const delivery = createCommittedBatch(9, 10, 11);
  const pullRequests = new Map([
    [9, { number: 42, createdAt: "2026-09-09T00:00:02Z" }],
    [10, { number: 43, createdAt: "2026-09-09T00:00:01Z" }],
    [11, { number: 41, createdAt: "2026-09-09T00:00:01Z" }],
  ]);
  const merged = new Set<number>();
  const operations: string[] = [];
  let activeCheckReads = 0;
  let maxActiveCheckReads = 0;
  let releaseChecks!: () => void;
  const allChecksStarted = new Promise<void>((resolve) => {
    releaseChecks = resolve;
  });

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
      gitWorkspace: delivery.gitWorkspace,
      agentExecutor: delivery.agentExecutor,
      codeHost: {
        async createPullRequest(input) {
          const ticket = Number(input.branch.split("-").at(-1));
          const pullRequest = pullRequests.get(ticket)!;
          operations.push(`create:${pullRequest.number}`);
          return {
            number: pullRequest.number,
            url: `https://github.com/owner/repo/pull/${pullRequest.number}`,
          };
        },
        async getRequiredChecks(_repository, pullRequest) {
          operations.push(`checks:${pullRequest}`);
          activeCheckReads += 1;
          maxActiveCheckReads = Math.max(maxActiveCheckReads, activeCheckReads);
          if (activeCheckReads === 3) releaseChecks();
          await allChecksStarted;
          activeCheckReads -= 1;
          return [];
        },
        async getPullRequest(_repository, pullRequest) {
          const metadata = [...pullRequests.values()].find(
            ({ number }) => number === pullRequest,
          )!;
          return {
            headSha: String(pullRequest).at(-1)!.repeat(40),
            createdAt: metadata.createdAt,
            merged: merged.has(pullRequest),
            mergeFailure: null,
          };
        },
        async requestSquashMerge({ pullRequest }) {
          operations.push(`merge:${pullRequest}`);
          merged.add(pullRequest);
          return { outcome: "accepted" };
        },
      },
    }),
  );

  assert.deepEqual(
    operations.filter((operation) => operation.startsWith("create:")).sort(),
    ["create:41", "create:42", "create:43"],
  );
  assert.equal(
    operations
      .slice(
        0,
        operations.findIndex((operation) => operation.startsWith("merge:")),
      )
      .filter((operation) => operation.startsWith("checks:")).length,
    3,
  );
  assert.deepEqual(
    operations.filter((operation) => operation.startsWith("merge:")),
    ["merge:41", "merge:43", "merge:42"],
  );
  assert.equal(maxActiveCheckReads, 3);
  assert.equal(result.summary.outcome, "succeeded");
  assert.deepEqual(result.summary.completedTickets, [11, 10, 9]);
  assert.ok(
    delivery.tickets.every(({ stateReason }) => stateReason === "completed"),
  );
});

test("three completed Delivery Tickets trigger committed Documentation Maintenance before closeout", async () => {
  const root = await createProject();
  await writeFile(
    path.join(root, "projects/demo/config.json"),
    JSON.stringify({
      ...validConfig,
      workflow: { ...validConfig.workflow, review: true },
      ticketClosure: "code_host",
    }),
  );
  const delivery = createCommittedBatch(9, 10, 11);
  const maintenance = {
    number: 100,
    state: "open" as "open" | "closed",
    stateReason: null as null | "completed",
    assignees: [] as string[],
    labels: ["doc-maintain"],
  };
  const merged = new Set<number>();
  const operations: string[] = [];
  let reviewCalls = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        ...delivery.tracker,
        async listLabelsPage() {
          operations.push("labels:read");
          return { labels: [], nextPage: null };
        },
        async createLabel(_repository, label) {
          operations.push(`label:create:${label}`);
        },
        async createMaintenanceTicket(_repository, title, body, label) {
          operations.push(`maintenance:create:${title}:${body}:${label}`);
          return maintenance;
        },
        async getTicket(repository, ticket) {
          return ticket === maintenance.number
            ? maintenance
            : delivery.tracker.getTicket!(repository, ticket);
        },
        async listBlockersPage() {
          return { blockers: [], nextPage: null };
        },
        async closeTicket(repository, ticket) {
          if (ticket === maintenance.number) {
            maintenance.state = "closed";
            maintenance.stateReason = "completed";
            operations.push("maintenance:close");
            return;
          }
          await delivery.tracker.closeTicket!(repository, ticket);
        },
        async closeParent() {
          operations.push("parent:close");
        },
      },
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async readReviewStandards() {
          return [];
        },
        async inspectReview({ worktree }) {
          const ticket = Number(worktree.split("-").at(-1));
          return {
            clean: true,
            deliveryCommits: [
              {
                sha: String(ticket).at(-1)!.repeat(40),
                message: `feat: ticket ${ticket}`,
              },
            ],
            reviewCommits: [],
          };
        },
      },
      agentExecutor: {
        async execute(input) {
          if (input.ticket !== maintenance.number)
            return delivery.agentExecutor.execute(input);
          operations.push("maintenance:agent");
          assert.match(input.promptFile, /prompts\/documentation\.md$/u);
          assert.deepEqual(Object.keys(input.promptArgs).sort(), [
            "BASE_SHA",
            "PROJECT_TARGET_BRANCH",
            "TICKET_NUMBER",
            "TICKET_REFERENCE",
            "WORKTREE_PATH",
          ]);
          assert.match(input.branch, /\/maintenance-100$/u);
          assert.notEqual(input.branch, input.promptArgs.PROJECT_TARGET_BRANCH);
          assert.equal(input.promptArgs.PROJECT_TARGET_BRANCH, "main");
          return {
            outcome: "committed",
            summary: "documentation updated",
            commits: [
              {
                sha: "0".repeat(40),
                message: "feat: ticket 100",
              },
            ],
            checks: [],
            blocker: null,
            pr_title: "docs: maintain project documentation",
            pr_body: "Maintain documentation.",
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
        async createPullRequest(input) {
          const ticket = Number(input.branch.split("-").at(-1));
          operations.push(`pr:create:${ticket}`);
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
            createdAt: `2026-09-09T00:00:${String(pullRequest).padStart(2, "0")}Z`,
            merged: merged.has(pullRequest),
            mergeFailure: null,
          };
        },
        async requestSquashMerge({ pullRequest }) {
          operations.push(`merge:${pullRequest}`);
          merged.add(pullRequest);
          if (pullRequest === 200) {
            maintenance.state = "closed";
            maintenance.stateReason = "completed";
          } else {
            const ticket = delivery.tickets.find(
              ({ number }) => number === pullRequest - 100,
            )!;
            ticket.state = "closed";
            ticket.stateReason = "completed";
          }
          return { outcome: "accepted" };
        },
      },
      operator: {
        async pause(message) {
          throw new Error(`unexpected pause: ${message}`);
        },
      },
    }),
  );
  assert.equal(result.summary.outcome, "succeeded");
  assert.deepEqual(result.summary.completedTickets, [9, 10, 11]);
  assert.equal(reviewCalls, 3);
  assert.ok(
    operations.indexOf("maintenance:agent") > operations.indexOf("merge:111"),
  );
  assert.ok(
    operations.indexOf("parent:close") > operations.indexOf("merge:200"),
  );
  assert.deepEqual(operations.slice(operations.indexOf("labels:read"), -1), [
    "labels:read",
    "label:create:doc-maintain",
    "maintenance:create:Maintain project documentation:Run the configured documentation-maintenance prompt for the current Target Branch.:doc-maintain",
    "maintenance:agent",
    "pr:create:100",
    "merge:200",
  ]);
  assert.deepEqual(
    (
      await readRecoverySnapshot(
        recoveryPaths(path.join(root, "projects", "demo"), 8).snapshot,
      )
    )?.publications
      ?.map(({ ticket }) => ticket)
      .sort((left, right) => left - right),
    [9, 10, 11],
  );
});
