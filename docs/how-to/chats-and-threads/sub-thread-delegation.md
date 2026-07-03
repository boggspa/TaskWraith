# How to: Sub-Thread Delegation

**Platform:** Electron

## What it is
Sub-thread delegation spawns a new, context-isolated chat under a parent chat and hands part of the work to a different provider. It can be started manually from the sidebar, or an agent can trigger it itself via the `delegate_to_subthread` tool. When the sub-thread finishes, its result can be returned and auto-appended to the parent transcript as a return card.

## Where to find it
Open a chat's overflow menu in the sidebar and choose **Delegate to a sub-thread**. An agent running in the chat can also call delegation as a tool during its turn, which prompts you for approval before anything is created.

<!-- screenshot-pending: Sub-thread delegation card and return card in a chat transcript -->

## How to use it
1. In the sidebar, open the overflow menu on a chat and select **Delegate to a sub-thread**.
2. Pick the target provider for the sub-thread and write the delegation prompt describing what it should focus on.
3. Leave **Return result to parent on completion** checked if you want the sub-thread's final answer auto-appended back into this chat when it finishes.
4. Confirm to spawn the sub-thread. It inherits the parent's workspace, and a delegation card appears in the parent transcript showing its status (Created, Active, Completed, Returned, Failed, or Cancelled).
5. Use **Open beside** or **Open drawer** on the delegation card to view the sub-thread next to the parent, or **Open main** to switch to it directly.
6. Sub-threads can't be delegated from again — delegation depth is limited to one level, so return to the parent chat to spawn another sub-thread.

## Tips & related
- [Chat Types](chat-types.md) — how sub-threads fit alongside workspace, ensemble, and side chats.
- [Side Chat](side-chat.md) — the "Open beside"/"Open drawer" panel is the same side-panel mechanism used for side chats.
- [Pinned Messages](pinned-messages.md) — pin a delegation or return card to keep it handy in the transcript.
