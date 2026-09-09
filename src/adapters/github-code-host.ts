import type { CodeHost } from "../run/contracts.ts";
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
}
