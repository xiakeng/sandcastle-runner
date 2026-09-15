import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

import { noShellSandbox } from "../../src/adapters/no-shell-sandbox.ts";

interface TestHandle {
  exec(command: string): Promise<{
    stdout: string;
    exitCode: number;
  }>;
  close(): Promise<void>;
}

async function createHandle(
  env: Record<string, string> = {},
): Promise<TestHandle> {
  const provider = noShellSandbox({ env }) as unknown as {
    create: (options: {
      worktreePath: string;
      env: Record<string, string>;
    }) => Promise<TestHandle>;
  };
  return provider.create({ worktreePath: process.cwd(), env });
}

test("noShellSandbox runs quoted arguments without a shell", async () => {
  const handle = await createHandle();
  const result = await handle.exec(
    "node -e 'process.stdout.write(process.argv[1])' 'hello world'",
  );
  assert.equal(result.stdout, "hello world");
  assert.equal(result.exitCode, 0);
  await handle.close();
});

test("noShellSandbox preserves Windows path separators and spaces", async () => {
  const handle = await createHandle();
  const path = String.raw`C:\work repo\src`;
  const result = await handle.exec(
    `node -e 'process.stdout.write(process.argv[1])' "${path}"`,
  );
  assert.equal(result.stdout, path);
  assert.equal(result.exitCode, 0);
  const trailingSeparator = "C:\\work repo\\";
  const trailingResult = await handle.exec(
    `node -e 'process.stdout.write(process.argv[1])' "${trailingSeparator}"`,
  );
  assert.equal(trailingResult.stdout, trailingSeparator);
  assert.equal(trailingResult.exitCode, 0);
  await handle.close();
});

test(
  "noShellSandbox launches Windows command shims without shell mode",
  {
    skip: process.platform !== "win32",
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandcastle-shim-"));
    try {
      const shim = join(directory, "codex shim.cmd");
      await writeFile(
        shim,
        '@echo off\r\nnode -e "process.stdout.write(process.argv[1])" "%~1"\r\n',
      );
      const handle = await createHandle({
        PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
      });
      const path = String.raw`C:\work repo\src`;
      const result = await handle.exec(`"${shim}" "${path}"`);
      assert.equal(result.stdout, path);
      assert.equal(result.exitCode, 0);
      await handle.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("noShellSandbox reports a missing logical command", async () => {
  const handle = await createHandle();
  await assert.rejects(
    handle.exec("sandcastle-command-that-does-not-exist"),
    /sandcastle-command-that-does-not-exist could not be started: .*README prerequisites/u,
  );
  await handle.close();
});
