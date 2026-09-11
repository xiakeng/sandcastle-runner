import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  InvalidRecoverySnapshot,
  ParentLock,
  readRecoverySnapshot,
  recoveryPaths,
  writeRecoverySnapshot,
  reconcileInitialPush,
  reconcilePullRequest,
} from "../src/recovery.ts";

test("recovery snapshots replace atomically and reject malformed input unchanged", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sandcastle-recovery-"));
  const filename = recoveryPaths(root, 8).snapshot;
  const snapshot = {
    schemaVersion: 1,
    project: "demo",
    repository: "owner/repo",
    checkout: "/tmp/repo",
    parentTicket: 8,
    runId: "run-1",
    phase: "running",
    targetBranch: "main",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
  };
  await writeRecoverySnapshot(filename, snapshot);
  assert.deepEqual(await readRecoverySnapshot(filename), snapshot);
  await writeFile(filename, "{not-json", "utf8");
  await assert.rejects(readRecoverySnapshot(filename), InvalidRecoverySnapshot);
  assert.equal(await readFile(filename, "utf8"), "{not-json");
});

test("recovery snapshots retain independent CI and conflict repair budgets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sandcastle-repair-state-"));
  const filename = recoveryPaths(root, 8).snapshot;
  const handoff = {
    ticket: 9,
    branch: "ticket-9",
    base: "base",
    commits: [{ sha: "head", message: "repair" }],
    prTitle: "fix",
    prBody: "body",
  };
  const snapshot = {
    schemaVersion: 1,
    project: "demo",
    repository: "owner/repo",
    checkout: "/tmp/repo",
    parentTicket: 8,
    runId: "run-1",
    phase: "running",
    targetBranch: "main",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    publications: [
      {
        ticket: 9,
        kind: "delivery" as const,
        originalBase: "base",
        targetBranch: "main",
        stableBranch: "ticket-9",
        intendedHeadSha: "head",
        title: "fix",
        body: "body",
        phase: "pr_created" as const,
        implementationEvidence: [],
        reviewEvidence: [],
        completionEvidence: handoff,
        pullRequest: {
          number: 1,
          url: "https://example.test/pull/1",
          headSha: "head",
        },
        repairState: {
          purpose: "conflict" as const,
          consumed: 1,
          generation: 2,
          attempt: 3,
          targetBase: "target",
        },
        repairBudgets: {
          ci: {
            purpose: "ci" as const,
            consumed: 2,
            generation: 1,
            attempt: 2,
          },
          conflict: {
            purpose: "conflict" as const,
            consumed: 1,
            generation: 2,
            attempt: 3,
            targetBase: "target",
          },
        },
      },
    ],
  };
  await writeRecoverySnapshot(filename, snapshot);
  assert.deepEqual(await readRecoverySnapshot(filename), snapshot);
});

test("recovery snapshots reject malformed repair budgets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sandcastle-repair-state-"));
  const filename = recoveryPaths(root, 8).snapshot;
  const snapshot = {
    schemaVersion: 1,
    project: "demo",
    repository: "owner/repo",
    checkout: "/tmp/repo",
    parentTicket: 8,
    runId: "run-1",
    phase: "running",
    targetBranch: "main",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    publications: [
      {
        ticket: 9,
        kind: "delivery" as const,
        originalBase: "base",
        targetBranch: "main",
        stableBranch: "ticket-9",
        intendedHeadSha: "head",
        title: "fix",
        body: "body",
        phase: "pr_created" as const,
        implementationEvidence: [],
        reviewEvidence: [],
        completionEvidence: {
          ticket: 9,
          branch: "ticket-9",
          base: "base",
          commits: [],
          prTitle: "fix",
          prBody: "body",
        },
        repairBudgets: null,
      },
    ],
  };
  await writeRecoverySnapshot(filename, { ...snapshot, publications: [] });
  await writeFile(
    filename,
    JSON.stringify({
      ...snapshot,
      publications: [
        {
          ...snapshot.publications[0],
          repairBudgets: null,
        },
      ],
    }),
    "utf8",
  );
  await assert.rejects(readRecoverySnapshot(filename), InvalidRecoverySnapshot);
  for (const maintenance of [
    { phase: "completed" as const, credit: 0, barrier: true, ticket: 10 },
    { phase: "scheduled" as const, credit: 1, barrier: true, ticket: 10 },
  ]) {
    await writeFile(
      filename,
      JSON.stringify({ ...snapshot, maintenance }),
      "utf8",
    );
    await assert.rejects(
      readRecoverySnapshot(filename),
      InvalidRecoverySnapshot,
    );
  }
});

test("recovery snapshots reject inconsistent unfinished maintenance state", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "sandcastle-maintenance-state-"),
  );
  const filename = recoveryPaths(root, 8).snapshot;
  const snapshot = {
    schemaVersion: 1,
    project: "demo",
    repository: "owner/repo",
    checkout: "/tmp/repo",
    parentTicket: 8,
    runId: "run-1",
    phase: "running",
    targetBranch: "main",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    maintenance: {
      phase: "attempting" as const,
      credit: 1,
      barrier: true,
      ticket: 10,
    },
    publications: [],
  };
  await writeRecoverySnapshot(filename, snapshot);
  await writeFile(
    filename,
    JSON.stringify({
      ...snapshot,
      publications: [
        {
          ticket: 11,
          kind: "maintenance" as const,
          originalBase: "base",
          targetBranch: "main",
          stableBranch: "maintenance-11",
          intendedHeadSha: "head",
          title: "fix",
          body: "body",
          phase: "pr_created" as const,
          implementationEvidence: [],
          reviewEvidence: [],
          completionEvidence: {
            ticket: 11,
            branch: "maintenance-11",
            base: "base",
            commits: [],
            prTitle: "fix",
            prBody: "body",
          },
          pullRequest: {
            number: 1,
            url: "https://example.test/pull/1",
            headSha: "head",
          },
        },
      ],
    }),
    "utf8",
  );
  await assert.rejects(readRecoverySnapshot(filename), InvalidRecoverySnapshot);
});

test("a Parent lock is nonblocking and released explicitly", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sandcastle-lock-"));
  const filename = recoveryPaths(root, 8).lock;
  const first = await ParentLock.acquire(filename, { runId: "one" });
  await assert.rejects(
    ParentLock.acquire(filename, { runId: "two" }),
    /already held/u,
  );
  await first.release();
  const second = await ParentLock.acquire(filename, { runId: "three" });
  await second.release();
});

test("publication reconciliation adopts only exact remote evidence", () => {
  const intent = {
    ticket: 9,
    kind: "delivery" as const,
    originalBase: "base",
    targetBranch: "main",
    stableBranch: "ticket-9",
    intendedHeadSha: "abc",
    title: "fix",
    body: "body",
    phase: "pending_push" as const,
    implementationEvidence: [],
    reviewEvidence: [],
    completionEvidence: {},
  };
  assert.equal(reconcileInitialPush(intent, null).outcome, "restart");
  assert.equal(reconcileInitialPush(intent, "abc").outcome, "adopt");
  assert.equal(reconcileInitialPush(intent, "def").outcome, "pause");
  assert.equal(
    reconcilePullRequest(intent, [
      {
        number: 4,
        url: "https://example.test/pull/4",
        branch: "ticket-9",
        targetBranch: "main",
        headSha: "abc",
        state: "open",
      },
    ]).outcome,
    "adopt",
  );
  assert.equal(
    reconcilePullRequest(intent, [
      {
        number: 4,
        url: "https://example.test/pull/4",
        branch: "ticket-9",
        targetBranch: "main",
        headSha: "def",
        state: "open",
      },
    ]).outcome,
    "pause",
  );
  assert.equal(
    reconcilePullRequest(intent, [
      {
        number: 4,
        url: "https://example.test/pull/4",
        branch: "other-branch",
        targetBranch: "main",
        headSha: "abc",
        state: "open",
      },
    ]).outcome,
    "pause",
  );
  assert.equal(
    reconcilePullRequest(intent, [
      {
        number: 4,
        url: "https://example.test/pull/4",
        branch: "ticket-9",
        targetBranch: "main",
        headSha: "abc",
        state: "open",
      },
      {
        number: 5,
        url: "https://example.test/pull/5",
        branch: "ticket-9",
        targetBranch: "main",
        headSha: "abc",
        state: "closed",
      },
    ]).outcome,
    "pause",
  );
});
