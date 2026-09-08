# Sandcastle Runner

Sandcastle Runner coordinates ticket-driven coding work for configured software projects.

## Language

**Project**:
A configured target repository together with its tracker, code host, and execution policy.
_Avoid_: Workspace, target

**Target Branch**:
The Project branch against which a Run prepares, validates, and integrates Delivery Tickets.
_Avoid_: Main branch, base branch, default branch

**Run**:
One CLI invocation that processes one Project and one supplied Parent Ticket to a terminal outcome.
_Avoid_: Job, session

**Operator Pause**:
A point at which a Run waits for a trusted operator to retry, abort, or supply a successful result for a failed operation.
_Avoid_: Terminal pause, human intervention

**Parent Ticket**:
The GitHub issue supplied to a Run as its delivery scope. Only its same-repository direct children can be Delivery Tickets.
_Avoid_: Parent issue, epic

**Batch**:
Up to three Delivery Tickets worked concurrently and integrated only after every pull request in that group is ready.
_Avoid_: Wave, group

**CI-ready Pull Request**:
A pull request whose check-discovery delay has elapsed and whose returned required CI checks are either empty or all passing.
_Avoid_: Ready PR, merge-ready PR

**Delivery Ticket**:
A same-repository direct child of the Parent Ticket that a Run may select for coding and integration.
_Avoid_: Task, work item

**Eligible Delivery Ticket**:
An open Delivery Ticket with no non-runner assignee, no complete or partial Reservation, and only closed native blockers.
_Avoid_: Ready ticket, available ticket

**Externally Owned Delivery Ticket**:
An open Delivery Ticket assigned to an account other than the runner. A Run skips it, but it prevents the Parent Ticket from being completed.
_Avoid_: Assigned ticket

**Reservation**:
The combination of the `sandcastle:reserved` label and runner-account assignee that marks a Delivery Ticket as owned by a Run.
_Avoid_: Claim

**Cancellation**:
A Delivery Ticket closed as `not_planned`. It is handled but not delivered, and it satisfies downstream blockers.
_Avoid_: Completion, delivery

**Completed Delivery Ticket**:
A Delivery Ticket whose pull request is merged and whose tracker state is confirmed closed with the completed reason.
_Avoid_: Handled ticket, terminal ticket

**Documentation Base**:
The full commit SHA stored by a documentation surface as the latest revision it has completely reviewed.
_Avoid_: Base commit, last documented commit

**Documentation Maintenance**:
A between-Batch review that advances each Documentation Base after bringing its documentation surface up to date with the Target Branch.
_Avoid_: Doc update, documentation task

**Maintenance Ticket**:
A standalone tracker item whose pull request delivers one Documentation Maintenance occurrence.
_Avoid_: Documentation Delivery Ticket, doc task

**Ticket Closure Policy**:
A Project rule that chooses whether the Runner closes PR-backed tickets after merge or waits for the code host to close linked tickets.
_Avoid_: Auto-close mode, issue-closing flag

**Agent Attempt**:
One Codex invocation for implementation, CI repair, conflict repair, or document maintenance.
_Avoid_: Agent session, worker

**Agent Attempt Result**:
A schema-validated JSON account of an Agent Attempt's outcome, summary, claimed commits, checks, and blockers. It is evidence for the runner, not proof of delivery.
_Avoid_: Completion marker, final message

**Verified Handoff**:
An Agent Attempt Result accepted after the runner independently validates the actual branch, commits, and worktree state.
_Avoid_: Agent completion, successful turn
