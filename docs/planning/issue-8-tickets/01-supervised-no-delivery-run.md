# T1: Run a configured Project through supervised no-delivery outcomes

## Parent

[Sandcastle Runner V1: ticket delivery orchestration #8](https://github.com/xiakeng/sandcastle-runner/issues/8)

## What to build

Make the actual Run CLI usable for a configured Parent with zero children or entirely terminal children. The operator gets the agreed startup validation, GitHub-backed reads and Parent closeout, bounded read retries, Operator Pause controls, and a diagnostic log. Introduce only the runtime and boundary operations this path needs; later slices extend the same Run.

## Acceptance criteria

- [ ] The `run` command selects one Project and Parent using the fixed configuration/prompt/log conventions in #8 and its linked #6 resolution. Validate the complete agreed configuration, credentials, prompts, and model/effort selections before workflow operations; resolve and fix the Target Branch without silently substituting settings.
- [ ] A complete, paginated GitHub child scan with zero children returns `no_work` and leaves the Parent open. An all-terminal child set permits Runner-owned Parent closure as `completed`, including all-cancelled children. Contradictory Parent state and unsupported cross-repository children fail explicitly. A Parent cancellation returns `cancelled` without modifying children.
- [ ] External reads use at most five total calls, five-second gaps, and a 60-second invocation timeout. Exhaustion pauses. Failed workflow writes pause immediately without automatic retry; local reads do not inherit remote-read retries.
- [ ] Empty Operator Pause input retries the current complete operation with reset budget; exactly `q` and EOF cancel; other input supplies trusted success, with read data parsed only for downstream fields and unusable input causing another pause. Nonempty write overrides suffice; no reconciliation or deduplication is added.
- [ ] Create the Run UUID and JSONL audit log with exactly the agreed fields and separate operation events. Exclude credentials/raw overrides/raw Agent streams. Log create/append failures support retry, cancel, and accepted audit gaps, with later appends attempted normally.
- [ ] Startup/business errors do not enter Operator Pause. Demonstrate appropriate structured summaries and zero/nonzero exit status for this slice's outcomes. A new invocation creates fresh state and never consumes earlier logs as recovery input.
- [ ] Exercise the actual CLI/orchestration path through scripted Tracker, CodeHost, Clock, and OperatorIO behavior and temporary real configuration/log directories. Include a production GitHub implementation for the operations used, verified without live mutations. Keep Tracker and CodeHost ownership separate; add no unused ports or plugin framework.
- [ ] Leave a repeatable local verification command and update operator documentation for this supported path. Include focused cases for every behavior introduced here; do not defer them to the final integration ticket.

## Blocked by

None (can start immediately).
