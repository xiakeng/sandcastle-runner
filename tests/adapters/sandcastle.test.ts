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
    promptFile: "/runner/projects/demo/prompts/review.md",
    promptArgs: { REVIEW_HANDOFF: "{}" },
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
  assert.equal(Object.hasOwn(options.promptArgs, "SOURCE_BRANCH"), false);
  assert.equal(Object.hasOwn(options.promptArgs, "TARGET_BRANCH"), false);
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
  const executor = new SandcastleAgentExecutor(async (received) => {
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
  assert.equal(options?.promptFile, "/runner/projects/demo/prompts/review.md");
  assert.deepEqual(options?.promptArgs, { REVIEW_HANDOFF: "{}" });
});

test("SandcastleAgentExecutor applies timeout and caller cancellation to review", async () => {
  const hanging = new SandcastleAgentExecutor(
    (options) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () =>
            reject(
              options.signal?.reason instanceof Error
                ? options.signal.reason
                : new Error("review aborted"),
            ),
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
  const executor = new SandcastleAgentExecutor(async (received) => {
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
  const executor = new SandcastleAgentExecutor(async (received) => {
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

test("SandcastleAgentExecutor resumes the captured session for continuation", async () => {
  const prompts: RunOptions[] = [];
  const executor = new SandcastleAgentExecutor(async (options) => {
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
