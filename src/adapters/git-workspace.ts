import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { CommitEvidence, GitWorkspace } from "../run/contracts.ts";

export type GitCommand = (
  cwd: string,
  args: string[],
  timeout: number,
) => Promise<string>;

const runGitCommand: GitCommand = (cwd, args, timeout) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout },
      (error, stdout, stderr) => {
        if (!error) resolve(stdout);
        else reject(new Error((stderr.trim() || error.message).trim()));
      },
    );
  });

function sha(value: string): string {
  const result = value.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(result))
    throw new Error("Git returned an invalid commit SHA");
  return result;
}

function commits(value: string): CommitEvidence[] {
  if (value.trim() === "") return [];
  return value
    .trimEnd()
    .split("\n")
    .map((line) => {
      const separator = line.indexOf("\0");
      if (separator < 0)
        throw new Error("Git returned invalid commit evidence");
      return {
        sha: sha(line.slice(0, separator)),
        message: line.slice(separator + 1),
      };
    });
}

export class LocalGitWorkspace implements GitWorkspace {
  private readonly command: GitCommand;

  constructor(command: GitCommand = runGitCommand) {
    this.command = command;
  }

  async fetchTargetBranch(
    checkout: string,
    targetBranch: string,
  ): Promise<string> {
    await this.command(
      checkout,
      ["fetch", "--no-tags", "origin", targetBranch],
      60_000,
    );
    return sha(
      await this.command(checkout, ["rev-parse", "FETCH_HEAD"], 60_000),
    );
  }

  async createWorktree(input: {
    checkout: string;
    worktree: string;
    branch: string;
    base: string;
  }): Promise<void> {
    await mkdir(path.dirname(input.worktree), { recursive: true });
    await this.command(
      input.checkout,
      ["worktree", "add", "-b", input.branch, input.worktree, input.base],
      60_000,
    );
  }

  async inspect({ worktree, base }: { worktree: string; base: string }) {
    const [actualPath, branch, actualBase, commitList, status] =
      await Promise.all([
        this.command(worktree, ["rev-parse", "--show-toplevel"], 60_000),
        this.command(worktree, ["branch", "--show-current"], 60_000),
        this.command(worktree, ["merge-base", base, "HEAD"], 60_000),
        this.command(
          worktree,
          ["log", "--reverse", "--format=%H%x00%s", `${base}..HEAD`],
          60_000,
        ),
        this.command(worktree, ["status", "--porcelain"], 60_000),
      ]);
    return {
      worktree: path.resolve(actualPath.trim()),
      branch: branch.trim(),
      base: sha(actualBase),
      commits: commits(commitList),
      clean: status === "",
    };
  }
}
