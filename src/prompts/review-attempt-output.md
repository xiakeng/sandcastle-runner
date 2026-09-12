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

Field definitions:

- "outcome": one of "passed" or "blocked". Use "passed" only when both standards and spec verdicts are "passed" with no unresolved findings.
- "summary": a concise, non-empty description of the review result.
- "standards" and "spec": each must contain a verdict and an array of non-empty unresolved finding strings. Use "blocked" when that review axis has actionable findings.
- "checks": an array of check objects. Each check must contain a non-empty command, a status of "passed", "failed", or "not_run", and non-empty details.
- "blocker": null when "outcome" is "passed"; otherwise a non-empty string explaining the unresolved obstacle.

Use "outcome": "passed" when both review axes pass cleanly. Use "outcome": "blocked" when an unresolved finding or other obstacle prevents a clean review.
