import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { registerTempRoot } from "../support/temp-cleanup.ts";
import { StructuredOutputError, type RunOptions } from "@ai-hero/sandcastle";
import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import { replacePromptPlaceholders } from "../../src/adapters/sandcastle-output.ts";
import {
  committed,
  createExecutor,
  input,
  object,
  result as makeResult,
} from "../support/sandcastle.ts";

test("replacePromptPlaceholders replaces repeated known values and ignores unused values", () => {
  assert.equal(
    replacePromptPlaceholders("{{KNOWN}}/{{KNOWN}}/{{MISSING}}", {
      KNOWN: "value",
      UNUSED: "ignored",
    }),
    "value/value/{{MISSING}}",
  );
});

test("SandcastleAgentExecutor retries session probe with exponential backoff", async () => {
  const calls: RunOptions[] = [];
  const waits: number[] = [];
  let probes = 0;
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      calls.push(options);
      if (options.prompt === "Reply with exactly: SESSION_READY") {
        probes += 1;
        if (probes < 5) throw new Error("server overloaded");
        return {
          iterations: [{ sessionId: "probe-session" }],
          stdout: "SESSION_READY",
          commits: [],
          branch: input().branch,
          output: undefined,
        };
      }
      return makeResult(
        `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
        committed,
      );
    },
    async (milliseconds) => {
      waits.push(milliseconds);
    },
    async () => {},
    async () => {},
  );
  await executor.execute(input());
  assert.deepEqual(waits, [10_000, 20_000, 40_000, 80_000]);
  assert.equal(
    calls.filter(({ prompt }) => prompt === "Reply with exactly: SESSION_READY")
      .length,
    5,
  );
});

test("SandcastleAgentExecutor uses the configured operation retry policy", async () => {
  const waits: number[] = [];
  let probes = 0;
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      if (options.prompt === "Reply with exactly: SESSION_READY") {
        probes += 1;
        if (probes < 3) throw new Error("server overloaded");
        return {
          iterations: [{ sessionId: "probe-session" }],
          stdout: "SESSION_READY",
          commits: [],
          branch: input().branch,
          output: undefined,
        };
      }
      return makeResult(
        `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
        committed,
      );
    },
    async (milliseconds) => {
      waits.push(milliseconds);
    },
    async () => {},
    async () => {},
  );
  await executor.execute({
    ...input(),
    retryPolicy: {
      operationRetry: 2,
      agentRetry: 0,
      operationRetryDelay: [1],
      agentRetryDelay: [1],
    },
  });
  assert.deepEqual(waits, [1_000, 1_000]);
});

test("session probe exhaustion requests a non-agent operator pause", async () => {
  const waits: number[] = [];
  const executor = new SandcastleAgentExecutor(
    async () => {
      throw new Error("server overloaded");
    },
    async (milliseconds) => {
      waits.push(milliseconds);
    },
    async () => {},
  );
  await assert.rejects(executor.execute(input()), (error: unknown) => {
    const diagnostics = (
      error as {
        diagnostics?: { errorCategory?: string; retryable?: boolean };
      }
    ).diagnostics;
    assert.equal(diagnostics?.errorCategory, "operation_retry");
    assert.equal(diagnostics?.retryable, false);
    return true;
  });
  assert.deepEqual(waits, [10_000, 20_000, 40_000, 80_000]);
});

test("SandcastleAgentExecutor recovers a missing output tag with continue", async () => {
  const prompts: RunOptions[] = [];
  const waits: number[] = [];
  const statuses: string[] = [];
  let calls = 0;
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      prompts.push(options);
      if (options.prompt === "Reply with exactly: SESSION_READY")
        return {
          iterations: [{ sessionId: "probe-session" }],
          stdout: "SESSION_READY",
          commits: [],
          branch: input().branch,
          output: undefined,
        };
      calls += 1;
      return calls === 1
        ? makeResult("The agent replied without a result tag.", committed)
        : makeResult(
            `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
            committed,
          );
    },
    async (milliseconds) => {
      waits.push(milliseconds);
    },
    async () => {},
    async (_logFile, message) => {
      statuses.push(message);
    },
  );
  await executor.execute(input());
  assert.deepEqual(waits, [10_000]);
  assert.deepEqual(statuses, [
    "Waiting 10 seconds before automatic prompt continuation (retry 1/4).",
  ]);
  assert.match(String(prompts[2]?.prompt), /^continue\n\n/u);
  assert.equal(prompts[2]?.resumeSession, "session-id");
});

test("SandcastleAgentExecutor recovers a process failure with continue", async () => {
  const prompts: RunOptions[] = [];
  const waits: number[] = [];
  let calls = 0;
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      prompts.push(options);
      if (options.prompt === "Reply with exactly: SESSION_READY")
        return {
          iterations: [{ sessionId: "probe-session" }],
          stdout: "SESSION_READY",
          commits: [],
          branch: input().branch,
          output: undefined,
        };
      calls += 1;
      if (calls === 1) throw new Error("codex exited with code 1");
      return makeResult(
        `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
        committed,
      );
    },
    async (milliseconds) => {
      waits.push(milliseconds);
    },
    async () => {},
    async () => {},
  );

  await executor.execute(input());
  assert.deepEqual(waits, [10_000]);
  assert.match(String(prompts[2]?.prompt), /^continue\n\n/u);
  assert.equal(prompts[2]?.resumeSession, "probe-session");
});

test("SandcastleAgentExecutor stops process recovery when total timeout expires", async () => {
  const prompts: RunOptions[] = [];
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      prompts.push(options);
      if (options.prompt === "Reply with exactly: SESSION_READY")
        return {
          iterations: [{ sessionId: "probe-session" }],
          stdout: "SESSION_READY",
          commits: [],
          branch: input().branch,
          output: undefined,
        };
      throw new Error("codex exited with code 1");
    },
    async () => new Promise((resolve) => setTimeout(resolve, 5)),
    async () => {},
    async () => {},
  );

  await assert.rejects(
    executor.execute({ ...input(), timeoutMs: 1 }),
    (error) => {
      const failure = error as Error & {
        diagnostics?: { sessionId?: string };
      };
      assert.match(failure.message, /Agent Attempt timed out/u);
      assert.equal(failure.diagnostics?.sessionId, "probe-session");
      return true;
    },
  );
  assert.equal(prompts.length, 2);
});

test("missing output tag recovery exhausts after four continues", async () => {
  const prompts: string[] = [];
  const waits: number[] = [];
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      prompts.push(String(options.prompt));
      if (options.prompt === "Reply with exactly: SESSION_READY")
        return {
          iterations: [{ sessionId: "probe-session" }],
          stdout: "SESSION_READY",
          commits: [],
          branch: input().branch,
          output: undefined,
        };
      return makeResult("No structured result.", committed);
    },
    async (milliseconds) => {
      waits.push(milliseconds);
    },
    async () => {},
    async () => {},
  );
  await assert.rejects(
    executor.execute(input()),
    /Agent Attempt output must contain exactly one result tag/u,
  );
  assert.deepEqual(waits, [10_000, 20_000, 40_000, 80_000]);
  assert.equal(
    prompts.filter((prompt) => prompt.startsWith("continue\n\n")).length,
    4,
  );
});

test("SandcastleAgentExecutor logs every prompt it sends", async () => {
  const logged: string[] = [];
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      if (options.prompt === "Reply with exactly: SESSION_READY")
        return {
          iterations: [{ sessionId: "probe-session" }],
          stdout: "SESSION_READY",
          commits: [],
          branch: input().branch,
          output: undefined,
        };
      return makeResult(
        `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
        committed,
      );
    },
    async () => {},
    async (_logFile, prompt) => {
      logged.push(prompt);
    },
  );
  await executor.execute(input());
  await executor.execute({ ...input(), resumePrompt: "operator instruction" });
  assert.equal(logged[0], "Reply with exactly: SESSION_READY");
  assert.match(logged[1]!, /<agent_attempt_result>/u);
  assert.match(logged[2]!, /^operator instruction\n\n/u);
  assert.match(logged[2]!, /<agent_attempt_result>/u);
});

test("prompt logs separate probe and real prompts", async () => {
  const directory = registerTempRoot(
    await mkdtemp(path.join(tmpdir(), "sandcastle-prompt-log-")),
  );
  try {
    let calls = 0;
    const executor = new SandcastleAgentExecutor(
      async (options) => {
        if (options.prompt === "Reply with exactly: SESSION_READY")
          return {
            iterations: [{ sessionId: "probe-session" }],
            stdout: "SESSION_READY",
            commits: [],
            branch: input().branch,
            output: undefined,
          };
        calls += 1;
        return calls === 1
          ? makeResult("No result tag yet.", committed)
          : makeResult(
              `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
              committed,
            );
      },
      async () => {},
    );
    const logFile = path.join(directory, "prompts.log");
    await executor.execute({ ...input(), logFile });
    await executor.execute({
      ...input(),
      logFile,
      resumePrompt: "operator instruction",
    });
    const log = await readFile(logFile, "utf8");
    assert.equal(
      (log.match(/===================================/gu) ?? []).length,
      4,
    );
    assert.match(log, /Reply with exactly: SESSION_READY/u);
    assert.match(log, /<agent_attempt_result>/u);
    assert.match(log, /\ncontinue\n/u);
    assert.match(log, /\noperator instruction\n/u);
    assert.match(
      log,
      /Waiting 10 seconds before automatic prompt continuation \(retry 1\/4\)\./u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("SandcastleAgentExecutor supplies the complete controlled Codex invocation", async () => {
  let options: RunOptions | undefined;
  const executor = createExecutor(async (received) => {
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
    const missingPrBody = Object.fromEntries(
      Object.entries(committed).filter(([field]) => field !== "pr_body"),
    );
    assert.match(
      JSON.stringify(await validateSchema(missingPrBody)),
      /missing fields: pr_body/u,
    );
    assert.deepEqual(await validateSchema(committed), {
      value: committed,
    });
    return makeResult(
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
  assert.equal(options.promptFile, undefined);
  assert.equal(options.promptArgs, undefined);
  assert.match(String(options.prompt), /# Implement Delivery Ticket 9/u);
  assert.match(String(options.prompt), /sandcastle\/run-id\/ticket-9/u);
  assert.match(String(options.prompt), /<agent_attempt_result>/u);
  assert.match(String(options.prompt), /"pr_title"/u);
  assert.ok(
    String(options.prompt).indexOf("<agent_attempt_result>") >
      String(options.prompt).indexOf("Run typechecking regularly"),
  );
  assert.equal(options.maxIterations, 1);
  assert.deepEqual(options.completionSignal, []);
  assert.equal(options.idleTimeoutSeconds, 120);
  assert.deepEqual(options.branchStrategy, { type: "head" });
  assert.deepEqual(options.logging, {
    type: "file",
    path: "/runner/projects/demo/logs/agent.log",
  });
  assert.equal(object(options.output).maxRetries, 0);
});

test("SandcastleAgentExecutor rejects multiple result tags", async () => {
  const tagged = `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`;
  const executor = createExecutor(async () =>
    makeResult(`${tagged}\n${tagged}`, committed),
  );

  await assert.rejects(executor.execute(input()), /exactly one result tag/u);
});

test("SandcastleAgentExecutor accepts a valid final retry payload from an output error", async () => {
  const statuses: string[] = [];
  const executor = new SandcastleAgentExecutor(
    async (options) => {
      if (options.prompt === "Reply with exactly: SESSION_READY")
        return {
          iterations: [{ sessionId: "probe-session" }],
          stdout: "SESSION_READY",
          commits: [],
          branch: input().branch,
          output: undefined,
        };
      throw new StructuredOutputError(
        "Structured output tag <agent_attempt_result> failed schema validation",
        {
          tag: "agent_attempt_result",
          rawMatched: JSON.stringify(committed),
          cause: [{ message: "stale first attempt" }],
          commits: committed.commits,
          branch: input().branch,
          sessionId: "session-id",
        },
      );
    },
    async () => {},
    async () => {},
    async (_logFile, message) => {
      statuses.push(message);
    },
  );

  const result = await executor.execute({
    ...input(),
    retryPolicy: {
      operationRetry: 4,
      agentRetry: 1,
      operationRetryDelay: [10, 20, 40, 80],
      agentRetryDelay: [10, 20, 40, 80],
    },
  });
  assert.equal(result.outcome, "committed");
  assert.deepEqual(result.commits, committed.commits);
  assert.equal(statuses.length, 5);
  assert.match(statuses[0]!, /Structured output validation failed;/u);
  assert.match(statuses[0]!, /stale first attempt/u);
  assert.match(
    statuses[1]!,
    /Waiting 10 seconds before automatic prompt continuation/u,
  );
  assert.equal(
    statuses[2],
    "Starting structured output retry; retryRemaining=0; resumeSession=session-id",
  );
  assert.match(statuses[3]!, /Structured output validation failed;/u);
  assert.equal(
    statuses[4],
    "Recovered the final structured output from the retry result.",
  );
});
