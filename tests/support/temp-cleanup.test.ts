import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { registerTempRoot } from "./temp-cleanup.ts";

test("registered roots are removed when the test process receives SIGTERM", async () => {
  const root = registerTempRoot(
    mkdtempSync(path.join(tmpdir(), "sandcastle-temp-cleanup-")),
  );
  const helper = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "temp-cleanup.ts"),
  ).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { registerTempRoot } from ${JSON.stringify(helper)}; registerTempRoot(${JSON.stringify(root)}); console.log("ready"); setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  try {
    const stdout = child.stdout;
    assert.ok(stdout);
    await once(stdout, "data");
    assert.equal(child.kill("SIGTERM"), true);
    const exit = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(exit.code, 143);
    assert.equal(exit.signal, null);
    assert.equal(existsSync(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
