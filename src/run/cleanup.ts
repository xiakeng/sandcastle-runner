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
  const prefix = new RegExp(
    `(?:^|/)(?:ticket-${ticket}|maintenance-${ticket})(?:-|$)`,
  );
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
  priorCandidates: string[] = [],
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
  const prior = priorCandidates.flatMap((value) => {
    const separator = value.lastIndexOf(":");
    if (separator < 1 || separator === value.length - 1) return [];
    return [
      {
        worktree: value.slice(0, separator),
        branch: value.slice(separator + 1),
        repository,
      },
    ];
  });
  const currentBranches = new Set(candidates.map(({ branch }) => branch));
  const pending = [
    ...evidence,
    ...prior
      .filter(({ branch }) => !currentBranches.has(branch))
      .map(({ worktree, branch }) => `${worktree}:${branch}`),
  ];
  await onCandidates?.(pending);
  for (const candidate of candidates) {
    await gitWorkspace.removeWorktree(checkout, candidate.worktree);
    await gitWorkspace.deleteBranch(checkout, candidate.branch);
  }
  for (const candidate of prior) {
    if (currentBranches.has(candidate.branch)) continue;
    await gitWorkspace.deleteBranch(checkout, candidate.branch);
  }
  return {
    status: "cleaned",
    candidates: pending,
  };
}
