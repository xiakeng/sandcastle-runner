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
