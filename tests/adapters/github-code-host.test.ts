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
