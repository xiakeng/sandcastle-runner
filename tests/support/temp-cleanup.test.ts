import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
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
  const stdout = child.stdout;
  assert.ok(stdout);
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, 5000);
  try {
    await Promise.race([
      once(stdout, "data"),
      once(child, "exit").then(() => {
        throw new Error("cleanup child exited before signaling ready");
      }),
    ]);
    assert.equal(child.kill("SIGTERM"), true);
    const [code, signal] = (await once(child, "exit")) as [
      number | null,
      NodeJS.Signals | null,
    ];
    assert.equal(code, 143);
    assert.equal(signal, null);
    assert.equal(existsSync(root), false);
  } finally {
    clearTimeout(timer);
    rmSync(root, { recursive: true, force: true });
  }
});
