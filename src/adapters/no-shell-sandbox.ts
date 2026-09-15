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

function commandArgs(command: string): [string, ...string[]] {
  const trimmed = command.trim();
  const args: string[] = [];
  let value = "";
  let quote = "";
  let escaped = false;
  let windowsPath = false;
  for (const character of trimmed) {
    if (escaped) {
      value += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      if (windowsPath) {
        value += "\\";
      } else {
        escaped = true;
      }
    } else if (quote !== "" && character === quote) {
      quote = "";
      windowsPath = false;
    } else if (quote === "") {
      if (character === "'" || character === '"') quote = character;
      else if (/\s/u.test(character)) {
        if (value !== "") {
          args.push(value);
          value = "";
          windowsPath = false;
        }
      } else {
        value += character;
      }
    } else {
      value += character;
      windowsPath ||= quote === '"' && /^[A-Za-z]:$/.test(value);
    }
  }
  if (escaped) throw new Error("invalid Codex command quoting");
  if (quote !== "") throw new Error("invalid Codex command quoting");
  if (value !== "") args.push(value);
  if (args.length === 0) throw new Error("empty Codex command");
  return args as [string, ...string[]];
}

function isWindowsShim(file: string): boolean {
  return /\.(?:bat|cmd)$/iu.test(file);
}

function quoteWindowsCommandArg(value: string): string {
  if (/["%!\r\n]/u.test(value))
    throw new Error("unsupported Windows shim argument");
  let result = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
    } else if (character === '"') {
      result += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      result += "\\".repeat(backslashes) + character;
      backslashes = 0;
    }
  }
  return result + "\\".repeat(backslashes * 2) + '"';
}

function environmentValue(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const entries = Object.entries(env);
  for (const [key, value] of entries.reverse()) {
    if (key.toLowerCase() === name.toLowerCase()) return value;
  }
  return undefined;
}

function resolveWindowsCommand(
  file: string,
  env: Record<string, string | undefined>,
): string {
  if (/[\\/]/u.test(file) || /\.[^\\/]+$/u.test(file)) return file;
  const path = environmentValue(env, "PATH") ?? "";
  const extensions = (environmentValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
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
  const comspec = environmentValue(env, "COMSPEC") ?? "cmd.exe";
  const command = [executable, ...args].map(quoteWindowsCommandArg).join(" ");
  return {
    file: comspec,
    args: ["/d", "/s", "/c", command],
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
