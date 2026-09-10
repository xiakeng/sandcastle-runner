import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { CommitEvidence, GitWorkspace } from "../run/contracts.ts";

export type GitCommand = (
  cwd: string,
  args: string[],
  options: {
    timeout: number;
    env?: Record<string, string>;
  },
) => Promise<string>;

const runGitCommand: GitCommand = (cwd, args, { timeout, env = {} }) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        env: { ...process.env, ...env },
        maxBuffer: 10 * 1024 * 1024,
        timeout,
      },
      (error, stdout, stderr) => {
        if (!error) resolve(stdout);
        else {
          let detail = (stderr.trim() || error.message).trim();
          for (const value of Object.values(env))
            detail = detail.replaceAll(value, "[redacted]");
          reject(new Error(detail));
        }
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
  private readonly token: string;
  private readonly command: GitCommand;

  constructor(token: string, command: GitCommand = runGitCommand) {
    this.token = token;
    this.command = command;
  }

  private remote(cwd: string, args: string[]): Promise<string> {
    return this.command(
      cwd,
      ["-c", "credential.helper=!gh auth git-credential", ...args],
      { timeout: 60_000, env: { GH_TOKEN: this.token } },
    );
  }

  async fetchTargetBranch(
    checkout: string,
    targetBranch: string,
  ): Promise<string> {
    await this.remote(checkout, ["fetch", "--no-tags", "origin", targetBranch]);
    return sha(
      await this.command(checkout, ["rev-parse", "FETCH_HEAD"], {
        timeout: 60_000,
      }),
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
      { timeout: 60_000 },
    );
  }

  async inspect({
    worktree,
    base,
    requiredAncestor,
  }: {
    worktree: string;
    base: string;
    requiredAncestor?: string;
  }) {
    const [actualPath, branch, actualBase, commitList, status] =
      await Promise.all([
        this.command(worktree, ["rev-parse", "--show-toplevel"], {
          timeout: 60_000,
        }),
        this.command(worktree, ["branch", "--show-current"], {
          timeout: 60_000,
        }),
        this.command(worktree, ["merge-base", base, "HEAD"], {
          timeout: 60_000,
        }),
        this.command(
          worktree,
          [
            "log",
            ...(requiredAncestor ? ["--first-parent"] : []),
            "--reverse",
            "--format=%H%x00%s",
            `${base}..HEAD`,
          ],
          { timeout: 60_000 },
        ),
        this.command(worktree, ["status", "--porcelain"], {
          timeout: 60_000,
        }),
        ...(requiredAncestor
          ? [
              this.command(
                worktree,
                ["merge-base", "--is-ancestor", requiredAncestor, "HEAD"],
                { timeout: 60_000 },
              ),
            ]
          : []),
      ]);
    return {
      worktree: path.resolve(actualPath.trim()),
      branch: branch.trim(),
      base: sha(actualBase),
      commits: commits(commitList),
      clean: status === "",
    };
  }

  async push(worktree: string, branch: string): Promise<void> {
    await this.remote(worktree, ["push", "origin", branch]);
  }

  async readReviewStandards(worktree: string, base: string) {
    const [changed, instructionFiles] = await Promise.all([
      this.command(worktree, ["diff", "--name-only", `${base}..HEAD`], {
        timeout: 60_000,
      }),
      this.command(worktree, ["ls-files", "AGENTS.md", ":(glob)**/AGENTS.md"], {
        timeout: 60_000,
      }),
    ]);
    const changedFiles = changed.trim().split("\n").filter(Boolean);
    const applicable = instructionFiles
      .trim()
      .split("\n")
      .filter(Boolean)
      .filter((filename) => {
        const directory = path.posix.dirname(filename);
        return (
          directory === "." ||
          changedFiles.some((changedFile) =>
            changedFile.startsWith(`${directory}/`),
          )
        );
      });
    return Promise.all(
      applicable.map(async (filename) => ({
        source: path.join(worktree, filename),
        content: await readFile(path.join(worktree, filename), "utf8"),
      })),
    );
  }

  async inspectReview({
    worktree,
    base,
    implementationHead,
  }: {
    worktree: string;
    base: string;
    implementationHead: string;
  }) {
    const [status, deliveryCommits, reviewCommits] = await Promise.all([
      this.command(worktree, ["status", "--porcelain"], { timeout: 60_000 }),
      this.command(
        worktree,
        ["log", "--reverse", "--format=%H%x00%s", `${base}..HEAD`],
        { timeout: 60_000 },
      ),
      this.command(
        worktree,
        [
          "log",
          "--reverse",
          "--format=%H%x00%s",
          `${implementationHead}..HEAD`,
        ],
        { timeout: 60_000 },
      ),
    ]);
    return {
      clean: status === "",
      deliveryCommits: commits(deliveryCommits),
      reviewCommits: commits(reviewCommits),
    };
  }
}
