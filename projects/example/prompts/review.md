# Review the implementation

The authoritative review input is this JSON handoff:

{{REVIEW_HANDOFF}}

Work only in the Worktree and delivery branch named by the handoff. Invoke `$code-review` and permit its Standards and Spec subagents. The first review must inspect the complete diff from the original fixed point and run both axes. After committing a fix, review only changes since the last reviewed HEAD and only the affected axis or axes; retain unresolved findings and fall back to a complete two-axis review if the checkpoint is missing, is not an ancestor, or the scope is uncertain.

You may inspect, edit, run checks, and commit only inside the supplied Worktree. Do not push, create or modify a Pull Request, operate CI, merge, or mutate the tracker; those operations belong to the Runner.

Return exactly one `<review_attempt_result>` JSON object with only `outcome`, `summary`, `standards`, `spec`, `checks`, and `blocker`. Each axis contains `verdict` and `unresolved_findings`. `passed` requires both axes to pass with empty unresolved lists and a null blocker; otherwise return `blocked` with a nonempty blocker.
