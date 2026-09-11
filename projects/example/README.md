# Example Project

This directory is a complete Linux Project template for Sandcastle Runner.

## Set up

1. Install Node.js with npm, Git, GitHub CLI, and Codex for Sandcastle.
2. Copy this directory to `projects/<project-key>`.
3. In `config.json`, replace `owner/repo`, `/absolute/path/to/repo`, and `user-or-bot`. The checkout must be an absolute path to the target repository. Change `targetBranch` if its Target Branch is not `main`.
4. Export a GitHub token under the configured name: `export GH_TOKEN=...`. Keep the token outside the configuration file.
5. Edit the five prompt files for the target repository without changing their placeholder contracts.
6. Ensure the target repository's agent instructions permit Agent Attempts to inspect, edit, check, and commit in the supplied Worktree while the Runner owns push, Pull Request and CI operations, merge, and tracker mutation. The Runner does not parse or rewrite those instructions.
7. From the Sandcastle Runner repository, run `npm ci`, then `npm exec -- sandcastle-runner run --project <project-key> --parent <issue-number>`.

Both workflow switches are enabled in this example. Either may be set to `false` independently. A disabled node may omit its profile and prompt; supplied profiles are still validated. See the root `README.md` for the complete schema, defaults, and placeholder sets.

On Linux, each Parent Ticket has a separate lock and durable state file under
`projects/<project-key>/state/parent-<number>.{lock,json}`. Keep the state files permanently;
they are the restart source, unlike `logs/`. A missing state file starts fresh, malformed state
pauses for operator repair, and an unpublished restart uses a newly fetched Target Branch and a
new disposable Worktree rather than adopting old local artifacts. A missing snapshot does not
search remote artifacts, so duplicate publication remains possible. Persisted configuration
identities are retained for context but are not compared with the current configuration. Once
publication starts, the snapshot records each Ticket's stable remote branch, intended head, exact
PR title/body, and
completion evidence. An absent pending branch restarts from a fresh base. A matching branch with no
PR creates one only after a second head check; exact existing PR identity is adopted. Unexpected or
ambiguous artifacts pause without force-push or metadata rewriting.
The snapshot also records the original Batch order and completed Delivery Ticket numbers. Recovery
replays only unfinished Batch members, keeps their publication evidence, and credits each Delivery
Ticket once after merge plus confirmed closure; completed evidence is retained permanently.
CI and conflict repairs use a new Worktree for every attempt. Repair budgets, launch identity,
remote base, and pending push intent are retained in the Parent snapshot. A restart adopts only an
exact intended head; an externally advanced stable branch pauses, and no repair uses a force-push or
an old Worktree.
After confirmed `closed/completed` or `closed/not_planned` closure for Delivery and standalone
Maintenance Tickets, terminal cleanup removes only registered repository Worktrees under the
configured root with the exact Ticket delimiter prefix, records cleanup evidence, and leaves remote
delivery branches untouched. This intentionally risks abandoned unpublished local work; failed cleanup
pauses for retry or a trusted residual override, and never repeats delivery or completion credit.

Enabled Documentation Maintenance records its active Ticket, phase, credit, and barrier in the Parent
snapshot before side effects. Startup retries that same Ticket before Delivery discovery or Parent
closeout, including pending no-change closure and published repair states. A blocked or failed occurrence
remains a recoverable barrier. Disabling maintenance atomically forgets only unfinished maintenance
state without touching its Ticket, branch, Pull Request, or Worktree; terminal records remain and
re-enabling does not rediscover the forgotten occurrence. Lost-create and redundant-occurrence
windows are accepted for maintenance scheduling, so it is not exactly-once; disabled maintenance
performs no artifact reads, reconciliation, execution, or cleanup. Delivery completion remains
exactly-once after merged plus completed closure. Old Agent Attempts are unmanaged and may continue;
unpublished Worktrees are disposable and may be removed after terminal tracker confirmation.
