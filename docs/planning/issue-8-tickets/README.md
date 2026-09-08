# Issue #8 published ticket breakdown

Status: published and verified on 2026-09-08T22:38:34.817566+00:00. The user approved the ten-ticket plan and direct blocking edges before publication.

Source: [Sandcastle Runner V1: ticket delivery orchestration #8](https://github.com/xiakeng/sandcastle-runner/issues/8), read with its comments on 2026-09-09. The issue had no comments and matched the local specification at that time.

The repository currently contains planning documents only, so no prefactoring ticket is needed. Each behavior slice delivers production operations, scripted verification of those operations, and affected documentation. The six agreed external boundaries grow only as a supported behavior needs them. The final slice supplies the two explicitly requested composed acceptance scenarios; focused tests stay with their behavior slices.

## Published tickets

| ID | Issue | Database ID | Title | Blocked by | Observable result |
| --- | --- | --- | --- | --- | --- |
| T1 | [#9](https://github.com/xiakeng/sandcastle-runner/issues/9) | 5392624429 | Run a configured Project through supervised no-delivery outcomes | None | Validated CLI invocation, zero-child/all-terminal outcome, supervised GitHub read/close operations, and diagnostic log. |
| T2 | [#10](https://github.com/xiakeng/sandcastle-runner/issues/10) | 5392624648 | Select and reserve eligible Delivery Tickets | [#9](https://github.com/xiakeng/sandcastle-runner/issues/9) | Complete dependency discovery chooses and visibly reserves up to three eligible children, or reports exhaustion correctly. |
| T3 | [#11](https://github.com/xiakeng/sandcastle-runner/issues/11) | 5392624902 | Implement a reserved Delivery Ticket to a Verified Handoff | [#10](https://github.com/xiakeng/sandcastle-runner/issues/10) | Sandcastle/Codex works in the owned Git location and returns independently verified local commits or the specified unresolved/paused outcome. |
| T4 | [#12](https://github.com/xiakeng/sandcastle-runner/issues/12) | 5392625112 | Publish a Verified Handoff and observe required CI readiness | [#11](https://github.com/xiakeng/sandcastle-runner/issues/11) | A verified branch becomes its non-draft PR and reaches required-check readiness or supplies actionable failure evidence. |
| T5 | [#13](https://github.com/xiakeng/sandcastle-runner/issues/13) | 5392625326 | Squash-merge a CI-ready Pull Request and confirm delivery | [#12](https://github.com/xiakeng/sandcastle-runner/issues/12) | The original PR is confirmed merged and its ticket confirmed completed under either closure policy. |
| T6 | [#14](https://github.com/xiakeng/sandcastle-runner/issues/14) | 5392625684 | Deliver dependency-driven Batches behind CI barriers | [#13](https://github.com/xiakeng/sandcastle-runner/issues/13) | Up to three parallel deliveries wait at the all-ready barrier, merge in creation order, then rescan for subsequent Batches or closeout. |
| T7 | [#15](https://github.com/xiakeng/sandcastle-runner/issues/15) | 5392625873 | Repair failed required CI on the existing Pull Request | [#12](https://github.com/xiakeng/sandcastle-runner/issues/12) | Fresh bounded repair attempts bring the same PR back to CI readiness, with operator-directed continuation on exhaustion. |
| T8 | [#16](https://github.com/xiakeng/sandcastle-runner/issues/16) | 5392626081 | Repair merge conflicts without replacing delivery identity | [#13](https://github.com/xiakeng/sandcastle-runner/issues/13), [#15](https://github.com/xiakeng/sandcastle-runner/issues/15) | An explicit conflict incorporates the current Target Branch, rechecks/repairs CI, and retries the same PR's merge. |
| T9 | [#17](https://github.com/xiakeng/sandcastle-runner/issues/17) | 5392626390 | Deliver standalone Documentation Maintenance between Batches | [#14](https://github.com/xiakeng/sandcastle-runner/issues/14), [#16](https://github.com/xiakeng/sandcastle-runner/issues/16) | Required maintenance is created and completed before the Run discovers another Batch or closes the Parent. |
| T10 | [#18](https://github.com/xiakeng/sandcastle-runner/issues/18) | 5392626800 | Verify the complete Run contract through the two five-ticket scenarios | [#17](https://github.com/xiakeng/sandcastle-runner/issues/17) | Both prescribed full-Run scenarios are reproducible and the existing behavioral checks account for the complete contract. |

Only direct blocking edges are listed. T5 and T7 can proceed independently after T4; T6 and T8 can proceed independently once their respective blockers are done. CI repair does not depend on Batch orchestration. Conflict repair depends on CI repair because conflict resolution may cause required checks to fail. Maintenance depends on the Batch loop and complete repaired PR lifecycle.

## Coverage ownership

| Contract area | Primary slice | Subsequent integration |
| --- | --- | --- |
| CLI, complete configuration, credentials, prompt lookup, Target Branch, ephemeral UUID | T1 | Purpose-specific execution in T3/T7/T8/T9 |
| Read retries, write uncertainty, Operator Pause, Clock, audit failure and redaction | T1 | Every slice extends the same handling to its own operations |
| Hierarchy/dependencies, eligibility, Reservations, no-work/incomplete/all-terminal outcomes | T1/T2 | Continuous scans in T6; maintenance-before-closeout in T9 |
| State revalidation, cancellation, and no adoption/removal of earlier artifacts | First relevant behavior slice | Cross-phase and cross-Run evidence in T10 |
| Worktree/base/commit verification, Sandcastle ownership, result correction, trusted Agent override | T3 | All repair and maintenance purposes reuse it |
| Runner push/publication, required checks, discovery delay and wait timeout | T4 | CI/conflict/maintenance paths reuse it |
| Squash/head/queue confirmation, both closure policies and completion evidence | T5 | Ordered Batch integration and maintenance reuse it |
| Concurrency, all-ready barrier, no overtaking, partial integration, continuous rescan | T6 | Maintenance barrier in T9 |
| Independent repair budgets, consumption exceptions, operator reset | T7/T8 | Maintenance in T9 and mixed recovery in T10 |
| Run-local maintenance counter, standalone ticket, Documentation Base, no-change closure, abandonment | T9 | Both prescribed full scenarios in T10 |
| Five outcomes, exit codes, resource lifecycle, absence of recovery | Respective behavior owners | Whole-contract evidence in T10 |

## Publication evidence

All ten approved English issues are open, labeled `ready-for-agent`, and attached as native direct sub-issues of #8. Their native blocked-by relationships contain exactly the eleven approved direct edges, with no extra blockers. Titles and bodies were read back and compared exactly against the approved source files, replacing only provisional ticket references with actual issue numbers. The ten source files remain unchanged.

The parent title, body, labels, comments, and open state were compared before and after publication and are unchanged. Only the approved child relationships were added; no parent comment or content edit was made.

The current eligible frontier is [T1 / #9](https://github.com/xiakeng/sandcastle-runner/issues/9). Each downstream ticket becomes eligible when all of its native blockers are closed. Publication does not authorize implementation or parent closeout.

Machine-readable issue numbers, database IDs, source/body hashes, verified edges, parent-preservation evidence, and verification time are recorded in [publication.json](publication.json). The native relationships use the documented [sub-issue](https://docs.github.com/en/rest/issues/sub-issues) and [issue-dependency](https://docs.github.com/en/rest/issues/issue-dependencies) APIs.
