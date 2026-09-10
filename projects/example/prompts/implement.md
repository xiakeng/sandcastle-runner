# Implement Delivery Ticket {{TICKET_NUMBER}}

Work only in the supplied Worktree `{{WORKTREE_PATH}}` on delivery branch `{{SOURCE_BRANCH}}`, based on `{{BASE_SHA}}` for Project Target Branch `{{PROJECT_TARGET_BRANCH}}`. The authoritative ticket is `{{TICKET_REFERENCE}}`.

Invoke {{IMPLEMENT_SKILL}} and implement only the accepted ticket scope. You may inspect, edit, run checks, and commit only inside the supplied Worktree. Do not push, create or modify a Pull Request, operate CI, merge, or mutate the tracker; those operations belong to the Runner.

Return exactly one `<agent_attempt_result>` JSON object. Use fields `outcome`, `summary`, `commits`, `checks`, `blocker`, `pr_title`, and `pr_body`. Use `committed` with full-SHA commit claims and Pull Request metadata, `no_change` with no commits, or `blocked` with a nonempty blocker. Keep `blocker` null otherwise. The output contract is unchanged whether Review is enabled or disabled.
