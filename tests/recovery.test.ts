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
