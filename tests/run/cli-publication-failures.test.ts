import assert from "node:assert/strict";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { cleanupTempRoots } from "../support/temp-cleanup.ts";
import {
  createCliDependencies,
  createAttemptTracker,
} from "../support/cli-dependencies.ts";
import { validConfig, createProject } from "../support/cli-project.ts";
import { executeCli } from "../../src/cli.ts";

test.afterEach(cleanupTempRoots);

test("required-check timeout enters Operator Pause", async () => {
  const root = await createProject();
  await writeFile(
    path.join(root, "projects/demo/config.json"),
    JSON.stringify({
      ...validConfig,
      timeouts: { ...validConfig.timeouts, requiredChecksMinutes: 1 / 60_000 },
    }),
  );
  let elapsed = 0;
  let discoveryDelays = 0;
  let branch = "";
  let pauseMessage = "";
  const responses = ["", "q"];
  const commit = {
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    message: "feat: implementation",
  };
  const { tracker } = createAttemptTracker(9);
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
        async createPullRequest() {
          return { number: 41, url: "https://github.com/owner/repo/pull/41" };
        },
        async getRequiredChecks() {
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
      clock: {
        now: () => new Date(elapsed),
        async sleep(milliseconds) {
          if (milliseconds === 30_000) discoveryDelays += 1;
          elapsed += milliseconds;
        },
      },
      operator: {
        async pause(message) {
          pauseMessage = message;
          return responses.shift() ?? "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.match(pauseMessage, /Required checks timed out/u);
  assert.equal(discoveryDelays, 1);
});

test("a successful publication write is not replayed when its result audit is cancelled", async () => {
  const root = await createProject();
  const logs = path.join(root, "projects/demo/logs");
  let branch = "";
  let pushCalls = 0;
  let damagedLog = "";
  const commit = {
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    message: "feat: implementation",
  };
  const { tracker } = createAttemptTracker(9);
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
        async push() {
          pushCalls += 1;
          if (pushCalls === 1) {
            const [filename] = await readdir(logs);
            assert.ok(filename);
            damagedLog = path.join(logs, filename);
            await rm(damagedLog);
            await mkdir(damagedLog);
          }
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
      operator: {
        async pause() {
          if (damagedLog) {
            await rm(damagedLog, { recursive: true });
            await writeFile(damagedLog, "");
            damagedLog = "";
            return "q";
          }
          return "";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(pushCalls, 1);
});

test("uncertain push and Pull Request creation writes are never replayed automatically", async () => {
  for (const failedWrite of ["push", "create"] as const) {
    const root = await createProject();
    let branch = "";
    let pushCalls = 0;
    let createCalls = 0;
    const commit = {
      sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      message: "feat: implementation",
    };
    const { tracker } = createAttemptTracker(9);
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
          async push() {
            pushCalls += 1;
            if (failedWrite === "push") throw new Error("uncertain push");
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
          async createPullRequest() {
            createCalls += 1;
            if (failedWrite === "create") throw new Error("uncertain create");
            return {
              number: 41,
              url: "https://github.com/owner/repo/pull/41",
            };
          },
          async getRequiredChecks() {
            return [];
          },
        },
        operator: {
          async pause() {
            return failedWrite === "push"
              ? "trusted success"
              : "https://github.com/owner/repo/pull/41";
          },
        },
      }),
    );

    assert.equal(result.summary.pullRequests?.[0]?.number, 41);
    assert.equal(pushCalls, 1);
    assert.equal(createCalls, 1);
  }
});

test("Parent cancellation before publication stops without branch, PR, or child mutations", async () => {
  const root = await createProject();
  let branch = "";
  let inspected = false;
  let writes = 0;
  let releases = 0;
  const commit = {
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    message: "feat: implementation",
  };
  const { tracker } = createAttemptTracker(9);
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        ...tracker,
        async getParent() {
          return inspected
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
        async createWorktree(input) {
          branch = input.branch;
        },
        async inspect({ worktree, base }) {
          inspected = true;
          return { worktree, branch, base, commits: [commit], clean: true };
        },
        async push() {
          writes += 1;
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
        async createPullRequest() {
          writes += 1;
          return { number: 41, url: "https://github.com/owner/repo/pull/41" };
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(writes, 0);
  assert.equal(releases, 0);
});

test("valid no_change and blocked results stay unresolved without handoffs", async () => {
  for (const scenario of [
    {
      outcome: "no_change" as const,
      summary: "the requested behavior already exists",
      blocker: null,
      expected:
        "Delivery Ticket 9 no_change: the requested behavior already exists",
      inspections: 1,
    },
    {
      outcome: "blocked" as const,
      summary: "waiting for an API decision",
      blocker: "API contract is unresolved",
      expected: "Delivery Ticket 9 blocked: API contract is unresolved",
      inspections: 0,
    },
  ]) {
    const root = await createProject();
    const config = structuredClone(validConfig);
    config.workflow.review = true;
    await writeFile(
      path.join(root, "projects/demo/config.json"),
      JSON.stringify(config),
    );
    let inspections = 0;
    let branch = "";
    const { tracker } = createAttemptTracker(9);
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
            inspections += 1;
            return {
              worktree,
              branch,
              base,
              commits: [],
              clean: true,
            };
          },
        },
        agentExecutor: {
          async execute() {
            return {
              ...scenario,
              commits: [],
              checks: [],
              pr_title: "unused metadata",
              pr_body: "unused metadata",
            };
          },
          async executeReview() {
            assert.fail(
              "review must not follow no_change or blocked implementation",
            );
          },
        },
        operator: {
          async pause() {
            return "q";
          },
        },
      }),
    );

    assert.equal(
      result.summary.outcome,
      scenario.outcome === "blocked" ? "cancelled" : "incomplete",
    );
    assert.equal(result.summary.handoffs?.length ?? 0, 0);
    if (scenario.outcome === "no_change")
      assert.ok(result.summary.reasons.includes(scenario.expected));
    assert.equal(inspections, scenario.inspections);
  }
});

test("Delivery Ticket no_change comments its summary with safe write retry", async () => {
  const root = await createProject();
  let branch = "";
  let commentAttempts = 0;
  const comments: string[] = [];
  const sleeps: number[] = [];
  const { tracker } = createAttemptTracker(9);
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        ...tracker,
        async addComment(_repository, ticket, body) {
          commentAttempts += 1;
          if (commentAttempts === 1) throw new Error("500 comment failure");
          comments.push(`${ticket}:${body}`);
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
            commits: [],
            clean: true,
          };
        },
      },
      agentExecutor: {
        async execute() {
          return {
            outcome: "no_change" as const,
            summary: "the requested behavior already exists",
            commits: [],
            checks: [],
            blocker: null,
            pr_title: "unused metadata",
            pr_body: "unused metadata",
          };
        },
      },
      clock: {
        async sleep(milliseconds) {
          sleeps.push(milliseconds);
        },
      },
      operator: {
        async pause(message) {
          throw new Error(`unexpected Operator Pause: ${message}`);
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "incomplete");
  assert.deepEqual(comments, ["9:the requested behavior already exists"]);
  assert.equal(commentAttempts, 2);
  assert.deepEqual(sleeps, [10_000]);
});

test("false commit claims enter Operator Pause and q cancels active Sandcastle resources", async () => {
  const root = await createProject();
  let signal: AbortSignal | undefined;
  const { tracker } = createAttemptTracker(9);
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      gitWorkspace: {
        async fetchTargetBranch() {
          return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        },
        async inspect({ worktree, base }) {
          return {
            worktree,
            branch: "sandcastle/mismatch",
            base,
            commits: [],
            clean: true,
          };
        },
      },
      agentExecutor: {
        async execute(input) {
          signal = input.signal;
          return {
            outcome: "committed",
            summary: "claimed success",
            commits: [
              {
                sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                message: "feat: claimed commit",
              },
            ],
            checks: [],
            blocker: null,
            pr_title: "feat: claimed commit",
            pr_body: "Claimed implementation.",
          };
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
  assert.equal(signal?.aborted, true);
});
