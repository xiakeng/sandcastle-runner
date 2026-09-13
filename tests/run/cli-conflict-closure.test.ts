import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
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

test.afterEach(cleanupTempRoots);

test("invalid conflict-repair handoffs do not consume the automatic budget", async () => {
  const root = await createProject();
  const { tracker } = createAttemptTracker(9);
  const implementation = {
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    message: "feat: implementation",
  };
  const firstRepair = {
    sha: "cccccccccccccccccccccccccccccccccccccccc",
    message: "fix: first merge conflict",
  };
  const secondRepair = {
    sha: "dddddddddddddddddddddddddddddddddddddddd",
    message: "fix: second merge conflict",
  };
  const falseClaim = {
    sha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    message: "fix: false claim",
  };
  let branch = "";
  let agentCalls = 0;
  let pushes = 0;
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
              agentCalls === 2
                ? []
                : agentCalls === 3
                  ? [firstRepair]
                  : agentCalls === 4
                    ? [secondRepair]
                    : [implementation],
            clean: true,
          };
        },
        async push() {
          pushes += 1;
          if (pushes === 2) headSha = firstRepair.sha;
          if (pushes === 3) headSha = secondRepair.sha;
        },
      },
      agentExecutor: {
        async execute() {
          agentCalls += 1;
          const commit =
            agentCalls === 1
              ? implementation
              : agentCalls === 2
                ? falseClaim
                : agentCalls === 3
                  ? firstRepair
                  : secondRepair;
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
          if (mergeRequests < 3) {
            return { outcome: "conflict", error: "merge conflict" };
          }
          merged = true;
          return { outcome: "accepted" };
        },
      },
      operator: {
        async pause(message) {
          pauses.push(message);
          return pauses.length === 1 ? "" : "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "succeeded");
  assert.equal(agentCalls, 4);
  assert.equal(mergeRequests, 3);
  assert.equal(pauses.length, 1);
  assert.match(pauses[0]!, /Agent Attempt failed/u);
});

test("Parent cancellation during a merge rejection pause prevents the authorized retry", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery();
  let parentCancelled = false;
  let mergeRequests = 0;

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
          return { outcome: "rejected", error: "merge rejected" };
        },
      },
      operator: {
        async pause() {
          parentCancelled = true;
          return "";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(mergeRequests, 1);
});

test("a post-merge cancellation releases its Reservation without completion credit", async () => {
  const root = await createProject();
  await writeFile(
    path.join(root, "projects/demo/config.json"),
    JSON.stringify({ ...validConfig, ticketClosure: "code_host" }),
  );
  const delivery = createCommittedDelivery();
  let releases = 0;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      tracker: {
        ...delivery.tracker,
        async removeAssignee() {
          releases += 1;
        },
        async removeLabel() {
          releases += 1;
        },
      },
      clock: {
        async sleep(milliseconds) {
          if (milliseconds === 10_000) {
            delivery.tickets[0]!.state = "closed";
            delivery.tickets[0]!.stateReason = "not_planned";
          }
        },
      },
    }),
  );

  assert.deepEqual(result.summary.completedTickets ?? [], []);
  assert.equal(releases, 2);
  assert.match(result.summary.reasons.join(" "), /cancelled after merge/u);
});

test("runner closure write failure retries only after operator authorization and never replays the merge", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery();
  let closeCalls = 0;
  let mergeCalls = 0;
  let merged = false;

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      tracker: {
        ...delivery.tracker,
        async closeTicket(_repository, ticket) {
          closeCalls += 1;
          if (closeCalls === 1) throw new Error("closure write failed");
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
            merged,
            mergeFailure: null,
          };
        },
        async requestSquashMerge() {
          mergeCalls += 1;
          merged = true;
          return { outcome: "accepted" };
        },
      },
      operator: {
        async pause() {
          return "";
        },
      },
    }),
  );

  assert.deepEqual(result.summary.completedTickets, [9]);
  assert.equal(closeCalls, 2);
  assert.equal(mergeCalls, 1);
});

test("confirmed completion credit survives a later Reservation release cancellation", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery();

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      tracker: {
        ...delivery.tracker,
        async removeAssignee() {
          throw new Error("release failed");
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
});

test("Parent cancellation during a closure write pause prevents the authorized retry", async () => {
  const root = await createProject();
  const delivery = createCommittedDelivery();
  let closeCalls = 0;
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
        async closeTicket() {
          closeCalls += 1;
          throw new Error("closure write failed");
        },
      },
      operator: {
        async pause() {
          parentCancelled = true;
          return "";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(closeCalls, 1);
});

test("an open code_host ticket after both closure reads enters Operator Pause without credit", async () => {
  const root = await createProject();
  await writeFile(
    path.join(root, "projects/demo/config.json"),
    JSON.stringify({ ...validConfig, ticketClosure: "code_host" }),
  );
  const delivery = createCommittedDelivery();
  let pauseMessage = "";

  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      ...delivery,
      operator: {
        async pause(message) {
          pauseMessage = message;
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.deepEqual(result.summary.completedTickets ?? [], []);
  assert.match(pauseMessage, /not closed as completed/u);
});

test("trusted completion releases the observed Reservation unless the Parent was cancelled", async () => {
  for (const cancelParent of [false, true]) {
    const root = await createProject();
    await writeFile(
      path.join(root, "projects/demo/config.json"),
      JSON.stringify({ ...validConfig, ticketClosure: "code_host" }),
    );
    const delivery = createCommittedDelivery();
    let parentCancelled = false;
    let releases = 0;

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
          async removeAssignee() {
            releases += 1;
          },
          async removeLabel() {
            releases += 1;
            if (!cancelParent) {
              delivery.tickets[0]!.state = "closed";
              delivery.tickets[0]!.stateReason = "completed";
            }
          },
        },
        operator: {
          async pause() {
            parentCancelled = cancelParent;
            return cancelParent ? "q" : "trusted completion";
          },
        },
      }),
    );
    assert.deepEqual(
      result.summary.completedTickets ?? [],
      cancelParent ? [] : [9],
    );
    assert.equal(releases, cancelParent ? 0 : 2);
  }
});
