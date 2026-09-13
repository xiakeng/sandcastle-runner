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
import type { AgentExecutor, RequiredCheck } from "../../src/run/contracts.ts";

test.afterEach(cleanupTempRoots);

test("Parent cancellation after merge confirmation prevents ticket closure mutations", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery();
  let merged = false;
  let closeCalls = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      tracker: {
        ...delivery.tracker,
        async getParent() {
          return merged
            ? { number: 8, state: "closed", stateReason: "not_planned" }
            : { number: 8, state: "open", stateReason: null };
        },
        async closeTicket() {
          closeCalls += 1;
        },
      },
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
          merged = true;
          return { outcome: "accepted" };
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(closeCalls, 0);
});

test("required-check polling repairs terminal failure and cancellation evidence", async () => {
  const scenarios: {
    name: string;
    reads: RequiredCheck[][];
    readiness: "ready" | "failed";
    failedChecks: RequiredCheck[];
    sleeps: number[];
  }[] = [
    {
      name: "pending then passing",
      reads: [
        [
          {
            name: "build",
            state: "IN_PROGRESS",
            link: "https://github.com/owner/repo/actions/runs/1",
            bucket: "pending",
          },
        ],
        [
          {
            name: "build",
            state: "SUCCESS",
            link: "https://github.com/owner/repo/actions/runs/1",
            bucket: "pass",
          },
        ],
      ],
      readiness: "ready",
      failedChecks: [],
      sleeps: [30_000, 10_000],
    },
    ...(["fail", "cancel"] as const).map((bucket) => {
      const check = {
        name: bucket === "fail" ? "build" : "deploy",
        state: bucket === "fail" ? "FAILURE" : "CANCELLED",
        link: `https://github.com/owner/repo/actions/runs/${bucket}`,
        bucket,
      };
      return {
        name: bucket,
        readiness: "ready" as const,
        failedChecks: [],
        reads: [[check], []],
        sleeps: [30_000, 30_000],
      };
    }),
  ];

  for (const scenario of scenarios) {
    const root = await createProject();
    const sleeps: number[] = [];
    const reads = [...scenario.reads];
    let branch = "";
    let agentCalls = 0;
    const implementation = {
      sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      message: "feat: implementation",
    };
    const repair = {
      sha: "cccccccccccccccccccccccccccccccccccccccc",
      message: "fix: required checks",
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
            return {
              worktree,
              branch,
              base,
              commits:
                base === implementation.sha ? [repair] : [implementation],
              clean: true,
            };
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
            return {
              number: 41,
              url: "https://github.com/owner/repo/pull/41",
            };
          },
          async getRequiredChecks() {
            const checks = reads.shift();
            assert.ok(checks, `${scenario.name} read beyond script`);
            return checks;
          },
        },
        clock: {
          async sleep(milliseconds) {
            sleeps.push(milliseconds);
          },
        },
      }),
    );

    assert.equal(
      result.summary.pullRequests?.[0]?.readiness,
      scenario.readiness,
    );
    assert.deepEqual(
      result.summary.pullRequests?.[0]?.failedChecks,
      scenario.failedChecks,
    );
    assert.deepEqual(sleeps, scenario.sleeps);
    assert.equal(reads.length, 0);
  }
});

test("failed required checks are repaired on the existing branch and Pull Request", async () => {
  const root = await createProject();
  await writeFile(
    path.join(root, "projects/demo/config.json"),
    JSON.stringify({
      ...validConfig,
      agents: {
        ...validConfig.agents,
        ciRepair: { model: "gpt-5.5", reasoningEffort: "medium" },
      },
      timeouts: { ...validConfig.timeouts, requiredChecksMinutes: 1 / 60_000 },
    }),
  );
  const { tracker } = createAttemptTracker(9);
  const implementation = {
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    message: "feat: implementation",
  };
  const repair = {
    sha: "cccccccccccccccccccccccccccccccccccccccc",
    message: "fix: required checks",
  };
  const agentInputs: Parameters<AgentExecutor["execute"]>[0][] = [];
  const pauses: string[] = [];
  const sleeps: number[] = [];
  let elapsed = 0;
  let branch = "";
  let checks = 0;
  let pushes = 0;
  let pullRequests = 0;
  let headSha = implementation.sha;
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
            commits: base === implementation.sha ? [repair] : [implementation],
            clean: true,
          };
        },
        async push() {
          pushes += 1;
          if (pushes === 2) headSha = repair.sha;
        },
      },
      agentExecutor: {
        async execute(input) {
          agentInputs.push(input);
          const commit = agentInputs.length === 1 ? implementation : repair;
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
          pullRequests += 1;
          return { number: 41, url: "https://github.com/owner/repo/pull/41" };
        },
        async getRequiredChecks() {
          checks += 1;
          if (checks === 1) {
            return [
              {
                name: "checks",
                state: "FAILURE",
                link: "https://github.com/owner/repo/actions/runs/1",
                bucket: "fail" as const,
              },
            ];
          }
          return checks < 4
            ? [
                {
                  name: "checks",
                  state: "IN_PROGRESS",
                  link: "https://github.com/owner/repo/actions/runs/1",
                  bucket: "pending" as const,
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
          merged = true;
          return { outcome: "accepted" };
        },
      },
      clock: {
        now: () => new Date(elapsed),
        async sleep(milliseconds) {
          sleeps.push(milliseconds);
          elapsed += milliseconds;
        },
      },
      operator: {
        async pause(message) {
          pauses.push(message);
          return "";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(pushes, 2);
  assert.equal(pullRequests, 1);
  assert.equal(agentInputs.length, 2);
  assert.equal(
    agentInputs[1]?.promptFile,
    path.join(root, "projects/demo/prompts/ci-repair.md"),
  );
  assert.equal(agentInputs[1]?.model, "gpt-5.5");
  assert.equal(agentInputs[1]?.effort, "medium");
  assert.equal(agentInputs[1]?.pullRequestMetadata, "ignored");
  assert.equal(agentInputs[1]?.branch, branch);
  assert.equal(agentInputs[1]?.base, implementation.sha);
  assert.deepEqual(agentInputs[1]?.promptArgs, {
    TICKET_NUMBER: 9,
    TICKET_REFERENCE: "owner/repo#9",
    WORKTREE_PATH: agentInputs[1]?.worktree,
    BASE_SHA: implementation.sha,
    PROJECT_TARGET_BRANCH: "main",
    PULL_REQUEST_NUMBER: 41,
    PULL_REQUEST_URL: "https://github.com/owner/repo/pull/41",
    FAILED_CHECKS: JSON.stringify([
      {
        name: "checks",
        state: "FAILURE",
        link: "https://github.com/owner/repo/actions/runs/1",
      },
    ]),
  });
  assert.deepEqual(sleeps.slice(0, 2), [30_000, 30_000]);
  assert.deepEqual(pauses, [
    "Required checks timed out. Enter to retry, q to cancel, or acknowledge trusted readiness.",
  ]);
  assert.equal(agentInputs.length, 2);
  assert.equal(result.summary.pullRequests?.[0]?.readiness, "ready");
  assert.ok(result.logPath);
  const audit = (await readFile(result.logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(
    audit.some(
      (event) =>
        event.phase === "ci_repair" && event.operation === "pull_request_state",
    ),
  );
});

test("an externally merged Pull Request skips pending repair work", async () => {
  for (const mergeDuringRepair of [false, true]) {
    const root = await createProject();
    const delivery = createCommittedDelivery();
    let agentCalls = 0;
    let pushes = 0;
    let merged = !mergeDuringRepair;

    const result = await executeCli(
      ["run", "--project", "demo", "--parent", "8"],
      createCliDependencies(root, {
        ...delivery,
        gitWorkspace: {
          ...delivery.gitWorkspace,
          async push() {
            pushes += 1;
          },
        },
        agentExecutor: {
          async execute(input) {
            agentCalls += 1;
            if (agentCalls === 2) merged = true;
            return delivery.agentExecutor.execute!(input);
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
        },
      }),
    );

    assert.equal(result.summary.outcome, "succeeded");
    assert.equal(agentCalls, mergeDuringRepair ? 2 : 1);
    assert.equal(pushes, 1);
  }
});

test("a trusted repair Agent override needs no replacement PR metadata", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery();
  let agentCalls = 0;
  let checkReads = 0;
  let pushes = 0;
  let merged = false;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async push() {
          pushes += 1;
        },
      },
      agentExecutor: {
        async execute(input) {
          agentCalls += 1;
          if (agentCalls === 2) throw new Error("Sandcastle failed");
          return delivery.agentExecutor.execute!(input);
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
          return "trusted repair";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(agentCalls, 2);
  assert.equal(pushes, 2);
});
