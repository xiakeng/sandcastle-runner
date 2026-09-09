import assert from "node:assert/strict";
import test from "node:test";

import { GitHubCodeHost } from "../../src/adapters/github-code-host.ts";

test("GitHubCodeHost resolves the Target Branch with the configured token and timeout", async () => {
  let observed: { args: string[]; token: string; timeout: number } | undefined;
  const codeHost = new GitHubCodeHost(
    "configured-token",
    async (args, options) => {
      observed = { args, ...options };
      return '{"default_branch":"trunk"}';
    },
  );

  assert.equal(await codeHost.resolveTargetBranch("owner/repo"), "trunk");
  assert.deepEqual(observed, {
    args: ["api", "--method", "GET", "repos/owner/repo"],
    token: "configured-token",
    timeout: 60_000,
  });
});

test("GitHubCodeHost creates a non-draft Pull Request and reads authoritative required checks", async () => {
  const calls: { args: string[]; allowedExitCodes?: number[] }[] = [];
  const codeHost = new GitHubCodeHost(
    "configured-token",
    async (args, options) => {
      calls.push({
        args,
        ...(options.allowedExitCodes
          ? { allowedExitCodes: options.allowedExitCodes }
          : {}),
      });
      return args[1] === "create"
        ? "https://github.com/owner/repo/pull/41\n"
        : JSON.stringify([
            {
              name: "build",
              state: "FAILURE",
              link: "https://github.com/owner/repo/actions/runs/1",
              bucket: "fail",
            },
          ]);
    },
  );

  assert.deepEqual(
    await codeHost.createPullRequest({
      repository: "owner/repo",
      targetBranch: "trunk",
      branch: "ticket-9",
      title: "feat: unchanged title",
      body: "Unchanged body.",
    }),
    { number: 41, url: "https://github.com/owner/repo/pull/41" },
  );
  assert.deepEqual(await codeHost.getRequiredChecks("owner/repo", 41), [
    {
      name: "build",
      state: "FAILURE",
      link: "https://github.com/owner/repo/actions/runs/1",
      bucket: "fail",
    },
  ]);
  assert.deepEqual(calls, [
    {
      args: [
        "pr",
        "create",
        "--repo",
        "owner/repo",
        "--base",
        "trunk",
        "--head",
        "ticket-9",
        "--title",
        "feat: unchanged title",
        "--body",
        "Unchanged body.",
      ],
    },
    {
      args: [
        "pr",
        "checks",
        "41",
        "--repo",
        "owner/repo",
        "--required",
        "--json",
        "name,state,link,bucket",
      ],
      allowedExitCodes: [1, 8],
    },
  ]);
});

test("GitHubCodeHost observes merge state and requests a head-matched admin squash merge", async () => {
  const calls: string[][] = [];
  const responses = [
    '{"headRefOid":"abc123","state":"OPEN","mergedAt":null}',
    "",
    '{"headRefOid":"abc123","state":"CLOSED","mergedAt":null}',
  ];
  const codeHost = new GitHubCodeHost("configured-token", async (args) => {
    calls.push(args);
    return responses.shift() ?? "";
  });

  assert.deepEqual(await codeHost.getPullRequest("owner/repo", 41), {
    headSha: "abc123",
    merged: false,
    mergeFailure: null,
  });
  assert.deepEqual(
    await codeHost.requestSquashMerge({
      repository: "owner/repo",
      pullRequest: 41,
      headSha: "abc123",
      admin: true,
    }),
    { outcome: "accepted" },
  );
  assert.deepEqual(await codeHost.getPullRequest("owner/repo", 41), {
    headSha: "abc123",
    merged: false,
    mergeFailure: "Pull Request 41 closed without merging",
  });
  assert.deepEqual(calls, [
    [
      "pr",
      "view",
      "41",
      "--repo",
      "owner/repo",
      "--json",
      "headRefOid,state,mergedAt",
    ],
    [
      "pr",
      "merge",
      "41",
      "--repo",
      "owner/repo",
      "--squash",
      "--match-head-commit",
      "abc123",
      "--admin",
    ],
    [
      "pr",
      "view",
      "41",
      "--repo",
      "owner/repo",
      "--json",
      "headRefOid,state,mergedAt",
    ],
  ]);
});

test("GitHubCodeHost distinguishes explicit conflicts and preserves other merge errors", async () => {
  for (const scenario of [
    {
      error:
        "gh command failed: not mergeable: the merge commit cannot be cleanly created",
      outcome: "conflict",
    },
    {
      error: "gh command failed: head SHA changed",
      outcome: "rejected",
    },
  ] as const) {
    const codeHost = new GitHubCodeHost("configured-token", async () => {
      throw new Error(scenario.error);
    });
    assert.deepEqual(
      await codeHost.requestSquashMerge({
        repository: "owner/repo",
        pullRequest: 41,
        headSha: "abc123",
        admin: false,
      }),
      { outcome: scenario.outcome, error: scenario.error },
    );
  }
});
