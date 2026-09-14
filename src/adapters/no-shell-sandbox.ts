import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import type {
  NoSandboxProvider,
  SandboxExecOptions,
  InteractiveExecOptions,
} from "@ai-hero/sandcastle";

import { formatToolError } from "./process-errors.ts";

function commandArgs(command: string): [string, ...string[]] {
  const args: string[] = [];
  let value = "";
  let quote = "";
  let escaped = false;
  for (const character of command.trim()) {
    if (escaped) {
      value += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
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
  if (escaped || quote !== "") throw new Error("invalid Codex command quoting");
  if (value !== "") args.push(value);
  if (args.length === 0) throw new Error("empty Codex command");
  return args as [string, ...string[]];
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
          const child = spawn(file, args, {
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
            const child: ChildProcess = spawn(args[0]!, args.slice(1), {
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
