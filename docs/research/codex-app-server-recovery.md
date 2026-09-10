# Codex App Server interruption and reconnect semantics

**Issue:** [#42](https://github.com/xiakeng/sandcastle-runner/issues/42)  
**Checked:** 2026-09-10  
**Runtime matched:** `codex-cli 0.153.4`, upstream tag `rust-v0.153.4`, release commit [`3d2ee51`](https://github.com/openai/codex/tree/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a)

## Resolution

Persisting an App Server `threadId` and `turnId` is sufficient to query and safely interrupt an attempt **only while the same App Server process still owns the live thread**. A reconnected client can read or resume that thread, recover the active turn record, and submit `turn/interrupt`; the server rejects a stale or mismatched turn ID instead of interrupting a different active turn ([App Server thread APIs](https://learn.chatgpt.com/docs/app-server#threads), [exact-ID check](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/request_processors/turn_processor.rs#L1560-L1604)).

That condition does not survive an App Server crash or restart. Thread and turn IDs remain useful history identifiers, but a new App Server has no durable server-generation identity, live task handle, terminal handle, or process-group handle with which to prove that it is attached to the old execution or stop it. Therefore, persisted App Server IDs alone cannot provide the issue's no-OS-supervisor recovery guarantee.

| Event | What is recoverable | Interruption guarantee |
| --- | --- | --- |
| Unix-socket or WebSocket client disconnect; App Server stays alive | A new initialized client can list/read/resume the same loaded or persisted thread and obtain its status/turns. | `turn/interrupt` is safe when sent with the exact currently active turn ID. |
| stdio client disconnect | The single-client App Server exits; there is no same-process endpoint to reconnect to. | Shutdown performs bounded cleanup, but this is not reconnect recovery. |
| App Server graceful shutdown | Persisted thread history remains. | The server attempts bounded thread/runtime cleanup. |
| App Server forced exit, crash, or host failure | Persisted history remains; stale `inProgress` history is presented as `interrupted` when no live turn exists. | No protocol guarantee that old shell, MCP, or detached descendant work was terminated; a new server cannot interrupt the old turn. |

## Same-server disconnect and reconnect

The official App Server protocol exposes `thread/list`, `thread/read`, `thread/resume`, `thread/loaded/list`, status notifications, and `turn/interrupt`. `thread/read` can inspect a thread without resuming it; `thread/resume` attaches to a persisted thread; and the returned thread has `notLoaded`, `idle`, `active`, or `systemError` status ([official thread lifecycle documentation](https://learn.chatgpt.com/docs/app-server#threads), [official interrupt documentation](https://learn.chatgpt.com/docs/app-server#interrupt-a-turn)).

Transport determines whether reconnecting to the same process is possible:

- A Unix-socket or WebSocket connection closing removes connection-scoped state and subscriptions, but does not itself abort the thread. The main server loop exits for a closed connection only in single-client stdio mode ([connection-close branch](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/lib.rs#L1017-L1037), [subscription cleanup](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/thread_state.rs#L584-L607)). An upstream WebSocket test reconnects a second client and observes the same thread still loaded ([test](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/tests/suite/v2/connection_handling_websocket.rs#L452-L481)).
- The default transport is stdio. Closing that sole stdio connection exits the App Server, so there is no surviving instance to reconnect to ([official transport documentation](https://learn.chatgpt.com/docs/app-server#transport)).
- With no subscribers, a loaded thread is eligible for unload only after it has no activity for 30 minutes; activity prevents that idle unload ([official loaded-thread documentation](https://learn.chatgpt.com/docs/app-server#threadloadedlist)).

The protocol's thread status is a useful observation, but status alone is not an execution handle. A caller must read/resume with turns included (or retain the start event) to obtain the active `turnId`, then use that exact pair for `turn/interrupt`. The handler verifies that the supplied ID equals the active turn and returns an error for a different or already-terminal turn ([interrupt handler](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/request_processors/turn_processor.rs#L1560-L1604)). This prevents a persisted stale turn ID from accidentally interrupting a newer turn on the same thread.

## What `turn/interrupt` stops

`turn/interrupt` cancels the active Codex task, waits briefly for graceful completion, then aborts its task handle and emits an interrupted terminal turn event ([task cancellation](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/tasks/mod.rs#L902-L944), [official completion contract](https://learn.chatgpt.com/docs/app-server#interrupt-a-turn)). Its boundaries are narrower than “kill everything descended from this attempt”:

- **Foreground shell execution:** on Unix, cancellation sends `TERM` to the original process group, waits for cleanup, then kills surviving members of that original group ([implementation](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/exec.rs#L1000-L1030), [descendant regression test](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/exec_tests.rs#L1209-L1307)). This is a concrete guarantee for processes that remain in that group, not a durable guarantee for daemonized or detached descendants that escaped it.
- **Background terminals:** the core operation explicitly says interruption does not terminate them. They require separate clean/list/terminate operations ([operation contract](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/protocol/src/protocol.rs#L592-L599)). Those App Server methods are experimental, and their `processId` is an App Server process handle rather than a durable OS identity ([official background-terminal documentation](https://learn.chatgpt.com/docs/app-server#background-terminals)).
- **MCP calls:** cancelling the turn cancels the local in-flight tool future, but the protocol provides no end-to-end guarantee that an external MCP server has rolled back a side effect or terminated work it already started. The local MCP runtime is explicitly shut down as part of a live session's runtime shutdown, not by the `turn/interrupt` contract ([session shutdown](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/session/handlers.rs#L402-L429)).
- **Other agent threads:** interruption targets one thread/turn pair. It is not a tree-wide descendant-agent termination primitive; the upstream agent-interrupt test explicitly verifies that a child thread remains resident and receives neither shutdown nor interrupt ([test](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/tools/handlers/multi_agents_tests.rs#L3765-L3795)).

Connection-scoped `command/exec` and `process/spawn` are different APIs from a turn's shell tools. Their processes are cleaned up when their owning connection closes ([connection cleanup](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/message_processor.rs#L800-L829)), so their behavior must not be generalized into a guarantee for all work created by an agent turn.

## App Server crash or restart

On a normal, non-forced App Server exit, the server drains connection/background work and invokes bounded shutdown for all loaded threads ([server exit path](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/lib.rs#L1178-L1190), [10-second thread shutdown bound](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/request_processors/thread_processor.rs#L1246-L1271)). Live session shutdown aborts tasks, terminates tracked unified-exec processes, and shuts down the MCP runtime ([session shutdown](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/session/handlers.rs#L402-L429)). The bounds and forced-exit branch mean this is cleanup behavior, not a crash-safety guarantee.

After restart, persisted history can still contain a recorded `inProgress` turn. When no live runtime owns it, App Server normalizes that stored view to `interrupted` ([stale-turn projection](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L903-L916)). That status is a historical projection; it is not evidence that an orphaned operating-system process or external MCP action has stopped.

The initialize response exposes client/runtime metadata and `codexHome`, but no App Server instance or generation ID ([protocol type](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-protocol/src/protocol/v1.rs#L68-L80)). Consequently, a restarted Runner cannot use the App Server protocol alone to establish that the endpoint answering for a persisted `threadId` is the same process generation that owned the original turn.

## Identity durability

| Identity | Durable across App Server restart? | What it safely identifies |
| --- | --- | --- |
| `threadId` | Yes | Persisted conversation/history; on the same server it also locates a live thread. |
| `turnId` | Yes as history | A turn record; actionable for interruption only when it exactly matches the live active turn on the same server. |
| Thread `status` | Recomputed | Current live state when the server owns the thread, or a normalized persisted view after restart. |
| Background-terminal `processId` | No | A process handle owned by the current App Server runtime. |
| `osPid` / process group | Not a general durable protocol identity | An optional operating-system detail for some process APIs, not a cross-restart turn handle. |
| App Server instance/generation | Not exposed | There is no protocol identity with which to fence old versus replacement servers. |

## SDK equivalence and maturity

The official guidance positions SDKs for programmatic automation and App Server for rich clients needing events, conversation history, and authentication ([App Server overview](https://learn.chatgpt.com/docs/app-server), [SDK overview](https://learn.chatgpt.com/docs/codex-sdk)). Neither SDK provides an equivalent cross-run recovery contract:

- The TypeScript SDK starts or resumes persisted threads and runs each turn through `codex exec`; it exposes an `AbortSignal` for the subprocess it currently owns, but no thread list/read/status API or interrupt-by-persisted-turn API ([thread API](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/sdk/typescript/src/thread.ts#L41-L140), [start/resume API](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/sdk/typescript/src/codex.ts#L6-L38)).
- The Python SDK is a typed client that starts its own App Server over stdio ([client launch](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/sdk/python/src/openai_codex/client.py#L212-L269)). It exposes thread read/list/resume and `TurnHandle.interrupt()`, but that handle is created for a turn started through the same client; the public API does not reconstruct a live handle for a persisted `(threadId, turnId)` on another pre-existing App Server ([turn handle](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/sdk/python/src/openai_codex/api.py#L721-L763)).

The entire `codex app-server` command remains experimental. WebSocket transport is also experimental and documented as unsupported, while Unix sockets are available for local multi-client communication ([official stability and transport warning](https://learn.chatgpt.com/docs/app-server#running-the-server)). Within the protocol, the thread lifecycle/read/list and turn interrupt methods used above are not individually marked experimental, whereas background-terminal management is ([lifecycle and background-terminal declarations](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-protocol/src/protocol/common.rs#L672-L705), [read declaration](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-protocol/src/protocol/common.rs#L781-L789), [interrupt declaration](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-protocol/src/protocol/common.rs#L984-L994)). Clients should still treat the containing App Server surface as experimental and negotiate experimental methods explicitly where required ([official opt-in documentation](https://learn.chatgpt.com/docs/app-server#experimental-api-opt-in)).

## Verification boundary

This conclusion comes from current official OpenAI documentation and the source/tests at the exact release commit matching the installed CLI. No live Agent Attempt was stopped and no model execution was performed. The evidence establishes protocol and implementation behavior; it does not assert that forced process termination was dynamically proven on every supported operating system.
