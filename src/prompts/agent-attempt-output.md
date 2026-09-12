Return exactly one result enclosed in these tags:
<agent_attempt_result>
{JSON object}
</agent_attempt_result>

The JSON object must contain exactly these required fields:

{
  "outcome": "...",
  "summary": "...",
  "commits": [...],
  "checks": [...],
  "blocker": null
}

Field definitions:

- "outcome": one of "committed", "no_change", or "blocked".
- "summary": a concise, non-empty description of what you did or why you stopped.
- "commits": Empty array if outcome is blocked. Otherwise, it must contain the actual full SHA and non-empty subject of every commit created in the supplied Worktree.
- "checks": Empty array unless outcome is committed. Otherwise, each check must contain a non-empty command, a status of "passed", "failed", or "not_run", and non-empty details.
- "blocker": null unless outcome is blocked. For a blocked result, it must be a non-empty string explaining the unresolved obstacle.
- "pr_title" and "pr_body": {{PULL_REQUEST_METADATA_RULE}}

Use "outcome": "committed" only when the accepted scope is complete, the required commits were created, and the Worktree is clean. Use "no_change" when no file changes or commits are required. Use "blocked" when an unresolved obstacle prevents completion.
