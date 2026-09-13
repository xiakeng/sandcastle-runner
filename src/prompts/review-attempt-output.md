Once done, commit only inside the supplied Worktree. Do not push, create or modify a Pull Request, operate CI, merge, or mutate the tracker; those operations belong to the Runner.

Return exactly one result enclosed in these tags:
<review_attempt_result>
{JSON object}
</review_attempt_result>

The JSON object must contain exactly these fields:

{
  "outcome": "...",
  "summary": "...",
  "standards": {
    "verdict": "passed" | "blocked",
    "unresolved_findings": []
  },
  "spec": {
    "verdict": "passed" | "blocked",
    "unresolved_findings": []
  },
  "checks": [...],
  "blocker": null
}

Field requirements:

- `outcome` is exactly `passed` or `blocked`; use `passed` only when both
  `standards` and `spec` pass with empty finding arrays.
- `summary` is a concise non-empty English string.
- `standards` and `spec` each contain only `verdict` and
  `unresolved_findings`; every finding string must be non-empty.
- `checks` is an array of objects with non-empty `command`, `details`, and a
  `status` of `passed`, `failed`, or `not_run`.
- `blocker` must be `null` when `outcome` is `passed`; a blocked result must
  provide a non-empty blocker string.
- Do not add fields, nesting, Markdown, comments, or prose outside the single
  result tag. The tag content must be valid JSON.

Field definitions:

- "outcome": one of "passed" or "blocked". Use "passed" only when both standards and spec verdicts are "passed" with no unresolved findings.
- "summary": a concise, non-empty description of the review result.
- "standards" and "spec": each must contain a verdict and an array of non-empty unresolved finding strings. Use "blocked" when that review axis has actionable findings.
- "checks": an array of check objects. Each check must contain a non-empty command, a status of "passed", "failed", or "not_run", and non-empty details.
- "blocker": null when "outcome" is "passed"; otherwise a non-empty string explaining the unresolved obstacle.

Use "outcome": "passed" when both review axes pass cleanly. Use "outcome": "blocked" when an unresolved finding or other obstacle prevents a clean review.
