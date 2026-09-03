# How to: Message context menu

**Platform:** Electron

## What it is
A right-click menu on any transcript message for copying, pinning, rating, or managing that message.

## Where to find it
Right-click any message bubble in the transcript: user messages, assistant replies, tool outputs, or result cards. The menu opens at the cursor.

![Right-click context menu on a transcript message](../images/transcript-and-search__message-context-menu.png)

## How to use it
1. Right-click a message bubble to open the menu.
2. Click **Copy message** to copy its text to the clipboard.
3. Click **Copy selection** to copy only highlighted text.
4. Click **Add to prompt** to drop the message into the composer.
5. Click **Pin message** or **Unpin message** to toggle its pinned state.
6. On an assistant reply, click **Good response** or **Poor response** to rate it. Click either again to remove the rating.
7. Click **Open side chat** to start a new isolated chat with that message as context.
8. Click **Delete message** to remove it after confirmation.

On read-only items, only **Copy message** and **Copy selection** appear.

## Tips & related
- [Pinned Messages](../chats-and-threads/pinned-messages.md) — review all pinned messages
- [Side Chat](../chats-and-threads/side-chat.md) — details on isolated side chats
- [Copy transcript button](copy-transcript-button.md) — copy the entire transcript
- [Transcript message stream](transcript-message-stream.md) — the message list this menu appears on
