# Sandcastle Runner

Sandcastle Runner is a local CLI for delivering a configured GitHub Parent Ticket. The current
implementation supports supervised startup, complete Delivery Ticket and blocker discovery, and a
deterministic Reservation checkpoint. Later delivery slices will consume the reserved Batch.

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

`logs/` is created when the Run starts. All four prompt files must exist and be nonempty.

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

The Reservation checkpoint returns `incomplete` with a `batch` array and reasons describing reserved,
blocked, externally owned, and previously reserved work; it does not claim delivery. Before reporting
exhaustion or closing the Parent, the Run performs a final complete scan so newly visible work can be
selected.

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
