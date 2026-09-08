# T5: Squash-merge a CI-ready Pull Request and confirm delivery

## Parent

[Sandcastle Runner V1: ticket delivery orchestration #8](https://github.com/xiakeng/sandcastle-runner/issues/8)

## What to build

Complete one PR-backed Delivery Ticket from CI readiness through confirmed squash merge and confirmed completed tracker closure. The operator can distinguish delivery from queue acceptance, cancellation, and a merged-but-not-completed ticket.

## Acceptance criteria

- [ ] Request squash merge with the observed PR head SHA and configured admin bypass. Do not inspect review/ruleset/protection state or proactively update/rerun CI solely because the Target Branch advanced.
- [ ] Wait for actual `merged=true`, including the configurable merge-queue timeout. A queued request alone never counts as delivery or permits later integration to advance.
- [ ] Preserve explicit conflict evidence for conflict repair. Non-conflict rejection preserves the original GitHub error and enters Operator Pause; queue failure/timeout follows the same execution-failure policy.
- [ ] Under `runner`, close the merged ticket as `completed` and verify its state. Under `code_host`, add no linkage requirement: wait 10 seconds and read, then another 30 seconds and reread if open. Missing `closed/completed` evidence enters Operator Pause.
- [ ] Count a Completed Delivery Ticket only when both merge and completed closure are confirmed. A cancelled terminal ticket can release its Reservation but receives no completion credit. Record confirmed credit immediately for later maintenance scheduling.
- [ ] Terminal-ticket Reservation release follows the Tracker policy. Retain unresolved artifacts and never roll back a completed merge after a later operation fails.
- [ ] Apply operation-boundary Parent/child/blocker revalidation throughout integration and closure. A cancelled Parent stops subsequent operations without child mutations; execution errors use the existing audit/Operator Pause path.
- [ ] Exercise the production merge/queue/closure path with scripted services and Clock. Cover both policies, closure-write failure, open/not-planned post-merge states, head/rejection evidence, queue timeout, operator actions, and resource lifecycle paths introduced here; update documentation.

## Blocked by

- T4: Publish a Verified Handoff and observe required CI readiness.
