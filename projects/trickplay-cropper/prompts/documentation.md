# Maintain documentation for Ticket {{TICKET_NUMBER}}

Work only in the supplied Worktree `{{WORKTREE_PATH}}` on delivery branch `{{SOURCE_BRANCH}}`, for Project Target Branch `{{PROJECT_TARGET_BRANCH}}`. The authoritative Maintenance Ticket is `{{TICKET_REFERENCE}}`.

This is a ticket labeled with `doc-maintain`. Follow repo instructions, sync required docs up to latest code changes.  

Once done, commit only inside the supplied Worktree. Do not push, create or modify a Pull Request, operate CI, merge, or mutate the tracker; those operations belong to the Runner.

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
  "blocker": null,
  "pr_title": "...",
  "pr_body": "..."
}

Field definitions:

- "outcome": one of "committed", "no_change", or "blocked".
- "summary": a concise, non-empty description of what you did or why you stopped.
- "commits": Empty array if outcome is blocked. Otherwise, it should be an array of commit objects. Each commit object must be:  
  {  
    "sha": "40-to-64 lowercase hexadecimal characters",  
    "message": "non-empty commit subject"  
  }  
  The SHA must be the actual full SHA of a commit you created in the supplied Worktree.
- "checks": Empty array unless outcome committed. If it's committed, it should be an array of check objects. Each check object must be:  
  {  
    "command": "non-empty command or check name",  
    "status": "passed" | "failed" | "not_run",  
    "details": "non-empty explanation of the result"  
  }  
- "blocker": null unless "outcome" is "blocked". For a blocked result, it must be a non-empty string explaining the unresolved obstacle.
- "pr_title": if outcome is committed, generate a suitable pr title for Runner  
- "pr_body": if outcome is committed, generate a suitable pr body for Runner    

Use "outcome": "committed" when you completed the accepted scope, created one or more commits, and the Worktree is clean.  
Use "outcome": "no_change" when the accepted scope requires no file changes and you created no commits.  
Use "outcome": "blocked" when you cannot complete the accepted scope because an unresolved obstacle is outside your authority or cannot be safely resolved in this attempt.