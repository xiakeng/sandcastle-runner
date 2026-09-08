# Codex execution feasibility

Status: preliminary feasibility research, not an implementation or an end-to-end validation.
Checked: 2026-09-08.

## Verified capabilities

- The installed executable is `/home/xiakeng/.local/bin/codex`, version `codex-cli 0.153.4`. Its `exec --help` exposes non-interactive execution, `--cd`, `--model`, config overrides, `--json`, `--output-schema`, `--output-last-message`, and `--dangerously-bypass-approvals-and-sandbox`.
- Official documentation describes JSONL events including `thread.started`, `turn.completed`, `turn.failed`, and `error`. A final response can be written separately or constrained by a JSON schema. Existing CLI authentication is reused by default. [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- The configuration supports `model_reasoning_effort`; supported effort values depend on the selected model and client. Configuration must not silently substitute a model or downgrade an unsupported effort. [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- Codex supports explicit skill invocation with `$skill`. The runner should explicitly name the installed implement skill and supply its path/context, rather than assume an interactive slash command is a programmatic RPC. [Build skills](https://learn.chatgpt.com/docs/build-skills)
- The installed `/home/xiakeng/.agents/skills/implement/SKILL.md` requests implementation, appropriate testing, code review, and a commit on the current branch. It does not require creating a PR. This is local evidence, not a guarantee about another target repository's instructions.

## Proposed handoff contract, pending decisions

The requested final `complete` marker is technically feasible. Accept it only from the final agent response associated with the launched session, alongside successful process completion and deterministic checks of the expected worktree, branch, commit, and working tree. Do not match arbitrary output substrings: source files, tool output, and quoted instructions can contain the same word.

`turn.completed` alone means that a model turn completed, not that the ticket's acceptance criteria were satisfied. A marker without a usable local commit must have an explicit no-change or failure path.

Implementation and document-maintenance sessions end after local commits. CI/conflict repair sessions may push to the existing PR branch as requested. The runner owns PR creation, CI polling, readiness decisions, merge sequencing, and tracker state updates. A subsequent session's repair input should contain the exact branch/head, failed checks/log evidence, and allowed write boundary.

In no-sandbox mode this division is an instruction and orchestration contract; it is not a filesystem or credential isolation guarantee. Target-repository skills and instructions must be checked for conflicting ownership of push, PR creation, CI waiting, and merge.

## Remaining evidence gaps

- No authenticated model execution was performed, and no particular model/effort pair was tested.
- No implementation, repair, or document-maintenance ticket was run.
- No Sandcastle/Codex end-to-end process cancellation or restart-recovery test was performed.
- The current runner repository has no commits. The user subsequently selected public `xiakeng/sandcastle-runner` with English issues, and the root session created it and configured `origin`.

The Sandcastle-specific integration assessment is in [sandcastle-feasibility.md](sandcastle-feasibility.md); tracker and merge semantics are in [tracker-feasibility.md](tracker-feasibility.md).
