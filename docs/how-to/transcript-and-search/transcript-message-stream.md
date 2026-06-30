# How to: Transcript message stream

**Platform:** Electron

## What it is
The transcript message stream is the main scrolling conversation view in the center stage — every user message, assistant reply, tool-activity block, and inline card (ensemble rounds, plan proposals, agent questions, run-failure notices) for the current chat, in order.

## Where to find it
It fills the center stage whenever a chat is open. Long-running chats render efficiently because rows outside the visible band are windowed (virtualized) rather than all mounted at once.

<!-- TODO(screenshot): Main chat transcript showing a multi-message conversation thread -->

## How to use it
1. Scroll up to read history; the view auto-follows new messages at the bottom while you stay scrolled to the bottom, and stops auto-following the moment you scroll away so it doesn't yank you back mid-read.
2. When new messages arrive while you've scrolled away, a **"↓ N new messages"** pill appears — click it, or press **End**, to jump back to the latest message and re-engage auto-follow.
3. Right-click any message bubble to copy, pin/unpin, delete, or spin it off into a new side chat (see [Message context menu](message-context-menu.md)).
4. Hover a message's footer for its timestamp and the same quick actions (copy/pin/delete/side-chat) via the actions chip.
5. Long pasted user messages collapse automatically — click **Show more** / **Show less** to expand or re-collapse them.
6. Tool activity (file reads, edits, shell commands, searches) appears inline beneath an agent's turn, grouped into expandable stacks — see [Activity stack](activity-stack.md).

## Tips & related
- [Message context menu](message-context-menu.md) — the right-click menu on any message bubble.
- [Copy transcript button](copy-transcript-button.md) — copy the whole visible transcript instead of one message.
- [Activity stack](activity-stack.md) — the collapsible tool-call list rendered inline in the stream.
- [Pinned messages](../chats-and-threads/pinned-messages.md) — review everything you've pinned from this stream.
