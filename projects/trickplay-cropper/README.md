# Project Template

This directory is a project template for Sandcastle Runner. Copy it to `projects/<project-key>` and adapt `config.json` and the prompts.

## Checkout installation contract

The Runner is used from a checkout only. From the repository root, run:

```sh
npm ci
npm exec -- sandcastle-runner run --project <project-key> --parent <issue-number>
```

This repository is not published for registry installation, global installation,
remote `npx`, or a native Runner installer, and it does not bundle Node.js, npm,
Git, GitHub CLI, or Codex. Install those prerequisites separately and keep
their executables on `PATH` in the terminal that invokes the Runner.

### Required tools on every native OS

- Node.js **>=22.18.0**, with its bundled npm.
- Git, GitHub CLI (`gh`), and an installed, authenticated Codex CLI.
- An absolute checkout path for the target repository.

Install prerequisites with the native vendor installer or maintained package
manager for your host: [Node.js](https://nodejs.org/en/download), [Git for
Windows](https://git-scm.com/install/windows) / [Git for macOS](https://git-scm.com/install/mac) /
[Git for Linux](https://git-scm.com/install/linux), [GitHub CLI](https://github.com/cli/cli#installation),
and [Codex CLI](https://learn.chatgpt.com/docs/codex/cli). On macOS, Xcode
Command Line Tools also provide Git; on Windows, reopen native PowerShell
after installation so `PATH` changes apply. No Codex version floor is claimed
by this project.

Check the tools before a Run. Use `command -v node npm git gh codex` on macOS
and Linux, or `Get-Command node, npm, git, gh, codex` in PowerShell, and verify
that `node --version` is `v22.18.0` or newer. `npm --version`, `git --version`,
`gh --version`, and `codex --version` must also succeed.
Authenticate Codex with the [Codex CLI instructions](https://learn.chatgpt.com/docs/codex/cli)
and verify `codex login status`. API-key authentication may use
`OPENAI_API_KEY` in the process environment; ChatGPT authentication uses
Codex's supported local sign-in. Keep these credentials out of `config.json`.

### Credentials

Set the environment variable named by both `tracker.tokenEnv` and
`codeHost.tokenEnv` in `config.json` (this template uses `GH_TOKEN`) before
invoking the Runner:

```sh
export GH_TOKEN='your-github-token'       # macOS/Linux
```

```powershell
$env:GH_TOKEN = 'your-github-token'       # Windows PowerShell
```

The token must be present in the process environment; never commit it. The
Runner uses non-interactive GitHub operations, so interactive `gh auth login` is
not used. Missing tools fail on first use through the existing logical-command
error path.

These instructions cover native macOS, Windows, and Linux checkout use. They
do not promise a broader OS/tool-version matrix, permanent cross-platform CI
coverage, WSL-specific behavior, or a real Codex/Sandcastle integration.

## `config.json`

- `repository`: GitHub repository in `owner/name` form.
- `checkout`: absolute path to that repository.
- `targetBranch`: branch to update.
- `tracker`: GitHub settings: `tokenEnv` names the credential variable; `runnerAccount` is the bot/user; `reservationLabel` marks reserved tickets.
- `codeHost`: GitHub settings; `tokenEnv` names the credential variable and `adminMerge` controls administrative merge requests.
- `workflow.review`: enable or disable the review attempt.
- `workflow.documentationMaintenance`: enable or disable Documentation Maintenance.
- `agents`: model and reasoning effort for `implement`, `review`, `ciRepair`, `conflictRepair`, and `documentation` attempts. `review` and `documentation` are needed only when enabled.
- `timeouts`: positive minute limits for agent attempts, required checks, and merge queue confirmation.
- `ticketClosure`: `runner` or `code_host`.
- `maintenanceTicket`: title, body, and `doc-maintain` label for maintenance tickets.

Keep credentials in the environment, for example `export GH_TOKEN=...`. Both workflow switches default to `true` when omitted. `$comment` fields are ignored.

## Documentation Maintenance workflow

Each completed Delivery Ticket adds one credit. Three credits schedule one maintenance ticket; remaining credits schedule one at final closeout.

```mermaid
flowchart TD
    A[Delivery Ticket closes] --> B[Add maintenance credit]
    B --> C{Three credits or final closeout?}
    C -- No --> D[Continue delivery]
    C -- Yes --> E[Create or resume doc-maintain ticket]
    E --> F[Run documentation prompt]
    F --> G{Result}
    G -- no_change --> H[Close maintenance ticket]
    G -- committed --> I[Review, publish, checks, repair, and merge]
    I --> J[Close maintenance ticket and reset credits]
    G -- blocked or failed --> K[Pause and retain barrier for recovery]
```

With `documentationMaintenance: false`, unfinished maintenance state is forgotten without reading or changing its ticket or artifacts; re-enabling does not rediscover it.

## Review enabled versus disabled

```mermaid
flowchart TD
    A[Implementation attempt] --> B{workflow.review}
    B -- true --> C[Fresh-context review]
    C --> D{Review passes?}
    D -- No --> E[Fix, commit, and review again]
    E --> C
    D -- Yes --> F[Publish pull request]
    B -- false --> F
    F --> G[Checks, repair if needed, merge, and close ticket]
```

## Prompt placeholders

- `implement.md`: `TICKET_NUMBER` (issue number), `TICKET_REFERENCE` (authoritative issue reference), `WORKTREE_PATH` (isolated worktree), `SOURCE_BRANCH` (delivery branch), `BASE_SHA` (worktree base commit), `PROJECT_TARGET_BRANCH` (configured target branch).
- `ci-repair.md`: the implementation fields above, plus `PULL_REQUEST_NUMBER` and `PULL_REQUEST_URL` (existing pull request), and `FAILED_CHECKS` (failed required checks and links).
- `conflict-repair.md`: the same ticket, worktree, branch, and base fields, plus `PULL_REQUEST_NUMBER`, `PULL_REQUEST_URL`, `TARGET_BRANCH_SHA` (fresh target branch commit), and `MERGE_CONFLICT` (reported conflict details).
- `documentation.md`: `TICKET_NUMBER`, `TICKET_REFERENCE`, `WORKTREE_PATH`, `SOURCE_BRANCH`, and `PROJECT_TARGET_BRANCH`.
- `review.md`: `REVIEW_HANDOFF`, a JSON review context containing repository, branches, worktree, fixed point, ticket/spec snapshots, instructions, and reported checks.

## Run

From the Sandcastle Runner repository:

```sh
npm ci
npm exec -- sandcastle-runner run --project <project-key> --parent <issue-number>
```
