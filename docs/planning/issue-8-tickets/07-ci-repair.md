# T7: Repair failed required CI on the existing Pull Request

## Parent

[Sandcastle Runner V1: ticket delivery orchestration #8](https://github.com/xiakeng/sandcastle-runner/issues/8)

## What to build

Turn failed or cancelled required checks into a fresh CI-repair Agent Attempt on the existing branch/PR, then republish verified repairs and wait for readiness again. The operator controls recovery once the bounded automatic repair operation is exhausted.

## Acceptance criteria

- [ ] Failed/cancelled required checks start a fresh Agent Attempt with failing names, states, log links, and the configured CI-repair prompt/model/effort on the original branch and PR. The agent commits locally; only the Runner pushes.
- [ ] Reuse ordinary result handling and Verified Handoff checks. Publish a verified repair and repeat the full 30-second required-check discovery delay and readiness path.
- [ ] Maintain a two-attempt automatic CI-repair budget per ticket. Schema-valid `blocked`/`no_change` repair results and verified repair commits proceeding to publication consume attempts.
- [ ] Agent process failure, timeout, output-correction exhaustion, and invalid handoff pause without consuming repair budget. Required-check wait timeout also pauses without consuming a repair attempt. Empty input for failed Agent execution starts a fresh Agent Attempt.
- [ ] If failure remains after two consumed attempts, enter Operator Pause. Empty input starts a new repair operation with a fresh two-attempt budget; trusted nonempty override and abort follow the common contract. Operator-authorized total attempts have no numeric cap.
- [ ] Keep CI accounting independent from future conflict-repair accounting. Do not create replacement branches, PRs, or tickets or require a Batch implementation to exercise this path.
- [ ] Extend operation-boundary state revalidation and audit/error handling through repair and republishing; a cancelled Parent stops subsequent work without child mutations.
- [ ] Demonstrate failed-check-to-CI-ready behavior and all consumption/reset/failure/override branches using scripted Agent, CodeHost, GitWorkspace, Clock, and OperatorIO interactions. Include production wiring and affected documentation.

## Blocked by

- T4: Publish a Verified Handoff and observe required CI readiness.
