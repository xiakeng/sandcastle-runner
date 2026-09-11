import path from "node:path";

import type { GitWorkspace, RegisteredWorktree } from "./contracts.ts";

export interface CleanupRecord {
  status: "pending" | "cleaned" | "accepted";
  candidates: string[];
  residual?: string[];
  error?: string;
}

export function matchingWorktrees(
  entries: RegisteredWorktree[],
  repository: string,
  root: string,
  ticket: number,
): RegisteredWorktree[] {
  const boundedRoot = `${path.resolve(root)}${path.sep}`;
  const prefix = new RegExp(`(?:^|/)ticket-${ticket}(?:-|$)`);
  return entries.filter(
    (entry) =>
      path.resolve(entry.repository) === path.resolve(repository) &&
      path.resolve(entry.worktree).startsWith(boundedRoot) &&
      prefix.test(entry.branch),
  );
}

export async function cleanupTicketWorktrees(
  gitWorkspace: GitWorkspace,
  checkout: string,
  repository: string,
  root: string,
  ticket: number,
  onCandidates?: (candidates: string[]) => Promise<void>,
): Promise<CleanupRecord> {
  if (
    !gitWorkspace.listWorktrees ||
    !gitWorkspace.removeWorktree ||
    !gitWorkspace.deleteBranch
  ) {
    return { status: "cleaned", candidates: [] };
  }
  const candidates = matchingWorktrees(
    await gitWorkspace.listWorktrees(checkout),
    repository,
    root,
    ticket,
  );
  const evidence = candidates.map(
    ({ worktree, branch }) => `${worktree}:${branch}`,
  );
  await onCandidates?.(evidence);
  for (const candidate of candidates) {
    await gitWorkspace.removeWorktree(checkout, candidate.worktree);
    await gitWorkspace.deleteBranch(checkout, candidate.branch);
  }
  return {
    status: "cleaned",
    candidates: evidence,
  };
}
