# T4: Publish a Verified Handoff and observe required CI readiness

## Parent

[Sandcastle Runner V1: ticket delivery orchestration #8](https://github.com/xiakeng/sandcastle-runner/issues/8)

## What to build

Publish an independently verified local change as its non-draft GitHub PR and determine whether its required checks make it a CI-ready Pull Request. This slice supplies the observable failed-check evidence that the later CI-repair slice consumes.

## Acceptance criteria

- [ ] The Runner pushes the existing ticket branch and creates a non-draft PR using nonempty AI-authored title/body unchanged. Do not synthesize metadata/closing keywords, deduplicate PRs, or implement lost-create-response recovery.
- [ ] Push/create failures enter Operator Pause without automatic write replay. Trusted overrides and repeated uncertain writes retain #8's explicit operator responsibility.
- [ ] Apply existing Parent/child/blocker revalidation before subsequent publication/readiness operations; Parent cancellation stops work without mutating children. Reuse audit and operation-failure handling for every new external operation.
- [ ] Wait 30 seconds after creation before polling required checks using authoritative GitHub CLI required-check semantics. An empty or all-passing set is ready; pending checks continue waiting; terminal failed/cancelled checks produce CI-repair evidence, never readiness.
- [ ] Required-check evidence includes failing names, states, and log links. Associate observations with the PR being processed and retain the existing branch/PR identity for later repair.
- [ ] Apply the configurable required-check timeout and common external-read retry policy. Timeout pauses without consuming a repair attempt. Keep time and polling controllable by Clock.
- [ ] Wire production push, PR creation, and required-check reads into the Run. Verify the complete local-handoff-to-PR-readiness path through scripted dependencies, including no-check, pending, failure, cancellation, timeout, and write uncertainty cases; do not claim completion before merge/closure.
- [ ] Reuse the same readiness path after later repair pushes, including the full discovery delay. Update behavior documentation with this slice.

## Blocked by

- T3: Implement a reserved Delivery Ticket to a Verified Handoff.
