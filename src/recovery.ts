import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const recoverySchemaVersion = 1;

export type PublicationPhase =
  "pending_push" | "pushed" | "pending_pr" | "pr_created";

export interface PublicationIntent {
  ticket: number;
  kind: "delivery" | "maintenance";
  originalBase: string;
  targetBranch: string;
  stableBranch: string;
  intendedHeadSha: string;
  title: string;
  body: string;
  phase: PublicationPhase;
  implementationEvidence: unknown;
  reviewEvidence: unknown;
  completionEvidence: unknown;
  pullRequest?: { number: number; url: string; headSha: string };
  repairBudgets?: {
    ci?: RepairState;
    conflict?: RepairState;
  };
  repairState?: {
    purpose?: "ci" | "conflict";
    consumed: number;
    generation: number;
    attempt: number;
    base?: string;
    worktree?: string;
    branch?: string;
    attemptId?: string;
    targetBase?: string;
    head?: string;
    pendingPush?: string;
  };
}

export interface RepairState {
  purpose?: "ci" | "conflict";
  consumed: number;
  generation: number;
  attempt: number;
  base?: string;
  worktree?: string;
  branch?: string;
  attemptId?: string;
  targetBase?: string;
  head?: string;
  pendingPush?: string;
}

export type PublicationReconciliation =
  | { outcome: "restart"; reason: string }
  | { outcome: "adopt"; reason: string }
  | { outcome: "pause"; reason: string };

export type PullRequestReconciliation =
  | { outcome: "restart"; reason: string }
  | {
      outcome: "adopt";
      reason: string;
      pullRequest: {
        number: number;
        url: string;
        branch: string;
        targetBranch: string;
        headSha: string;
        state: "open" | "closed" | "merged";
      };
    }
  | { outcome: "pause"; reason: string };

export function reconcileInitialPush(
  intent: PublicationIntent,
  remoteHead: string | null,
): PublicationReconciliation {
  if (remoteHead === null)
    return { outcome: "restart", reason: "stable remote branch is absent" };
  if (remoteHead === intent.intendedHeadSha)
    return { outcome: "adopt", reason: "remote branch matches intended head" };
  return {
    outcome: "pause",
    reason: `stable remote branch head ${remoteHead} does not match intended head ${intent.intendedHeadSha}`,
  };
}

export function reconcilePullRequest(
  intent: PublicationIntent,
  candidates: {
    number: number;
    url: string;
    branch: string;
    targetBranch: string;
    headSha: string;
    state: "open" | "closed" | "merged";
  }[],
): PullRequestReconciliation {
  const matches = candidates.filter(
    (candidate) =>
      candidate.branch === intent.stableBranch &&
      candidate.targetBranch === intent.targetBranch &&
      candidate.headSha === intent.intendedHeadSha,
  );
  const identityCandidates = candidates.filter(
    (candidate) =>
      candidate.branch === intent.stableBranch ||
      (candidate.targetBranch === intent.targetBranch &&
        candidate.headSha === intent.intendedHeadSha),
  );
  if (identityCandidates.length > matches.length)
    return {
      outcome: "pause",
      reason: "Pull Request identity or head mismatch",
    };
  if (matches.length === 1)
    return {
      outcome: "adopt",
      reason: `adopted Pull Request ${matches[0]!.number}`,
      pullRequest: matches[0]!,
    };
  if (matches.length > 1)
    return {
      outcome: "pause",
      reason: "multiple matching Pull Requests found",
    };
  if (identityCandidates.length > 0)
    return {
      outcome: "pause",
      reason: "Pull Request identity or head mismatch",
    };
  return { outcome: "restart", reason: "no matching Pull Request exists" };
}

export interface RecoverySnapshot {
  schemaVersion: number;
  project: string;
  repository: string;
  checkout: string;
  parentTicket: number;
  runId: string;
  phase: string;
  targetBranch: string | null;
  createdAt: string;
  updatedAt: string;
  batch?: number[];
  completedDeliveries?: number[];
  publications?: PublicationIntent[];
  [key: string]: unknown;
}

export class InvalidRecoverySnapshot extends Error {}

export function recoveryPaths(projectDirectory: string, parentTicket: number) {
  const stateDirectory = path.join(projectDirectory, "state");
  return {
    stateDirectory,
    snapshot: path.join(stateDirectory, `parent-${parentTicket}.json`),
    lock: path.join(stateDirectory, `parent-${parentTicket}.lock`),
  };
}

export class ParentLock {
  private readonly filename: string;
  private readonly holder: ChildProcessWithoutNullStreams;
  private readonly closed: Promise<void>;

  private constructor(
    filename: string,
    holder: ChildProcessWithoutNullStreams,
  ) {
    this.filename = filename;
    this.holder = holder;
    this.closed = new Promise((resolve) =>
      holder.once("close", () => resolve()),
    );
  }

  static async acquire(
    filename: string,
    metadata: object,
  ): Promise<ParentLock> {
    await mkdir(path.dirname(filename), { recursive: true });
    const handle = await open(filename, "a+", 0o600);
    await handle.close();
    await chmod(filename, 0o600);
    const holder = spawn("flock", ["-n", filename, "-c", "printf ready; cat"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const onExit = (code: number | null) => {
        reject(
          new Error(
            code === 1
              ? `Parent Ticket lock is already held: ${filename}`
              : `unable to hold Parent Ticket lock: ${filename}`,
          ),
        );
      };
      holder.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("ready")) {
          holder.removeListener("exit", onExit);
          resolve();
        }
      });
      holder.once("error", reject);
      holder.once("exit", onExit);
    });
    try {
      await writeFile(filename, JSON.stringify(metadata), "utf8");
      return new ParentLock(filename, holder);
    } catch (error) {
      holder.kill();
      throw error;
    }
  }

  async release(): Promise<void> {
    if (!this.holder.killed) this.holder.kill();
    await this.closed;
  }
}

function parseSnapshot(value: unknown): RecoverySnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidRecoverySnapshot("recovery snapshot must be an object");
  }
  const snapshot = value as Record<string, unknown>;
  if (snapshot.schemaVersion !== recoverySchemaVersion) {
    throw new InvalidRecoverySnapshot("unsupported recovery snapshot schema");
  }
  for (const field of [
    "project",
    "repository",
    "checkout",
    "runId",
    "phase",
    "createdAt",
    "updatedAt",
  ]) {
    if (typeof snapshot[field] !== "string" || snapshot[field] === "") {
      throw new InvalidRecoverySnapshot(`snapshot is missing ${field}`);
    }
  }
  if (
    !Number.isSafeInteger(snapshot.parentTicket) ||
    (snapshot.parentTicket as number) <= 0
  ) {
    throw new InvalidRecoverySnapshot("snapshot has no Parent Ticket");
  }
  if (
    snapshot.targetBranch !== null &&
    typeof snapshot.targetBranch !== "string"
  ) {
    throw new InvalidRecoverySnapshot("snapshot has an invalid Target Branch");
  }
  if (snapshot.publications !== undefined) {
    if (!Array.isArray(snapshot.publications))
      throw new InvalidRecoverySnapshot("snapshot has invalid publications");
    const tickets = new Set<number>();
    for (const publication of snapshot.publications) {
      if (!isPublicationIntent(publication))
        throw new InvalidRecoverySnapshot(
          "snapshot has an incomplete publication",
        );
      if (tickets.has(publication.ticket))
        throw new InvalidRecoverySnapshot(
          "snapshot has duplicate publication tickets",
        );
      tickets.add(publication.ticket);
    }
  }
  for (const field of ["batch", "completedDeliveries"] as const) {
    const value = snapshot[field];
    if (
      value !== undefined &&
      (!Array.isArray(value) ||
        value.some((ticket) => !Number.isSafeInteger(ticket) || ticket <= 0))
    ) {
      throw new InvalidRecoverySnapshot(`snapshot has invalid ${field}`);
    }
  }
  return snapshot as RecoverySnapshot;
}

function isPublicationIntent(value: unknown): value is PublicationIntent {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const publication = value as Record<string, unknown>;
  const completion = publication.completionEvidence as Record<
    string,
    unknown
  > | null;
  const pullRequest = publication.pullRequest as Record<string, unknown> | null;
  const repairState = publication.repairState as
    Record<string, unknown> | undefined;
  const repairBudgets = publication.repairBudgets as
    Record<string, unknown> | null | undefined;
  const validRepairState = (value: unknown): boolean => {
    if (value === undefined) return true;
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return false;
    const state = value as Record<string, unknown>;
    return (
      Number.isSafeInteger(state.consumed) &&
      (state.consumed as number) >= 0 &&
      Number.isSafeInteger(state.generation) &&
      (state.generation as number) >= 0 &&
      Number.isSafeInteger(state.attempt) &&
      (state.attempt as number) >= 0 &&
      (state.purpose === undefined ||
        state.purpose === "ci" ||
        state.purpose === "conflict") &&
      [
        "base",
        "worktree",
        "branch",
        "attemptId",
        "targetBase",
        "head",
        "pendingPush",
      ].every(
        (field) =>
          state[field] === undefined ||
          (typeof state[field] === "string" && state[field] !== ""),
      ) &&
      (state.pendingPush === undefined ||
        (state.base !== undefined &&
          state.worktree !== undefined &&
          state.branch !== undefined &&
          state.attemptId !== undefined))
    );
  };
  const validBudgets =
    repairBudgets === undefined ||
    (repairBudgets !== null &&
      typeof repairBudgets === "object" &&
      !Array.isArray(repairBudgets) &&
      validRepairState(repairBudgets.ci) &&
      validRepairState(repairBudgets.conflict) &&
      (repairBudgets.ci === undefined ||
        (repairBudgets.ci as Record<string, unknown>).purpose === undefined ||
        (repairBudgets.ci as Record<string, unknown>).purpose === "ci") &&
      (repairBudgets.conflict === undefined ||
        (repairBudgets.conflict as Record<string, unknown>).purpose ===
          undefined ||
        (repairBudgets.conflict as Record<string, unknown>).purpose ===
          "conflict"));
  return (
    Number.isSafeInteger(publication.ticket) &&
    (publication.ticket as number) > 0 &&
    ["delivery", "maintenance"].includes(String(publication.kind)) &&
    [
      "originalBase",
      "targetBranch",
      "stableBranch",
      "intendedHeadSha",
      "title",
      "body",
    ].every(
      (field) =>
        typeof publication[field] === "string" && publication[field] !== "",
    ) &&
    ["pending_push", "pushed", "pending_pr", "pr_created"].includes(
      String(publication.phase),
    ) &&
    Array.isArray(publication.implementationEvidence) &&
    Array.isArray(publication.reviewEvidence) &&
    completion !== null &&
    validRepairState(repairState) &&
    validBudgets &&
    typeof completion === "object" &&
    completion.ticket === publication.ticket &&
    completion.branch === publication.stableBranch &&
    completion.base === publication.originalBase &&
    completion.prTitle === publication.title &&
    completion.prBody === publication.body &&
    Array.isArray(completion.commits) &&
    (publication.phase !== "pr_created" ||
      (pullRequest !== null &&
        typeof pullRequest === "object" &&
        Number.isSafeInteger(pullRequest.number) &&
        typeof pullRequest.url === "string" &&
        pullRequest.url !== "" &&
        pullRequest.headSha ===
          (repairState?.head ?? publication.intendedHeadSha)))
  );
}

export async function readRecoverySnapshot(
  filename: string,
): Promise<RecoverySnapshot | null> {
  try {
    return parseSnapshot(
      JSON.parse(await readFile(filename, "utf8")) as unknown,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof InvalidRecoverySnapshot) throw error;
    if (error instanceof SyntaxError) {
      throw new InvalidRecoverySnapshot("recovery snapshot is malformed JSON");
    }
    throw error;
  }
}

export async function writeRecoverySnapshot(
  filename: string,
  snapshot: RecoverySnapshot,
): Promise<void> {
  parseSnapshot(snapshot);
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(snapshot)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filename);
  const directory = await open(path.dirname(filename), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
