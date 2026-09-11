export type TicketState = "open" | "closed";
export type ClosureReason = "completed" | "not_planned" | null;
export type TicketClosurePolicy = "runner" | "code_host";

export interface Ticket {
  number: number;
  state: TicketState;
  stateReason: ClosureReason;
  repository?: string;
  assignees?: string[];
  labels?: string[];
  title?: string;
  body?: string;
  source?: string;
}

export interface ChildPage {
  children: Ticket[];
  nextPage: number | null;
}

export interface BlockerPage {
  blockers: Ticket[];
  nextPage: number | null;
}

export interface LabelPage {
  labels: string[];
  nextPage: number | null;
}

export interface Tracker {
  getParent(repository: string, parentTicket: number): Promise<Ticket>;
  listChildrenPage(
    repository: string,
    parentTicket: number,
    page: number,
  ): Promise<ChildPage>;
  getTicket(repository: string, ticket: number): Promise<Ticket>;
  listBlockersPage(
    repository: string,
    ticket: number,
    page: number,
  ): Promise<BlockerPage>;
  listLabelsPage(repository: string, page: number): Promise<LabelPage>;
  createLabel(repository: string, label: string): Promise<void>;
  createMaintenanceTicket(
    repository: string,
    title: string,
    body: string,
    label: string,
  ): Promise<Ticket>;
  addLabel(repository: string, ticket: number, label: string): Promise<void>;
  addAssignee(
    repository: string,
    ticket: number,
    assignee: string,
  ): Promise<void>;
  removeLabel(repository: string, ticket: number, label: string): Promise<void>;
  removeAssignee(
    repository: string,
    ticket: number,
    assignee: string,
  ): Promise<void>;
  closeTicket(repository: string, ticket: number): Promise<void>;
  closeParent(repository: string, parentTicket: number): Promise<void>;
}

export interface CodeHost {
  resolveTargetBranch(repository: string): Promise<string>;
  createPullRequest(input: {
    repository: string;
    targetBranch: string;
    branch: string;
    title: string;
    body: string;
  }): Promise<PullRequestIdentity>;
  getRemoteBranchHead(
    repository: string,
    branch: string,
  ): Promise<string | null>;
  listPullRequests(repository: string): Promise<PullRequestRecord[]>;
  getRequiredChecks(
    repository: string,
    pullRequest: number,
  ): Promise<RequiredCheck[]>;
  getPullRequest(
    repository: string,
    pullRequest: number,
  ): Promise<PullRequestState>;
  requestSquashMerge(input: {
    repository: string;
    pullRequest: number;
    headSha: string;
    admin: boolean;
  }): Promise<MergeRequestResult>;
}

export interface PullRequestRecord extends PullRequestIdentity {
  branch: string;
  targetBranch: string;
  headSha: string;
  state: "open" | "closed" | "merged";
}

export interface PullRequestIdentity {
  number: number;
  url: string;
}

export interface PullRequestState {
  headSha: string;
  createdAt: string;
  merged: boolean;
  mergeFailure: string | null;
}

export type MergeRequestResult =
  | { outcome: "accepted" }
  | { outcome: "conflict"; error: string }
  | { outcome: "rejected"; error: string };

export interface RequiredCheck {
  name: string;
  state: string;
  link: string;
  bucket: "pass" | "fail" | "pending" | "skipping" | "cancel";
}

export function parseRequiredChecks(
  value: unknown,
  errorMessage: string,
): RequiredCheck[] {
  if (!Array.isArray(value)) throw new Error(errorMessage);
  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      throw new Error(errorMessage);
    const check = item as Record<string, unknown>;
    if (
      typeof check.name !== "string" ||
      typeof check.state !== "string" ||
      typeof check.link !== "string" ||
      !["pass", "fail", "pending", "skipping", "cancel"].includes(
        String(check.bucket),
      )
    ) {
      throw new Error(errorMessage);
    }
    return {
      name: check.name,
      state: check.state,
      link: check.link,
      bucket: check.bucket as RequiredCheck["bucket"],
    };
  });
}

export interface CommitEvidence {
  sha: string;
  message: string;
}

export interface CheckEvidence {
  command: string;
  status: "passed" | "failed" | "not_run";
  details: string;
}

export interface WorkspaceEvidence {
  worktree: string;
  branch: string;
  base: string;
  commits: CommitEvidence[];
  clean: boolean;
}

export interface SourceSnapshot {
  source: string;
  content: string;
}

export interface ReviewWorkspaceEvidence {
  clean: boolean;
  deliveryCommits: CommitEvidence[];
  reviewCommits: CommitEvidence[];
}

export interface GitWorkspace {
  fetchTargetBranch(checkout: string, targetBranch: string): Promise<string>;
  createWorktree(input: {
    checkout: string;
    worktree: string;
    branch: string;
    base: string;
  }): Promise<void>;
  inspect(input: {
    worktree: string;
    base: string;
    requiredAncestor?: string;
  }): Promise<WorkspaceEvidence>;
  readReviewStandards(
    worktree: string,
    base: string,
  ): Promise<SourceSnapshot[]>;
  inspectReview(input: {
    worktree: string;
    base: string;
    implementationHead: string;
  }): Promise<ReviewWorkspaceEvidence>;
  push(worktree: string, branch: string): Promise<void>;
}

export interface AgentAttemptResult {
  outcome: "committed" | "no_change" | "blocked";
  summary: string;
  commits: CommitEvidence[];
  checks: CheckEvidence[];
  blocker: string | null;
  pr_title?: string;
  pr_body?: string;
}

export interface AgentAttemptInput {
  ticket: number;
  worktree: string;
  branch: string;
  base: string;
  promptFile: string;
  promptArgs: Record<string, string | number>;
  pullRequestMetadata: "required" | "required_for_committed" | "ignored";
  model: string;
  effort: "low" | "medium" | "high" | "xhigh";
  gitConfigGlobal: string;
  logFile: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface ReviewVerdict {
  verdict: "passed" | "blocked";
  unresolved_findings: string[];
}

export interface ReviewAttemptResult {
  outcome: "passed" | "blocked";
  summary: string;
  standards: ReviewVerdict;
  spec: ReviewVerdict;
  checks: CheckEvidence[];
  blocker: string | null;
}

export type ReviewAttemptInput = Omit<AgentAttemptInput, "pullRequestMetadata">;

export interface AgentExecutor {
  execute(input: AgentAttemptInput): Promise<AgentAttemptResult>;
  executeReview(input: ReviewAttemptInput): Promise<ReviewAttemptResult>;
}

export interface Clock {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
}

export interface OperatorIO {
  write(message: string): void;
  pause(message: string): Promise<string | null>;
}
