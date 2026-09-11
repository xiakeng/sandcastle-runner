# Code Architecture

Use this map to decide where TypeScript code belongs. It describes the intended
V1 layout, not existing implementation. Create each module when implementation needs
its behavior; keep small helpers inside their owner. `npm run check` owns
formatting, lint, and type diagnostics.

## Directory ownership

```text
src/
  cli.ts          Command parsing, production wiring, exit status
  config.ts       Project configuration, credentials, prompt paths
  audit.ts        Diagnostic JSONL serialization and filesystem writes
  recovery.ts     Per-Parent lock and durable recovery snapshot I/O
  run/            Workflow decisions and in-memory Run state
  adapters/       GitHub, Git, Sandcastle, clock, and terminal operations
tests/
  recovery.test.ts Recovery snapshot and lock behavior
  run/            Behavioral scenarios through the real Run
  adapters/       Production adapter contract checks
  support/        Scripted fakes and controlled time
  integration/    Optional checks using temporary local Git repositories
```

`cli.ts` constructs adapters and passes them to the Run entry point. Keep it
importable without starting a process so tests can exercise command handling.
`config.ts` reads and validates Project files and resolves credential references;
it does not select tickets or start agents. Project JSON, Markdown prompts, and
logs remain external files in their configured locations, not embedded source.

## Workflow modules

Place these modules under `src/run/`. Each owns a cohesive workflow responsibility.

| Module | Code that belongs here |
| --- | --- |
| `run.ts` | Public Run entry point; Run-local state; Batch concurrency, all-ready barrier, ordered integration, rescans, maintenance scheduling, and terminal outcomes. |
| `discovery.ts` | Eligibility, Reservations, Parent/child/blocker revalidation, exhaustion, and Parent closeout eligibility. |
| `attempt.ts` | Worktree preparation, per-Attempt Git configuration, prompt metadata, Agent Attempt Result parsing/correction, and Verified Handoff decisions using observed Git state. Reused for implementation, repairs, and maintenance. |
| `pull-request.ts` | Separate publication/readiness and integration operations; push, required-check polling, CI/conflict repair budgets, merge confirmation, and Ticket Closure Policy. It never decides Batch order. |
| `maintenance.ts` | One maintenance occurrence: ticket creation, documentation attempt, ordinary PR lifecycle reuse, or direct no-change closure. Scheduling and completion credit stay in `run.ts`. |
| `cleanup.ts` | Terminal Worktree enumeration, exact ownership matching, removal, and retry evidence. |
| `operations.ts` | Shared external-read retry and Operator Pause control, cancellation, and operation audit events. Preserve separate normal-result validation and trusted-override handling. |
| `contracts.ts` | The six injected interfaces and cross-module input/result types. Keep operation-specific types beside their owner. |

Keep audit serialization and file writes in `audit.ts`; workflow policy for audit
failures belongs in `operations.ts`. Configuration and audit use the filesystem
directly, including temporary directories in tests; add no filesystem interface.

## Adapters and dependency direction

Under `src/adapters/`, implement only operations the current implementation needs:

| File / interface | Responsibility |
| --- | --- |
| `github-tracker.ts` / `Tracker` | Issue hierarchy, dependencies, state, assignees, labels, and issue mutations. |
| `github-code-host.ts` / `CodeHost` | Repository metadata, PRs, required checks, merge requests, and queue observations. |
| `git-workspace.ts` / `GitWorkspace` | Fetch, Worktree creation/inspection/closure, commits, working-tree evidence, and push. |
| `sandcastle.ts` / `AgentExecutor` | Sandcastle invocation, streaming, session continuation, timeout/abort, and settlement. Delegate process lifecycle to Sandcastle. |
| `clock.ts` / `Clock` | Time, delays, and timeouts. |
| `terminal.ts` / `OperatorIO` | Display and input/EOF; workflow code interprets operator decisions. |

`cli.ts` imports workflow and concrete adapters. Workflow code imports contracts,
never concrete adapters. Adapters implement contracts and translate external
data; they do not call workflow modules or decide eligibility, retries, repair,
or completion. The two GitHub adapters may share private transport code while
retaining separate responsibilities.

Within the workflow, `run.ts` coordinates discovery, attempts, PR operations, and
maintenance. Maintenance reuses attempts and PR operations; PR repairs reuse
attempts. Lower-level modules never call back into `run.ts`. Keep Run state
in-memory and instance-owned; audit logs are not recovery storage.

## Evolving the structure

When this layout no longer fits the current implementation needs, adapt it.
Keep related behavior together, give each module a clear responsibility, and
maintain explicit, acyclic dependencies. Place tests with the behavior they verify
within the test layout.

Update this document in the same change to reflect the resulting directories,
module responsibilities, and dependency direction. Keep the documented structure
aligned with the code as it evolves.
