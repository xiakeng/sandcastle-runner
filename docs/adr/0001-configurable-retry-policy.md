# ADR-0001: Configure automatic retry policy by boundary

## Decision

Each Project configuration must provide `operationRetry`, `agentRetry`,
`operationRetryDelay`, and `agentRetryDelay` as top-level fields. Retry counts
are additional attempts after the initial attempt. Delay schedules are in
seconds; the final delay is reused when a budget is longer than its schedule.

Operation Retry applies to automatic external reads, automatic workflow writes,
and agent-session probes. Agent Retry applies to recoverable continuation in an
existing agent session, including process/output and structured-output recovery.
Operator Pause retries remain manually controlled and do not consume either
automatic budget.

## Consequences

Startup rejects missing or malformed retry fields, making retry behavior explicit
per Project. Workflow code receives one validated policy, while manual recovery
remains outside automatic retry limits.
