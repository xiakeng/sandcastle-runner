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

test("GitHubTracker maps blockers and Reservation operations", async () => {
  const calls: string[][] = [];
  const responses = [
    '{"number":9,"state":"open","state_reason":null,"assignees":[{"login":"runner"}],"labels":[{"name":"sandcastle:reserved"}]}',
    '[{"number":20,"state":"closed","state_reason":"completed","repository_url":"https://api.github.com/repos/other/repo","assignees":[],"labels":[]}]',
    "{}",
    "{}",
    "{}",
    "{}",
    "{}",
  ];
  const tracker = new GitHubTracker("configured-token", async (args) => {
    calls.push(args);
    return responses.shift() ?? "{}";
  });

  assert.deepEqual(await tracker.getTicket("owner/repo", 9), {
    number: 9,
    state: "open",
    stateReason: null,
    assignees: ["runner"],
    labels: ["sandcastle:reserved"],
  });
  assert.deepEqual(await tracker.listBlockersPage("owner/repo", 9, 2), {
    blockers: [
      {
        number: 20,
        state: "closed",
        stateReason: "completed",
        repository: "other/repo",
        assignees: [],
        labels: [],
      },
    ],
    nextPage: null,
  });
  await tracker.addLabel("owner/repo", 9, "sandcastle:reserved");
  await tracker.addAssignee("owner/repo", 9, "runner");
  await tracker.removeAssignee("owner/repo", 9, "runner");
  await tracker.removeLabel("owner/repo", 9, "sandcastle:reserved");
  await tracker.closeTicket("owner/repo", 9);

  assert.deepEqual(calls, [
    ["api", "--method", "GET", "repos/owner/repo/issues/9"],
    [
      "api",
      "--method",
      "GET",
      "repos/owner/repo/issues/9/dependencies/blocked_by",
      "-f",
      "per_page=100",
      "-f",
      "page=2",
    ],
    [
      "api",
      "--method",
      "POST",
      "repos/owner/repo/issues/9/labels",
      "-f",
      "labels[]=sandcastle:reserved",
    ],
    [
      "api",
      "--method",
      "POST",
      "repos/owner/repo/issues/9/assignees",
      "-f",
      "assignees[]=runner",
    ],
    [
      "api",
      "--method",
      "DELETE",
      "repos/owner/repo/issues/9/assignees",
      "-f",
      "assignees[]=runner",
    ],
    [
      "api",
      "--method",
      "DELETE",
      "repos/owner/repo/issues/9/labels/sandcastle%3Areserved",
    ],
    [
      "api",
      "--method",
      "PATCH",
      "repos/owner/repo/issues/9",
      "-f",
      "state=closed",
      "-f",
      "state_reason=completed",
    ],
  ]);
});
