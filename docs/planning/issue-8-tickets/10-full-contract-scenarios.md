# T10: Verify the complete Run contract through the two five-ticket scenarios

## Parent

[Sandcastle Runner V1: ticket delivery orchestration #8](https://github.com/xiakeng/sandcastle-runner/issues/8)

## What to build

Deliver the two explicitly requested deterministic end-to-end acceptance demonstrations of the composed Runner, and reconcile the existing per-slice scenarios against every transition and exception in #8. This is final integration evidence, not a replacement for tests in earlier behavior tickets.

## Acceptance criteria

- [ ] Use the actual Run orchestration with scripted Tracker, CodeHost, GitWorkspace, AgentExecutor, Clock, and OperatorIO boundaries, temporary real configuration/log directories, and controlled concurrent completions. No live Codex, GitHub, Plane, or remote mutations occur.
- [ ] First-try success uses five Delivery Tickets: 1–4 mutually unblocked, 5 blocked by all four. Assert Batch(1,2,3), maintenance, Batch(4), Batch(5), final maintenance, then completed Parent. Every operation succeeds on its first attempt.
- [ ] The same topology ultimately succeeds on the longest practical recovery path: external read success on call five; write failure and empty retry; Agent failure then fresh attempt; malformed result corrected in-session; failed Verified Handoff then fresh attempt; trusted nonempty override; CI repair; required-check read retries; conflict repair; maintenance CI and merge repair; all delivery and Parent completion evidence.
- [ ] Reconcile all #8 phase transitions, conditional branches, retry boundaries, Operator Pause actions, cleanup paths, and terminal outcomes with named runnable behavioral scenarios. Reuse existing protection; add a focused scenario only for an uncovered behavior rather than duplicating lower-level tests or targeting numerical coverage.
- [ ] Keep mutually incompatible terminal cases focused: `q`/EOF, exhausted reads awaiting operator input, unusable overrides, valid blocked/no-change work, unsupported children, contradictory Parent state, residual Reservations, and startup failures. Verify no restart/adoption/counter reconstruction and audit omission/failure behavior.
- [ ] Assert public effects, ordered operations, barriers, summaries, and exit status rather than private implementation layout. Optional Git integration checks use temporary local repositories and are distinct from fake orchestration evidence.
- [ ] Publish a reproducible verification command and concise evidence mapping with the affected documentation. Clearly identify fake/static validation; do not claim authenticated Codex/Sandcastle end-to-end execution. Fix integration defects exposed by these scenarios within this ticket.
- [ ] Completion of this child does not close or modify parent specification #8; parent closeout remains a separate maintainer decision.

## Blocked by

- T9: Deliver standalone Documentation Maintenance between Batches.
