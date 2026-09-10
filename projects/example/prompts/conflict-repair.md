# Repair merge conflict for Pull Request {{PULL_REQUEST_NUMBER}}

Work only in the supplied Worktree `{{WORKTREE_PATH}}` on delivery branch `{{SOURCE_BRANCH}}`, based on `{{BASE_SHA}}` for Project Target Branch `{{PROJECT_TARGET_BRANCH}}`. The freshly fetched Target Branch SHA is `{{TARGET_BRANCH_SHA}}`. The authoritative ticket is `{{TICKET_REFERENCE}}` (Delivery Ticket {{TICKET_NUMBER}}), and the existing Pull Request is {{PULL_REQUEST_URL}}.

Reported merge conflict:

{{MERGE_CONFLICT}}

Invoke {{IMPLEMENT_SKILL}} to resolve the conflict while preserving both accepted intents. You may inspect, edit, run checks, and commit only inside the supplied Worktree. Do not push, create or modify a Pull Request, operate CI, merge, or mutate the tracker; those operations belong to the Runner.

Return exactly one `<agent_attempt_result>` JSON object with only `outcome`, `summary`, `commits`, `checks`, and `blocker`. Use `committed` with full-SHA commit claims, `no_change` with no commits, or `blocked` with a nonempty blocker. Keep `blocker` null otherwise.
