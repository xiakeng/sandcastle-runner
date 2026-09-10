# Sandcastle Runner V1: ticket delivery orchestration

## Problem Statement

A developer delivering a Parent Ticket through several child tickets must repeatedly select unblocked work, isolate concurrent changes, supervise coding agents, publish pull requests, repair CI and conflicts, integrate changes, verify ticket closure, and maintain project documentation. Manual coordination makes it easy to start blocked work, mistake an agent's completion claim for delivery, merge a Batch prematurely, or lose track of unfinished work.

The developer needs a configurable local CLI that owns this orchestration deterministically while delegating coding to Codex through Sandcastle. Its full behavior must be verifiable without running real agents or modifying live services. V1 deliberately depends on a present, trusted operator for execution failures and does not resume interrupted Runs.

## Solution

An operator selects one configured Project and one Parent Ticket for a Run. The Runner discovers eligible direct children, reserves up to three Delivery Tickets, prepares separate Worktrees and branches from the freshly fetched Target Branch, and runs their implementation Agent Attempts concurrently. Agents check their work and commit locally; the Runner verifies their handoffs and owns all pushes, pull requests, CI monitoring, merges, and tracker mutations.

Every pull request in a Batch must become a CI-ready Pull Request before serial squash integration begins. Delivery requires both a confirmed merge and a ticket confirmed closed with the completed reason. Between successful Batches, the Runner performs Documentation Maintenance when at least three Delivery Tickets have completed since the previous occurrence, or when final Parent closeout is possible and the counter is nonzero. It rescans for newly eligible children and explicitly closes the Parent Ticket only after a complete final scan permits it.

Execution failures enter an Operator Pause after any applicable automatic retry budget. The operator can retry, abort, or supply a trusted successful output. Each invocation has independent in-memory state and a diagnostic JSONL log; a later Run never adopts or cleans up earlier artifacts.

## User Stories

1. As an operator, I want to select a Project and Parent Ticket with one CLI invocation, so that I can deliver work across configured repositories without editing Runner code.
2. As an operator, I want invalid configuration, missing credentials, missing prompts, and unsupported model settings rejected before workflow operations, so that a misconfigured Run does not begin delivery.
3. As an operator, I want an explicit Target Branch or the repository default, so that all delivery in a Run integrates into the intended branch.
4. As an operator, I want only same-repository direct children considered, so that delivery scope remains predictable.
5. As an operator, I want all hierarchy and dependency pages read successfully, so that incomplete discovery cannot be mistaken for completion.
6. As an operator, I want cross-repository children rejected explicitly, so that unsupported work is not silently omitted.
7. As an operator, I want open eligible children selected by issue number in Batches of at most three, so that selection is deterministic and concurrency is bounded.
8. As an operator, I want native blockers outside the Parent Ticket respected, so that dependencies are not bypassed by local scope.
9. As an operator, I want either completed or cancelled blockers to unblock dependent work, so that terminal decisions are respected.
10. As a developer, I want my assigned tickets skipped, so that the Runner does not take over externally owned work.
11. As an operator, I want complete and partial Reservations reported and skipped, so that a new Run does not take over earlier work.
12. As an operator, I want visible Reservations for selected tickets, so that concurrent human activity can recognize Runner ownership under the single-operator convention.
13. As an operator, I want Parent, ticket, and blocker state revalidated at operation boundaries, so that cancellation and scope changes prevent subsequent work.
14. As an operator, I want a cancelled Parent to stop its Run without child mutations, so that Parent cancellation does not rewrite child decisions.
15. As an operator, I want newly visible children included in later scans, so that the Run can continue through evolving delivery scope.
16. As an operator, I want a zero-child Parent to produce no work and stay open, so that absence of a breakdown is not treated as delivery.
17. As an operator, I want blocked, reserved, and externally owned open children identified in the final result, so that incomplete Runs leave an actionable explanation.
18. As a developer, I want isolated Worktrees, branches, and per-Attempt Git configuration, so that concurrent Agent Attempts do not contend on the same working tree or global Git configuration.
19. As an operator, I want configurable Codex model and reasoning effort for each attempt purpose, so that Project execution policy is explicit.
20. As a Project maintainer, I want editable Markdown prompts for implementation, CI repair, conflict repair, and documentation, so that repository-specific instructions remain caller-owned.
21. As an operator, I want agents restricted by their prompt contract to checks and local commits, so that deterministic Runner code owns delivery operations.
22. As an operator, I want structured Agent Attempt Results independently checked against Git, so that false commit claims and dirty Worktrees cannot enter ordinary publication.
23. As an operator, I want one same-session correction opportunity for malformed output, so that formatting errors can be corrected without silently accepting an invalid handoff.
24. As an operator, I want blocked and no-change delivery results reported without publication or completion credit, so that unresolved coding work remains visible.
25. As an operator, I want the Runner to publish one non-draft PR using the agent's title and body, so that PR metadata accompanies a verified change.
26. As an operator, I want only required CI checks to control readiness after a discovery delay, so that empty check sets and optional checks follow the agreed policy.
27. As an operator, I want fresh CI-repair Agent Attempts on the existing branch and PR, so that failures can be repaired without creating replacement delivery artifacts.
28. As an operator, I want every PR in a Batch ready before any merge starts, so that a partially ready Batch cannot begin integration.
29. As an operator, I want squash merges in PR creation order with the observed head SHA, so that integration order and the requested revision are explicit.
30. As an operator, I want an earlier queued merge confirmed before a later PR proceeds, so that a merge request is not mistaken for a completed merge.
31. As an operator, I want explicit merge conflicts repaired on the original branch and PR, so that the Runner can incorporate the current Target Branch without replacing ticket identity.
32. As an operator, I want CI and conflict repair budgets kept separate, so that one failure class does not consume the other class's allowance.
33. As an operator, I want one Project-wide Ticket Closure Policy, so that all PR-backed Delivery Tickets and Maintenance Tickets use consistent closure ownership.
34. As an operator, I want delivery counted only after a merged PR and confirmed completed closure, so that cancelled or merely merged work cannot inflate progress.
35. As an operator, I want already integrated work retained after a later Batch failure, so that recovery never rolls back successful deliveries.
36. As an operator, I want Documentation Maintenance after three completions or before final closeout with pending completion credit, so that documentation catches up at predictable boundaries.
37. As a Project maintainer, I want each documentation surface to own its Documentation Base, so that incremental review remains self-contained without a Runner-generated changed-ticket list.
38. As an operator, I want a standalone labelled Maintenance Ticket for each occurrence, so that documentation work remains visible without entering the Parent's delivery hierarchy.
39. As an operator, I want Documentation Maintenance to finish before the next Batch or Parent closeout, so that maintenance is a delivery barrier within the current Run.
40. As an operator, I want a valid clean no-change maintenance result to close its Maintenance Ticket directly, so that a successful review need not manufacture a commit or PR.
41. As an operator, I want transient external reads retried within fixed limits, so that temporary failures do not immediately require my input.
42. As an operator, I want failed writes paused without automatic replay, so that I choose whether to repeat an operation with uncertain effects.
43. As a trusted operator, I want to retry, abort, or override a failed operation, so that I can supervise exceptional states without a restart-recovery subsystem.
44. As an operator, I want abort and EOF to close active Agent/Sandcastle resources, so that cancellation follows the supported execution lifecycle.
45. As an operator, I want diagnostic events that exclude credentials, raw Agent streams, and raw overrides, so that I can inspect a Run without those values being copied into its audit log.
46. As an operator, I want distinct terminal outcomes and exit codes, so that successful delivery, no work, incomplete work, cancellation, and unrecoverable failure remain distinguishable.
47. As a Runner maintainer, I want the complete orchestration exercised through scripted fakes and a controlled clock, so that tests are deterministic and require no live service mutations.
48. As a Runner maintainer, I want the option to run focused Git integration checks in temporary local repositories, so that I can verify actual Worktree and commit behavior without touching a live repository.
49. As an operator, I want each new Run to ignore earlier recovery state and report ineligible residual work, so that the V1 recovery limitation is explicit.
50. As a Runner maintainer, I want Tracker and CodeHost boundaries separated, so that a future implemented Plane tracker can coexist with GitHub hosting without changing delivery orchestration.

## Implementation Decisions

### Authority and product boundary

- This specification synthesizes the completed [V1 planning map](https://github.com/xiakeng/sandcastle-runner/issues/1) and its five resolved decision tickets. The [final Run/configuration decision](https://github.com/xiakeng/sandcastle-runner/issues/6) supersedes earlier immediate-termination, retry-accounting, logging, and persistence proposals. The [Ticket Closure Policy amendment](https://github.com/xiakeng/sandcastle-runner/issues/4#issuecomment-5590682264) supersedes the original code-host-only closure rule.
- V1 is a local, single-Run CLI. Multiple Projects may be configured; one invocation selects one Project and Parent Ticket. Codex is the sole agent provider and Sandcastle runs without a sandbox. Only GitHub Tracker and CodeHost adapters are implemented.
- The existing configured checkout is the Project's Git working location. The Runner owns dedicated branches and Worktrees. A temporary-clone deployment mode is not part of the resolved V1 contract.
- There is no Project lock, Parent Ticket lock, or cross-process coordination. The operating convention is one developer per Parent Ticket at a time; different Parent Tickets may be processed concurrently. Reservations are best-effort metadata, not atomic exclusion.

### CLI, configuration, and validation

- The CLI provides a `run` command requiring `--project` and `--parent`; the parent value is a GitHub issue number and the project key selects that Project's directory under the Runner repository.
- Each Project has one JSON configuration document, three always-required conventionally named Markdown prompts for implementation, CI repair, and conflict repair, enabled-only review and documentation prompts, and its own log directory. Prompt names and locations are fixed rather than configurable. The exact agreed layout and CLI spelling remain recorded in [decision #6](https://github.com/xiakeng/sandcastle-runner/issues/6#issuecomment-5592352688).
- Configuration includes `repository` in owner/repository form; absolute `checkout`; optional `targetBranch`; `tracker.type`, `tracker.tokenEnv`, `tracker.runnerAccount`, and `tracker.reservationLabel`; `codeHost.type`, `codeHost.tokenEnv`, and `codeHost.adminMerge`; `workflow.review` and `workflow.documentationMaintenance`; `agents.implement`, `agents.ciRepair`, and `agents.conflictRepair`; conditionally required `agents.review` and `agents.documentation`; `timeouts.agentMinutes`, `timeouts.requiredChecksMinutes`, and `timeouts.mergeQueueMinutes`; and `ticketClosure`. Agent profiles contain `model` and `reasoningEffort`.
- Both workflow switches are strict booleans and default to `true` when their field or the workflow object is omitted. The workflow object rejects unknown fields except `$comment`. Enabling a node requires its profile and nonempty fixed prompt; startup errors identify both paths. Disabling it permits both to be omitted and does not read the prompt, while a supplied profile is still validated. Review uses `timeouts.agentMinutes`; it adds no timeout, fallback, compatibility mode, or migration.
- Both adapter types are `github` in V1. Omitting `targetBranch` selects the repository default; the Run then fixes that Target Branch. `ticketClosure` accepts only `runner` or `code_host`.
- Validate configuration, required prompts, credential references, and supported model/effort values before workflow operations. Missing or unsupported values fail explicitly; no model substitution or effort downgrade is permitted.
- `tokenEnv` references an environment variable read at startup and supplied only where needed by the adapter or subprocess. Secrets are not configuration values; missing credentials fail startup and there is no implicit dependency on interactive GitHub CLI authentication.
- Batch size is fixed at three. Retry counts and delays, prompt conventions, and log location are fixed. Alternative configuration roots, dynamic prompt lookup, and schema migrations are excluded.

### Discovery, selection, and Reservations

- Read all pages of same-repository direct children and all native blocker information. Cross-repository children fail the Run; incomplete hierarchy or dependency reads never produce a partial selection or completion decision.
- An eligible Delivery Ticket is open, has no non-runner assignee, has no complete or partial Reservation, and has every native blocker closed. Blockers outside the Parent Ticket count; both `completed` and `not_planned` satisfy a blocker.
- Select eligible tickets by ascending issue number, reserving at most three for a Batch. Log and skip external ownership and complete or partial Reservations.
- A Reservation combines the configured reservation label (the agreed marker is `sandcastle:reserved`) and the runner-account assignee. Partial writes are not compensated, repaired, or rolled back automatically. Their failures follow Operator Pause rules.
- Release Reservations on terminal Delivery Tickets or explicit release. Failed or interrupted work retains its Reservations for manual action; a later Run never adopts them.
- Revalidate Parent Ticket, Delivery Ticket, and blockers at operation boundaries, not continuously during an active operation. Cancellation, external completion, removal from scope, or other terminal changes stop subsequent work; terminal tickets release their Reservations and the outcome is logged.
- A Parent changed to `not_planned` cancels the Run without modifying children. A Parent marked `completed` while a child remains open is contradictory and fails the Run.
- Rescan after every Batch and perform one final complete discovery scan before concluding exhaustion or closing the Parent Ticket. Children visible in those complete scans join the Run; children appearing after the final scan wait for another invocation.
- If no eligible work remains but open blocked, reserved, externally owned, or otherwise unresolved children remain, report `incomplete` and leave the Parent open. An initial complete scan with zero direct children returns `no_work` and leaves the Parent open. Once the Parent has had children, a final complete scan with every child closed permits Parent closure as `completed`, including all-cancelled children.

### Sandcastle execution and verified local handoffs

- Prepare a separate Runner-owned Worktree and branch from a freshly fetched Target Branch commit before initial implementation. Execute the selected Batch's implementations concurrently.
- Invoke Sandcastle with the Worktree as its working directory, the `head` branch strategy, `noSandbox`, one iteration, and no completion-substring signal. Sandcastle owns process launch, streaming, timeout, abort, and termination. Wait for it to settle; no additional operating-system-specific process supervisor is introduced, and V1 claims no stronger process-tree cleanup than Sandcastle provides.
- Every concurrent Agent Attempt receives a unique `GIT_CONFIG_GLOBAL` file through its no-sandbox environment, isolating Sandcastle's Git identity and safe-directory writes from the user's shared global configuration.
- Supply the selected caller-owned Markdown template through `promptFile` and `promptArgs`, and model/effort through the Codex provider. Initial implementation prompts identify the Delivery Ticket and implement skill, absolute Worktree, expected branch, and exact freshly fetched Target Branch base.
- Agents may work in their assigned Worktree, run appropriate checks, and commit locally. All Agent Attempt purposes, including repairs, leave push, PR operations, merge, closure, and other tracker mutations to Runner code. Without a sandbox this is an instruction/ownership contract, not an isolation guarantee.
- Ordinary Agent Attempt output contains exactly one `agent_attempt_result` tag with schema-validated JSON. Common fields are `outcome`, `summary`, `commits`, `checks`, and `blocker`; outcomes are `committed`, `no_change`, or `blocked`, with `blocker` required for `blocked`. Claimed commits contain SHA/message pairs. Checks record command, `passed`/`failed`/`not_run`, and details; claims are evidence rather than authority.
- Initial implementation results provide nonempty `pr_title` and `pr_body` for PR creation. Documentation `committed` results likewise require them; documentation `no_change` and `blocked` results do not. Repair uses the existing PR.
- Missing, malformed, or schema-invalid output permits one resume of the same session solely to re-emit a valid result, using Sandcastle's structured-output mechanism with one iteration and one retry. A second invalid result enters Operator Pause.
- A `committed` result becomes a Verified Handoff only after successful Sandcastle settlement and independent confirmation of the expected Worktree, branch, recorded base, actual new commits, agreement with the claimed commit list, and a clean working tree. A false commit claim, missing commit, mismatched list, dirty Worktree, or other verification failure blocks ordinary publication and enters Operator Pause.
- When enabled, only a committed initial implementation Verified Handoff starts one fresh Review Agent Attempt on the same Worktree and delivery branch. The review prompt receives only `REVIEW_HANDOFF`, containing Runner-owned repository, Target Branch, Worktree, delivery branch, original fixed point, observed implementation HEAD, full Delivery Ticket and governing specification snapshots with sources, applicable standards sources, governing exceptions, and implementation-reported checks as claims. Pull Request metadata remains in Runner state.
- Review invokes `code-review` against the original fixed point, initially covers Standards and Spec, commits fixes locally, and keeps incremental checkpoints and finding retention inside that fresh session. Its strict `review_attempt_result` contains only `outcome` (`passed` or `blocked`), `summary`, separate axis verdicts and unresolved-finding lists, checks, and blocker. Passing requires both axes passing with empty lists; blocked enters ordinary Operator Pause. Structured-output correction, timeout, cancellation, retry, and trusted override use the common Agent Attempt behavior.
- After a passing review, the Runner gates only on a clean Worktree. It does not compare frozen HEAD, branch, or merge-base values. It derives review-only commits from the observed implementation HEAD and complete delivery commits from the original fixed point, preserving the implementation's Pull Request title and body. Disabled Review preserves the existing Verified Handoff path. No Review follows implementation `no_change`/`blocked`, Documentation Maintenance, CI repair, or conflict repair.
- A failed, timed-out, or aborted execution remains failed even if it left commits or output. An operator-authorized retry starts a fresh Agent Attempt. These execution/handoff failures do not consume repair budget.
- An ordinary valid delivery `no_change` must explain the absent commit and pass clean-Worktree verification; it leaves the ticket unresolved for human judgment. A valid delivery `blocked` preserves its explanation and prevents publication. Neither counts as delivery; unresolved work produces `incomplete`.
- The trusted Operator Pause override is the explicit exception to normal result-schema and Verified Handoff validation, as specified below.

### Pull requests, required checks, and serial integration

- The Runner pushes verified commits and creates one non-draft PR on the existing ticket branch with the AI-authored title and body unchanged. It does not synthesize metadata, require a closing keyword, deduplicate PRs, or recover a lost creation response.
- After PR creation or any repair push, wait a fixed 30 seconds before polling required checks. GitHub CLI required-check semantics govern readiness: empty or all-passing returned required checks produce a CI-ready Pull Request; pending checks continue waiting; terminal failure or cancellation starts CI repair. Optional checks do not add a readiness gate.
- Required-check waiting defaults to 60 minutes and is configurable. Timeout enters Operator Pause without consuming a repair attempt. Failed check reads use the external-read retry policy.
- CI repair starts a fresh Agent Attempt on the original branch and PR, supplying failing check names, states, and log links. Publish a Verified repair commit, then repeat discovery delay and required-check polling.
- All PRs in a Batch must be CI-ready before any is merged. If the barrier cannot be satisfied, none in that Batch is merged. After it is satisfied, integrate in ascending PR `createdAt`, breaking ties by PR number; later PRs never overtake earlier ones.
- Request squash merge only, supplying the observed PR head SHA. The Project may enable the merge command's admin bypass. The Runner does not inspect rulesets, classic branch protection, or review state, and does not proactively update a branch or rerun CI solely because the Target Branch advanced.
- A non-conflict merge rejection enters Operator Pause and preserves the original GitHub error. An explicit conflict reported by a merge request starts conflict repair; no speculative conflict-repair attempt is launched.
- Conflict repair uses a fresh Agent Attempt on the existing branch and PR, incorporates the current Target Branch, and commits the resolution. Independently verify and push, then repeat the same 30-second delay and required checks. CI failures after conflict repair use the CI budget.
- If GitHub queues the merge, wait for confirmed `merged=true` before advancing. The configurable queue timeout defaults to 60 minutes; failure/timeout enters Operator Pause.
- CI and conflict repair have independent two-attempt automatic budgets per ticket, also applied to Maintenance Tickets. Schema-valid `blocked` or `no_change` repair results consume an attempt, as does a Verified repair commit proceeding to publication. Agent process failure, timeout, malformed-output exhaustion, or invalid handoff enters Operator Pause without consuming an attempt. If failure remains after two consumed attempts, pause; empty-input retry starts a fresh two-attempt operation budget. Total operator-authorized attempts are unbounded.
- A partially integrated Batch is never rolled back. Already completed deliveries retain their completion evidence; unresolved original PRs, branches, and Reservations remain available for operator action. No maintenance begins from a Batch that has not ultimately completed successfully.

### Completion and Ticket Closure Policy

- A Completed Delivery Ticket requires both a confirmed merged PR and tracker state `closed/completed`. Release of a Reservation, an Agent claim, or merge confirmation alone is insufficient. `not_planned` is handled cancellation, not delivery credit.
- Under `runner`, after merge confirmation close the PR-backed ticket as `completed` and verify its state. Closure mutation failures enter Operator Pause.
- Under `code_host`, rely on the returned AI-authored PR body and the host's closure behavior without synthesizing or requiring linkage. After merge confirmation wait 10 seconds and read the ticket; if still open, wait another 30 seconds and read again. Missing `closed/completed` confirmation is a merged-but-not-completed execution failure and enters Operator Pause. Terminal `not_planned` may release a Reservation but cannot establish completion.
- Apply the same Project-wide policy to PR-backed Maintenance Tickets. Direct Parent closeout and no-PR maintenance closure are separate Runner-owned operations.

### Documentation Maintenance

- When Documentation Maintenance is disabled, do not accumulate credit, evaluate triggers, inspect or create its label, create a Maintenance Ticket, start its Agent Attempt or Pull Request workflow, install a Batch or Parent-closeout barrier, or add a maintenance-specific summary or audit event. Delivery, cancellation, integration, and Parent closeout otherwise continue unchanged.
- When Documentation Maintenance is enabled, start a Run-local completion counter at zero. Increment immediately for each Completed Delivery Ticket in this Run, including completions retained from partial integration. Cancelled tickets, externally completed work without this Run's delivery evidence, and maintenance itself add no credit.
- Evaluate maintenance only after a whole Batch completes successfully. Trigger one occurrence when the counter reaches at least three, or a final complete child scan permits Parent closeout and the counter is nonzero. Coincident triggers produce one occurrence. Reset to zero with no remainder only after maintenance succeeds, because it reviews through the current Target Branch.
- Initial zero-child Runs, all-cancelled Parents, and exhaustion solely due to blocked, reserved, or externally owned work do not independently trigger maintenance. An unsuccessful Batch does not trigger maintenance even if some deliveries already completed.
- Each occurrence creates a new same-repository standalone Maintenance Ticket. Its title is `Maintain project documentation` and body is `Run the configured documentation-maintenance prompt for the current Target Branch.` Ensure `doc-maintain` exists, creating it if absent, and apply it. The ticket has no parent, dependency, assignee, or Reservation. Use normal read/write failure handling; never search for, reuse, or deduplicate earlier Maintenance Tickets.
- Documentation Maintenance is an inter-Batch barrier outside the three Delivery Ticket positions. It must succeed before next-Batch discovery or Parent closure in that Run.
- Prepare a fresh Worktree and branch from the latest Target Branch. Supply the ordinary Maintenance Ticket, Worktree, branch, and fresh base metadata to the editable documentation prompt. Do not supply a completed-ticket list, commit range, or synthesized documentation context.
- Each documentation surface owns its full Documentation Base SHA, discovers changes through the current Target Branch from repository history, reads associated PRs/tickets when its own instructions require them, and advances its base only after complete review. Follow the reference contract identified in [decision #5](https://github.com/xiakeng/sandcastle-runner/issues/5#issuecomment-5590682678).
- A Verified maintenance commit follows ordinary Runner publication, required checks, CI repair, conflict repair, squash merge, and PR-backed closure verification using its unchanged AI-authored PR metadata. Success requires a merged PR and Maintenance Ticket confirmed `closed/completed`.
- A valid maintenance `no_change` explains the absent commit and passes clean-Worktree verification; the Runner directly closes that ticket as `completed`, outside the PR-backed Ticket Closure Policy. A valid `blocked` leaves maintenance unresolved. Operational failures use Operator Pause; abandoned artifacts remain as-is.
- A later Run starts with a zero counter and never rediscovers earlier Maintenance Tickets. It may close an otherwise complete Parent without replacing failed maintenance. A future independently triggered occurrence catches up using Documentation Bases; this cross-Run loss of scheduling credit is accepted.

### Ephemeral state, failure handling, and Operator Pause

- A Run has an ephemeral UUID, in-memory ticket/branch/Worktree/PR identities, phase, Agent Attempt and repair counts, and latest error. The audit log correlates these operations but is never recovery input. No workflow checkpoint or restart metadata is persisted.
- The phase flow covers discovery, reservation, Worktree preparation, implementation, publication, CI wait/repair, merge/conflict repair, completion verification, documentation maintenance, rescan, Parent closeout, and terminal outcome. Operator Pause is an execution event, not a resumable persisted phase.
- A new Run never adopts or automatically removes Reservations, Worktrees, branches, commits, PRs, or Maintenance Tickets from another Run. Residual artifacts making children ineligible are reported as incomplete work; the operator must finish or remove them before another Run can own that work.
- Failed external reads have at most five calls total, separated by fixed five-second delays. This includes GitHub/API reads, remote Git queries, and fetch, but excludes ordinary local Git/filesystem reads. Each external command/API invocation has a fixed 60-second timeout. Exhaustion enters Operator Pause; retry resets the five-call budget.
- Failed external or local workflow writes receive no automatic retry and immediately enter Operator Pause. Other execution-time failures, including local Git/Worktree operations, Agent execution/timeout/handoff failures, exhausted repair, CI or merge waiting timeout, merge or completion failure, and audit failure, also enter Operator Pause.
- An Operator Pause has no timeout. Empty input retries the current operation with its complete automatic budget reset. Exactly `q`, or EOF, aborts, closes active Agent/Sandcastle resources, and ends `cancelled`. Any other input is treated as the current operation's successful output.
- Any nonempty write override suffices. Read or Agent overrides are parsed only enough to obtain downstream-required fields and receive no schema validation or Verified Handoff validation. If necessary fields cannot be extracted, pause again. Do not interpret a non-`q` value as an abort.
- The Runner does not inspect operator changes, reconcile external state, deduplicate effects, or prove override success. Correctness after override belongs to the trusted operator. Repeating a successful-but-unobserved write can produce duplicate/conflicting artifacts; this is an accepted V1 limitation.
- Initial implementation and maintenance have no numeric fresh-Attempt retry ceiling; every such retry requires operator action. Repairs retain the automatic accounting described above until the operator authorizes a new budget.
- Startup validation errors, missing credentials/prompts, unsupported cross-repository children, contradictory terminal Parent state, and ordinary business outcomes bypass Operator Pause.
- Agent Attempt timeout defaults to 120 minutes; required-check and merge-queue timeouts each default to 60 minutes. These three are Project-configurable. The 60-second external-call timeout, five-second read retry delay, 30-second check-discovery delay, and code-host closure reads after 10 and another 30 seconds are fixed.

### Audit and terminal outcomes

- Each Run creates a JSONL file under its Project's log directory, named with UTC timestamp, Parent number, and Run UUID. Workflow operations append separate start, result, and error events.
- Every event contains only `timestamp`, `runId`, `project`, `parentTicket`, `phase`, `operation`, `target`, `attempt`, `result`, and `error`. Exclude tokens, credential values, raw operator input, and raw Agent streams from all event data. Record accepted overrides as `operator_override` when logging is available.
- Log creation/append failures follow Operator Pause: retry retries that log operation; abort cancels; a nonempty override accepts an audit gap. Continue attempting later appends normally. Logs are diagnostic only and never reconstruct state.
- Terminal outcomes are `succeeded` for all owned work completed; `no_work` for an initial complete scan with no children; `incomplete` for remaining blocked/reserved/externally owned or valid blocked/no-change delivery work; `cancelled` for Parent cancellation or operator abort; and `failed` for invalid startup, unsupported/contradictory states, or other unrecoverable errors.
- `succeeded` and `no_work` return exit code zero. Other outcomes return nonzero and print a final structured summary with the relevant reasons. Closing execution resources must respect Sandcastle's supported lifecycle and must not become automatic deletion/adoption of earlier artifacts.

### Orchestration boundaries

- Keep the Run orchestration deterministic behind six agreed boundaries, rather than distributing scheduling decisions across prompts.
- `Tracker` owns Parent/child/dependency/state/closure-reason/assignee/label/Reservation reads and tracker mutations, including maintenance creation and closure.
- `CodeHost` owns repository and PR reads, required-check evidence, mergeability, queues, PR creation, merge requests, and merge confirmation.
- `GitWorkspace` owns Target Branch fetches, Runner-owned Worktree creation/inspection/closure, commit and working-tree verification, and branch pushes.
- `AgentExecutor` owns Sandcastle-backed execution with prompt, Worktree, model, effort, environment, timeout, and resulting output/failure. It is the production process boundary.
- `Clock` supplies time, delays, and timeouts. `OperatorIO` displays pauses and returns operator input.
- Tracker selection and hosting selection stay separate for future adapters. No dynamic adapter/plugin loading is introduced. Configuration and logs use the real filesystem, including temporary directories in tests, without another filesystem abstraction.

## Testing Decisions

- Reuse the testing boundaries already agreed in [decision #6](https://github.com/xiakeng/sandcastle-runner/issues/6#issuecomment-5592352688): the main test entry is a complete Run driven by scripted fakes for Tracker, CodeHost, GitWorkspace, AgentExecutor, Clock, and OperatorIO. This is one high-level orchestration seam backed by the six necessary external boundaries, not a separate mock surface for every function.
- Good tests observe selections, externally visible operation order and effects, publication/merge barriers, completion evidence, operator interactions, summaries, and exit status. Do not assert private helper structure or mirror the implementation. Control concurrent completions and time explicitly rather than relying on real sleeps.
- Routine tests launch no real Codex sessions and mutate no live GitHub, Plane, or remote repository. Configuration and logging tests use temporary real directories. Focused Git integration tests, when included, use temporary local repositories for Worktree/base/commit/dirty-state verification. Do not add a production filesystem port solely for tests.
- Cover every defined phase transition, conditional branch, retry boundary, Operator Pause action, cleanup path, and terminal outcome with at least one focused deterministic scenario. Organize tests around behavioral cases rather than one test per function or numerical coverage targets.
- The scenario matrix includes configuration and credential validation; Project/prompt resolution; pagination and incomplete reads; unsupported hierarchy; blocker scope/order/closure; external ownership; complete/partial Reservations and write failure; boundary revalidation and cancellation; newly added/removed children; initial zero-child and all-terminal Parents; residual artifact rejection; Worktree preparation; per-Attempt Git configuration; every Agent result, output correction, verification failure, and timeout; publication; required-check discovery/empty/pending/failure/cancellation/timeout; independent repair budgets and resets; ordered merge, queue, rejection, conflict, and partial integration; both closure policies; all maintenance triggers, counter outcomes, no-change closure, barrier and abandonment; log failures and omissions; and every Operator Pause input branch including EOF, invalid read/Agent overrides, and accepted audit gaps.
- Verify absence of recovery explicitly: a fresh Run does not adopt or remove prior Reservations, Worktrees, branches, PRs, or Maintenance Tickets, does not reconstruct the documentation counter, and never reads an audit log as workflow state.
- The first complete success scenario has five Delivery Tickets: tickets 1–4 are mutually unblocked; ticket 5 depends on all four. All operations succeed on the first attempt. Assert Batch(1, 2, 3), Documentation Maintenance, Batch(4), Batch(5), final Documentation Maintenance, and completed Parent, in that order.
- A second complete scenario uses the same topology and ultimately succeeds while exercising: external read success on call five; failed write then empty-input retry; Agent process failure then fresh successful attempt; invalid structured output corrected in its original session; invalid Verified Handoff then fresh successful attempt; a nonempty trusted override; CI repair; retried required-check reads; conflict repair; maintenance CI and merge repair; and every delivery and Parent confirmed completed.
- Keep incompatible failure outcomes in focused scenarios instead of forcing them into the successful recovery scenario: `q`/EOF, permanently exhausted reads awaiting input, repeated unusable overrides, valid `blocked`/`no_change`, unsupported children, contradictory Parent state, residual Reservations, and startup failures.
- Prior art is planning evidence, not an existing production suite: the [handoff prototype at the recorded commit](https://github.com/xiakeng/sandcastle-runner/commit/e85e7cb759d2a87a39424caf1d9c05b7281731d9) demonstrates committed, no-change, false-claim, output-correction, and process-failure decisions as a static model. The repository's [Sandcastle feasibility research](https://github.com/xiakeng/sandcastle-runner/blob/main/docs/research/sandcastle-feasibility.md) records execution-boundary evidence. No authenticated Codex or end-to-end Sandcastle execution was established by the prototype; fake acceptance tests must not be reported as such validation.

## Out of Scope

- Plane Community adapter implementation, agent providers other than Codex, sandbox/container execution, stronger OS-specific process supervision, a daemon, web UI, or remote control plane.
- Durable Run state, checkpoints, restart recovery/idempotency, databases, event-sourced workflow storage, automatic adoption/reconciliation/deduplication/cleanup of prior artifacts, and cross-Run documentation scheduling credit.
- Project/Parent locks, atomic Reservations, multi-host coordination, recursive child scope, cross-repository child delivery, or bypassing native blockers to keep a Run busy.
- Dynamic adapter/plugin loading, alternate configuration roots, configurable Batch size/retry constants/prompt names, or schema-version migration.
- PR metadata synthesis, closing-keyword validation, lost-create-response recovery, automatic rollback of integrated work, proactive Target Branch updates solely due to branch advancement, and separate review/ruleset/protection inspection.
- Routine test execution against live Codex, GitHub, Plane, or remote repositories.
- Implementation-ticket breakdown, application implementation, and production rollout as part of this specification-writing task. These follow this implementation-ready contract.

## Further Notes

- Canonical planning sources: [map #1](https://github.com/xiakeng/sandcastle-runner/issues/1), [discovery and completion #2](https://github.com/xiakeng/sandcastle-runner/issues/2), [execution and handoff #3](https://github.com/xiakeng/sandcastle-runner/issues/3), [PR integration and closure amendment #4](https://github.com/xiakeng/sandcastle-runner/issues/4), [Documentation Maintenance #5](https://github.com/xiakeng/sandcastle-runner/issues/5), and [final state/configuration/testing contract #6](https://github.com/xiakeng/sandcastle-runner/issues/6).
- The resolved issue comments take precedence over stale feasibility proposals and the earlier local map draft. In particular, V1 has no durable recovery, agents never own repair pushes, the structured result replaces the early completion substring, Target Branch replaces assumptions about main, and operational/audit failures use Operator Pause rather than automatic termination.
- Existing Project terminology is retained: Project, Target Branch, Run, Operator Pause, Batch, CI-ready Pull Request, Delivery Ticket, Completed Delivery Ticket, Documentation Base, Documentation Maintenance, Maintenance Ticket, Ticket Closure Policy, and Agent Attempt.
- This document is a synthesis of accepted decisions, not evidence of an implemented or end-to-end-tested Runner. Testing seams and the extensive scenario requirement were already resolved in #6; no new test boundary is proposed here.
