import type {
  CodeHost,
  PullRequestIdentity,
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
}

function pullRequest(value: string): PullRequestIdentity {
  const url = value.trim();
  const match = /\/pull\/(\d+)\/?$/u.exec(url);
  if (!match) throw new Error("GitHub returned invalid Pull Request identity");
  return { number: Number(match[1]), url };
}
