import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";

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
    this.closed = new Promise((resolve) => holder.once("close", resolve));
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
      const onExit = (code: number | null) =>
        reject(
          new Error(
            code === 1
              ? `Parent Ticket lock is already held: ${filename}`
              : `unable to hold Parent Ticket lock: ${filename}`,
          ),
        );
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
