# T2: Select and reserve eligible Delivery Tickets

## Parent

[Sandcastle Runner V1: ticket delivery orchestration #8](https://github.com/xiakeng/sandcastle-runner/issues/8)

## What to build

Extend a Run from Parent discovery to a deterministic Batch reservation. An operator can see which children the Runner selected, which remain blocked or externally owned, and the visible GitHub ownership markers. Verify this path at its reservation checkpoint without claiming that reserved work has been delivered.

## Acceptance criteria

- [ ] Fully paginate direct children and native blockers, including blockers outside the Parent. A partial hierarchy/dependency read never produces selection or closeout. Reuse T1 external-read retries and Operator Pause.
- [ ] Eligibility requires an open same-repository child, no non-runner assignee, no complete or partial Reservation, and every native blocker closed. Both `completed` and `not_planned` satisfy blockers.
- [ ] Select by ascending issue number, reserving at most three. Record external ownership, blocked work, and existing complete/partial Reservations; do not adopt existing reservations or introduce a lock, CAS claim, or coordination service.
- [ ] Create Reservations through the configured label and runner-account assignee. Mutation failure pauses immediately; do not compensate or roll back a partial marker. Terminal tickets and explicit release remove Reservations; failed/interrupted work keeps them.
- [ ] Revalidate Parent, child, and blockers at operation boundaries. Stop subsequent work on cancellation, external completion, scope removal, or other terminal changes; release terminal-ticket Reservations. Parent cancellation does not mutate children.
- [ ] Before concluding exhaustion, perform the final complete scan. Open blocked/reserved/externally owned children produce `incomplete` with reasons and leave the Parent open. Newly visible eligible work prevents premature exhaustion.
- [ ] Wire production Tracker reads/mutations into the Run, and verify selection plus externally visible mutation ordering with scripted fakes. Cover partial writes, pagination failures, residual markers, ordering, and revalidation changes; do not use a fake-only scheduler as the delivered implementation.
- [ ] Update the operator-facing behavior documentation alongside these changes.

## Blocked by

- T1: Run a configured Project through supervised no-delivery outcomes.
