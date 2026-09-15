import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";

import type {
  NoSandboxProvider,
  SandboxExecOptions,
  InteractiveExecOptions,
} from "@ai-hero/sandcastle";

import { formatToolError } from "./process-errors.ts";

function shouldEscapeCommandCharacter(character: string | undefined): boolean {
  return (
    character !== undefined &&
    (character === '"' ||
      character === "'" ||
      character === "\\" ||
      /\s/u.test(character))
  );
}

function commandArgs(command: string): [string, ...string[]] {
  const trimmed = command.trim();
  const args: string[] = [];
  let value = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index]!;
    if (escaped) {
      value += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      if (shouldEscapeCommandCharacter(trimmed[index + 1])) escaped = true;
      else value += "\\";
    } else if (quote !== "" && character === quote) {
      quote = "";
    } else if (quote === "") {
      if (character === "'" || character === '"') quote = character;
      else if (/\s/u.test(character)) {
        if (value !== "") {
          args.push(value);
          value = "";
        }
      } else value += character;
    } else value += character;
  }
  if (escaped) value += "\\";
  if (quote !== "") throw new Error("invalid Codex command quoting");
  if (value !== "") args.push(value);
  if (args.length === 0) throw new Error("empty Codex command");
  return args as [string, ...string[]];
}

function isWindowsShim(file: string): boolean {
  return /\.(?:bat|cmd)$/iu.test(file);
}

function resolveWindowsCommand(
  file: string,
  env: Record<string, string | undefined>,
): string {
  if (/[\\/]/u.test(file) || /\.[^\\/]+$/u.test(file)) return file;
  const path = env.PATH ?? "";
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((extension) => extension !== "");
  for (const directory of path.split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${file}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return file;
}

function spawnCommand(
  file: string,
  args: string[],
  env: Record<string, string | undefined>,
): { file: string; args: string[] } {
  if (process.platform !== "win32") return { file, args };
  const executable = resolveWindowsCommand(file, env);
  if (!isWindowsShim(executable)) return { file: executable, args };
  const comspec = env.ComSpec ?? env.COMSPEC ?? "cmd.exe";
  return {
    file: comspec,
    args: ["/d", "/s", "/c", executable, ...args],
  };
}

export function noShellSandbox(
  options: {
    env?: Record<string, string>;
  } = {},
): NoSandboxProvider {
  return {
    tag: "none",
    name: "no-sandbox",
    env: options.env ?? {},
    create: ({
      worktreePath,
      env,
    }: {
      worktreePath: string;
      env: Record<string, string>;
    }) => {
      const processEnv = { ...process.env, ...env };
      return Promise.resolve({
        worktreePath,
        exec: (command: string, execOptions: SandboxExecOptions = {}) => {
          const [file, ...args] = commandArgs(command);
          const launched = spawnCommand(file, args, processEnv);
          const child = spawn(launched.file, launched.args, {
            cwd: execOptions.cwd ?? worktreePath,
            env: processEnv,
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
          });
          if (execOptions.stdin !== undefined) {
            child.stdin.write(execOptions.stdin);
          }
          child.stdin.end();
          return new Promise((resolve, reject) => {
            let stdout = "";
            let stderr = "";
            const readline = execOptions.onLine
              ? createInterface({ input: child.stdout })
              : undefined;
            if (execOptions.onLine) readline?.on("line", execOptions.onLine);
            child.stdout.on("data", (chunk: Buffer) => {
              stdout += chunk.toString();
            });
            child.stderr.on("data", (chunk: Buffer) => {
              stderr += chunk.toString();
            });
            child.once("error", (error) => {
              reject(new Error(formatToolError(file, error)));
            });
            child.once("close", (exitCode) => {
              readline?.close();
              resolve({ stdout, stderr, exitCode: exitCode ?? 0 });
            });
          });
        },
        interactiveExec: async (
          args: string[],
          execOptions: InteractiveExecOptions,
        ) =>
          new Promise((resolve, reject) => {
            const [file, ...commandArgsForSpawn] = args;
            const launched = spawnCommand(
              file!,
              commandArgsForSpawn,
              processEnv,
            );
            const child: ChildProcess = spawn(launched.file, launched.args, {
              cwd: execOptions.cwd ?? worktreePath,
              env: processEnv,
              shell: false,
              stdio: [
                execOptions.stdin as never,
                execOptions.stdout as never,
                execOptions.stderr as never,
              ],
            });
            child.once("error", (error) =>
              reject(new Error(formatToolError(args[0]!, error))),
            );
            child.once("close", (exitCode) =>
              resolve({ exitCode: exitCode ?? 0 }),
            );
          }),
        close: () => Promise.resolve(),
      });
    },
  } as NoSandboxProvider;
}
