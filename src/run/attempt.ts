import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AuditEvent } from "../audit.ts";
import type { AgentConfig } from "../config.ts";
import type {
  AgentAttemptResult,
  AgentExecutor,
  CommitEvidence,
  GitWorkspace,
} from "./contracts.ts";
import {
  type DeliveryBoundaryResult,
  type DiscoveryInput,
  revalidateReservedDeliveryTicket,
} from "./discovery.ts";
import {
  externalRead,
  OperatorCancelled,
  pauseForOperator,
  supervisedAuditWrite,
  workflowWrite,
} from "./operations.ts";

export interface VerifiedHandoff {
  ticket: number;
  worktree: string;
  branch: string;
  base: string;
  commits: CommitEvidence[];
  checks: AgentAttemptResult["checks"];
  prTitle: string;
  prBody: string;
  verification: "verified" | "operator_override";
}

interface AttemptInput extends DiscoveryInput {
  batch: number[];
  runId: string;
  checkout: string;
  targetBranch: string;
  projectDirectory: string;
  promptFile: string;
  agent: AgentConfig;
  timeoutMs: number;
  gitWorkspace: GitWorkspace;
  agentExecutor: AgentExecutor;
}

export interface AttemptBatchResult {
  outcome: "incomplete" | "cancelled" | "failed";
  reasons: string[];
  handoffs: VerifiedHandoff[];
}

class BoundaryStop extends Error {
  readonly result: Exclude<DeliveryBoundaryResult, { outcome: "ready" }>;

  constructor(result: Exclude<DeliveryBoundaryResult, { outcome: "ready" }>) {
    super(result.reason);
    this.result = result;
  }
}

function fullSha(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40,64}$/u.test(value))
    throw new Error("override has no full base SHA");
  return value;
}

async function appendOperation(
  input: AttemptInput,
  event: Omit<AuditEvent, "result" | "error">,
  result: string,
  error: string | null,
): Promise<void> {
  await supervisedAuditWrite(
    () => input.audit.append({ ...event, result, error }),
    input.operator,
  );
}

async function boundary(input: AttemptInput, ticket: number): Promise<void> {
  const result = await revalidateReservedDeliveryTicket(input, ticket);
  if (result.outcome !== "ready") throw new BoundaryStop(result);
}

function sameCommits(
  claimed: CommitEvidence[],
  actual: CommitEvidence[],
): boolean {
  return (
    claimed.length === actual.length &&
    claimed.every(
      (commit, index) =>
        commit.sha === actual[index]?.sha &&
        commit.message === actual[index]?.message,
    )
  );
}

function trustedHandoff(
  value: string,
  ticket: number,
  worktree: string,
  branch: string,
  base: string,
): VerifiedHandoff {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  if (
    parsed.outcome !== "committed" ||
    typeof parsed.pr_title !== "string" ||
    parsed.pr_title.trim() === "" ||
    typeof parsed.pr_body !== "string" ||
    parsed.pr_body.trim() === ""
  ) {
    throw new Error("override has no downstream PR metadata");
  }
  return {
    ticket,
    worktree,
    branch,
    base,
    commits: [],
    checks: [],
    prTitle: parsed.pr_title,
    prBody: parsed.pr_body,
    verification: "operator_override",
  };
}

async function runAgentOperation(
  input: AttemptInput,
  ticket: number,
  worktree: string,
  branch: string,
  base: string,
  signal: AbortSignal,
): Promise<VerifiedHandoff | string> {
  let attemptNumber = 0;
  for (;;) {
    await boundary(input, ticket);
    attemptNumber += 1;
    const attemptId = randomUUID();
    const event = input.event(
      "implement",
      "agent_attempt",
      `ticket:${ticket}`,
    )(attemptNumber);
    await appendOperation(input, event, "started", null);
    try {
      const gitDirectory = await mkdtemp(
        path.join(tmpdir(), "sandcastle-runner-git-"),
      );
      let result: AgentAttemptResult;
      try {
        const gitConfigGlobal = path.join(gitDirectory, "config");
        await writeFile(gitConfigGlobal, "");
        result = await input.agentExecutor.execute({
          ticket,
          worktree,
          branch,
          base,
          promptFile: input.promptFile,
          promptArgs: {
            TICKET_NUMBER: ticket,
            TICKET_REFERENCE: `${input.repository}#${ticket}`,
            IMPLEMENT_SKILL: "$implement",
            WORKTREE_PATH: worktree,
            BRANCH: branch,
            BASE_SHA: base,
            TARGET_BRANCH: input.targetBranch,
          },
          model: input.agent.model,
          effort: input.agent.reasoningEffort,
          gitConfigGlobal,
          logFile: path.join(
            input.projectDirectory,
            "logs",
            `agent-${ticket}-${attemptId}.log`,
          ),
          timeoutMs: input.timeoutMs,
          signal,
        });
      } finally {
        await rm(gitDirectory, { recursive: true, force: true });
      }

      if (result.outcome === "blocked") {
        await appendOperation(input, event, "blocked", null);
        return `Delivery Ticket ${ticket} blocked: ${result.blocker}`;
      }
      await boundary(input, ticket);
      const observed = await input.gitWorkspace.inspect({ worktree, base });
      if (
        observed.worktree !== path.resolve(worktree) ||
        observed.branch !== branch ||
        observed.base !== base ||
        !observed.clean
      ) {
        throw new Error("Agent Attempt left mismatched or dirty Git state");
      }
      if (result.outcome === "no_change") {
        if (observed.commits.length !== 0)
          throw new Error("no_change left new commits");
        await appendOperation(input, event, "no_change", null);
        return `Delivery Ticket ${ticket} no_change: ${result.summary}`;
      }
      if (
        observed.commits.length === 0 ||
        !sameCommits(result.commits, observed.commits)
      ) {
        throw new Error("Agent commit claims do not match Git evidence");
      }
      const handoff: VerifiedHandoff = {
        ticket,
        worktree,
        branch,
        base,
        commits: observed.commits,
        checks: result.checks,
        prTitle: result.pr_title,
        prBody: result.pr_body,
        verification: "verified",
      };
      await appendOperation(input, event, "succeeded", null);
      return handoff;
    } catch (error) {
      if (error instanceof BoundaryStop) {
        await appendOperation(input, event, error.result.outcome, null);
        throw error;
      }
      await appendOperation(
        input,
        event,
        "failed",
        error instanceof Error ? error.message : "Agent Attempt failed",
      );
      for (;;) {
        const response = await pauseForOperator(
          input.audit,
          event,
          input.operator,
          "Agent Attempt failed. Enter to retry, q to cancel, or supply a trusted committed result.",
        );
        if (response === "") break;
        try {
          const handoff = trustedHandoff(
            response,
            ticket,
            worktree,
            branch,
            base,
          );
          await appendOperation(input, event, "operator_override", null);
          return handoff;
        } catch {
          await appendOperation(input, event, "invalid_override", null);
        }
      }
    }
  }
}

async function implementTicket(
  input: AttemptInput,
  ticket: number,
  base: string,
  controller: AbortController,
): Promise<VerifiedHandoff | string> {
  try {
    await boundary(input, ticket);
    const branch = `sandcastle/run-${input.runId}/ticket-${ticket}`;
    const worktree = path.join(
      input.projectDirectory,
      "worktrees",
      input.runId,
      `ticket-${ticket}`,
    );
    await workflowWrite({
      action: () =>
        input.gitWorkspace.createWorktree({
          checkout: input.checkout,
          worktree,
          branch,
          base,
        }),
      audit: input.audit,
      event: () =>
        input.event(
          "prepare_worktrees",
          "create_worktree",
          `ticket:${ticket}`,
        )(1),
      operator: input.operator,
    });
    return await runAgentOperation(
      input,
      ticket,
      worktree,
      branch,
      base,
      controller.signal,
    );
  } catch (error) {
    if (error instanceof BoundaryStop && error.result.outcome === "stopped")
      return error.result.reason;
    throw error;
  }
}

export async function implementReservedBatch(
  input: AttemptInput,
): Promise<AttemptBatchResult> {
  const candidates: number[] = [];
  const stopped: string[] = [];
  try {
    for (const ticket of input.batch) {
      try {
        await boundary(input, ticket);
        candidates.push(ticket);
      } catch (error) {
        if (!(error instanceof BoundaryStop)) throw error;
        if (
          error.result.outcome === "cancelled" ||
          error.result.outcome === "failed"
        )
          throw error;
        stopped.push(error.result.reason);
      }
    }
    if (candidates.length === 0)
      return { outcome: "incomplete", reasons: stopped, handoffs: [] };
    const base = await externalRead({
      action: () =>
        input.gitWorkspace.fetchTargetBranch(
          input.checkout,
          input.targetBranch,
        ),
      parseOverride: (value) => {
        const parsed = JSON.parse(value) as { base?: unknown };
        return fullSha(parsed.base);
      },
      audit: input.audit,
      event: input.event(
        "prepare_worktrees",
        "fetch_target_branch",
        input.targetBranch,
      ),
      clock: input.clock,
      operator: input.operator,
    });
    const controller = new AbortController();
    const attempts = candidates.map((ticket) =>
      implementTicket(input, ticket, base, controller),
    );
    try {
      const settled = await Promise.all(attempts);
      const handoffs = settled.filter(
        (result): result is VerifiedHandoff => typeof result !== "string",
      );
      return {
        outcome: "incomplete",
        handoffs,
        reasons: [
          ...stopped,
          ...settled.filter(
            (result): result is string => typeof result === "string",
          ),
          ...(handoffs.length > 0
            ? [
                `Verified Handoffs awaiting publication: ${handoffs.map(({ ticket }) => ticket).join(", ")}`,
              ]
            : []),
        ],
      };
    } catch (error) {
      controller.abort(error);
      await Promise.allSettled(attempts);
      throw error;
    }
  } catch (error) {
    if (error instanceof BoundaryStop) {
      return {
        outcome: error.result.outcome === "cancelled" ? "cancelled" : "failed",
        reasons: [error.result.reason],
        handoffs: [],
      };
    }
    if (error instanceof OperatorCancelled) throw error;
    throw error;
  }
}
