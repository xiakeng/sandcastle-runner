import { execFile } from "node:child_process";

export interface GitHubCommandOptions {
  token: string;
  timeout: number;
}

export type GitHubCommand = (
  args: string[],
  options: GitHubCommandOptions,
) => Promise<string>;

const runGitHubCommand: GitHubCommand = (args, { token, timeout }) =>
  new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      {
        encoding: "utf8",
        env: { ...process.env, GH_TOKEN: token },
        maxBuffer: 10 * 1024 * 1024,
        timeout,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const detail = (stderr.trim() || error.message).replaceAll(
          token,
          "[redacted]",
        );
        reject(new Error(`gh command failed: ${detail}`));
      },
    );
  });

export class GitHubClient {
  private readonly token: string;
  private readonly command: GitHubCommand;

  constructor(token: string, command: GitHubCommand = runGitHubCommand) {
    this.token = token;
    this.command = command;
  }

  request(args: string[]): Promise<string> {
    return this.command(args, { token: this.token, timeout: 60_000 });
  }
}
