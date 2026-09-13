import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { cleanupTempRoots } from "../support/temp-cleanup.ts";
import {
  createCliDependencies,
  createAttemptTracker,
  createCommittedDelivery,
  createCommittedBatch,
} from "../support/cli-dependencies.ts";
import {
  validConfig,
  createProject,
  publicationIntent,
  writePublicationState,
} from "../support/cli-project.ts";
import { executeCli } from "../../src/cli.ts";
import { readRecoverySnapshot, recoveryPaths } from "../../src/recovery.ts";

test.afterEach(cleanupTempRoots);

test("restart adopts an exact published Pull Request without rerunning implementation", async () => {
  const root = await createProject();
  const config = structuredClone(validConfig);
  config.workflow.documentationMaintenance = false;
  await writeFile(
    path.join(root, "projects", "demo", "config.json"),
    JSON.stringify(config),
  );
  const intent = publicationIntent("pending_pr");
  const snapshot = await writePublicationState(root, [intent]);
  const { tracker, tickets } = createAttemptTracker(9);
  tickets[0]!.labels = ["sandcastle:reserved"];
  tickets[0]!.assignees = ["runner"];
  let forbiddenCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      codeHost: {
        async getRemoteBranchHead() {
          return intent.intendedHeadSha;
        },
        async listPullRequests() {
          return [
            {
              number: 4,
              url: "https://example.test/pull/4",
              branch: intent.stableBranch,
              targetBranch: "main",
              headSha: intent.intendedHeadSha,
              state: "open",
            },
          ];
        },
        async getPullRequest() {
          return {
            headSha: intent.intendedHeadSha,
            createdAt: "2026-09-08T00:00:00.000Z",
            merged: true,
            mergeFailure: null,
          };
        },
        async createPullRequest() {
          forbiddenCalls += 1;
          throw new Error("must not create a duplicate Pull Request");
        },
      },
      gitWorkspace: {
        async push() {
          forbiddenCalls += 1;
          throw new Error("must not repeat the push");
        },
      },
      agentExecutor: {
        async execute() {
          forbiddenCalls += 1;
          throw new Error("must not rerun implementation");
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.deepEqual(result.summary.completedTickets, [9]);
  assert.equal(forbiddenCalls, 0);
  const recovered = await readRecoverySnapshot(snapshot);
  assert.deepEqual(recovered?.completedDeliveries, [9]);
  assert.deepEqual(
    recovered?.publications?.map(({ ticket }) => ticket),
    [9],
  );
});

test("restart abandons an absent pending push and creates fresh work", async () => {
  const root = await createProject();
  const config = structuredClone(validConfig);
  config.workflow.documentationMaintenance = false;
  await writeFile(
    path.join(root, "projects", "demo", "config.json"),
    JSON.stringify(config),
  );
  const intent = publicationIntent("pending_push");
  await writePublicationState(root, [intent]);
  const delivery = createCommittedDelivery();
  delivery.tickets[0]!.labels = ["sandcastle:reserved"];
  delivery.tickets[0]!.assignees = ["runner"];
  const pushed: string[] = [];
  let agentCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async push(_worktree, branch) {
          pushed.push(branch);
        },
      },
      agentExecutor: {
        async execute(input) {
          agentCalls += 1;
          return delivery.agentExecutor.execute!(input);
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(agentCalls, 1);
  assert.equal(pushed.length, 1);
  assert.notEqual(pushed[0], intent.stableBranch);
});

test("restart pauses on an unexpected remote branch head", async () => {
  const root = await createProject();
  const intent = publicationIntent("pending_push");
  await writePublicationState(root, [intent]);
  const { tracker, tickets } = createAttemptTracker(9);
  tickets[0]!.labels = ["sandcastle:reserved"];
  tickets[0]!.assignees = ["runner"];
  let agentCalls = 0;
  let pauses = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      codeHost: {
        async getRemoteBranchHead() {
          return "ffffffffffffffffffffffffffffffffffffffff";
        },
      },
      agentExecutor: {
        async execute() {
          agentCalls += 1;
          throw new Error("must not rerun implementation");
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
  assert.equal(agentCalls, 0);
  assert.equal(pauses, 1);
});

test("restart creates one absent Pull Request after rechecking the remote head", async () => {
  const root = await createProject();
  const config = structuredClone(validConfig);
  config.workflow.documentationMaintenance = false;
  await writeFile(
    path.join(root, "projects", "demo", "config.json"),
    JSON.stringify(config),
  );
  const intent = publicationIntent("pending_pr");
  await writePublicationState(root, [intent]);
  const { tracker, tickets } = createAttemptTracker(9);
  tickets[0]!.labels = ["sandcastle:reserved"];
  tickets[0]!.assignees = ["runner"];
  let remoteReads = 0;
  const creations: object[] = [];
  let forbiddenCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      codeHost: {
        async getRemoteBranchHead() {
          remoteReads += 1;
          return intent.intendedHeadSha;
        },
        async listPullRequests() {
          return [];
        },
        async createPullRequest(input) {
          creations.push(input);
          return { number: 6, url: "https://example.test/pull/6" };
        },
        async getPullRequest() {
          return {
            headSha: intent.intendedHeadSha,
            createdAt: "2026-09-08T00:00:00.000Z",
            merged: true,
            mergeFailure: null,
          };
        },
      },
      gitWorkspace: {
        async push() {
          forbiddenCalls += 1;
          throw new Error("must not repeat the push");
        },
      },
      agentExecutor: {
        async execute() {
          forbiddenCalls += 1;
          throw new Error("must not rerun implementation");
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(remoteReads, 2);
  assert.equal(creations.length, 1);
  assert.deepEqual(creations[0], {
    repository: "owner/repo",
    targetBranch: "main",
    branch: intent.stableBranch,
    title: intent.title,
    body: intent.body,
  });
  assert.equal(forbiddenCalls, 0);
});

test("publication recovery exhausts remote reads before Operator Pause", async () => {
  const root = await createProject();
  const intent = publicationIntent("pending_push");
  await writePublicationState(root, [intent]);
  const { tracker, tickets } = createAttemptTracker(9);
  tickets[0]!.labels = ["sandcastle:reserved"];
  tickets[0]!.assignees = ["runner"];
  let remoteReads = 0;
  let agentCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      codeHost: {
        async getRemoteBranchHead() {
          remoteReads += 1;
          throw new Error("remote unavailable");
        },
      },
      agentExecutor: {
        async execute() {
          agentCalls += 1;
          throw new Error("must not rerun implementation");
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
  assert.equal(remoteReads, 5);
  assert.equal(agentCalls, 0);
});

test("a recorded Pull Request resumes through ordinary reads without rediscovery", async () => {
  const root = await createProject();
  const intent = publicationIntent("pr_created");
  await writePublicationState(root, [intent]);
  const { tracker, tickets } = createAttemptTracker(9);
  tickets[0]!.labels = ["sandcastle:reserved"];
  tickets[0]!.assignees = ["runner"];
  let checkReads = 0;
  let forbiddenCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker,
      codeHost: {
        async getRemoteBranchHead() {
          return intent.intendedHeadSha;
        },
        async listPullRequests() {
          forbiddenCalls += 1;
          throw new Error("must not rediscover a recorded Pull Request");
        },
        async createPullRequest() {
          forbiddenCalls += 1;
          throw new Error("must not replace a recorded Pull Request");
        },
        async getRequiredChecks() {
          checkReads += 1;
          throw new Error("recorded Pull Request unavailable");
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
  assert.equal(checkReads, 5);
  assert.equal(forbiddenCalls, 0);
});

test("an interrupted Batch retains every pending publication", async () => {
  const root = await createProject();
  const config = structuredClone(validConfig);
  config.workflow.documentationMaintenance = false;
  await writeFile(
    path.join(root, "projects", "demo", "config.json"),
    JSON.stringify(config),
  );
  const delivery = createCommittedBatch(9, 10);
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: delivery.tracker,
      gitWorkspace: {
        ...delivery.gitWorkspace,
        async push() {
          throw new Error("interrupted push");
        },
      },
      agentExecutor: delivery.agentExecutor,
      operator: {
        async pause() {
          return "q";
        },
      },
    }),
  );
  const snapshot = await readRecoverySnapshot(
    recoveryPaths(path.join(root, "projects", "demo"), 8).snapshot,
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.deepEqual(
    snapshot?.publications?.map(({ ticket }) => ticket).sort((a, b) => a - b),
    [9, 10],
  );
});

test("a complete zero-child scan returns no_work and leaves the Parent open", async () => {
  const root = await createProject();
  let closeCalls = 0;
  let maintenanceCreates = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async createMaintenanceTicket() {
          maintenanceCreates += 1;
          return { number: 100, state: "open", stateReason: null };
        },
        async closeParent() {
          closeCalls += 1;
        },
      },
      codeHost: {
        async resolveTargetBranch() {
          throw new Error("explicit Target Branch must not be replaced");
        },
      },
      operator: {
        async pause() {
          return "q";
        },
      },
    }),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.outcome, "no_work");
  assert.equal(result.summary.targetBranch, "main");
  assert.equal(closeCalls, 0);
  assert.equal(maintenanceCreates, 0);

  assert.ok(result.logPath);
  const events = (await readFile(result.logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(events.length > 0);
  assert.deepEqual(Object.keys(events[0] ?? {}).sort(), [
    "attempt",
    "error",
    "operation",
    "parentTicket",
    "phase",
    "project",
    "result",
    "runId",
    "target",
    "timestamp",
  ]);
  assert.equal(JSON.stringify(events).includes("secret"), false);
});

test("an all-cancelled paginated scan closes the Parent as completed", async () => {
  const root = await createProject();
  const pages: number[] = [];
  let closeCalls = 0;
  let maintenanceCreates = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async createMaintenanceTicket() {
          maintenanceCreates += 1;
          return { number: 100, state: "open", stateReason: null };
        },
        async listChildrenPage(_repository, _parent, page) {
          pages.push(page);
          return page === 1
            ? {
                children: [
                  {
                    number: 9,
                    state: "closed",
                    stateReason: "not_planned",
                    repository: "owner/repo",
                  } as const,
                ],
                nextPage: 2,
              }
            : {
                children: [
                  {
                    number: 10,
                    state: "closed",
                    stateReason: "not_planned",
                    repository: "owner/repo",
                  } as const,
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

  assert.deepEqual(pages, [1, 2, 1, 2]);
  assert.equal(closeCalls, 1);
  assert.equal(maintenanceCreates, 0);
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.outcome, "succeeded");
});

test("a cancelled Parent stops without reading or modifying children", async () => {
  const root = await createProject();
  let childCalls = 0;
  let closeCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          return {
            number: 8,
            state: "closed",
            stateReason: "not_planned",
          } as const;
        },
        async listChildrenPage() {
          childCalls += 1;
          return { children: [], nextPage: null };
        },
        async closeParent() {
          closeCalls += 1;
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(result.exitCode, 1);
  assert.equal(childCalls, 0);
  assert.equal(closeCalls, 0);
});
