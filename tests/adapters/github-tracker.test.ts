import assert from "node:assert/strict";
import test from "node:test";

import { GitHubTracker } from "../../src/adapters/github-tracker.ts";

test("GitHubTracker maps Parent, paginated children, and completed closure operations", async () => {
  const calls: string[][] = [];
  const responses = [
    '{"number":8,"state":"open","state_reason":null}',
    '[{"number":9,"state":"closed","state_reason":"not_planned","repository_url":"https://api.github.com/repos/other/repo"}]',
    "{}",
  ];
  const tracker = new GitHubTracker("configured-token", async (args) => {
    calls.push(args);
    return responses.shift() ?? "{}";
  });

  assert.deepEqual(await tracker.getParent("owner/repo", 8), {
    number: 8,
    state: "open",
    stateReason: null,
  });
  assert.deepEqual(await tracker.listChildrenPage("owner/repo", 8, 2), {
    children: [
      {
        number: 9,
        state: "closed",
        stateReason: "not_planned",
        repository: "other/repo",
      },
    ],
    nextPage: null,
  });
  await tracker.closeParent("owner/repo", 8);

  assert.deepEqual(calls, [
    ["api", "--method", "GET", "repos/owner/repo/issues/8"],
    [
      "api",
      "--method",
      "GET",
      "repos/owner/repo/issues/8/sub_issues",
      "-f",
      "per_page=100",
      "-f",
      "page=2",
    ],
    [
      "api",
      "--method",
      "PATCH",
      "repos/owner/repo/issues/8",
      "-f",
      "state=closed",
      "-f",
      "state_reason=completed",
    ],
  ]);
});
