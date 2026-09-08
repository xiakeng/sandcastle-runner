# T9: Deliver standalone Documentation Maintenance between Batches

## Parent

[Sandcastle Runner V1: ticket delivery orchestration #8](https://github.com/xiakeng/sandcastle-runner/issues/8)

## What to build

After a successful Batch, deliver the required documentation review as a standalone Maintenance Ticket and hold the next Batch/Parent closeout until it succeeds. Reuse the established Agent and PR delivery/repair paths instead of implementing a second lifecycle.

## Acceptance criteria

- [ ] Start the Run-local counter at zero and use immediately confirmed Completed Delivery Ticket credit, including retained partial-Batch credit. Cancellations and maintenance add none. Evaluate only after a whole Batch succeeds.
- [ ] Trigger one occurrence at counter >= 3 or final complete-scan closeout eligibility with nonzero counter. Coincident triggers collapse to one. Initial zero-child/all-cancelled Runs and exhaustion solely from blocked/reserved/externally owned work do not independently trigger it; failed Batches do not trigger it.
- [ ] Ensure and apply `doc-maintain`; create a new same-repository standalone Maintenance Ticket with #8's exact fixed title/body and no parent, dependency, assignee, or Reservation. Reuse normal read/write failure handling and never search for/deduplicate/reuse earlier occurrences.
- [ ] Prepare a fresh Worktree/branch from the latest Target Branch and use the documentation prompt/profile. Supply only ordinary ticket/Worktree/branch/base metadata; no completed-ticket list, commit range, or synthesized context. The prompt contract makes each documentation surface own its full Documentation Base and advance it only after complete review.
- [ ] For `committed`, require the nonempty AI PR title/body and Verified Handoff, then reuse push/publication, required checks, CI/conflict repair, squash merge, and both Ticket Closure Policies. Completion requires merged plus confirmed `closed/completed`.
- [ ] For valid clean `no_change` with explanation, directly close the Maintenance Ticket as `completed`, irrespective of the PR-backed closure policy. `blocked` leaves maintenance unresolved; operational failures use Operator Pause.
- [ ] Successful maintenance resets the counter to zero without remainder. It occupies no Delivery Ticket position and blocks next-Batch discovery/Parent closeout until success in this Run.
- [ ] Insert maintenance into T6's existing Run loop: after a successful Batch, counter >= 3 starts maintenance before next-Batch discovery. Below that threshold, a final complete scan can establish the nonzero-counter closeout trigger. Resume the existing rescan/Parent closeout path only after required maintenance succeeds. Preserve all-terminal/zero-child/cancelled-Parent outcomes and extend audit, operation failure, and boundary revalidation to maintenance.
- [ ] Earlier Run maintenance artifacts are neither adopted nor rediscovered. A new Run starts with zero credit and may close an otherwise complete Parent without replacing abandoned maintenance; future independently triggered reviews use stored Documentation Bases to catch up.
- [ ] Verify thresholds, combined/final/negative triggers, blocked/no-change/committed outcomes, label/ticket failures, PR closure, and CI/conflict repair through scripted full maintenance occurrences. Reuse production delivery operations; update Project prompt/operator documentation.

## Blocked by

- T6: Deliver dependency-driven Batches behind CI barriers.
- T8: Repair merge conflicts without replacing delivery identity.
