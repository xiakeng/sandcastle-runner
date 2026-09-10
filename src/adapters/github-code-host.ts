import type {
  CodeHost,
  MergeRequestResult,
  PullRequestIdentity,
  PullRequestState,
  PullRequestRecord,
  RequiredCheck,
} from "../run/contracts.ts";
import { parseRequiredChecks } from "../run/contracts.ts";
import { GitHubClient, type GitHubCommand } from "./github-client.ts";

export class GitHubCodeHost implements CodeHost {
  private readonly client: GitHubClient;

  constructor(token: string, command?: GitHubCommand) {
    this.client = new GitHubClient(token, command);
  }

  async resolveTargetBranch(repository: string): Promise<string> {
    const value = JSON.parse(
      await this.client.request([
        "api",
        "--method",
        "GET",
        `repos/${repository}`,
      ]),
    ) as { default_branch?: unknown };
    if (
      typeof value.default_branch !== "string" ||
      value.default_branch.length === 0
    ) {
      throw new Error("GitHub response has no Target Branch");
    }
    return value.default_branch;
  }

  async createPullRequest(input: {
    repository: string;
    targetBranch: string;
    branch: string;
    title: string;
    body: string;
  }): Promise<PullRequestIdentity> {
    return pullRequest(
      await this.client.request([
        "pr",
        "create",
        "--repo",
        input.repository,
        "--base",
        input.targetBranch,
        "--head",
        input.branch,
        "--title",
        input.title,
        "--body",
        input.body,
      ]),
    );
  }

  async getRemoteBranchHead(
    repository: string,
    branch: string,
  ): Promise<string | null> {
    try {
      const value = JSON.parse(
        await this.client.request([
          "api",
          `repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
        ]),
      ) as { object?: { sha?: unknown } };
      return typeof value.object?.sha === "string" ? value.object.sha : null;
    } catch (error) {
      if (error instanceof Error && /404|not found/iu.test(error.message))
        return null;
      throw error;
    }
  }

  async listPullRequests(repository: string): Promise<PullRequestRecord[]> {
    const value = JSON.parse(
      await this.client.request([
        "pr",
        "list",
        "--repo",
        repository,
        "--state",
        "all",
        "--json",
        "number,url,headRefName,baseRefName,headRefOid,state",
        "--limit",
        "1000",
      ]),
    ) as unknown;
    if (!Array.isArray(value))
      throw new Error("GitHub returned invalid Pull Requests");
    return value.map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item))
        throw new Error("GitHub returned invalid Pull Request");
      const row = item as Record<string, unknown>;
      if (
        !Number.isSafeInteger(row.number) ||
        typeof row.url !== "string" ||
        typeof row.headRefName !== "string" ||
        typeof row.baseRefName !== "string" ||
        typeof row.headRefOid !== "string" ||
        !["OPEN", "CLOSED", "MERGED"].includes(String(row.state))
      )
        throw new Error("GitHub returned invalid Pull Request");
      return {
        number: row.number as number,
        url: row.url,
        branch: row.headRefName,
        targetBranch: row.baseRefName,
        headSha: row.headRefOid,
        state: String(row.state).toLowerCase() as PullRequestRecord["state"],
      };
    });
  }

  async getRequiredChecks(
    repository: string,
    pullRequestNumber: number,
  ): Promise<RequiredCheck[]> {
    const value = JSON.parse(
      await this.client.request(
        [
          "pr",
          "checks",
          String(pullRequestNumber),
          "--repo",
          repository,
          "--required",
          "--json",
          "name,state,link,bucket",
        ],
        [1, 8],
      ),
    ) as unknown;
    return parseRequiredChecks(
      value,
      "GitHub returned invalid required-check evidence",
    );
  }

  async getPullRequest(
    repository: string,
    pullRequestNumber: number,
  ): Promise<PullRequestState> {
    const value = JSON.parse(
      await this.client.request([
        "pr",
        "view",
        String(pullRequestNumber),
        "--repo",
        repository,
        "--json",
        "headRefOid,createdAt,state,mergedAt",
      ]),
    ) as Record<string, unknown>;
    if (
      typeof value.headRefOid !== "string" ||
      value.headRefOid.length === 0 ||
      typeof value.createdAt !== "string" ||
      value.createdAt.length === 0 ||
      (value.state !== "OPEN" &&
        value.state !== "CLOSED" &&
        value.state !== "MERGED") ||
      (value.mergedAt !== null && typeof value.mergedAt !== "string")
    ) {
      throw new Error("GitHub returned invalid Pull Request state");
    }
    const merged = value.state === "MERGED" || value.mergedAt !== null;
    return {
      headSha: value.headRefOid,
      createdAt: value.createdAt,
      merged,
      mergeFailure:
        value.state === "CLOSED" && !merged
          ? `Pull Request ${pullRequestNumber} closed without merging`
          : null,
    };
  }

  async requestSquashMerge(input: {
    repository: string;
    pullRequest: number;
    headSha: string;
    admin: boolean;
  }): Promise<MergeRequestResult> {
    try {
      await this.client.request([
        "pr",
        "merge",
        String(input.pullRequest),
        "--repo",
        input.repository,
        "--squash",
        "--match-head-commit",
        input.headSha,
        ...(input.admin ? ["--admin"] : []),
      ]);
      return { outcome: "accepted" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "merge rejected";
      return /conflict|cannot be cleanly created/iu.test(message)
        ? { outcome: "conflict", error: message }
        : { outcome: "rejected", error: message };
    }
  }
}

function pullRequest(value: string): PullRequestIdentity {
  const url = value.trim();
  const match = /\/pull\/(\d+)\/?$/u.exec(url);
  if (!match) throw new Error("GitHub returned invalid Pull Request identity");
  return { number: Number(match[1]), url };
}
