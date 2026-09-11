import {
  codex,
  Output,
  run as runSandcastle,
  type RunOptions,
  type RunResult,
} from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";

import type {
  AgentAttemptResult,
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
  private readonly sessions = new Map<string, string>();

  constructor(run: SandcastleRun = runSandcastle as SandcastleRun) {
    this.run = run;
  }

  private async runOutput<T>(
    input: ReviewAttemptInput,
    tag: string,
    schema: StandardSchema<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const relayAbort = () => controller.abort(input.signal.reason);
    if (input.signal.aborted) relayAbort();
    else input.signal.addEventListener("abort", relayAbort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error("Agent Attempt timed out")),
      input.timeoutMs,
    );
    timeout.unref();
    let result: Awaited<ReturnType<SandcastleRun>>;
    try {
      result = await this.run({
        agent: codex(input.model, { effort: input.effort }),
        sandbox: noSandbox({
          env: { GIT_CONFIG_GLOBAL: input.gitConfigGlobal },
        }),
        cwd: input.worktree,
        ...(input.resumePrompt === undefined
          ? { promptFile: input.promptFile }
          : { prompt: input.resumePrompt }),
        promptArgs: input.promptArgs,
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
        ...(input.resumePrompt === undefined ||
        this.sessions.get(input.logFile) === undefined
          ? {}
          : { resumeSession: this.sessions.get(input.logFile)! }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", relayAbort);
    }
    const openingTags = result.stdout.split(`<${tag}>`).length - 1;
    const closingTags = result.stdout.split(`</${tag}>`).length - 1;
    if (
      (openingTags !== 1 || closingTags !== 1) &&
      result.iterations.length === 1
    )
      throw new Error(
        "Agent Attempt output must contain exactly one result tag",
      );
    const sessionId = result.iterations.at(-1)?.sessionId;
    if (sessionId) this.sessions.set(input.logFile, sessionId);
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
