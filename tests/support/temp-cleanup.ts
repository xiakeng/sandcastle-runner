import { rmSync } from "node:fs";
import { rm } from "node:fs/promises";

const roots = new Set<string>();
let installed = false;

function installExitCleanup(): void {
  if (installed) return;
  installed = true;
  const cleanup = () => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  };
  process.once("exit", cleanup);
}

export function registerTempRoot(root: string): string {
  installExitCleanup();
  roots.add(root);
  return root;
}

export async function cleanupTempRoots(): Promise<void> {
  const failures: unknown[] = [];
  await Promise.all(
    [...roots].map(async (root) => {
      try {
        await rm(root, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 10,
        });
        roots.delete(root);
      } catch (error) {
        failures.push(error);
      }
    }),
  );
  if (failures.length > 0)
    throw new AggregateError(failures, "Failed to clean temporary roots");
}
