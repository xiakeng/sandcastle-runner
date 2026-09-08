# Sandcastle Runner

Sandcastle Runner coordinates ticket-driven coding work for configured software projects.

## Language

**Project**:
A configured target repository together with its tracker, code host, and execution policy.
_Avoid_: Workspace, target

**Run**:
One CLI invocation that processes one Project and one supplied Parent Ticket to a terminal outcome.
_Avoid_: Job, session

**Batch**:
Up to three Delivery Tickets worked concurrently and integrated only after every pull request in that group is ready.
_Avoid_: Wave, group

**Delivery Ticket**:
A tracker item selected by a Run for coding and integration.
_Avoid_: Task, work item

**Agent Attempt**:
One Codex invocation for implementation, CI repair, conflict repair, or document maintenance.
_Avoid_: Agent session, worker

