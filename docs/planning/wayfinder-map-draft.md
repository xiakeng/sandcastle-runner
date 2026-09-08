# Wayfinder Map Draft

This is a review artifact. It is not the canonical GitHub Wayfinder map.

## Destination

Resolve the V1 behavior, configuration, state transitions, failure recovery, and mock-driven verification contract for a configurable local runner that uses Sandcastle and Codex to deliver another repository's child tickets. The completed map must be ready for handoff to `to-spec`.

## Notes

- Planning only. Implementation, `to-spec`, and delivery-ticket breakdown are separate follow-on work.
- Use `grilling` and `domain-modeling` for decision tickets. Use `prototype` for the supervised Codex execution boundary.
- V1 is a local, single-Run CLI. Configuration may contain multiple Projects; each invocation selects one Project and Parent Ticket.
- V1 implements GitHub Issues only. A stable tracker boundary allows a future Plane Community adapter; once an adapter is installed, a Project selects it through configuration.
- Codex is the only agent provider. Agent Attempts run without a sandbox and use configurable model and reasoning effort.
- The full orchestration must be testable with fakes and must not require real Codex, GitHub, or Plane operations. Focused local Git integration tests may use temporary repositories.
- Research context:
  - [Feasibility intake](../research/feasibility.md)
  - [Sandcastle integration](../research/sandcastle-feasibility.md)
  - [Codex execution](../research/codex-feasibility.md)
  - [Tracker and merge automation](../research/tracker-feasibility.md)

## Decisions so far

## Not yet specified

- Operator-visible Run states, diagnostics, and recovery controls after the lifecycle and persistence model are known.
- Exact CLI arguments and configuration-file schema after Project identity and policy boundaries are known.
- Final V1 acceptance scenarios after all lifecycle decisions are resolved.

## Out of scope

- Application implementation, implementation-ticket breakdown, and production rollout.
- Agent providers other than Codex.
- Container or sandbox execution.
- A long-running service, web UI, or remote control plane.
- Implementing the Plane Community adapter in V1.

## Proposed decision tickets

### Define Delivery Ticket discovery, reservation, and completion

Type: `wayfinder:grilling`

Question: Define the exact child scope, ordering, eligibility, blocking and cancellation semantics, concurrent-Run exclusion, reservation mechanism, newly-added-child behavior, and the condition under which a Parent Ticket has no remaining Delivery Tickets.

Blockers: none.

### Choose the supervised Codex execution boundary

Type: `wayfinder:prototype`

Question: Choose and validate the smallest execution boundary that preserves Sandcastle while reliably supervises no-sandbox Codex process trees, isolates concurrent Git configuration, supplies skills and model settings, and produces a verifiable local-commit handoff for implementation and repair Agent Attempts.

Blockers: none.

### Define pull-request readiness and serial integration

Type: `wayfinder:grilling`

Question: Define PR creation ownership, check discovery and empty-check behavior, review and branch-policy handling, CI repair limits, current-base validation, conflict repair, creation-time ordering, merge method, and the evidence that makes a Delivery Ticket complete.

Blockers:

- Define Delivery Ticket discovery, reservation, and completion.
- Choose the supervised Codex execution boundary.

### Define document-maintenance scheduling and delivery

Type: `wayfinder:grilling`

Question: Define the counter scope, trigger deduplication, context supplied without tracker links, label and standalone-ticket behavior, interaction with Batches, failure handling, and completion semantics for document-maintenance work.

Blockers:

- Define Delivery Ticket discovery, reservation, and completion.
- Define pull-request readiness and serial integration.

### Define durable Run state, configuration, and mock verification

Type: `wayfinder:grilling`

Question: Define persisted identities and transitions, restart idempotency, timeouts and retry ceilings, Project configuration and credentials references, adapter boundaries, fake contracts, deterministic clock/process control, and the minimum scenario matrix proving the complete orchestration without live services.

Blockers:

- Define Delivery Ticket discovery, reservation, and completion.
- Choose the supervised Codex execution boundary.
- Define pull-request readiness and serial integration.
- Define document-maintenance scheduling and delivery.

