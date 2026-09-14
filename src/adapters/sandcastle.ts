import {
  codex,
  Output,
  StructuredOutputError,
  run as runSandcastle,
  type RunOptions,
  type RunResult,
} from "@ai-hero/sandcastle";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  formatStructuredCause,
  pullRequestMetadataRule,
  replacePromptPlaceholders,
  resultSchema,
  reviewResultSchema,
  type StandardSchema,
} from "./sandcastle-output.ts";
import type {
  AgentAttemptInput,
  AgentDiagnostics,
  AgentExecutor,
  ReviewAttemptInput,
} from "../run/contracts.ts";
import { OperatorCancelled } from "../run/operations.ts";
import { noShellSandbox } from "./no-shell-sandbox.ts";

type SandcastleRun = (
  options: RunOptions,
) => Promise<RunResult & { output: unknown }>;

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

function isAgentProcessFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^codex exited with code \d+(?::|$)/u.test(error.message)
  );
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

  private async waitForContinuation(
    input: ReviewAttemptInput,
    recoveryAttempt: number,
    timeoutSignal: AbortSignal,
  ): Promise<number | undefined> {
    const backoff = [10_000, 20_000, 40_000, 80_000][recoveryAttempt]!;
    await this.logStatus(
      input.logFile,
      `Waiting ${backoff / 1000} seconds before automatic prompt continuation (retry ${recoveryAttempt + 1}/4).`,
    );
    let resolveTimeout!: () => void;
    const timeout = new Promise<void>((resolve) => {
      resolveTimeout = () => resolve();
      if (timeoutSignal.aborted) resolve();
      else
        timeoutSignal.addEventListener("abort", resolveTimeout, {
          once: true,
        });
    });
    try {
      await Promise.race([this.wait(backoff, input.signal), timeout]);
    } catch (error) {
      if (error instanceof OperatorCancelled) throw error;
      if (input.signal.aborted) return undefined;
      throw error;
    } finally {
      timeoutSignal.removeEventListener("abort", resolveTimeout);
    }
    return timeoutSignal.aborted ? undefined : recoveryAttempt + 1;
  }

  private agentFailure(
    input: ReviewAttemptInput,
    resumeSession: string | undefined,
    error: unknown,
  ): AgentOutputError {
    const diagnostics: AgentDiagnostics = {
      errorCategory: "agent_attempt",
      attemptOrdinal: 1,
      retryable: input.resumePrompt !== undefined ? false : true,
      provider: "codex",
      model: input.model,
      workingDirectory: input.worktree,
      ...(resumeSession === undefined ? {} : { sessionId: resumeSession }),
      diagnosticLogPath: input.logFile,
      raw: error instanceof Error ? error.message : String(error),
    };
    return new AgentOutputError(
      input.resumePrompt !== undefined
        ? "Provider session unavailable or unrecoverable for continuation"
        : error instanceof Error
          ? error.message
          : String(error),
      diagnostics,
    );
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
          sandbox: noShellSandbox({
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
    const pullRequestMetadata =
      "pullRequestMetadata" in input
        ? (input as AgentAttemptInput).pullRequestMetadata
        : "ignored";
    const outputPrompt = replacePromptPlaceholders(
      await readFile(
        join(
          runnerPromptDirectory,
          tag === "review_attempt_result"
            ? "review-attempt-output.md"
            : "agent-attempt-output.md",
        ),
        "utf8",
      ),
      {
        PULL_REQUEST_METADATA_RULE:
          pullRequestMetadataRule(pullRequestMetadata),
      },
    ).trim();
    if (prompt === undefined) {
      resumeSession ??= await this.prepareSession(input);
      const template = replacePromptPlaceholders(
        await readFile(input.promptFile, "utf8"),
        {
          ...input.promptArgs,
          SOURCE_BRANCH: input.branch,
          TARGET_BRANCH: String(input.targetBranch),
        },
      );
      prompt = `${template.trimEnd()}\n\n${outputPrompt}`;
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
    let structuredRetryRemaining = 1;
    try {
      for (;;) {
        const normalizedPrompt = prompt.trimEnd();
        const runPrompt = normalizedPrompt.endsWith(outputPrompt)
          ? prompt
          : `${normalizedPrompt}\n\n${outputPrompt}`;
        await this.logPrompt(input.logFile, runPrompt);
        try {
          result = await this.run({
            agent: codex(input.model, { effort: input.effort }),
            sandbox: noShellSandbox({
              env: { GIT_CONFIG_GLOBAL: input.gitConfigGlobal },
            }),
            cwd: input.worktree,
            prompt: runPrompt,
            maxIterations: 1,
            completionSignal: [],
            idleTimeoutSeconds: input.timeoutMs / 1000,
            branchStrategy: { type: "head" },
            logging: { type: "file", path: input.logFile },
            output: Output.object({
              tag,
              schema,
              maxRetries: 0,
            }),
            ...(resumeSession === undefined ? {} : { resumeSession }),
            signal: controller.signal,
          });
        } catch (error) {
          if (error instanceof StructuredOutputError) {
            await this.logStatus(
              input.logFile,
              `Structured output validation failed; retryRemaining=${structuredRetryRemaining}; raw=${error.rawMatched ?? "<none>"}; issues=${formatStructuredCause(error.cause)}`,
            );
            if (structuredRetryRemaining > 0 && error.sessionId !== undefined) {
              structuredRetryRemaining -= 1;
              prompt = [
                `The previous structured output failed validation. Specific validation errors: ${formatStructuredCause(error.cause)}`,
                "Re-emit exactly one corrected result using the complete output protocol below.",
                outputPrompt,
              ].join("\n\n");
              resumeSession = error.sessionId;
              await this.logStatus(
                input.logFile,
                `Starting structured output retry; retryRemaining=${structuredRetryRemaining}; resumeSession=${error.sessionId}`,
              );
              continue;
            }
            const recovered = this.recoverStructuredOutput(error, schema);
            if (recovered !== undefined) {
              await this.logStatus(
                input.logFile,
                "Recovered the final structured output from the retry result.",
              );
              const diagnostics = this.structuredDiagnostics(input, error);
              Object.defineProperty(recovered, "diagnostics", {
                value: diagnostics,
                enumerable: false,
                configurable: true,
              });
              return recovered;
            }
            const diagnostics = this.structuredDiagnostics(input, error);
            diagnostics.error =
              formatStructuredCause(error.cause) || error.message;
            throw new AgentOutputError(error.message, diagnostics);
          }
          if (
            input.signal.aborted &&
            error === input.signal.reason &&
            error instanceof OperatorCancelled
          )
            throw error;
          if (
            !controller.signal.aborted &&
            !input.signal.aborted &&
            isAgentProcessFailure(error) &&
            resumeSession !== undefined &&
            recoveryAttempt < 4
          ) {
            const nextRecoveryAttempt = await this.waitForContinuation(
              input,
              recoveryAttempt,
              controller.signal,
            );
            if (nextRecoveryAttempt === undefined)
              throw this.agentFailure(
                input,
                resumeSession,
                controller.signal.reason ?? error,
              );
            recoveryAttempt = nextRecoveryAttempt;
            prompt = "continue";
            resumeSession = this.sessions.get(input.logFile) ?? resumeSession;
            continue;
          }
          throw this.agentFailure(input, resumeSession, error);
        }
        const sessionId = result.iterations.at(-1)?.sessionId;
        if (sessionId) this.sessions.set(input.logFile, sessionId);
        const openingTags = result.stdout.split(`<${tag}>`).length - 1;
        const closingTags = result.stdout.split(`</${tag}>`).length - 1;
        if (openingTags !== 0 || closingTags !== 0 || recoveryAttempt === 4)
          break;
        const nextRecoveryAttempt = await this.waitForContinuation(
          input,
          recoveryAttempt,
          controller.signal,
        );
        if (nextRecoveryAttempt === undefined)
          throw this.agentFailure(
            input,
            resumeSession,
            controller.signal.reason,
          );
        recoveryAttempt = nextRecoveryAttempt;
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

  private recoverStructuredOutput<T>(
    error: StructuredOutputError,
    schema: StandardSchema<T>,
  ): T | undefined {
    if (error.rawMatched === undefined) return undefined;
    try {
      const parsed = JSON.parse(error.rawMatched.trim()) as unknown;
      const validation = schema["~standard"].validate(parsed);
      return "value" in validation ? validation.value : undefined;
    } catch {
      return undefined;
    }
  }

  private structuredDiagnostics(
    input: ReviewAttemptInput,
    error: StructuredOutputError,
  ): AgentDiagnostics {
    return {
      ...(input.promptArgs.OPERATION === undefined
        ? {}
        : { operation: input.promptArgs.OPERATION.toString() }),
      errorCategory: "agent_attempt",
      attemptOrdinal: 1,
      retryable: true,
      provider: "codex",
      model: input.model,
      workingDirectory: input.worktree,
      ...(error.sessionId === undefined ? {} : { sessionId: error.sessionId }),
      diagnosticLogPath: input.logFile,
      ...(error.rawMatched === undefined ? {} : { raw: error.rawMatched }),
    };
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
