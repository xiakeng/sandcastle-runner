import assert from "node:assert/strict";
import test from "node:test";

import type { RunOptions, RunResult } from "@ai-hero/sandcastle";

import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import type { AgentAttemptResult } from "../../src/run/contracts.ts";

function object(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

const committed: AgentAttemptResult = {
  outcome: "committed",
  summary: "implemented",
  commits: [
    {
      sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      message: "feat: implementation",
    },
  ],
  checks: [{ command: "npm test", status: "passed", details: "ok" }],
  blocker: null,
  pr_title: "feat: implementation",
  pr_body: "Implements the ticket.",
};

function input() {
  return {
    ticket: 9,
    worktree: "/repo/worktree",
    branch: "sandcastle/run-id/ticket-9",
    base: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    promptFile: "/runner/projects/demo/prompts/implement.md",
    promptArgs: {
      TICKET_NUMBER: 9,
      IMPLEMENT_SKILL: "$implement",
      WORKTREE_PATH: "/repo/worktree",
      BRANCH: "sandcastle/run-id/ticket-9",
      BASE_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    model: "gpt-5.6-sol",
    effort: "high" as const,
    gitConfigGlobal: "/tmp/attempt/config",
    logFile: "/runner/projects/demo/logs/agent.log",
    timeoutMs: 120_000,
    signal: new AbortController().signal,
  };
}

function result(
  stdout: string,
  output: AgentAttemptResult,
): RunResult & { output: AgentAttemptResult } {
  return {
    iterations: [{ sessionId: "session-id" }],
    stdout,
    commits: output.commits,
    branch: "sandcastle/run-id/ticket-9",
    output,
  };
}

test("SandcastleAgentExecutor supplies the complete controlled Codex invocation", async () => {
  let options: RunOptions | undefined;
  const executor = new SandcastleAgentExecutor(async (received) => {
    options = received;
    const definition = object(received.output);
    assert.equal(definition._tag, "object");
    const standard = object(object(definition.schema)["~standard"]);
    const validate = standard.validate;
    if (typeof validate !== "function") assert.fail("schema must validate");
    const validateSchema = validate as (value: unknown) => unknown;
    assert.ok(
      object(await validateSchema({ ...committed, pr_body: "" })).issues,
    );
    assert.deepEqual(await validateSchema(committed), {
      value: committed,
    });
    return result(
      `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
      committed,
    );
  });

  assert.deepEqual(await executor.execute(input()), committed);
  assert.ok(options);
  assert.equal(options.agent.name, "codex");
  assert.match(
    options.agent.buildPrintCommand({
      prompt: "controlled prompt",
      dangerouslySkipPermissions: true,
    }).command,
    /-m 'gpt-5\.6-sol'.*model_reasoning_effort="high"/u,
  );
  assert.equal(options.sandbox.name, "no-sandbox");
  assert.deepEqual(options.sandbox.env, {
    GIT_CONFIG_GLOBAL: "/tmp/attempt/config",
  });
  assert.equal(options.cwd, "/repo/worktree");
  assert.equal(
    options.promptFile,
    "/runner/projects/demo/prompts/implement.md",
  );
  assert.deepEqual(options.promptArgs, input().promptArgs);
  assert.equal(options.maxIterations, 1);
  assert.deepEqual(options.completionSignal, []);
  assert.equal(options.idleTimeoutSeconds, 120);
  assert.deepEqual(options.branchStrategy, { type: "head" });
  assert.deepEqual(options.logging, {
    type: "file",
    path: "/runner/projects/demo/logs/agent.log",
  });
  assert.equal(object(options.output).maxRetries, 1);
});

test("SandcastleAgentExecutor rejects multiple result tags", async () => {
  const tagged = `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`;
  const executor = new SandcastleAgentExecutor(async () =>
    result(`${tagged}\n${tagged}`, committed),
  );

  await assert.rejects(executor.execute(input()), /exactly one result tag/u);
});

test("SandcastleAgentExecutor aborts a continuously active run at the configured total timeout", async () => {
  const executor = new SandcastleAgentExecutor(
    (options) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            reject(new Error("Agent Attempt timed out"));
          },
          { once: true },
        );
      }),
  );

  await assert.rejects(
    executor.execute({ ...input(), timeoutMs: 5 }),
    /Agent Attempt timed out/u,
  );
});

test("SandcastleAgentExecutor forwards caller cancellation", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const executor = new SandcastleAgentExecutor(
    (options) =>
      new Promise((_resolve, reject) => {
        receivedSignal = options.signal;
        options.signal?.addEventListener(
          "abort",
          () => reject(new Error("caller aborted")),
          { once: true },
        );
      }),
  );

  const execution = executor.execute({
    ...input(),
    signal: controller.signal,
  });
  controller.abort();

  await assert.rejects(execution, /caller aborted/u);
  assert.equal(receivedSignal?.aborted, true);
});
