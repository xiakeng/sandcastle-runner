Return exactly one result enclosed in these tags:
<agent_attempt_result>
{JSON object}
</agent_attempt_result>

The JSON object must contain exactly these fields, plus the conditional Pull Request fields described below:

{
  "outcome": "...",
  "summary": "...",
  "commits": [...],
  "checks": [...],
  "blocker": null
}

Field requirements:

- `outcome` is exactly `committed`, `no_change`, or `blocked`.
- `summary` is a concise non-empty English string describing the result.
- `commits` is an array of every commit created in the supplied Worktree. Each
  `sha` must be a full lowercase hexadecimal Git SHA (40 to 64 characters);
  never use `git log --oneline` abbreviations. Each `message` must be non-empty.
- `checks` is an array. Every check has a non-empty `command`, a `status` of
  `passed`, `failed`, or `not_run`, and non-empty `details`.
- `blocker` must be `null` unless `outcome` is `blocked`; a blocked result must
  provide a non-empty blocker string.
- If present, `pr_title` and `pr_body` must each be non-empty JSON strings.

Field definitions:

- "outcome": one of "committed", "no_change", or "blocked".
- "summary": a concise, non-empty description of what you did or why you stopped.
- "commits": Empty array if outcome is blocked. Otherwise, it must contain the actual full SHA and non-empty subject of every commit created in the supplied Worktree.
- "checks": Empty array unless outcome is committed. Otherwise, each check must contain a non-empty command, a status of "passed", "failed", or "not_run", and non-empty details.
- "blocker": null unless outcome is blocked. For a blocked result, it must be a non-empty string explaining the unresolved obstacle.
- "pr_title" and "pr_body": {{PULL_REQUEST_METADATA_RULE}}

Use "outcome": "committed" only when the accepted scope is complete, the required commits were created, and the Worktree is clean. Use "no_change" when no file changes or commits are required. Use "blocked" when an unresolved obstacle prevents completion.
