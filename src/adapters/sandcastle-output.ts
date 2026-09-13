import type {
  AgentAttemptInput,
  AgentAttemptResult,
  CheckEvidence,
  CommitEvidence,
  ReviewAttemptResult,
  ReviewVerdict,
} from "../run/contracts.ts";

export interface StandardSchema<T> {
  "~standard": {
    version: 1;
    vendor: string;
    validate(value: unknown): { value: T } | { issues: { message: string }[] };
  };
}

export function pullRequestMetadataRule(
  metadata: AgentAttemptInput["pullRequestMetadata"],
): string {
  if (metadata === "required")
    return "pr_title and pr_body are required complete non-empty strings; the Runner will use them later to create the Pull Request, even if this attempt does not create one; inspect the target repository's contribution and Pull Request documentation and follow its title and body conventions when generating both fields";
  if (metadata === "required_for_committed")
    return "when outcome is committed, include pr_title and pr_body as complete non-empty strings because the Runner will use them later to create the Pull Request, even if this attempt does not create one; inspect the target repository's contribution and Pull Request documentation and follow its title and body conventions when generating both fields; omit both otherwise";
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

export function formatStructuredCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  if (Array.isArray(cause)) return cause.map(formatStructuredCause).join("; ");
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  )
    return cause.message;
  try {
    return JSON.stringify(cause) ?? String(cause);
  } catch {
    return String(cause);
  }
}

function assertExactFields(
  input: Record<string, unknown>,
  expected: string[],
  name: string,
): void {
  const missing = expected.filter((field) => !(field in input));
  const unexpected = Object.keys(input).filter(
    (field) => !expected.includes(field),
  );
  if (missing.length === 0 && unexpected.length === 0) return;
  const details = [
    ...(missing.length === 0 ? [] : [`missing fields: ${missing.join(", ")}`]),
    ...(unexpected.length === 0
      ? []
      : [`unexpected fields: ${unexpected.join(", ")}`]),
  ];
  throw new Error(`${name} has invalid fields; ${details.join("; ")}`);
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
  assertExactFields(input, expected, "Agent Attempt Result");
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

export function resultSchema(
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
  assertExactFields(input, expected, "Review Attempt Result");
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

export function reviewResultSchema(): StandardSchema<ReviewAttemptResult> {
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
