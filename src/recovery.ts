import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

export const recoverySchemaVersion = 1;

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
  private readonly handle: Awaited<ReturnType<typeof open>>;

  private constructor(
    filename: string,
    handle: Awaited<ReturnType<typeof open>>,
  ) {
    this.filename = filename;
    this.handle = handle;
  }

  static async acquire(
    filename: string,
    metadata: object,
  ): Promise<ParentLock> {
    await mkdir(path.dirname(filename), { recursive: true });
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(filename, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Parent Ticket lock is already held: ${filename}`, {
          cause: error,
        });
      }
      throw error;
    }
    try {
      await handle.writeFile(JSON.stringify(metadata));
      await handle.sync();
      return new ParentLock(filename, handle);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(filename, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async release(): Promise<void> {
    await this.handle.close();
    await rm(this.filename, { force: true });
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
  return snapshot as RecoverySnapshot;
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

export async function snapshotExists(filename: string): Promise<boolean> {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
