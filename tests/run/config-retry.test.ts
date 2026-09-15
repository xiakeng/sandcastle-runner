import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { loadProject } from "../../src/config.ts";
import { createProject, validConfig } from "../support/cli-project.ts";
import { cleanupTempRoots } from "../support/temp-cleanup.ts";

test.afterEach(cleanupTempRoots);

test("loadProject validates the complete retry policy", async () => {
  const root = await createProject();
  const loaded = await loadProject(root, "demo", {
    TEST_GH_TOKEN: "token",
  });
  assert.deepEqual(
    {
      operationRetry: loaded.config.operationRetry,
      agentRetry: loaded.config.agentRetry,
      operationRetryDelay: loaded.config.operationRetryDelay,
      agentRetryDelay: loaded.config.agentRetryDelay,
    },
    {
      operationRetry: 4,
      agentRetry: 4,
      operationRetryDelay: [10, 20, 40, 80],
      agentRetryDelay: [10, 20, 40, 80],
    },
  );
});

test("loadProject rejects missing and malformed retry fields", async () => {
  const invalid = [
    ["operationRetry", undefined],
    ["agentRetry", -1],
    ["operationRetryDelay", []],
    ["agentRetryDelay", [0]],
    ["operationRetryDelay", [Number.POSITIVE_INFINITY]],
  ] as const;

  for (const [field, value] of invalid) {
    const root = await createProject();
    const config = structuredClone(validConfig) as Record<string, unknown>;
    if (value === undefined) delete config[field];
    else config[field] = value;
    await writeFile(
      path.join(root, "projects", "demo", "config.json"),
      JSON.stringify(config),
    );
    await assert.rejects(
      loadProject(root, "demo", { TEST_GH_TOKEN: "token" }),
      new RegExp(field, "u"),
    );
  }
});
