import {
  codex,
  Output,
  run as runSandcastle,
  type RunOptions,
  type RunResult,
} from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  AgentAttemptResult,
  AgentAttemptInput,
  AgentDiagnostics,
  AgentExecutor,
  CheckEvidence,
  CommitEvidence,
  ReviewAttemptInput,
  ReviewAttemptResult,
  ReviewVerdict,
} from "../run/contracts.ts";

type SandcastleRun = (
  options: RunOptions,
) => Promise<RunResult & { output: unknown }>;

interface StandardSchema<T> {
  "~standard": {
    version: 1;
    vendor: string;
    validate(value: unknown): { value: T } | { issues: { message: string }[] };
  };
}

class AgentOutputError extends Error {
  readonly diagnostics: AgentDiagnostics;

  constructor(message: string, diagnostics: AgentDiagnostics) {
    super(message);
    this.diagnostics = diagnostics;
  }
}

type Delay = (milliseconds: number, signal: AbortSignal) => Promise<void>;
type PromptLogger = (logFile: string, prompt: string) => Promise<void>;
type StatusLogger = (logFile: string, message: string) => Promise<void>;

const delay: Delay = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("aborted"),
      );
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });

const runnerPromptDirectory = join(import.meta.dirname, "../prompts");
const promptSeparator = "===================================";
const logPrompt: PromptLogger = (logFile, prompt) =>
  appendFile(logFile, `${promptSeparator}\n${prompt}\n`, "utf8");
const logStatus: StatusLogger = (logFile, message) =>
  appendFile(logFile, `${message}\n`, "utf8");

function pullRequestMetadataRule(
  metadata: AgentAttemptInput["pullRequestMetadata"],
): string {
  if (metadata === "required")
    return "required non-empty strings; both fields must be present";
  if (metadata === "required_for_committed")
    return "include both as non-empty strings only when outcome is committed; omit both otherwise";
  return "omit both fields";
}

export function replacePromptPlaceholders(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{\{([A-Za-z0-9_]+)\}\}/gu, (placeholder, key) => {
    const name = String(key);
    return name in values ? String(values[name]) : placeholder;
  });
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function nonempty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${name} must be nonempty`);
  return value;
}

function parseCommit(value: unknown): CommitEvidence {
  const input = object(value, "commit");
  if (!/^[0-9a-f]{40,64}$/u.test(nonempty(input.sha, "commit.sha")))
    throw new Error("commit.sha must be a full SHA");
  return {
    sha: input.sha as string,
    message: nonempty(input.message, "commit.message"),
  };
}

function parseCheck(value: unknown): CheckEvidence {
  const input = object(value, "check");
  if (
    input.status !== "passed" &&
    input.status !== "failed" &&
    input.status !== "not_run"
  ) {
    throw new Error("check.status is unsupported");
  }
  return {
    command: nonempty(input.command, "check.command"),
    status: input.status,
    details: nonempty(input.details, "check.details"),
  };
}

function parseAttemptResult(
  value: unknown,
  pullRequestMetadata: "required" | "required_for_committed" | "ignored",
): AgentAttemptResult {
  const input = object(value, "Agent Attempt Result");
  const requiresPullRequestMetadata =
    pullRequestMetadata === "required" ||
    (pullRequestMetadata === "required_for_committed" &&
      input.outcome === "committed");
  const expected = [
    "blocker",
    "checks",
    "commits",
    "outcome",
    "summary",
    ...(requiresPullRequestMetadata ? ["pr_body", "pr_title"] : []),
  ];
  if (
    Object.keys(input).length !== expected.length ||
    expected.some((field) => !(field in input))
  ) {
    throw new Error("Agent Attempt Result has unexpected fields");
  }
  if (
    input.outcome !== "committed" &&
    input.outcome !== "no_change" &&
    input.outcome !== "blocked"
  ) {
    throw new Error("outcome is unsupported");
  }
  if (!Array.isArray(input.commits) || !Array.isArray(input.checks))
    throw new Error("commits and checks must be arrays");
  const commits = input.commits.map(parseCommit);
  if (input.outcome === "committed" && commits.length === 0)
    throw new Error("committed requires a claimed commit");
  if (input.outcome === "no_change" && commits.length !== 0)
    throw new Error("no_change cannot claim commits");
  const blocker =
    input.outcome === "blocked"
      ? nonempty(input.blocker, "blocker")
      : input.blocker;
  if (input.outcome !== "blocked" && blocker !== null)
    throw new Error("blocker must be null unless blocked");
  return {
    outcome: input.outcome,
    summary: nonempty(input.summary, "summary"),
    commits,
    checks: input.checks.map(parseCheck),
    blocker: blocker as string | null,
    ...(requiresPullRequestMetadata
      ? {
          pr_title: nonempty(input.pr_title, "pr_title"),
          pr_body: nonempty(input.pr_body, "pr_body"),
        }
      : {}),
  };
}

function resultSchema(
  pullRequestMetadata: "required" | "required_for_committed" | "ignored",
) {
  return {
    "~standard": {
      version: 1 as const,
      vendor: "sandcastle-runner",
      validate(value: unknown) {
        try {
          return { value: parseAttemptResult(value, pullRequestMetadata) };
        } catch (error) {
          return {
            issues: [
              {
                message:
                  error instanceof Error
                    ? error.message
                    : "invalid Agent Attempt Result",
              },
            ],
          };
        }
      },
    },
  } satisfies StandardSchema<AgentAttemptResult>;
}

function parseVerdict(value: unknown, name: string): ReviewVerdict {
  const input = object(value, name);
  if (input.verdict !== "passed" && input.verdict !== "blocked")
    throw new Error(`${name}.verdict is unsupported`);
  if (
    !Array.isArray(input.unresolved_findings) ||
    input.unresolved_findings.some(
      (finding) => typeof finding !== "string" || finding.trim() === "",
    )
  ) {
    throw new Error(`${name}.unresolved_findings must be strings`);
  }
  return {
    verdict: input.verdict,
    unresolved_findings: input.unresolved_findings as string[],
  };
}

function parseReviewResult(value: unknown): ReviewAttemptResult {
  const input = object(value, "Review Attempt Result");
  const expected = [
    "blocker",
    "checks",
    "outcome",
    "spec",
    "standards",
    "summary",
  ];
  if (
    Object.keys(input).length !== expected.length ||
    expected.some((field) => !(field in input))
  ) {
    throw new Error("Review Attempt Result has unexpected fields");
  }
  if (input.outcome !== "passed" && input.outcome !== "blocked")
    throw new Error("review outcome is unsupported");
  if (!Array.isArray(input.checks)) throw new Error("checks must be an array");
  const standards = parseVerdict(input.standards, "standards");
  const spec = parseVerdict(input.spec, "spec");
  if (
    input.outcome === "passed" &&
    (standards.verdict !== "passed" ||
      spec.verdict !== "passed" ||
      standards.unresolved_findings.length !== 0 ||
      spec.unresolved_findings.length !== 0)
  ) {
    throw new Error("passed review requires both axes to pass cleanly");
  }
  const blocker =
    input.outcome === "blocked"
      ? nonempty(input.blocker, "blocker")
      : input.blocker;
  if (input.outcome === "passed" && blocker !== null)
    throw new Error("blocker must be null when review passes");
  return {
    outcome: input.outcome,
    summary: nonempty(input.summary, "summary"),
    standards,
    spec,
    checks: input.checks.map(parseCheck),
    blocker: blocker as string | null,
  };
}

function reviewResultSchema(): StandardSchema<ReviewAttemptResult> {
  return {
    "~standard": {
      version: 1,
      vendor: "sandcastle-runner",
      validate(value: unknown) {
        try {
          return { value: parseReviewResult(value) };
        } catch (error) {
          return {
            issues: [
              {
                message:
                  error instanceof Error
                    ? error.message
                    : "invalid Review Attempt Result",
              },
            ],
          };
        }
      },
    },
  };
}

export class SandcastleAgentExecutor implements AgentExecutor {
  private readonly run: SandcastleRun;
  private readonly wait: Delay;
  private readonly logPrompt: PromptLogger;
  private readonly logStatus: StatusLogger;
  private readonly sessions = new Map<string, string>();
  private readonly replies = new Map<string, string>();

  constructor(
    run: SandcastleRun = runSandcastle as SandcastleRun,
    wait: Delay = delay,
    promptLogger: PromptLogger = logPrompt,
    statusLogger: StatusLogger = logStatus,
  ) {
    this.run = run;
    this.wait = wait;
    this.logPrompt = promptLogger;
    this.logStatus = statusLogger;
  }

  private async prepareSession(input: ReviewAttemptInput): Promise<string> {
    const existing = this.sessions.get(input.logFile);
    if (existing !== undefined) return existing;

    let lastError: unknown;
    const backoffs = [10_000, 20_000, 40_000, 80_000];
    for (let attempt = 0; attempt <= backoffs.length; attempt++) {
      try {
        await this.logPrompt(
          input.logFile,
          "Reply with exactly: SESSION_READY",
        );
        const result = await this.run({
          agent: codex(input.model, { effort: input.effort }),
          sandbox: noSandbox({
            env: { GIT_CONFIG_GLOBAL: input.gitConfigGlobal },
          }),
          cwd: input.worktree,
          prompt: "Reply with exactly: SESSION_READY",
          maxIterations: 1,
          completionSignal: ["SESSION_READY"],
          idleTimeoutSeconds: input.timeoutMs / 1000,
          branchStrategy: { type: "head" },
          logging: { type: "file", path: input.logFile },
          signal: input.signal,
        });
        const sessionId = result.iterations.at(-1)?.sessionId;
        if (sessionId === undefined)
          throw new Error("session probe returned no session ID");
        this.sessions.set(input.logFile, sessionId);
        return sessionId;
      } catch (error) {
        lastError = error;
        if (attempt === backoffs.length) break;
        await this.wait(backoffs[attempt]!, input.signal);
      }
    }
    throw new AgentOutputError("Agent session probe failed after 4 retries", {
      errorCategory: "operator_pause",
      retryable: false,
      provider: "codex",
      model: input.model,
      workingDirectory: input.worktree,
      diagnosticLogPath: input.logFile,
      raw: lastError instanceof Error ? lastError.message : String(lastError),
    });
  }

  private async runOutput<T>(
    input: ReviewAttemptInput,
    tag: string,
    schema: StandardSchema<T>,
  ): Promise<T> {
    let resumeSession = this.sessions.get(input.logFile);
    let prompt = input.resumePrompt;
    if (prompt === undefined) {
      resumeSession ??= await this.prepareSession(input);
      const pullRequestMetadata =
        "pullRequestMetadata" in input
          ? (input as AgentAttemptInput).pullRequestMetadata
          : "ignored";
      const template = replacePromptPlaceholders(
        await readFile(input.promptFile, "utf8"),
        {
          ...input.promptArgs,
          SOURCE_BRANCH: input.branch,
          TARGET_BRANCH: String(input.targetBranch),
        },
      );
      const outputPrompt = await readFile(
        join(
          runnerPromptDirectory,
          tag === "review_attempt_result"
            ? "review-attempt-output.md"
            : "agent-attempt-output.md",
        ),
        "utf8",
      );
      prompt = `${template.trimEnd()}\n\n${replacePromptPlaceholders(
        outputPrompt,
        {
          PULL_REQUEST_METADATA_RULE:
            pullRequestMetadataRule(pullRequestMetadata),
        },
      ).trim()}`;
    }
    if (prompt !== undefined && resumeSession === undefined) {
      throw new AgentOutputError(
        "Provider session unavailable for continuation",
        {
          errorCategory: "agent_attempt",
          retryable: false,
          provider: "codex",
          model: input.model,
          workingDirectory: input.worktree,
          diagnosticLogPath: input.logFile,
        },
      );
    }
    const controller = new AbortController();
    const relayAbort = () => controller.abort(input.signal.reason);
    if (input.signal.aborted) relayAbort();
    else input.signal.addEventListener("abort", relayAbort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error("Agent Attempt timed out")),
      input.timeoutMs,
    );
    let result: Awaited<ReturnType<SandcastleRun>>;
    let recoveryAttempt = 0;
    try {
      for (;;) {
        await this.logPrompt(input.logFile, prompt);
        try {
          result = await this.run({
            agent: codex(input.model, { effort: input.effort }),
            sandbox: noSandbox({
              env: { GIT_CONFIG_GLOBAL: input.gitConfigGlobal },
            }),
            cwd: input.worktree,
            prompt,
            maxIterations: 1,
            completionSignal: [],
            idleTimeoutSeconds: input.timeoutMs / 1000,
            branchStrategy: { type: "head" },
            logging: { type: "file", path: input.logFile },
            output: Output.object({
              tag,
              schema,
              maxRetries: 1,
            }),
            ...(resumeSession === undefined ? {} : { resumeSession }),
            signal: controller.signal,
          });
        } catch (error) {
          if (input.resumePrompt !== undefined) {
            throw new AgentOutputError(
              "Provider session unavailable or unrecoverable for continuation",
              {
                errorCategory: "agent_attempt",
                retryable: false,
                provider: "codex",
                model: input.model,
                workingDirectory: input.worktree,
                diagnosticLogPath: input.logFile,
                raw: error instanceof Error ? error.message : String(error),
              },
            );
          }
          throw error;
        }
        const sessionId = result.iterations.at(-1)?.sessionId;
        if (sessionId) this.sessions.set(input.logFile, sessionId);
        const openingTags = result.stdout.split(`<${tag}>`).length - 1;
        const closingTags = result.stdout.split(`</${tag}>`).length - 1;
        if (openingTags !== 0 || closingTags !== 0 || recoveryAttempt === 4)
          break;
        const backoff = [10_000, 20_000, 40_000, 80_000][recoveryAttempt]!;
        await this.logStatus(
          input.logFile,
          `Waiting ${backoff / 1000} seconds before automatic prompt continuation (retry ${recoveryAttempt + 1}/4).`,
        );
        await this.wait(backoff, input.signal);
        recoveryAttempt += 1;
        prompt = "continue";
        resumeSession = this.sessions.get(input.logFile) ?? resumeSession;
      }
    } finally {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", relayAbort);
    }
    const openingTags = result.stdout.split(`<${tag}>`).length - 1;
    const closingTags = result.stdout.split(`</${tag}>`).length - 1;
    const sessionId = result.iterations.at(-1)?.sessionId;
    if (sessionId) this.sessions.set(input.logFile, sessionId);
    const assistantReply = result.stdout.trim() || undefined;
    const previousAssistantReply = this.replies.get(input.logFile);
    if (assistantReply) this.replies.set(input.logFile, assistantReply);
    const diagnostics: AgentDiagnostics = {
      ...(input.promptArgs.OPERATION === undefined
        ? {}
        : { operation: input.promptArgs.OPERATION.toString() }),
      errorCategory: "agent_attempt",
      attemptOrdinal: 1,
      retryable: true,
      ...(input.promptArgs.RUN_ID === undefined
        ? {}
        : { runId: input.promptArgs.RUN_ID.toString() }),
      provider: "codex",
      model: input.model,
      workingDirectory: input.worktree,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(assistantReply === undefined ? {} : { assistantReply }),
      ...(previousAssistantReply === undefined
        ? {}
        : { previousAssistantReply }),
      diagnosticLogPath: input.logFile,
      raw: result.stdout,
    };
    if (
      (openingTags !== 1 || closingTags !== 1) &&
      result.iterations.length === 1
    )
      throw new AgentOutputError(
        "Agent Attempt output must contain exactly one result tag",
        diagnostics,
      );
    if (typeof result.output === "object" && result.output !== null) {
      Object.defineProperty(result.output, "diagnostics", {
        value: diagnostics,
        enumerable: false,
        configurable: true,
      });
    }
    return result.output as T;
  }

  execute(input: Parameters<AgentExecutor["execute"]>[0]) {
    return this.runOutput(
      input,
      "agent_attempt_result",
      resultSchema(input.pullRequestMetadata),
    );
  }

  executeReview(input: Parameters<AgentExecutor["executeReview"]>[0]) {
    return this.runOutput(input, "review_attempt_result", reviewResultSchema());
  }
}
