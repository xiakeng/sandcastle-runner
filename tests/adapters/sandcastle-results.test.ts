import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { registerTempRoot } from "../support/temp-cleanup.ts";
import { StructuredOutputError, type RunOptions } from "@ai-hero/sandcastle";
import type { AgentAttemptResult } from "../../src/run/contracts.ts";
import { SandcastleAgentExecutor } from "../../src/adapters/sandcastle.ts";
import {
  pullRequestMetadataRule,
  replacePromptPlaceholders,
} from "../../src/adapters/sandcastle-output.ts";
import {
  committed,
  createExecutor,
  input,
  object,
  reviewInput,
  result as makeResult,
} from "../support/sandcastle.ts";

test("Pull Request metadata rules preserve downstream handoff context", () => {
  assert.match(
    pullRequestMetadataRule("required"),
    /pr_title and pr_body.*Runner will use them later to create the Pull Request/u,
  );
  assert.match(
    pullRequestMetadataRule("required"),
    /inspect the target repository's contribution and Pull Request documentation/u,
  );
  assert.match(
    pullRequestMetadataRule("required_for_committed"),
    /even if this attempt does not create one/u,
  );
  assert.equal(pullRequestMetadataRule("ignored"), "omit both fields");
});

test("structured output retry explains validation and repeats the complete protocol", async () => {
  const prompts: RunOptions[] = [];
  let attempts = 0;
  const directory = registerTempRoot(
    await mkdtemp(path.join(tmpdir(), "sandcastle-retry-log-")),
  );
  try {
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
        attempts += 1;
        if (attempts === 1) {
          throw new StructuredOutputError(
            "Structured output tag <agent_attempt_result> failed schema validation",
            {
              tag: "agent_attempt_result",
              rawMatched: JSON.stringify({ ...committed, pr_body: undefined }),
              cause: [{ message: "missing fields: pr_body" }],
              commits: committed.commits,
              branch: input().branch,
              sessionId: "session-id",
            },
          );
        }
        return makeResult(
          `<agent_attempt_result>${JSON.stringify(committed)}</agent_attempt_result>`,
          committed,
        );
      },
      async () => {},
      undefined,
      async () => {},
    );
    const logFile = path.join(directory, "agent.log");
    await executor.execute({ ...input(), logFile });
    const retryPrompt = prompts.at(-1)?.prompt;
    assert.match(
      String(retryPrompt),
      /\n\nOnce done, commit only inside the supplied Worktree\./u,
    );
    assert.match(String(retryPrompt), /missing fields: pr_body/u);
    assert.match(String(retryPrompt), /<agent_attempt_result>/u);
    assert.doesNotMatch(
      String(retryPrompt),
      /When Pull Request metadata is required/u,
    );
    assert.match(String(retryPrompt), /"pr_title"/u);
    assert.match(String(retryPrompt), /"pr_body"/u);
    const protocol = replacePromptPlaceholders(
      await readFile(
        path.resolve("src/prompts/agent-attempt-output.md"),
        "utf8",
      ),
      {
        PULL_REQUEST_METADATA_RULE:
          "pr_title and pr_body are required complete non-empty strings; the Runner will use them later to create the Pull Request, even if this attempt does not create one; inspect the target repository's contribution and Pull Request documentation and follow its title and body conventions when generating both fields",
      },
    ).trim();
    assert.ok(String(retryPrompt).endsWith(protocol));
    assert.equal(prompts.at(-1)?.resumeSession, "session-id");
    const log = await readFile(logFile, "utf8");
    assert.equal(
      (log.match(/===================================/gu) ?? []).length,
      3,
    );
    assert.match(log, /missing fields: pr_body/u);
    assert.match(log, /<agent_attempt_result>/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("review structured output retry repeats the review protocol", async () => {
  const review = {
    outcome: "passed",
    summary: "Both axes pass.",
    standards: { verdict: "passed", unresolved_findings: [] },
    spec: { verdict: "passed", unresolved_findings: [] },
    checks: [{ command: "npm test", status: "passed", details: "ok" }],
    blocker: null,
  };
  const prompts: RunOptions[] = [];
  let attempts = 0;
  const executor = createExecutor(async (options) => {
    prompts.push(options);
    attempts += 1;
    if (attempts === 1) {
      throw new StructuredOutputError(
        "Structured output tag <review_attempt_result> failed schema validation",
        {
          tag: "review_attempt_result",
          rawMatched: JSON.stringify({ ...review, extra: true }),
          cause: [{ message: "unexpected fields: extra" }],
          commits: [],
          branch: input().branch,
          sessionId: "session-id",
        },
      );
    }
    return {
      iterations: [{ sessionId: "session-id" }],
      stdout: `<review_attempt_result>${JSON.stringify(review)}</review_attempt_result>`,
      commits: [],
      branch: input().branch,
      output: review,
    };
  });

  await executor.executeReview(reviewInput());
  const retryPrompt = prompts.at(-1)?.prompt;
  assert.match(String(retryPrompt), /unexpected fields: extra/u);
  assert.match(String(retryPrompt), /<review_attempt_result>/u);
  assert.match(String(retryPrompt), /"standards"/u);
  assert.match(String(retryPrompt), /"spec"/u);
  const protocol = (
    await readFile(path.resolve("src/prompts/review-attempt-output.md"), "utf8")
  ).trim();
  assert.ok(String(retryPrompt).endsWith(protocol));
  assert.equal(prompts.at(-1)?.resumeSession, "session-id");
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
  assert.equal(object(options?.output).maxRetries, 0);
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
    return makeResult(
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
    return makeResult(
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
    (error) => {
      const failure = error as Error & {
        diagnostics?: { sessionId?: string };
      };
      assert.match(failure.message, /Agent Attempt timed out/u);
      assert.equal(failure.diagnostics?.sessionId, "probe-session");
      return true;
    },
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
            reject(
              (options.signal?.reason ?? new Error("caller aborted")) as Error,
            );
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

  await assert.rejects(execution, (error) => {
    const failure = error as Error & {
      diagnostics?: { sessionId?: string };
    };
    assert.match(failure.message, /aborted/u);
    assert.equal(failure.diagnostics?.sessionId, "probe-session");
    return true;
  });
  assert.equal(receivedSignal?.aborted, true);
});

test("SandcastleAgentExecutor resumes the captured session for continuation", async () => {
  const prompts: RunOptions[] = [];
  const executor = createExecutor(async (options) => {
    prompts.push(options);
    return makeResult(
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
