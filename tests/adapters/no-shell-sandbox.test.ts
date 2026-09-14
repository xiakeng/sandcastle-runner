import assert from "node:assert/strict";
import test from "node:test";

import { noShellSandbox } from "../../src/adapters/no-shell-sandbox.ts";

interface TestHandle {
  exec(command: string): Promise<{
    stdout: string;
    exitCode: number;
  }>;
  close(): Promise<void>;
}

async function createHandle(): Promise<TestHandle> {
  const provider = noShellSandbox() as unknown as {
    create: (options: {
      worktreePath: string;
      env: Record<string, string>;
    }) => Promise<TestHandle>;
  };
  return provider.create({ worktreePath: process.cwd(), env: {} });
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

test("noShellSandbox reports a missing logical command", async () => {
  const handle = await createHandle();
  await assert.rejects(
    handle.exec("sandcastle-command-that-does-not-exist"),
    /sandcastle-command-that-does-not-exist could not be started: .*README prerequisites/u,
  );
  await handle.close();
});
