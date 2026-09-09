# Sandcastle Runner

Sandcastle Runner is a local CLI for delivering a configured GitHub Parent Ticket. The current
implementation supports supervised startup, complete Delivery Ticket and blocker discovery,
Reservations, and Sandcastle-backed implementation through independently Verified Handoffs. A later
delivery slice will publish those handoffs.

## Project configuration

Create one fixed-layout directory under this repository:

```text
projects/<project-key>/
├── config.json
├── prompts/
│   ├── implement.md
│   ├── ci-repair.md
│   ├── conflict-repair.md
│   └── documentation.md
└── logs/
```

`logs/` is created when the Run starts. All four prompt files must exist and be nonempty. The
implementation prompt may use `{{TICKET_NUMBER}}`, `{{TICKET_REFERENCE}}`, `{{IMPLEMENT_SKILL}}`,
`{{WORKTREE_PATH}}`, `{{BRANCH}}`, `{{BASE_SHA}}`, and `{{TARGET_BRANCH}}`. It must restrict the
Agent Attempt to checks and local commits and request one `<agent_attempt_result>` JSON tag with
`outcome`, `summary`, `commits`, `checks`, `blocker`, `pr_title`, and `pr_body`.

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
set; interactive `gh auth` is not used as a fallback.

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
are returned in the `incomplete` summary until the publication slice consumes them.

Before reporting exhaustion or closing the Parent, the Run performs a final complete scan so newly
visible work can be selected.

External reads make at most five calls with five-second gaps. After exhaustion, or immediately after
a failed write, the Run enters an Operator Pause: Enter retries, exactly `q` or EOF cancels, and any
other input supplies a trusted successful result. Trusted overrides are not reconciled; the audit
records `operator_override` but never the raw override input.

Each invocation creates a fresh UUID and diagnostic JSONL file under the Project's `logs/` directory.
Logs are never read as recovery state, and a new invocation does not adopt or remove earlier artifacts.

## Verify

```sh
npm run verify
```
