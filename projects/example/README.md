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
new disposable Worktree rather than adopting old local artifacts. Once publication starts, the
snapshot records each Ticket's stable remote branch, intended head, exact PR title/body, and
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
