import type { AuditEvent, AuditLog } from "../audit.ts";
import type { AgentConfig } from "../config.ts";
import type { VerifiedHandoff } from "./attempt.ts";
import type {
  AgentExecutor,
  Clock,
  CodeHost,
  GitWorkspace,
  OperatorIO,
  RetryPolicy,
  TicketClosurePolicy,
  Tracker,
} from "./contracts.ts";
import type { PullRequestObservation } from "./pull-request.ts";
import type { MaintenanceState, PublicationIntent } from "../recovery.ts";
import type { CleanupRecord } from "./cleanup.ts";

export type RunOutcome =
  "succeeded" | "no_work" | "incomplete" | "cancelled" | "failed";

export interface RunSummary {
  outcome: RunOutcome;
  project: string;
  parentTicket: number;
  issueTicket?: number;
  targetBranch: string;
  reasons: string[];
  batch?: number[];
  handoffs?: VerifiedHandoff[];
  pullRequests?: PullRequestObservation[];
  completedTickets?: number[];
}

export interface RunInput {
  project: string;
  parentTicket: number;
  issueTicket?: number;
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
  checkout: string;
  projectDirectory: string;
  implementationPrompt: string;
  implementationAgent: AgentConfig;
  review: boolean;
  reviewPrompt: string;
  reviewAgent?: AgentConfig;
  ciRepairPrompt: string;
  ciRepairAgent: AgentConfig;
  conflictRepairPrompt: string;
  conflictRepairAgent: AgentConfig;
  documentationMaintenance: boolean;
  documentationPrompt: string;
  documentationAgent?: AgentConfig;
  maintenanceTicket: { title: string; body: string; label: string };
  agentTimeoutMs: number;
  requiredChecksTimeoutMs: number;
  mergeQueueTimeoutMs: number;
  adminMerge: boolean;
  ticketClosure: TicketClosurePolicy;
  retryPolicy: RetryPolicy;
  gitWorkspace: GitWorkspace;
  agentExecutor: AgentExecutor;
  persistPublication?: (
    ticket: number,
    intent: PublicationIntent | null,
  ) => Promise<void>;
  persistBatch?: (batch: number[], completed: number[]) => Promise<void>;
  recoveredPublications?: PublicationIntent[];
  recoveredBatch?: number[];
  recoveredCompletedDeliveries?: number[];
  persistCleanup?: (ticket: number, record: CleanupRecord) => Promise<void>;
  recoveredCleanup?: Record<string, CleanupRecord>;
  persistMaintenance?: (state: MaintenanceState) => Promise<void>;
  recoveredMaintenance?: MaintenanceState;
}

export function createEvent(input: RunInput) {
  return (phase: string, operation: string, target: string) =>
    (attempt: number): Omit<AuditEvent, "result" | "error"> => ({
      timestamp: input.clock.now().toISOString(),
      runId: input.runId,
      project: input.project,
      parentTicket: input.parentTicket,
      phase,
      operation,
      target,
      attempt,
    });
}
