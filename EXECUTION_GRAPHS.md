# Execution graphs

TaskWraith's execution graph is an orchestration model, not a canvas wrapper
around chats. The graph revision, run ledger, dependency readiness, attempt
identity, and permission ceiling are main-process-owned. Stack and Execution
Map are projections of that same state.

## V1 product surface

- **Composer / above-row queue / Steer are classic RunQueue paths.** Sending
  another message while a chat is busy enqueues it on the durable desktop run
  queue and surfaces it in `QueuedMessagesAboveRow` with Edit / Delete / Steer.
  Steer on a queued row still cancels the live turn and dispatches (or
  re-queues) the follow-up. The separate composer-level Steer control is a
  different path and not a RunQueue one: depending on the provider it injects
  the text into the live turn without interrupting it, cancels the in-flight
  prompt and immediately re-prompts the same session with it, or falls back to
  delivery at the natural turn boundary. The Execution Graph **does not**
  intercept ordinary busy-sends
  and **does not** render a Stack strip above the Composer.
- **Execution Graph, Stack, and Map remain Work-tab / map tooling.** They inspect
  and formalize main-owned multi-step run structure (serial `solo_agent` chains,
  success-only control edges, permission ceilings, recovery). They are not the
  day-to-day message queue.
- When graph tooling does create Stack steps, each row is a real `solo_agent`
  step connected by a success-only control edge. The next provider run is not
  published to RunQueue until its predecessor succeeds.
- **Execution Map** is a semantic topological view of the persisted run. It is
  not a free-position canvas and does not own execution state.
- **Save graph** creates an immutable graph revision from the verified effective
  topology. It deliberately does not claim to create a legacy scheduled
  workflow.
- Cancelling a planned frontier row means **Cancel remaining**: it terminalizes
  the Stack and cancels graph-owned provider work without rewiring completed or
  claimed history.

Ensemble chats, global chats, scheduled turns, retries, remote composer turns,
guest turns, and attachment-quarantine failures continue through their existing
paths. They are not silently coerced into a Stack.

## Durable model

The repository under Electron `userData/execution-graph` stores:

- immutable, content-verified graph revisions;
- immutable, content-addressed run templates;
- display-only layouts, outside the authority digest;
- an execution registry; and
- one append-only, hash-chained JSONL event ledger per execution.

The event ledger is authoritative. Run status, step status, Stack rows,
Execution Map, and the redacted remote attention record are folded projections.
Corrupt or missing individual ledgers are quarantined so one damaged execution
cannot make healthy executions disappear. Quarantined identities remain
reserved and cannot be overwritten with fresh history.

## Dispatch boundary

For a ready agent step, the coordinator follows this order:

1. Persist the activation claim, attempt identity, and exact provider run ID.
2. Load the immutable run template and verify its authority digest against the
   execution's frozen permission ceiling.
3. Materialize a **paused** RunQueue job with a main-only graph binding.
4. Verify the queue job still names the exact execution, activation, attempt,
   template, workspace, chat, provider, and ceiling.
5. Release the job to `queued` and append the queued transition to the graph
   ledger.

Graph-owned queue rows remain main-only after release: MAIN reserves the chat,
revalidates authority, leases the row, composes the provider prompt, registers
the transcript, and dispatches the provider adapter. The renderer cannot lease,
compose, dispatch, or replace the graph binding, provider, model snapshot,
runtime profile, or signed permission posture. Full Access is ephemeral and
is never durable graph authority; a requested Full Access posture is reduced to
the durable workspace-write ceiling.

## Recovery rule

Restart recovery reconciles by exact run identity. It never infers success from
chat/provider activity and never replays an attempt that may have crossed a
side-effect boundary.

| Persisted state | Exact queue/provider evidence | Recovery |
| --- | --- | --- |
| Claimed attempt | Matching paused graph job | Release to queued |
| Claimed attempt | Matching queued graph job | Restore queued projection |
| Nonterminal attempt | Matching terminal graph job | Requires action; post-restart queue status is not provider terminal evidence |
| Claimed attempt | Missing or mismatched graph job | Requires action |
| Starting/active attempt after restart | Side-effect boundary uncertain | Requires action |
| Waiting on anchor | Exact terminal anchor result | Advance or settle Stack |
| Waiting on anchor | Missing/ambiguous anchor | Requires action |

`requires_action` is a durable attention stop for V1 recovery; TaskWraith does
not guess or automatically retry uncertain external work.

## Honest runtime admission

The generic schema can represent future graph mechanisms, but the bound V1
executor admits only a serial chain of `solo_agent` steps with one attempt per
step. Admission rejects unsupported semantics explicitly, including:

- parallel branches, joins, human gates, ensemble rounds, deterministic checks,
  and output nodes;
- data edges or declared input/output ports;
- retries or retry backoff;
- step timeouts;
- wall-clock, token, or cost budgets; and
- attempt limits the current executor cannot enforce.

Those shapes may be stored as future-compatible definitions, but they cannot be
presented as runnable until a real executor, resolution command, and recovery
contract exist for them.

## Design invariant

If changing an edge would not change readiness, dispatch, data delivery,
failure propagation, or cancellation, that edge does not belong in the
executable graph. Kanban, timeline, delegation tree, Stack, and Execution Map
should remain alternate projections over one durable model.
