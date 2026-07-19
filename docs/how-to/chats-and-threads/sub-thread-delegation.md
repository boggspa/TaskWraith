# How to: Sub-Thread Delegation

**Platform:** Electron

## What it is
Sub-thread delegation spawns a new, context-isolated chat under a parent chat and hands part of the work to a fresh provider seat. The child may use the same provider as its parent or a different one. Delegation can be started manually from the sidebar, or an agent can trigger it via `delegate_to_subthread`. When a returned child reaches `done`, `requires_action`, `failed`, or `cancelled`, TaskWraith persists a typed terminal result and appends an untrusted, projection-only return card to the parent transcript; assistant output is included when present.

## Where to find it
Open a chat's overflow menu in the sidebar and choose **Delegate to a sub-thread**. An agent can also call delegation during its turn. Agent-driven calls route through the `subThreadDelegation` policy: the default **Ask** policy opens an approval modal, while Allow/Deny policies and existing session/workspace grants may resolve without one. No child is created when the call is declined.

<!-- screenshot-pending: Sub-thread delegation card and return card in a chat transcript -->

## How to use it
1. In the sidebar, open the overflow menu on a chat and select **Delegate to a sub-thread**.
2. Pick a selectable, currently admitted provider and write the delegation prompt. Packaged source-ahead Kimi has no commissioned runtime tuple, so it remains unavailable until the qualification roster is populated; credentials alone do not admit it.
3. Leave **Return result to parent on completion** checked if you want the typed terminal result returned to this parent as an untrusted card.
4. Confirm to spawn the sub-thread. It inherits the parent's workspace and appears under the parent in the sidebar. Manual sidebar delegation does not currently append a parent transcript delegation card; an approved agent-driven spawn/recall does.
5. Open the child from the sidebar. For an agent-driven delegation card, **Open beside** / **Open drawer** shows it next to the parent, while **Open main** switches to it.
6. An agent can continue the same child by passing its `subThreadId` again. An idle child resumes its linked native provider session; if the child is already starting or running, TaskWraith durably queues the follow-up behind the live turn instead of starting a concurrent run.
7. Sub-threads can't be delegated from again — delegation depth is limited to one level, so return to the parent chat to spawn another sub-thread.

Source-ahead delegation cannot target Cursor and Cursor cannot act as the
parent: TaskWraith starts no managed Cursor process. Historical Cursor
sub-thread records remain readable.

For a solo parent, returned mailbox data enters provider context exactly once
through an auto-wake or the next ordinary turn. An Ensemble parent currently
retains the durable mailbox event and return card, but TaskWraith does not
automatically inject that result into any participant seat's context. This is a
current v1.8.4 and source-ahead limitation.

## Tips & related
- [Chat Types](chat-types.md) — how sub-threads fit alongside workspace, ensemble, and side chats.
- [Side Chat](side-chat.md) — the "Open beside"/"Open drawer" panel is the same side-panel mechanism used for side chats.
- [Pinned Messages](pinned-messages.md) — pin a delegation or return card to keep it handy in the transcript.
