# Sandcastle Runner

Sandcastle Runner coordinates ticket-driven coding work for configured software projects.

## Language

**Project**:
A configured target repository together with its tracker, code host, and execution policy.
_Avoid_: Workspace, target

**Run**:
One CLI invocation that processes one Project and one supplied Parent Ticket to a terminal outcome.
_Avoid_: Job, session

**Parent Ticket**:
The GitHub issue supplied to a Run as its delivery scope. Only its same-repository direct children can be Delivery Tickets.
_Avoid_: Parent issue, epic

**Batch**:
Up to three Delivery Tickets worked concurrently and integrated only after every pull request in that group is ready.
_Avoid_: Wave, group

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

**Agent Attempt**:
One Codex invocation for implementation, CI repair, conflict repair, or document maintenance.
_Avoid_: Agent session, worker

**Agent Attempt Result**:
A schema-validated JSON account of an Agent Attempt's outcome, summary, claimed commits, checks, and blockers. It is evidence for the runner, not proof of delivery.
_Avoid_: Completion marker, final message

**Verified Handoff**:
An Agent Attempt Result accepted after the runner independently validates the actual branch, commits, and worktree state.
_Avoid_: Agent completion, successful turn
