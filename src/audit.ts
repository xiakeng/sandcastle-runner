import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface AuditEvent {
  timestamp: string;
  runId: string;
  project: string;
  parentTicket: number;
  phase: string;
  operation: string;
  target: string;
  attempt: number;
  result: string | null;
  error: string | null;
  agentAttemptId?: string;
  diagnosticLogPath?: string;
  transition?: string;
  diagnostics?: object;
}

export class AuditLog {
  readonly path: string;

  constructor(
    projectDirectory: string,
    timestamp: string,
    parentTicket: number,
    runId: string,
  ) {
    const safeTimestamp = timestamp.replaceAll(":", "-");
    this.path = path.join(
      projectDirectory,
      "logs",
      `${safeTimestamp}-parent-${parentTicket}-${runId}.jsonl`,
    );
  }

  async create(): Promise<void> {
    await mkdir(path.dirname(this.path), { recursive: true });
    await appendFile(this.path, "");
  }

  async append(event: AuditEvent): Promise<void> {
    await appendFile(this.path, `${JSON.stringify(event)}\n`);
  }
}
