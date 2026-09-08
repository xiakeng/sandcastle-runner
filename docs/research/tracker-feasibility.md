# Tracker and merge automation feasibility

Research date: 2026-09-08. This is a feasibility assessment, not an implementation or a live acceptance test. No tracker items, pull requests, repository settings, or deployments were changed.

## Conclusion

**GitHub is feasible for the first adapter.** Native issue hierarchy and dependency APIs provide the inputs for a deterministic scheduler. The application can limit concurrent AI implementation sessions to three and own scheduling, PR creation, CI observation, and serialized merging. An AI session's completion message must not authorize a merge or establish ticket completion.

**Plane Community Edition has the necessary basic public REST capabilities in release v1.4.2 source.** A future adapter still needs implementation and acceptance tests against the actual self-hosted instance. Cloud documentation alone is insufficient evidence of CE support.

These conclusions concern API capability. Repository policy, runner recovery, authorization, and exact completion rules remain application design decisions.

## GitHub issue selection

### Verified facts

| Need | Native API or behavior |
| --- | --- |
| Read immediate children | `GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues` |
| Read a child's parent | `GET /repos/{owner}/{repo}/issues/{issue_number}/parent` |
| Read prerequisites | `GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by` |
| Read downstream dependants | `GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocking` |

The hierarchy endpoints expose issue records and require Issues read permission for private resources. Sub-issue listing accepts `page` and `per_page`, defaulting to 30 and allowing 100. It has no documented state filter, so filter returned records by state. [Sub-issues REST reference](https://docs.github.com/en/rest/issues/sub-issues)

The dependency endpoints also provide issue records, use Issues read permission, and support page-based listing up to 100 records per page. For relationship mutations, `issue_id` is the database ID, not the repository-local issue number. [Issue dependencies REST reference](https://docs.github.com/en/rest/issues/issue-dependencies)

GitHub supports up to 100 immediate sub-issues per parent and eight nested levels; children can be in other repositories. A direct-child scan therefore differs from recursively scanning all descendants. [Adding sub-issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues)

Follow every `Link: ... rel="next"` response until exhausted; requesting 100 records does not replace pagination. An inaccessible page or prerequisite must not be interpreted as an empty set. The latter is an application safety rule inferred from incomplete API evidence. [REST pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)

Closing an issue can mean either completed work or work that is not planned. Closure alone does not prove implementation acceptance. Linked PRs close their issue when merged into the default branch; closing keywords for PRs targeting another branch are ignored. [Closing an issue](https://docs.github.com/en/issues/tracking-your-work-with-issues/administering-issues/closing-an-issue), [PR linkage and automatic closure](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)

### Application interpretation and unresolved policy

Recommended selection rule: select open, in-scope children whose prerequisite reads are complete and whose prerequisites satisfy the selected completion policy; atomically reserve at most three AI execution slots. Keep a durable ticket-to-attempt/branch/PR mapping so restarts do not dispatch the same ticket again.

Decide whether a closed prerequisite with `state_reason=not_planned` should unblock dependants. A strict implementation workflow should require explicit acceptance for cancellation or replacement rather than silently treating it as delivered.

Do not infer parent completion from child progress. The cited hierarchy documentation provides relationship/progress tracking, not a completion contract for the parent. This research did not establish an automatic parent-closing guarantee. A parent needs its own explicit closeout policy.

## GitHub CI and merge readiness

### Verified facts

`GET /repos/{owner}/{repo}/pulls/{pull_number}` exposes `head.sha`, `mergeable`, and a test-merge SHA before merging. `mergeable=null` means GitHub is still computing; retry later. `mergeable=true` establishes that GitHub can construct the merge, not that every repository requirement is satisfied. The synchronous merge endpoint accepts `sha` to require the observed head, returning 409 for a mismatch. It does not expose an expected-base-SHA parameter. Confirm `merged=true` and the resulting commit after merging. [Pull requests REST reference](https://docs.github.com/en/rest/pulls/pulls)

Checks and commit statuses are separate APIs:

- `GET /repos/{owner}/{repo}/commits/{sha}/check-runs`: read latest check runs, preserve check name and producing app, and paginate. Avoid filtering only to completed runs, which could hide pending work. [Check runs REST reference](https://docs.github.com/en/rest/checks/runs)
- `GET /repos/{owner}/{repo}/commits/{sha}/status`: combines the latest commit status per context. No statuses produces `pending`; this alone cannot evaluate a repository that uses only check runs. [Commit statuses REST reference](https://docs.github.com/en/rest/commits/statuses)

Required checks must correspond to the current commit. GitHub accepts check conclusions `success`, `neutral`, and `skipped` for its required-check semantics. If a check and commit status share a required name, both must pass. GitHub may evaluate a test-merge commit when it has a status, otherwise the head commit; head-only inspection is insufficient as a universal implementation. [Required-check troubleshooting](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)

Required reviews, stale-review dismissal, expected check sources, and branch freshness are independent constraints. Strict required checks require a branch to incorporate the current base; loose checks permit merging against a changed base and can admit incompatible combinations. [Protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)

Read applicable rulesets through `GET /repos/{owner}/{repo}/rules/branches/{branch}`; this includes active rules from repository and organization levels. Also account for classic branch protection through its separate API. Failure to read classic protection due to insufficient permission is not evidence that it is absent. [Rules API](https://docs.github.com/en/rest/repos/rules), [Branch protection API](https://docs.github.com/en/rest/branches/branch-protection)

GraphQL `reviewDecision` and `mergeStateStatus` expose useful server assessments, including `REVIEW_REQUIRED`, `CHANGES_REQUESTED`, `BEHIND`, `BLOCKED`, and `UNKNOWN`. They complement check details and provide explanations for waiting. [Pull request GraphQL types](https://docs.github.com/en/graphql/reference/pulls)

### Recommended deterministic merge protocol

1. Observe the PR's current head, target branch, draft/open state, reviews, checks, statuses, and applicable policy. Missing required evidence means wait or report a blocker.
2. Serialize merge decisions per target branch. Re-read head and base when the PR reaches the front of the merge sequence.
3. If the base changed, invalidate previous integration-readiness evidence. With strict checks, update the branch and await checks for its resulting head. A configured GitHub merge queue can instead test the current base plus preceding queued changes; its availability and workflow configuration must be verified before selecting it. [Merge queue documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
4. Request the authorized merge method with the observed head SHA. Do not use an administrative bypass to turn a rejected merge into success.
5. Persist confirmed merge evidence, then evaluate ticket completion and downstream eligibility again.

This protocol is a design recommendation, not a claim that every successful PR must always rerun CI after any unrelated merge. Loose protection may allow old checks. For this concurrent workflow, validating the combination with the current base is the recommended safety policy. A program-level merge lock covers this program's merges; GitHub enforcement or a merge queue is needed to cover other writers. Passing a head SHA alone does not solve the base race.

The exact acceptance set also needs a decision: GitHub-required checks only, or additional configured checks that must succeed. An empty check set must not silently become success when the project expects CI.

## Plane Community Edition evidence

### Version and edition boundary

Plane documents Community Edition as AGPL-licensed open source and distinguishes it from Commercial and Cloud editions with separate codebases and release cycles. This report uses the public CE repository, not paid-cloud feature tables, for capability claims. [Plane editions](https://developers.plane.so/self-hosting/editions-and-versions)

The latest public release page resolved to [v1.4.2](https://github.com/makeplane/plane/releases/tag/v1.4.2). Its commit is `5f7d92784c403f76284f0f16718f320221dc7fec`. Source was inspected locally at this tag and compared with main commit `1fec307f91003df96351557af32ce87891a3678a`. No deployed Plane instance was contacted.

### Capabilities present in v1.4.2 source

| Need | Evidence and adapter implication |
| --- | --- |
| Public REST authentication | Root routing mounts `plane.api.urls` at `/api/v1/`; API base views use `APIKeyAuthentication`. Use `X-Api-Key` and an active, unexpired token with appropriate project access. |
| Read parent/children | Issue model has nullable `parent`; `IssueSerializer` exposes model fields including parent. Paginate project issues and filter by parent ID client-side. For cross-project children, cover every allowed project. |
| Read blocking relationships | `GET /api/v1/workspaces/{slug}/projects/{project_id}/work-items/{issue_id}/relations/` is explicitly routed. It returns grouped `blocked_by` and `blocking` references containing `issue_id` and `project_id`. Fetch referenced issues to determine state; the relation response itself does not establish completion. |
| Create a standalone labeled ticket | `POST .../work-items/` accepts optional label IDs; the serializer validates project labels and creates label membership. Omit `parent`; do not call relation or link endpoints. A description can contain ordinary text/HTML without issue references. |

Primary source links: [root routes](https://github.com/makeplane/plane/blob/5f7d92784c403f76284f0f16718f320221dc7fec/apps/api/plane/urls.py), [public work-item routes](https://github.com/makeplane/plane/blob/5f7d92784c403f76284f0f16718f320221dc7fec/apps/api/plane/api/urls/work_item.py), [API base views](https://github.com/makeplane/plane/blob/5f7d92784c403f76284f0f16718f320221dc7fec/apps/api/plane/api/views/base.py), [token authentication](https://github.com/makeplane/plane/blob/5f7d92784c403f76284f0f16718f320221dc7fec/apps/api/plane/api/middleware/api_authentication.py), [issue model](https://github.com/makeplane/plane/blob/5f7d92784c403f76284f0f16718f320221dc7fec/apps/api/plane/db/models/issue.py), [serializer](https://github.com/makeplane/plane/blob/5f7d92784c403f76284f0f16718f320221dc7fec/apps/api/plane/api/serializers/issue.py), [list/create/detail and relation views](https://github.com/makeplane/plane/blob/5f7d92784c403f76284f0f16718f320221dc7fec/apps/api/plane/api/views/issue.py).

### Concrete limits

- The old `/issues/` routes remain for basic operations, but this release's relation route is under `/work-items/`. Do not invent an `/issues/{id}/relations/` alias. See the routed paths above.
- The CE list view explicitly rejects nonempty `pql` or structured `filters` parameters with HTTP 400. A cloud search example is not an implementation for CE. Use full pagination and client-side filtering for this bounded future adapter. See `IssueListCreateAPIEndpoint.get` above.
- `Issue.issue_objects` excludes archived issues, archived projects, drafts, and triage state. A missing prerequisite may therefore be filtered or inaccessible rather than nonexistent or completed. The adapter needs explicit unavailable/unknown handling. See the issue model manager above.
- Source pagination defaults/maxes to 1,000 in the shared paginator, while the general API introduction documents 100. Requesting 100 and following returned cursors is a conservative interoperable choice; the actual deployment's response is authoritative. The relation view returns grouped arrays without invoking pagination. [CE paginator](https://github.com/makeplane/plane/blob/5f7d92784c403f76284f0f16718f320221dc7fec/apps/api/plane/utils/paginator.py), [general API introduction](https://developers.plane.so/api-reference/introduction)
- CE has an `API_KEY_RATE_LIMIT` environment setting defaulting to `60/minute`; read returned rate-limit headers and back off. This is a deployment setting, not a universal cloud-plan limit. [CE settings](https://github.com/makeplane/plane/blob/5f7d92784c403f76284f0f16718f320221dc7fec/apps/api/plane/settings/common.py), [API throttling](https://github.com/makeplane/plane/blob/5f7d92784c403f76284f0f16718f320221dc7fec/apps/api/plane/api/rate_limit.py)

### Future adapter acceptance criteria

Before claiming the target deployment works, verify its edition/version and token permissions; read a known parent with multiple children across pagination; read a known blocking relation and its referenced state; distinguish completed and cancelled states; and demonstrate standalone labeled-ticket creation in an authorized test scope. This research performed none of those writes or deployment tests.

Periodic doc-maintain can create an independent issue with a configured label and no parent, dependency, PR-closing keyword, or external-link record. That is an application behavior enabled by ordinary issue creation, not a special Plane scheduler capability. Persist the scheduled occurrence and created issue ID locally to prevent duplicate creation without adding tracker relationships. Scheduling frequency, overlap handling, and whether documentation work consumes one of the three AI slots remain to be decided.
