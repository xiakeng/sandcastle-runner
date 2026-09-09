import type {
  ChildPage,
  ClosureReason,
  Ticket,
  Tracker,
} from "../run/contracts.ts";
import { GitHubClient, type GitHubCommand } from "./github-client.ts";

function parseTicket(value: unknown, includeRepository: boolean): Ticket {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub returned an invalid issue");
  }
  const issue = value as Record<string, unknown>;
  if (!Number.isSafeInteger(issue.number) || (issue.number as number) <= 0) {
    throw new Error("GitHub issue has no valid number");
  }
  if (issue.state !== "open" && issue.state !== "closed") {
    throw new Error("GitHub issue has an unsupported state");
  }
  let stateReason: ClosureReason = null;
  if (issue.state === "closed") {
    if (
      issue.state_reason !== null &&
      issue.state_reason !== "completed" &&
      issue.state_reason !== "not_planned"
    ) {
      throw new Error("GitHub issue has an unsupported closure reason");
    }
    stateReason = issue.state_reason;
  }
  const ticket: Ticket = {
    number: issue.number as number,
    state: issue.state,
    stateReason,
  };
  if (includeRepository) {
    if (typeof issue.repository_url !== "string") {
      throw new Error("GitHub child has no repository URL");
    }
    const marker = "/repos/";
    const markerIndex = issue.repository_url.lastIndexOf(marker);
    if (
      markerIndex < 0 ||
      issue.repository_url.slice(markerIndex + marker.length).split("/")
        .length !== 2
    ) {
      throw new Error("GitHub child has an invalid repository URL");
    }
    ticket.repository = issue.repository_url.slice(markerIndex + marker.length);
  }
  return ticket;
}

export class GitHubTracker implements Tracker {
  private readonly client: GitHubClient;

  constructor(token: string, command?: GitHubCommand) {
    this.client = new GitHubClient(token, command);
  }

  async getParent(repository: string, parentTicket: number): Promise<Ticket> {
    return parseTicket(
      JSON.parse(
        await this.client.request([
          "api",
          "--method",
          "GET",
          `repos/${repository}/issues/${parentTicket}`,
        ]),
      ) as unknown,
      false,
    );
  }

  async listChildrenPage(
    repository: string,
    parentTicket: number,
    page: number,
  ): Promise<ChildPage> {
    const value = JSON.parse(
      await this.client.request([
        "api",
        "--method",
        "GET",
        `repos/${repository}/issues/${parentTicket}/sub_issues`,
        "-f",
        "per_page=100",
        "-f",
        `page=${page}`,
      ]),
    ) as unknown;
    if (!Array.isArray(value))
      throw new Error("GitHub returned an invalid child page");
    return {
      children: value.map((child) => parseTicket(child, true)),
      nextPage: value.length === 100 ? page + 1 : null,
    };
  }

  async closeParent(repository: string, parentTicket: number): Promise<void> {
    await this.client.request([
      "api",
      "--method",
      "PATCH",
      `repos/${repository}/issues/${parentTicket}`,
      "-f",
      "state=closed",
      "-f",
      "state_reason=completed",
    ]);
  }
}
