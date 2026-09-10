# Sandcastle Runner

Sandcastle Runner is a local CLI for delivering a configured GitHub Parent Ticket. The current
implementation supports supervised startup, complete Delivery Ticket and blocker discovery,
Reservations, Sandcastle-backed implementation through independently Verified Handoffs, and
publication through required CI readiness observation. It repairs failed required checks and
explicit merge conflicts on their existing branches and Pull Requests, then counts delivery only
after both the merge and completed ticket closure are confirmed.

## Project configuration

Create one fixed-layout directory under this repository:

```text
projects/<project-key>/
├── config.json
├── prompts/
│   ├── implement.md
│   ├── ci-repair.md
│   ├── conflict-repair.md
│   └── documentation.md  # required when Documentation Maintenance is enabled
└── logs/
```

`logs/` is created when the Run starts. The implementation and repair prompts must exist and be
nonempty. The documentation prompt is required only when Documentation Maintenance is enabled. The
implementation prompt may use `{{TICKET_NUMBER}}`, `{{TICKET_REFERENCE}}`, `{{IMPLEMENT_SKILL}}`,
`{{WORKTREE_PATH}}`, `{{SOURCE_BRANCH}}`, `{{BASE_SHA}}`, and `{{PROJECT_TARGET_BRANCH}}`.
`SOURCE_BRANCH` is Sandcastle's built-in delivery branch; `PROJECT_TARGET_BRANCH` is the Project
Target Branch. Custom prompts must not pass or override Sandcastle's built-in `TARGET_BRANCH`, which
has head-strategy semantics distinct from the Project Target Branch. The prompt must restrict the
Agent Attempt to checks and local commits and request one `<agent_attempt_result>` JSON tag with
`outcome`, `summary`, `commits`, `checks`, `blocker`, `pr_title`, and `pr_body`.
The CI-repair prompt receives the same arguments plus `{{PULL_REQUEST_NUMBER}}`,
`{{PULL_REQUEST_URL}}`, and `{{FAILED_CHECKS}}`, a JSON array of failing check names, states, and
links. Repair PR metadata is ignored because the Runner retains the original Pull Request.
The conflict-repair prompt receives the Pull Request arguments plus `{{TARGET_BRANCH_SHA}}` and
`{{MERGE_CONFLICT}}`. The first is the freshly fetched Target Branch commit; the second is the
explicit conflict reported by the merge request.
The documentation prompt receives `{{TICKET_NUMBER}}`, `{{TICKET_REFERENCE}}`,
`{{WORKTREE_PATH}}`, `{{SOURCE_BRANCH}}`, `{{BASE_SHA}}`, and `{{PROJECT_TARGET_BRANCH}}`. It owns
each documentation surface's full Documentation Base and receives no completed-ticket list, commit
range, or synthesized context. Existing custom prompts must replace `BRANCH` with `SOURCE_BRANCH`
and `TARGET_BRANCH` with `PROJECT_TARGET_BRANCH`.

```json
{
  "repository": "owner/repo",
  "checkout": "/absolute/path/to/repo",
  "targetBranch": "main",
  "tracker": {
    "type": "github",
    "tokenEnv": "GH_TOKEN",
    "runnerAccount": "user-or-bot",
    "reservationLabel": "sandcastle:reserved"
  },
  "codeHost": {
    "type": "github",
    "tokenEnv": "GH_TOKEN",
    "adminMerge": false
  },
  "workflow": {
    "documentationMaintenance": true
  },
  "agents": {
    "implement": { "model": "gpt-5.6-sol", "reasoningEffort": "high" },
    "ciRepair": { "model": "gpt-5.6-sol", "reasoningEffort": "high" },
    "conflictRepair": { "model": "gpt-5.6-sol", "reasoningEffort": "high" },
    "documentation": { "model": "gpt-5.6-sol", "reasoningEffort": "high" }
  },
  "timeouts": {
    "agentMinutes": 120,
    "requiredChecksMinutes": 60,
    "mergeQueueMinutes": 60
  },
  "ticketClosure": "runner"
}
```

`targetBranch` may be omitted to resolve the Project's Target Branch through CodeHost. Both adapter
types must be `github`. Supported models are `gpt-5.2`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`,
`gpt-5.6-terra`, and `gpt-6-astra`; reasoning effort must be `low`, `medium`, `high`, or `xhigh`.
`ticketClosure` must be `runner` or `code_host`. The named credential environment variables must be
set; interactive `gh auth` is not used as a fallback. `workflow.documentationMaintenance` must be a
boolean and defaults to `true` when either it or `workflow` is omitted. Workflow rejects unknown
fields except `$comment`; `review` is also recognized for its owning review delivery. When
Documentation Maintenance is disabled, `agents.documentation` and `prompts/documentation.md` may be
omitted, the prompt is not read, and any supplied documentation profile is still validated.

## Run

```sh
npm ci
npm exec -- sandcastle-runner run --project <project-key> --parent <issue-number>
```

The CLI prints one JSON summary. `succeeded` and `no_work` exit with zero; `incomplete`, `cancelled`,
and `failed` exit nonzero. An initial complete scan with no children returns `no_work` and keeps the
Parent open. An all-terminal child set closes an open Parent as completed. A cancelled Parent stops
without changing children.

Discovery reads every direct-child and native-blocker page before selecting work. An eligible
Delivery Ticket is open, has no external assignee or existing complete/partial Reservation, and has
only completed or cancelled blockers. The Run selects the three lowest issue numbers and writes the
configured Reservation label before the runner-account assignee. It revalidates Parent, scope,
ticket, and blockers between operations; terminal tickets release their Reservation. Failed or
interrupted work keeps any partial marker for manual action rather than attempting rollback.

The Runner freshly fetches the Target Branch once for a reserved Batch, creates a unique branch and
Worktree for each Delivery Ticket at that exact commit, and starts the Agent Attempts concurrently.
Each Attempt gets an isolated temporary `GIT_CONFIG_GLOBAL`, the configured model, effort and agent
timeout, and the caller-owned implementation prompt. The temporary Git configuration is removed after
Sandcastle settles; unresolved branches and Worktrees remain for operator action. Verified Handoffs
are pushed with the configured code-host credential and published concurrently as non-draft Pull
Requests using their AI-authored title and body unchanged. The Runner waits 30 seconds, then polls
each Pull Request's required checks through GitHub CLI semantics. Empty, passing, or skipped
required-check sets are CI-ready; pending checks are polled every 10 seconds; failed or cancelled
checks start a fresh CI-repair Agent Attempt on that Worktree and branch. A Verified repair is pushed
by the Runner and repeats the full 30-second discovery and readiness path on the same Pull Request.
Read failures use the common retry policy, and the configured required-check timeout enters Operator
Pause.

Each CI-repair operation automatically consumes at most two valid `blocked`, `no_change`, or Verified
repair results. Agent execution and handoff failures pause without consuming that budget; empty input
retries with a fresh Agent Attempt. Exhaustion enters Operator Pause, where empty input starts a fresh
two-attempt budget, nonempty input acknowledges trusted readiness, and `q` or EOF cancels the Run.

Only an explicit merge conflict starts conflict repair; an advanced Target Branch or ordinary merge
rejection does not. The Runner freshly fetches the Target Branch, starts a conflict-repair Agent
Attempt on the existing Worktree and branch, independently verifies and pushes its commit, and
confirms the fetched Target Branch commit is an ancestor before pushing. It then repeats
required-check discovery on the original Pull Request before retrying its ordered merge.
Conflict repair has its own two-consumed-attempt budget with the same reset, override, and
cancellation behavior as CI repair. A CI failure after conflict repair uses only the CI budget.

No Pull Request in a Batch is merged until every selected Agent Attempt produced a Verified Handoff
and every published Pull Request is CI-ready. The Runner then orders the Batch by Pull Request
`createdAt`, using the Pull Request number as the tie-breaker, and integrates one at a time. It
observes each head SHA and requests a squash merge with the configured admin setting. Queue
acceptance is not delivery: the Runner waits up to `mergeQueueMinutes` for confirmed merge state
before advancing. Under `runner`, it then closes the Delivery Ticket; under `code_host`, it waits 10
seconds and, if necessary, another 30 seconds for GitHub closure. Only `closed/completed` records
completion credit. Rejections, queue timeout, closure failure, and missing completion evidence use
Operator Pause; completed merges are never rolled back and an earlier unresolved merge cannot be
overtaken.

After every successful Batch, the same Run performs a complete rescan so newly visible or newly
unblocked work can be selected. Before reporting exhaustion or closing the Parent, it performs a
final complete scan. Only an initially empty Parent returns `no_work`; if a Parent had children
earlier in the Run and a later scan becomes empty, that scan proceeds through Parent closeout.

When Documentation Maintenance is enabled, each confirmed Completed Delivery Ticket adds one
Run-local documentation credit. After a successful Batch, three credits trigger a standalone
`doc-maintain` Maintenance Ticket before the next rescan; a final closeout scan also triggers one when
any credit remains. Maintenance uses a fresh Worktree, the documentation prompt/profile, and the
ordinary PR, CI/repair, merge, and closure path. A clean `no_change` result closes the Maintenance
Ticket directly. Successful maintenance resets the counter to zero; blocked or failed maintenance
leaves its artifacts unresolved and stops the Run. When disabled, the Run creates no maintenance
credit, label, ticket, Agent Attempt, Pull Request workflow, closeout barrier, summary reason, or audit
event; Delivery Tickets and Parent closeout continue normally.

External reads make at most five calls with five-second gaps. After exhaustion, or immediately after
a failed write, the Run enters an Operator Pause: Enter retries, exactly `q` or EOF cancels, and any
other input supplies a trusted successful result. Trusted overrides are not reconciled; the audit
records `operator_override` but never the raw override input.

Each invocation creates a fresh UUID and diagnostic JSONL file under the Project's `logs/` directory.
Logs are never read as recovery state, and a new invocation does not adopt or remove earlier artifacts.

## Verify

```sh
# The two composed five-ticket acceptance scenarios
node --test tests/run/full-contract.test.ts

# The complete behavioral, adapter, formatting, lint, and type-check suite
npm run verify
```

The acceptance suite uses the real CLI and Run orchestration with scripted `Tracker`, `CodeHost`,
`GitWorkspace`, `AgentExecutor`, `Clock`, and `OperatorIO` boundaries plus temporary real Project
configuration and JSONL log directories. It performs no authenticated Codex/Sandcastle execution,
live GitHub mutation, or remote Git mutation.

| V1 contract evidence | Runnable scenarios |
| --- | --- |
| Complete first-try and longest practical recovery Runs | `five Delivery Tickets complete through both maintenance barriers on the first try`; `the five-ticket topology succeeds through the composed recovery path` |
| Startup, read/write retry, Operator Pause, and audit gaps | `startup validation errors return a failed summary without workflow or pause`; `an external read succeeds on the fifth call with fixed delays`; `a failed Parent close pauses immediately and retries only after empty input`; `an accepted audit creation gap does not suppress later appends` |
| Discovery, blockers, Reservations, revalidation, and closeout | `eligibility reports ownership and Reservations after complete blocker pagination`; `successive revalidation changes cannot hide newly eligible work`; `the final complete scan closes a now-terminal Parent scope` |
| Agent process failure, result correction, Verified Handoff failure, and override | `the five-ticket topology succeeds through the composed recovery path`; `SandcastleAgentExecutor supplies the complete controlled Codex invocation`; `empty input starts a fresh Agent Attempt with a new Git configuration`; `a trusted committed override extracts only downstream metadata and bypasses Git verification` |
| Publication, CI repair, conflict repair, merge confirmation, and closure | `a Verified Handoff is published unchanged and becomes CI-ready after check discovery`; `failed required checks are repaired on the existing branch and Pull Request`; `an explicit merge conflict is repaired on the original branch and Pull Request`; `a CI-ready Pull Request is delivered only after its merge and completed closure are confirmed` |
| Batch concurrency, all-ready barrier, ordered integration, rescans, and maintenance | `a reserved Batch runs its Agent Attempts concurrently`; `a Batch publishes every PR before merging by creation order`; both five-ticket scenarios; `Documentation Maintenance reuses CI and conflict repair on its original Pull Request` |
| Focused terminal outcomes and no restart/adoption | `q and EOF at an exhausted external read cancel the Run`; `valid no_change and blocked results stay unresolved without handoffs`; `a cross-repository child fails explicitly without Operator Pause`; `a completed Parent with an open child fails as contradictory`; `open children return an actionable incomplete summary`; `blocked Documentation Maintenance is preserved but ignored by a later Run`; `a fresh Run ignores existing audit logs` |
