# Code Review Contract

Use this contract for code, tests, tools, and build configuration.

## Prepare

1. Inspect the complete diff within the supplied base/head scope using default
   diff context. Do not expand it with `--unified`; read targeted source ranges
   when a specific question needs more context.
2. Read the governing issue or specification's relevant requirements, non-goals,
   and explicit exceptions. Resolve missing or ambiguous details at the source.
3. Apply `docs/agents/code-standards.md`.
4. Inspect affected functionalities and tests.

Preparation is complete when every changed behavior maps to the requested
contract or is identified as unintended scope.

## Incremental /code-review rule

Within one `/implementation` task, the first `/code-review` reviews the complete
branch diff against its original fixed point and runs both Standards and Spec.

After that review, record the reviewed `HEAD` commit as the review checkpoint.
For every subsequent review:

1. Review only `git diff <last-reviewed-head>..HEAD` and its commits.
2. Review only the affected axis:
   - Run Standards for changes made solely to resolve Standards findings.
   - Run Spec for changes made solely to resolve Spec findings or acceptance
     requirements.
   - Run both only when the new changes affect both axes.
3. Do not re-review unchanged hunks from before the checkpoint. Read unchanged
   code only as context for the new diff or to verify an outstanding finding.
4. After the required review axes pass, advance the checkpoint to the current
   `HEAD`. Retain unresolved findings until verified as fixed or explicitly
   dispositioned; an empty incremental diff does not clear them.

This incremental-review rule overrides `/code-review`'s default full-diff,
two-axis behavior for repeated reviews within the same implementation task.
If the checkpoint is missing, is not an ancestor of `HEAD`, or the review scope
is uncertain, perform the complete two-axis review again.

## Review

- Verify success, boundary, malformed-input, cancellation, and failure paths
  relevant to the contract.
- Check compatibility, public behavior, state transitions, resource ownership,
  concurrency, exceptions, and performance where affected.
- Leave deterministic formatting, lint, and type diagnostics to configured
  tooling unless the configuration was bypassed or is incorrect.
- Confirm tests independently prove the changed behavior at stable seams.
- Unit tests should follow guidelines under `docs/agents/test-value-gate.md`
- Prefer the simplest design that fully satisfies the requirement.
- Keep one authoritative source for each fact; derive copies, fixtures, and
  expectations from it.
- Avoid duplication, speculative abstractions, hidden side effects, and
  unnecessary dependencies.
- Make invalid states, boundaries, and failure paths explicit.
- Use names that reveal intent. Comments explain why, not what.
- Preserve existing behavior unless the specification explicitly changes it.
- Review the final diff for design, correctness, simplicity, tests, naming,
  comments, style, and documentation.
- After non-mechanical review fixes, review the final HEAD using the incremental
  rule above.

Review is complete when every changed execution path and applicable guideline
category has been considered.

## Findings

Report only actionable problems caused or exposed by the change. Each finding
must identify the smallest useful file and line range, a concrete failure
scenario, and its engineering impact.

Exclude subjective preferences, configured-tool diagnostics, unrelated
pre-existing problems, and out-of-scope recommendations. Respect explicit
exceptions and non-goals; silence in the issue is not a waiver of repository
standards.

Present findings first, ordered by file location. If there are none, say so
explicitly.
