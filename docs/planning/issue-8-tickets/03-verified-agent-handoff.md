# T3: Implement a reserved Delivery Ticket to a Verified Handoff

## Parent

[Sandcastle Runner V1: ticket delivery orchestration #8](https://github.com/xiakeng/sandcastle-runner/issues/8)

## What to build

Take selected work through a Runner-owned Worktree and an actual Sandcastle-backed Codex invocation to independently verified local commits. A false completion claim cannot become an ordinary publication input; blocked/no-change work and execution failures follow the agreed operator-visible outcomes.

## Acceptance criteria

- [ ] Fetch the Target Branch and prepare a dedicated branch/Worktree with its exact fresh base. Never adopt or remove earlier-Run Worktrees, branches, or commits. Introduce production GitWorkspace and AgentExecutor operations used by this path; no temporary-clone mode or alternative provider is added.
- [ ] Execute through Sandcastle using the Worktree, head strategy, no sandbox, one iteration, and no completion-substring signal. Sandcastle owns launch/streaming/timeout/abort/termination, and the Runner waits for settlement without claiming stronger process-tree cleanup.
- [ ] Pass a unique per-Attempt global Git configuration file, selected model/effort, configured timeout, and the caller-owned implementation Markdown prompt. Supply ticket/implement-skill identity, absolute Worktree, branch, and exact base. Prompts allow checks and local commits only; Runner delivery operations remain outside the Agent Attempt.
- [ ] Require the agreed single tagged, schema-validated Agent Attempt Result, claimed commit/check evidence, and initial PR metadata. Missing/malformed/schema-invalid output gets one same-session re-emission opportunity; a second failure pauses.
- [ ] Independently verify successful settlement, Worktree/branch/base, actual new commits, agreement with claims, and a clean tree before accepting `committed`. False claims, absent commits, dirty state, and mismatches cannot enter ordinary publication.
- [ ] Valid delivery `no_change` explains the missing commit and passes clean-tree verification; valid `blocked` retains its reason. They leave work unresolved and add no completion credit. Failed execution remains failed despite partial output/commits.
- [ ] Execution, timeout, and handoff failure enter Operator Pause; empty input starts a fresh Agent Attempt. Trusted Agent override extracts only required downstream fields and bypasses normal schema/handoff validation exactly as #8 specifies. Cancellation closes active Sandcastle resources and preserves unresolved artifacts.
- [ ] Apply the existing Parent/child/blocker revalidation at each new operation boundary. Parent cancellation stops subsequent work without mutating children, including no child Reservation release merely because the Parent was cancelled.
- [ ] Verify production invocation arguments/returned behavior through controlled execution inputs and scripted Agent/Git behavior; routine tests launch no real Codex or remote mutations. Temporary local Git checks are optional. Include every introduced result/correction/failure/override path and applicable lifecycle cleanup, with affected documentation.

## Blocked by

- T2: Select and reserve eligible Delivery Tickets.
