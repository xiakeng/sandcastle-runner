import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { loadProject } from "../../src/config.ts";

const root = path.resolve(import.meta.dirname, "../..");

const placeholders = {
  "implement.md": [
    "BASE_SHA",
    "PROJECT_TARGET_BRANCH",
    "SOURCE_BRANCH",
    "TICKET_NUMBER",
    "TICKET_REFERENCE",
    "WORKTREE_PATH",
  ],
  "review.md": ["PROJECT_TARGET_BRANCH", "REVIEW_HANDOFF"],
  "ci-repair.md": [
    "BASE_SHA",
    "FAILED_CHECKS",
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
    "PROJECT_TARGET_BRANCH",
    "SOURCE_BRANCH",
    "TICKET_NUMBER",
    "TICKET_REFERENCE",
    "WORKTREE_PATH",
  ],
} as const;

test("checked-in projects are loadable and have exact prompt placeholders", async () => {
  const projects = await readdir(path.join(root, "projects"), {
    withFileTypes: true,
  });
  for (const project of projects.filter((entry) => entry.isDirectory())) {
    const directory = path.join(root, "projects", project.name);
    await loadProject(root, project.name, { GH_TOKEN: "test-only" });
    for (const [filename, expected] of Object.entries(placeholders)) {
      const prompt = await readFile(
        path.join(directory, "prompts", filename),
        "utf8",
      );
      const actual = [
        ...new Set(
          [...prompt.matchAll(/\{\{([A-Z_]+)\}\}/gu)].map((match) => match[1]),
        ),
      ].sort();
      assert.deepEqual(actual, expected, filename);
    }
  }
});
