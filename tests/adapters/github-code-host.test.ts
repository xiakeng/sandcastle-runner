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
