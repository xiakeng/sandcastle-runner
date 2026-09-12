import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { tmpdir } from "node:os";

import type { RunOptions, RunResult } from "@ai-hero/sandcastle";

import {
  replacePromptPlaceholders,
  SandcastleAgentExecutor,
} from "../../src/adapters/sandcastle.ts";
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
    targetBranch: "main",
    promptFile: path.resolve("projects/trickplay-cropper/prompts/implement.md"),
    promptArgs: {
      TICKET_NUMBER: 9,
      WORKTREE_PATH: "/repo/worktree",
      BASE_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      PROJECT_TARGET_BRANCH: "main",
    },
    pullRequestMetadata: "required" as const,
    model: "gpt-5.6-sol",
    effort: "high" as const,
    gitConfigGlobal: "/tmp/attempt/config",
    logFile: "/runner/projects/demo/logs/agent.log",
    timeoutMs: 120_000,
    signal: new AbortController().signal,
  };
}

function reviewInput() {
  const { pullRequestMetadata, ...review } = input();
  void pullRequestMetadata;
  return {
    ...review,
    promptFile: path.resolve("projects/trickplay-cropper/prompts/review.md"),
    promptArgs: { REVIEW_HANDOFF: "{}" },
  };
}

type FakeRun = (
  options: RunOptions,
) => Promise<RunResult & { output: unknown }>;

function createExecutor(run: FakeRun): SandcastleAgentExecutor {
  return new SandcastleAgentExecutor(
    async (options) => {
      if (options.prompt === "Reply with exactly: SESSION_READY") {
        return {
          iterations: [{ sessionId: "probe-session" }],
          stdout: "SESSION_READY",
          commits: [],
          branch: input().branch,
          output: undefined,
        };
      }
      return run(options);
    },
    async () => {},
    async () => {},
  );
}

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
      return result(
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
    assert.equal(diagnostics?.errorCategory, "operator_pause");
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
        ? result("The agent replied without a result tag.", committed)
        : result(
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
  assert.equal(prompts[2]?.prompt, "continue");
  assert.equal(prompts[2]?.resumeSession, "session-id");
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
      return result("No structured result.", committed);
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
  assert.equal(prompts.filter((prompt) => prompt === "continue").length, 4);
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
      return result(
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
  assert.equal(logged[2], "operator instruction");
});

test("prompt logs separate probe and real prompts", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "sandcastle-prompt-log-"),
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
          ? result("No result tag yet.", committed)
          : result(
              `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
              committed,
            );
      },
      async () => {},
    );
    const logFile = path.join(directory, "prompts.log");
    await executor.execute({ ...input(), logFile });
    const log = await readFile(logFile, "utf8");
    assert.equal(
      (log.match(/===================================/gu) ?? []).length,
      3,
    );
    assert.match(log, /Reply with exactly: SESSION_READY/u);
    assert.match(log, /<agent_attempt_result>/u);
    assert.match(
      log,
      /Waiting 10 seconds before automatic prompt continuation \(retry 1\/4\)\./u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
  assert.equal(object(options.output).maxRetries, 1);
});

test("SandcastleAgentExecutor rejects multiple result tags", async () => {
  const tagged = `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`;
  const executor = createExecutor(async () =>
    result(`${tagged}\n${tagged}`, committed),
  );

  await assert.rejects(executor.execute(input()), /exactly one result tag/u);
});

test("SandcastleAgentExecutor runs a fresh strict review result with one correction opportunity", async () => {
  const review = {
    outcome: "passed" as const,
    summary: "Both axes pass.",
    standards: { verdict: "passed" as const, unresolved_findings: [] },
    spec: { verdict: "passed" as const, unresolved_findings: [] },
    checks: [{ command: "npm test", status: "passed" as const, details: "ok" }],
    blocker: null,
  };
  let options: RunOptions | undefined;
  const executor = createExecutor(async (received) => {
    options = received;
    const definition = object(received.output);
    const standard = object(object(definition.schema)["~standard"]);
    const validate = standard.validate as (value: unknown) => unknown;
    assert.ok(
      object(
        await validate({
          ...review,
          standards: { verdict: "passed", unresolved_findings: ["P1"] },
        }),
      ).issues,
    );
    assert.ok(
      object(await validate({ ...review, pr_title: "not owned" })).issues,
    );
    assert.deepEqual(await validate(review), { value: review });
    return {
      iterations: [{ sessionId: "fresh-review-session" }],
      stdout: `<review_attempt_result>${JSON.stringify(review)}</review_attempt_result>`,
      commits: [],
      branch: input().branch,
      output: review,
    };
  });
  assert.deepEqual(await executor.executeReview(reviewInput()), review);
  assert.equal(object(options?.output).maxRetries, 1);
  assert.equal(options?.promptFile, undefined);
  assert.equal(options?.promptArgs, undefined);
  assert.match(String(options?.prompt), /Review/u);
  assert.match(String(options?.prompt), /<review_attempt_result>/u);
  assert.match(String(options?.prompt), /"standards"/u);
  assert.match(String(options?.prompt), /"spec"/u);
  assert.ok(
    String(options?.prompt).indexOf("<review_attempt_result>") >
      String(options?.prompt).indexOf("Use the `/code-review` skill"),
  );
});

test("SandcastleAgentExecutor applies timeout and caller cancellation to review", async () => {
  const hanging = createExecutor(
    (options) =>
      new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => {}, 1_000);
        if (options.signal?.aborted) {
          clearTimeout(keepAlive);
          reject(
            options.signal.reason instanceof Error
              ? options.signal.reason
              : new Error("caller aborted"),
          );
          return;
        }
        options.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(keepAlive);
            reject(
              options.signal?.reason instanceof Error
                ? options.signal.reason
                : new Error("review aborted"),
            );
          },
          { once: true },
        );
      }),
  );
  await assert.rejects(
    hanging.executeReview({ ...reviewInput(), timeoutMs: 5 }),
    /Agent Attempt timed out/u,
  );

  const controller = new AbortController();
  const execution = hanging.executeReview({
    ...reviewInput(),
    signal: controller.signal,
  });
  controller.abort(new Error("review cancelled"));
  await assert.rejects(execution, /review cancelled/u);
});

test("SandcastleAgentExecutor accepts repair results without Pull Request metadata", async () => {
  const repair = {
    outcome: "committed" as const,
    summary: "repaired CI",
    commits: committed.commits,
    checks: committed.checks,
    blocker: null,
  };
  const executor = createExecutor(async (received) => {
    const definition = object(received.output);
    const standard = object(object(definition.schema)["~standard"]);
    const validate = standard.validate as (value: unknown) => unknown;
    assert.deepEqual(await validate(repair), { value: repair });
    assert.ok(object(await validate(committed)).issues);
    return result(
      `<agent_attempt_result>${JSON.stringify(repair)}</agent_attempt_result>`,
      repair,
    );
  });

  assert.deepEqual(
    await executor.execute({
      ...input(),
      pullRequestMetadata: "ignored",
    }),
    repair,
  );
});

test("SandcastleAgentExecutor requires Pull Request metadata only for committed maintenance", async () => {
  const noChange: AgentAttemptResult = {
    outcome: "no_change",
    summary: "documentation is current",
    commits: [],
    checks: [],
    blocker: null,
  };
  const executor = createExecutor(async (received) => {
    const definition = object(received.output);
    const standard = object(object(definition.schema)["~standard"]);
    const validate = standard.validate as (value: unknown) => unknown;
    assert.deepEqual(await validate(noChange), { value: noChange });
    const withoutMetadata = {
      outcome: committed.outcome,
      summary: committed.summary,
      commits: committed.commits,
      checks: committed.checks,
      blocker: committed.blocker,
    };
    assert.ok(object(await validate(withoutMetadata)).issues);
    return result(
      `<agent_attempt_result>${JSON.stringify(noChange)}</agent_attempt_result>`,
      noChange,
    );
  });

  assert.deepEqual(
    await executor.execute({
      ...input(),
      pullRequestMetadata: "required_for_committed",
    }),
    noChange,
  );
});

test("SandcastleAgentExecutor aborts a continuously active run at the configured total timeout", async () => {
  const executor = createExecutor(
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
  const executor = createExecutor(
    (options) =>
      new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => {}, 1_000);
        receivedSignal = options.signal;
        if (options.signal?.aborted) {
          clearTimeout(keepAlive);
          reject(new Error("caller aborted"));
          return;
        }
        options.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(keepAlive);
            reject(new Error("caller aborted"));
          },
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

test("SandcastleAgentExecutor resumes the captured session for continuation", async () => {
  const prompts: RunOptions[] = [];
  const executor = createExecutor(async (options) => {
    prompts.push(options);
    return result(
      `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
      committed,
    );
  });
  await executor.execute(input());
  await executor.execute({ ...input(), resumePrompt: "continue" });
  assert.equal(prompts[1]?.prompt, "continue");
  assert.equal(prompts[1]?.resumeSession, "session-id");
  assert.equal(
    prompts[1]?.logging && JSON.stringify(prompts[1].logging),
    JSON.stringify(prompts[0]?.logging),
  );
});

test("SandcastleAgentExecutor reports an unavailable continuation session", async () => {
  const executor = createExecutor(async () => {
    throw new Error("provider must not be called");
  });

  await assert.rejects(
    executor.execute({ ...input(), resumePrompt: "continue" }),
    /Provider session unavailable for continuation/u,
  );
});
