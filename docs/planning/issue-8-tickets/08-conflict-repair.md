# T8: Repair merge conflicts without replacing delivery identity

## Parent

[Sandcastle Runner V1: ticket delivery orchestration #8](https://github.com/xiakeng/sandcastle-runner/issues/8)

## What to build

Recover an explicitly conflicting merge request by incorporating the current Target Branch into the original delivery branch, verifying and publishing the repair, and completing required CI and merge. Keep all work on the same PR and preserve independent CI/conflict repair allowances.

## Acceptance criteria

- [ ] Start conflict repair only for an explicit conflict reported by the merge request. Ordinary rejection uses Operator Pause; Target Branch advancement alone does not start repair or branch updating.
- [ ] Use a fresh Agent Attempt with configured conflict-repair prompt/model/effort, existing branch/PR, and current Target Branch context. Commit the resolution locally without creating another branch, PR, or issue.
- [ ] Independently verify the repair, push through the Runner, and repeat required-check discovery and readiness. Any resulting CI failure runs the existing CI-repair operation and uses only its budget.
- [ ] Enforce an independent two-attempt conflict-repair automatic budget with the same consumed-result versus execution-failure rules as #8. Exhaustion, empty-input reset, trusted override, and cancellation follow Operator Pause semantics.
- [ ] Resume the original PR's merge after successful repair/readiness; merge/queue/completion evidence still follows T5. Preserve the original ordering position for Batch integration.
- [ ] Extend operation-boundary state revalidation and audit/error handling through conflict repair, republishing, and remerge; a cancelled Parent stops subsequent work without child mutations.
- [ ] Verify conflict-to-confirmed-delivery through real production operation wiring with scripted boundaries. Include CI failure after conflict repair, independent budget exhaustion/resets, non-conflict errors, invalid handoffs, and unchanged branch/PR/ticket identity. Update affected documentation.

## Blocked by

- T5: Squash-merge a CI-ready Pull Request and confirm delivery.
- T7: Repair failed required CI on the existing Pull Request.
