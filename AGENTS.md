# Contribution Workflow

1. Every change must have a GitHub issue.
2. Immediately before creating the issue branch, fetch `origin/main`.
3. Create `issue-<number>` from the fetched `origin/main` commit and make the
   change there.
4. Open a pull request to this repository's `main` branch unless explicitly told otherwise.
5. Leave the pull request open after previous steps finished. Merge it only when the user explicitly
   requests the merge.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `xiakeng/sandcastle-runner`. See `docs/agents/issue-tracker.md`.

### Triage labels

The repository uses the default five-label triage vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context domain documentation layout. See `docs/agents/domain.md`.

### Code standards

For TypeScript implementation, apply `docs/agents/code-standards.md`.

### Code review

For code reviews, follow `docs/agents/code-review.md`.

## Mandatory pre-review context compaction

Immediately before invoking the `code-review` skill:

1. Resolve any missing fixed point or specification source, then create a review
   capsule from the current repository state. Include the resolved fixed-point
   and `HEAD` SHAs, the exact three-dot diff command and commit list, the
   originating issue/specification and its relevant requirements, non-goals,
   and exceptions, the applicable standards sources, changed-file scope,
   validation evidence, unresolved risks, user constraints, and the exact next
   action. The capsule is complete when every input required by `code-review`
   preparation is present or named by a stable path, URL, or commit ID.
2. Perform native context compaction with that capsule as the continuation
   state before dispatching any reviewer. If the runtime cannot invoke native
   compaction, present the capsule and ask the user to run `/compact`; resume
   only after compaction.
3. After compaction, re-read this file and the identified review sources,
   resolve the fixed point and `HEAD` again, and confirm that `HEAD` still
   matches the capsule and the diff is non-empty. Refresh the capsule if the
   repository state changed.
4. Invoke `code-review` from the rehydrated capsule. Keep orchestration in the
   root session and give each fresh reviewer only its axis-specific inputs. The
   repository and issue/specification are authoritative; the implementation
   transcript is not review input.
