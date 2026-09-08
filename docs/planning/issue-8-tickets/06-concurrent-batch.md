# T6: Deliver dependency-driven Batches behind CI barriers

## Parent

[Sandcastle Runner V1: ticket delivery orchestration #8](https://github.com/xiakeng/sandcastle-runner/issues/8)

## What to build

Deliver up to three selected tickets concurrently through implementation/publication, integrate their ready PRs strictly one at a time, and rescan for the next Batch. A slow or unready PR prevents the Batch from starting integration; completion order cannot reorder merges. T9 extends this real Run loop with the specified Documentation Maintenance barrier.

## Acceptance criteria

- [ ] Start at most three selected implementations concurrently with distinct Runner-owned branches/Worktrees and per-Attempt Git configuration. Keep ticket/PR/attempt identities and errors separate in memory.
- [ ] Publish each verified result through the established Runner path. No PR in the Batch may merge until every PR in that Batch is CI-ready; unresolved blocked/no-change work prevents the barrier from passing.
- [ ] After the barrier, merge in ascending GitHub PR `createdAt`, with PR number as tie-breaker. Agent completion order and CI completion order do not change this sequence.
- [ ] An earlier merge waiting in a queue, paused, or awaiting future conflict repair prevents later PRs overtaking it. Confirm merge and completed closure before advancing the ordered delivery flow.
- [ ] Partial integration retains already completed credit and never rolls back. Unresolved original branches, PRs, and Reservations remain available to the operator; an unsuccessful Batch cannot start maintenance.
- [ ] After a successful Batch, fully rescan and select newly eligible work, respecting dependencies and newly visible direct children. Perform a final complete scan before exhaustion or Parent closeout; children appearing afterward wait for a later Run. Reuse T1 Parent closure and T2 exhaustion rules rather than introducing a second closeout implementation.
- [ ] Preserve whether the Parent has had children during this Run: only an initially empty complete scan is `no_work`. A later complete scan that becomes empty through scope removal uses final closeout eligibility rather than incorrectly returning the initial no-work outcome.
- [ ] Expose final-scan closeout eligibility and confirmed completion credit in the same Run flow where T9 adds maintenance. Do not claim the full #8 lifecycle is complete before that barrier is implemented.
- [ ] Boundary revalidation prevents subsequent work after cancellation or state changes. Run abort closes active Agent/Sandcastle resources through the supported lifecycle without deleting prior-Run artifacts.
- [ ] Use controlled asynchronous completions and Clock to verify concurrency limits, the all-ready barrier, tie-breaking, no overtaking, partial integration, dependency rescans, child additions/removals, exhaustion/closeout, and cancellation/resource cleanup. No real timing sleeps or live services are required. Update affected documentation.

## Blocked by

- T5: Squash-merge a CI-ready Pull Request and confirm delivery.
