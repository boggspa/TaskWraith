# How to: Side Chat

**Platform:** Electron

## What it is
A side chat is a linked sidecar chat that opens next to your current chat — either docked as a split pane, a right-hand drawer, or a separate pop-out window. It starts from a copied snapshot of the parent chat (or a single ensemble participant, a fan-out of all participants, or a specific message/run result/summary) so you can explore a tangent without disturbing the main transcript. Ending a side chat cancels its queued work and archives it.

## Where to find it
Open the **linked chat menu** (the split-pane icon with a chevron, in the chat header next to the other corner buttons) and choose how to open it:
- **Open isolated side split** — docks a sidecar pane beside the current chat with a copied parent snapshot.
- **Open isolated side drawer** — opens the sidecar as a right-hand overlay instead of a split pane.
- **Pop out linked chat** — opens the current linked chat in its own window.
- **Open linked chat as main** — navigates to the linked chat in the main pane.

You can also right-click (or use the context menu on) any message in the transcript and choose **Open side chat** to seed a new side chat from that message.

<!-- screenshot-pending: Side chat panel docked on the right -->

## How to use it
1. With a chat open, click the linked chat menu in the chat header and pick a presentation: **Open isolated side split** (docked pane) or **Open isolated side drawer** (overlay).
2. For ensemble chats, the menu also offers **Side ensemble clone** (same participants), **Isolated participant side chat** (a single participant), or **Fan-out side chat** (all participants answer in parallel).
3. To start from existing context instead of a blank sidecar, use **Open from selected message**, **Open from latest run result**, or **Open from summary** in the same menu.
4. Work in the side chat like any other chat — it has its own composer and transcript.
5. When you're done, use the docking controls to re-dock it as a **split** or **drawer**, or click the danger button to **End side chat**, which cancels queued work and archives it.

## Tips & related
- [Sub-Thread Delegation](sub-thread-delegation.md) — delegate work to a new child agent instead of a linked sidecar.
- [Chat Types](chat-types.md) — overview of how side chats relate to other chat kinds.
- [Pinned Messages](pinned-messages.md) — pin a message before branching it into a side chat.
- [In-Chat Search](in-chat-search.md) — find the message you want to seed a side chat from.
