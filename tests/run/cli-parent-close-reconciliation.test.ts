import assert from "node:assert/strict";
import test from "node:test";

import { executeCli } from "../../src/cli.ts";
import { createCliDependencies } from "../support/cli-dependencies.ts";
import { createProject } from "../support/cli-project.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

test("an uncertain Parent close does not overwrite external cancellation", async () => {
  const root = await createProject();
  let cancelled = false;
  let closeCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          return {
            number: 8,
            state: cancelled ? "closed" : "open",
            stateReason: cancelled ? "not_planned" : null,
          };
        },
        async listChildrenPage() {
          return {
            children: [
              {
                number: 9,
                state: "closed",
                stateReason: "completed",
                repository: "owner/repo",
              } as const,
            ],
            nextPage: null,
          };
        },
        async closeParent() {
          closeCalls += 1;
          cancelled = true;
          throw new Error("502 Bad Gateway");
        },
      },
      operator: {
        async pause() {
          return "q";
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(closeCalls, 1);
});

test("a cancelled Parent is not closed after the initial state check", async () => {
  const root = await createProject();
  let reads = 0;
  let closeCalls = 0;
  const result = await executeCli(
    ["run", "--project", "demo", "--parent", "8"],
    createCliDependencies(root, {
      tracker: {
        async getParent() {
          reads += 1;
          return {
            number: 8,
            state: reads > 1 ? "closed" : "open",
            stateReason: reads > 1 ? "not_planned" : null,
          };
        },
        async listChildrenPage() {
          return {
            children: [
              {
                number: 9,
                state: "closed",
                stateReason: "completed",
                repository: "owner/repo",
              } as const,
            ],
            nextPage: null,
          };
        },
        async closeParent() {
          closeCalls += 1;
        },
      },
    }),
  );

  assert.equal(result.summary.outcome, "cancelled");
  assert.equal(closeCalls, 0);
});
