# Sandcastle Runner: feasibility and Wayfinder intake

Date: 2026-09-08.
Status: planning only. The public runner repository has been created. No application implementation, PR, merge, or end-to-end execution has occurred.

## Feasibility verdict

**Technically feasible, with integration work required.** Sandcastle `0.12.0` at `e99f832f26dc9d245c019a9ddd19fa5dee792427` provides the execution primitives; it does not provide the requested ticket-to-merge state machine. Its no-sandbox process lifecycle and shared Git configuration require downstream adaptation. GitHub provides the necessary issue and PR APIs. Plane Community `v1.4.2` source contains the basic future tracker capabilities, but no Plane adapter or target deployment was tested. See the source-linked reports below.

## Proposed destination

Resolve the product and technical decisions required to hand off to `to-spec` for a configurable V1 runner that uses Sandcastle and Codex to deliver another repository's child tickets. This includes a deterministic testing approach that can exercise the orchestration with mocks, without launching real Codex sessions or mutating a live tracker or GitHub repository. Produce a Wayfinder map with decision tickets; the specification, implementation ticket breakdown, and coding follow separately.

The user confirmed this destination and added mock-driven testability as a required part of it.

## Confirmed planning decisions

- V1 is a local, single-Run CLI. Configuration may contain multiple Projects; each invocation selects one Project and Parent Ticket.
- V1 implements GitHub Issues only. A stable tracker adapter boundary permits a future Plane Community adapter; Projects select an implemented adapter through configuration.
- The full orchestration state machine is verified with fake tracker, Git/host, agent, and clock boundaries. Focused local Git integration tests may use temporary repositories. Routine validation requires no real Codex or live GitHub/Plane mutation.

## User-specified requirements

1. A run accepts a parent ticket identifier and selects up to three open, unblocked child tickets.
2. Local Git commands create a separate worktree and branch for each selected ticket from the latest main branch.
3. Parallel Codex sessions use the implement skill and stop after local commits; they do not create PRs.
4. A completed session emits `complete`. The runner pushes and creates a PR, then waits for CI checks when present.
5. CI failures trigger fresh repair sessions allowed to push to the existing PR. Code, not AI, continues monitoring CI and PR state.
6. Once all PRs in the batch are ready, merge them serially in PR creation-time order. Conflicts trigger repair sessions with the same push boundary; the runner retains merge ownership.
7. After merges, create an independent document-maintenance ticket labelled `doc-maintain` when all child tickets are handled or at least three tickets have completed since the previous maintenance ticket. Do not add ticket relationships or links.
8. A document-maintenance session commits locally. The runner owns its PR creation, CI wait, and merge.
9. Continue until every child ticket is handled. All operations outside the explicitly listed AI sessions are deterministic application code.
10. Support only Codex and no-sandbox execution. Model and reasoning effort are configurable.
11. Initially support GitHub Issues. Preserve an extension boundary for future free, self-hosted Plane support and configuration-based use across repositories and trackers.
12. The orchestration must be testable through mocks; routine validation must not require real Codex execution or live GitHub/Plane mutations.

## Evidence

- [Sandcastle integration](sandcastle-feasibility.md): current source, provider behavior, configuration, process and concurrency limitations.
- [Codex execution](codex-feasibility.md): local CLI and implement skill, official non-interactive and configuration documentation.
- [Tracker and PR automation](tracker-feasibility.md): GitHub APIs, readiness and merge semantics, Plane Community evidence.

Feasibility is assessed from documentation and source inspection. It must not be described as a working or tested runner.

## Integration implications

- Git manages commits, branches, pushes, and worktrees. PRs belong to the hosting service and require GitHub APIs or `gh`; this still satisfies the requirement that code owns orchestration.
- Sandcastle supplies agent execution primitives. The runner still needs deterministic scheduling, durable run state, PR/CI coordination, maintenance scheduling, and recovery.
- Process supervision and per-session Git configuration isolation need explicit handling in Sandcastle's no-sandbox path; see the pinned source findings.
- A model completion marker and a successful turn are evidence of a handoff, not proof that a ticket has been delivered. Delivery requires a defined repository/tracker completion contract.
- Readiness can become stale after an earlier PR merges or a repair pushes. Re-evaluate the next PR against its current head and the updated main branch before merging.
- A supported tracker can be selected and configured without editing runner source. Supporting a tracker whose API has no implemented adapter still requires adapter development or an explicitly chosen plugin/configuration interpreter. The desired boundary needs a decision.

## Candidate decision questions

These are an interview agenda, not created or resolved Wayfinder tickets.

1. **Scope and deployment:** Is V1 a local CLI with independent runs per configured project, or one long-lived process serving multiple repositories concurrently? Is Plane adapter implementation deferred while preserving configuration compatibility?
2. **Execution boundary:** How should no-sandbox process cancellation, shared configuration, and target-repository instructions be reconciled with runner ownership? What is the exact final-response and local-commit handoff contract, including no-change outcomes?
3. **Ticket frontier and ownership:** Direct children or all descendants? What ordering selects the next three? How are existing assignees, concurrent runs, dependencies outside the parent, cancelled tickets, and newly added children treated?
4. **PR readiness and integration:** Which checks count, what happens with no checks or checks not yet registered, how are required reviews handled, and what merge method and base-update policy apply? How is order preserved after repairs?
5. **Failure, restart, and deterministic testing:** What retry/timeout limits apply? What must be persisted to recover without duplicate sessions, pushes, PRs, merges, or maintenance tickets? Which ports and clock/process boundaries must be replaceable so the full orchestration can be tested with in-memory or scripted fakes?
6. **Document maintenance:** Does the counter track successfully merged implementation tickets per parent, run, or repository? Does maintenance block the next batch? How are its changed-ticket context and identity recorded without adding links? How are overlapping final/threshold triggers deduplicated and maintenance excluded from recursively triggering itself?
7. **Configuration contract:** Which repository identity, tracker project, state/label mapping, credentials references, skill path, model/effort profiles, and policies vary per project? Can code hosting remain GitHub when the tracker is Plane?

## In-scope fog

The exact acceptance scenarios, operational diagnostics, and deployment/package shape depend on the decisions above. They should become precise tickets only when those dependencies are settled.

## Current planning location

The user selected a new public GitHub repository under `xiakeng` and English issues. [xiakeng/sandcastle-runner](https://github.com/xiakeng/sandcastle-runner) has been created and configured as local `origin`. Local documents and GitHub issues use English; conversation uses Chinese. The local repository still has no commits.

The canonical [Wayfinder map](https://github.com/xiakeng/sandcastle-runner/issues/1) and five decision tickets have been published with native GitHub sub-issue and dependency relationships. The initial frontier contains [Define Delivery Ticket discovery, reservation, and completion](https://github.com/xiakeng/sandcastle-runner/issues/2) and [Choose the supervised Codex execution boundary](https://github.com/xiakeng/sandcastle-runner/issues/3).
