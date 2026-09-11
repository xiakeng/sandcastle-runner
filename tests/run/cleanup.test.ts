import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupTicketWorktrees,
  matchingWorktrees,
} from "../../src/run/cleanup.ts";
import type { GitWorkspace } from "../../src/run/contracts.ts";

test("terminal cleanup retries a branch after its Worktree was removed", async () => {
  const calls: string[] = [];
  let listed = true;
  let failBranch = true;
  const workspace = {
    async listWorktrees() {
      return listed
        ? [
            {
              worktree: "/project/worktrees/run/ticket-5",
              branch: "sandcastle/ticket-5",
              repository: "/repo",
            },
          ]
        : [];
    },
    async removeWorktree(_checkout: string, worktree: string) {
      calls.push(`remove:${worktree}`);
      listed = false;
    },
    async deleteBranch(_checkout: string, branch: string) {
      calls.push(`delete:${branch}`);
      if (failBranch) {
        failBranch = false;
        throw new Error("temporary branch failure");
      }
    },
  } as unknown as GitWorkspace;

  const pending: string[][] = [];
  await assert.rejects(
    cleanupTicketWorktrees(
      workspace,
      "/repo",
      "/repo",
      "/project/worktrees",
      5,
      async (candidates) => {
        pending.push(candidates);
      },
    ),
  );
  const result = await cleanupTicketWorktrees(
    workspace,
    "/repo",
    "/repo",
    "/project/worktrees",
    5,
    async (candidates) => {
      pending.push(candidates);
    },
    pending.at(-1),
  );

  assert.equal(result.status, "cleaned");
  assert.deepEqual(calls, [
    "remove:/project/worktrees/run/ticket-5",
    "delete:sandcastle/ticket-5",
    "delete:sandcastle/ticket-5",
  ]);
});

test("terminal cleanup accepts the existing maintenance Ticket prefix", () => {
  assert.equal(
    matchingWorktrees(
      [
        {
          worktree: "/project/worktrees/run/maintenance-5",
          branch: "sandcastle/run/maintenance-5",
          repository: "/repo",
        },
      ],
      "/repo",
      "/project/worktrees",
      5,
    ).length,
    1,
  );
});
