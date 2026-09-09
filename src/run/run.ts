import type { AuditLog } from "../audit.ts";
import type { Clock, CodeHost, OperatorIO, Tracker } from "./contracts.ts";
import { discoverAndReserve } from "./discovery.ts";
import { externalRead, workflowWrite } from "./operations.ts";

export type RunOutcome =
  "succeeded" | "no_work" | "incomplete" | "cancelled" | "failed";

export interface RunSummary {
  outcome: RunOutcome;
  project: string;
  parentTicket: number;
  targetBranch: string;
  reasons: string[];
  batch?: number[];
}

interface RunInput {
  project: string;
  parentTicket: number;
  repository: string;
  configuredTargetBranch?: string;
  runId: string;
  audit: AuditLog;
  tracker: Tracker;
  codeHost: CodeHost;
  clock: Clock;
  operator: OperatorIO;
  runnerAccount: string;
  reservationLabel: string;
}

export async function runProject(input: RunInput): Promise<RunSummary> {
  const event =
    (phase: string, operation: string, target: string) =>
    (attempt: number) => ({
      timestamp: input.clock.now().toISOString(),
      runId: input.runId,
      project: input.project,
      parentTicket: input.parentTicket,
      phase,
      operation,
      target,
      attempt,
    });
  const targetBranch =
    input.configuredTargetBranch ??
    (await externalRead({
      action: () => input.codeHost.resolveTargetBranch(input.repository),
      parseOverride: (value) => {
        const parsed = JSON.parse(value) as { targetBranch?: unknown };
        if (
          typeof parsed.targetBranch !== "string" ||
          parsed.targetBranch.length === 0
        ) {
          throw new Error("override has no Target Branch");
        }
        return parsed.targetBranch;
      },
      audit: input.audit,
      event: event("startup", "resolve_target_branch", input.repository),
      clock: input.clock,
      operator: input.operator,
    }));

  const discovery = await discoverAndReserve({
    repository: input.repository,
    parentTicket: input.parentTicket,
    tracker: input.tracker,
    audit: input.audit,
    clock: input.clock,
    operator: input.operator,
    event,
    runnerAccount: input.runnerAccount,
    reservationLabel: input.reservationLabel,
  });
  if (discovery.outcome === "close_parent") {
    await workflowWrite({
      action: () =>
        input.tracker.closeParent(input.repository, input.parentTicket),
      audit: input.audit,
      event: () =>
        event(
          "close_parent",
          "close_parent",
          `parent:${input.parentTicket}`,
        )(1),
      operator: input.operator,
    });
    return {
      outcome: "succeeded",
      project: input.project,
      parentTicket: input.parentTicket,
      targetBranch,
      reasons: [],
    };
  }
  return {
    ...discovery,
    project: input.project,
    parentTicket: input.parentTicket,
    targetBranch,
  };
}
