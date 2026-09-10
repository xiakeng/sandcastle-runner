import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalGitWorkspace } from "../../src/adapters/git-workspace.ts";

test("LocalGitWorkspace fetches an exact base and creates and inspects only the requested Worktree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "git-workspace-test-"));
  const worktree = path.join(root, "worktrees", "ticket-9");
  const base = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const commit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const targetBase = "cccccccccccccccccccccccccccccccccccccccc";
  const calls: {
    cwd: string;
    args: string[];
    timeout: number;
    env?: Record<string, string>;
  }[] = [];
  const workspace = new LocalGitWorkspace(
    "configured-token",
    async (cwd, args, { timeout, env }) => {
      calls.push({ cwd, args, timeout, ...(env ? { env } : {}) });
      if (args.includes("fetch")) return "";
      if (args.includes("push")) return "";
      if (args.join(" ") === "rev-parse FETCH_HEAD") return `${base}\n`;
      if (args[0] === "worktree") return "";
      if (args.join(" ") === "rev-parse --show-toplevel")
        return `${worktree}\n`;
      if (args.join(" ") === "branch --show-current")
        return "sandcastle/run-id/ticket-9\n";
      if (args.join(" ") === `merge-base --is-ancestor ${targetBase} HEAD`)
        return "";
      if (args[0] === "merge-base") return `${base}\n`;
      if (args[0] === "log") return `${commit}\0feat: implementation\n`;
      if (args[0] === "status") return "";
      throw new Error(`unexpected Git command: ${args.join(" ")}`);
    },
  );

  try {
    assert.equal(await workspace.fetchTargetBranch(root, "trunk"), base);
    await workspace.createWorktree({
      checkout: root,
      worktree,
      branch: "sandcastle/run-id/ticket-9",
      base,
    });
    assert.deepEqual(
      await workspace.inspect({
        worktree,
        base,
        requiredAncestor: targetBase,
      }),
      {
        worktree,
        branch: "sandcastle/run-id/ticket-9",
        base,
        commits: [{ sha: commit, message: "feat: implementation" }],
        clean: true,
      },
    );
    await workspace.push(worktree, "sandcastle/run-id/ticket-9");
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  assert.deepEqual(calls.slice(0, 3), [
    {
      cwd: root,
      args: [
        "-c",
        "credential.helper=!gh auth git-credential",
        "fetch",
        "--no-tags",
        "origin",
        "trunk",
      ],
      timeout: 60_000,
      env: { GH_TOKEN: "configured-token" },
    },
    { cwd: root, args: ["rev-parse", "FETCH_HEAD"], timeout: 60_000 },
    {
      cwd: root,
      args: [
        "worktree",
        "add",
        "-b",
        "sandcastle/run-id/ticket-9",
        worktree,
        base,
      ],
      timeout: 60_000,
    },
  ]);
  assert.equal(
    calls.some(
      ({ args }) => args.includes("remove") || args.includes("delete"),
    ),
    false,
  );
  assert.ok(
    calls.some(
      ({ args }) =>
        args.join(" ") === `merge-base --is-ancestor ${targetBase} HEAD`,
    ),
  );
  assert.ok(
    calls.some(
      ({ args }) =>
        args.join(" ") ===
        `log --first-parent --reverse --format=%H%x00%s ${base}..HEAD`,
    ),
  );
  assert.deepEqual(calls.at(-1), {
    cwd: worktree,
    args: [
      "-c",
      "credential.helper=!gh auth git-credential",
      "push",
      "origin",
      "sandcastle/run-id/ticket-9",
    ],
    timeout: 60_000,
    env: { GH_TOKEN: "configured-token" },
  });
});

test("LocalGitWorkspace surfaces a Worktree name collision without adopting it", async () => {
  const workspace = new LocalGitWorkspace(
    "configured-token",
    async (_cwd, args) => {
      if (args[0] === "worktree") throw new Error("already exists");
      return "";
    },
  );

  await assert.rejects(
    workspace.createWorktree({
      checkout: "/repo",
      worktree: "/run/ticket-9",
      branch: "sandcastle/run-id/ticket-9",
      base: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
    /already exists/u,
  );
});

test("LocalGitWorkspace supplies scoped standards and post-review commit evidence without frozen-state checks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "git-review-test-"));
  const nested = path.join(root, "src", "feature");
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(root, "AGENTS.md"), "root rules");
  await writeFile(path.join(root, "src", "AGENTS.md"), "source rules");
  const base = "a".repeat(40);
  const implementationHead = "b".repeat(40);
  const reviewHead = "c".repeat(40);
  const calls: string[] = [];
  const workspace = new LocalGitWorkspace("token", async (_cwd, args) => {
    const command = args.join(" ");
    calls.push(command);
    if (command === `diff --name-only ${base}..HEAD`)
      return "src/feature/index.ts\n";
    if (args[0] === "ls-files")
      return "AGENTS.md\nsrc/AGENTS.md\ntests/AGENTS.md\n";
    if (command === "status --porcelain") return "";
    if (command.endsWith(`${base}..HEAD`))
      return `${implementationHead}\0feat: implementation\n${reviewHead}\0fix: review finding\n`;
    if (command.endsWith(`${implementationHead}..HEAD`))
      return `${reviewHead}\0fix: review finding\n`;
    throw new Error(`unexpected Git command: ${command}`);
  });

  try {
    assert.deepEqual(await workspace.readReviewStandards(root, base), [
      { source: path.join(root, "AGENTS.md"), content: "root rules" },
      { source: path.join(root, "src/AGENTS.md"), content: "source rules" },
    ]);
    assert.deepEqual(
      await workspace.inspectReview({
        worktree: root,
        base,
        implementationHead,
      }),
      {
        clean: true,
        deliveryCommits: [
          { sha: implementationHead, message: "feat: implementation" },
          { sha: reviewHead, message: "fix: review finding" },
        ],
        reviewCommits: [{ sha: reviewHead, message: "fix: review finding" }],
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(
    calls.some((call) => /branch|merge-base|rev-parse/u.test(call)),
    false,
  );
});
