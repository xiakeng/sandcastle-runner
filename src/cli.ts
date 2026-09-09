#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import path from "node:path";

import { SystemClock } from "./adapters/clock.ts";
import { LocalGitWorkspace } from "./adapters/git-workspace.ts";
import { GitHubCodeHost } from "./adapters/github-code-host.ts";
import { GitHubTracker } from "./adapters/github-tracker.ts";
import { SandcastleAgentExecutor } from "./adapters/sandcastle.ts";
import { TerminalOperator } from "./adapters/terminal.ts";
import { AuditLog } from "./audit.ts";
import { loadProject } from "./config.ts";
import type {
  AgentExecutor,
  Clock,
  CodeHost,
  GitWorkspace,
  OperatorIO,
  Tracker,
} from "./run/contracts.ts";
import { OperatorCancelled, supervisedAuditWrite } from "./run/operations.ts";
import { runProject, type RunSummary } from "./run/run.ts";

export interface CliDependencies {
  root: string;
  env: Record<string, string | undefined>;
  tracker?: Tracker;
  codeHost?: CodeHost;
  gitWorkspace?: GitWorkspace;
  agentExecutor?: AgentExecutor;
  clock: Clock;
  operator: OperatorIO;
}

export interface CliResult {
  exitCode: number;
  summary: RunSummary;
  logPath: string | null;
}

function parseArguments(argv: string[]): {
  project: string;
  parentTicket: number;
} {
  if (
    argv.length !== 5 ||
    argv[0] !== "run" ||
    argv[1] !== "--project" ||
    argv[3] !== "--parent"
  ) {
    throw new Error(
      "usage: sandcastle-runner run --project <project-key> --parent <issue-number>",
    );
  }
  const project = argv[2];
  const parentTicket = Number(argv[4]);
  if (!project || !Number.isSafeInteger(parentTicket) || parentTicket <= 0) {
    throw new Error("project and a positive Parent Ticket number are required");
  }
  return { project, parentTicket };
}

export async function executeCli(
  argv: string[],
  dependencies: CliDependencies,
): Promise<CliResult> {
  let project: string;
  let parentTicket: number;
  try {
    ({ project, parentTicket } = parseArguments(argv));
  } catch (error) {
    const summary: RunSummary = {
      outcome: "failed",
      project: argv[2] ?? "unknown",
      parentTicket: 0,
      targetBranch: "unresolved",
      reasons: [
        error instanceof Error ? error.message : "invalid CLI arguments",
      ],
    };
    dependencies.operator.write(JSON.stringify(summary));
    return { exitCode: 1, summary, logPath: null };
  }
  let loaded: Awaited<ReturnType<typeof loadProject>>;
  try {
    loaded = await loadProject(dependencies.root, project, dependencies.env);
  } catch (error) {
    const summary: RunSummary = {
      outcome: "failed",
      project,
      parentTicket,
      targetBranch: "unresolved",
      reasons: [
        error instanceof Error ? error.message : "startup validation failed",
      ],
    };
    dependencies.operator.write(JSON.stringify(summary));
    return { exitCode: 1, summary, logPath: null };
  }
  const runId = randomUUID();
  const timestamp = dependencies.clock.now().toISOString();
  const audit = new AuditLog(loaded.directory, timestamp, parentTicket, runId);
  const tracker =
    dependencies.tracker ?? new GitHubTracker(loaded.trackerToken);
  const codeHost =
    dependencies.codeHost ?? new GitHubCodeHost(loaded.codeHostToken);
  const gitWorkspace = dependencies.gitWorkspace ?? new LocalGitWorkspace();
  const agentExecutor =
    dependencies.agentExecutor ?? new SandcastleAgentExecutor();
  let summary: RunSummary;
  try {
    await supervisedAuditWrite(() => audit.create(), dependencies.operator);
    summary = await runProject({
      project,
      parentTicket,
      repository: loaded.config.repository,
      ...(loaded.config.targetBranch === undefined
        ? {}
        : { configuredTargetBranch: loaded.config.targetBranch }),
      runId,
      audit,
      tracker,
      codeHost,
      clock: dependencies.clock,
      operator: dependencies.operator,
      runnerAccount: loaded.config.tracker.runnerAccount,
      reservationLabel: loaded.config.tracker.reservationLabel,
      checkout: loaded.config.checkout,
      projectDirectory: loaded.directory,
      implementationPrompt: path.join(
        loaded.directory,
        "prompts",
        "implement.md",
      ),
      implementationAgent: loaded.config.agents.implement,
      agentTimeoutMs: loaded.config.timeouts.agentMinutes * 60_000,
      gitWorkspace,
      agentExecutor,
    });
  } catch (error) {
    summary = {
      outcome: error instanceof OperatorCancelled ? "cancelled" : "failed",
      project,
      parentTicket,
      targetBranch: loaded.config.targetBranch ?? "unresolved",
      reasons: [
        error instanceof OperatorCancelled
          ? "operator cancelled"
          : error instanceof Error
            ? error.message
            : "Run failed",
      ],
    };
  }
  dependencies.operator.write(JSON.stringify(summary));
  return {
    exitCode:
      summary.outcome === "succeeded" || summary.outcome === "no_work" ? 0 : 1,
    summary,
    logPath: audit.path,
  };
}

if (import.meta.main) {
  const result = await executeCli(process.argv.slice(2), {
    root: path.resolve(import.meta.dirname, ".."),
    env: process.env,
    clock: new SystemClock(),
    operator: new TerminalOperator(),
  });
  process.exitCode = result.exitCode;
}
