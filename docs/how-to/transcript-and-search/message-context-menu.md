# How to: Message context menu

**Platform:** Electron

## What it is
A right-click menu on a transcript message that lets you copy its text, pin or unpin it, spin it off into a new side chat, or delete it from the transcript.

## Where to find it
Right-click any message bubble in the main transcript: user messages, assistant/system/guest-participant replies, tool messages, provider-failure cards, and sub-thread result cards. The menu opens at the cursor position; "Pin", "Open side chat", and "Delete" are omitted for read-only items like provider-failure cards.

<!-- TODO(screenshot): Right-click context menu on a transcript message -->

## How to use it
1. Right-click a message bubble to open the menu.
2. Choose **Copy message** to copy its text to the clipboard (disabled if there's nothing to copy).
3. Choose **Pin message** / **Unpin message** to toggle the message's pinned state.
4. Choose **Open side chat** to start a new isolated side chat seeded with that message's content (not available on linked/child chats).
5. Choose **Delete message** to permanently remove it from the transcript; you'll get a confirmation prompt first, and deletion is blocked while the message has an open prompt (agent question or plan choice) waiting on it.
6. Use Arrow Up/Down, Home/End, or Escape to navigate or dismiss the menu with the keyboard.

## Tips & related
- [Pinned Messages](../chats-and-threads/pinned-messages.md) — review everything you've pinned across chats.
- [Side Chat](../chats-and-threads/side-chat.md) — more on the isolated chat that "Open side chat" creates.
- [Copy transcript button](copy-transcript-button.md) — copy the whole transcript instead of one message.
- [Transcript message stream](transcript-message-stream.md) — the message list this menu attaches to.
