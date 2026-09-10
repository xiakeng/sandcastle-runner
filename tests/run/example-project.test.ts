import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { loadProject } from "../../src/config.ts";

const root = path.resolve(import.meta.dirname, "../..");
const example = path.join(root, "projects/example");

const placeholders = {
  "implement.md": [
    "BASE_SHA",
    "IMPLEMENT_SKILL",
    "PROJECT_TARGET_BRANCH",
    "SOURCE_BRANCH",
    "TICKET_NUMBER",
    "TICKET_REFERENCE",
    "WORKTREE_PATH",
  ],
  "review.md": ["REVIEW_HANDOFF"],
  "ci-repair.md": [
    "BASE_SHA",
    "FAILED_CHECKS",
    "IMPLEMENT_SKILL",
    "PROJECT_TARGET_BRANCH",
    "PULL_REQUEST_NUMBER",
    "PULL_REQUEST_URL",
    "SOURCE_BRANCH",
    "TICKET_NUMBER",
    "TICKET_REFERENCE",
    "WORKTREE_PATH",
  ],
  "conflict-repair.md": [
    "BASE_SHA",
    "IMPLEMENT_SKILL",
    "MERGE_CONFLICT",
    "PROJECT_TARGET_BRANCH",
    "PULL_REQUEST_NUMBER",
    "PULL_REQUEST_URL",
    "SOURCE_BRANCH",
    "TARGET_BRANCH_SHA",
    "TICKET_NUMBER",
    "TICKET_REFERENCE",
    "WORKTREE_PATH",
  ],
  "documentation.md": [
    "BASE_SHA",
    "PROJECT_TARGET_BRANCH",
    "SOURCE_BRANCH",
    "TICKET_NUMBER",
    "TICKET_REFERENCE",
    "WORKTREE_PATH",
  ],
} as const;

test("the checked-in example is loadable and has exact prompt placeholders", async () => {
  const loaded = await loadProject(root, "example", { GH_TOKEN: "test-only" });

  assert.deepEqual(loaded.config, {
    repository: "owner/repo",
    checkout: "/absolute/path/to/repo",
    targetBranch: "main",
    tracker: {
      type: "github",
      tokenEnv: "GH_TOKEN",
      runnerAccount: "user-or-bot",
      reservationLabel: "sandcastle:reserved",
    },
    codeHost: { type: "github", tokenEnv: "GH_TOKEN", adminMerge: false },
    workflow: { review: true, documentationMaintenance: true },
    agents: Object.fromEntries(
      [
        "implement",
        "review",
        "ciRepair",
        "conflictRepair",
        "documentation",
      ].map((name) => [
        name,
        { model: "gpt-5.6-sol", reasoningEffort: "high" },
      ]),
    ),
    timeouts: {
      agentMinutes: 120,
      requiredChecksMinutes: 60,
      mergeQueueMinutes: 60,
    },
    ticketClosure: "runner",
  });

  for (const [filename, expected] of Object.entries(placeholders)) {
    const prompt = await readFile(
      path.join(example, "prompts", filename),
      "utf8",
    );
    const actual = [
      ...new Set(
        [...prompt.matchAll(/\{\{([A-Z_]+)\}\}/gu)].map((match) => match[1]),
      ),
    ].sort();
    assert.deepEqual(actual, expected, filename);
  }
});
