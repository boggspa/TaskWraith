# How to: Copy transcript button

**Platform:** Electron

## What it is
The copy transcript button exports the current chat as handoff-ready Markdown to your clipboard, so you can paste the conversation into another app or share it with someone else.

## Where to find it
It's a small icon button in the composer's bottom telemetry row, next to the run timecode, Goal button, and Multiview layout picker, just below the message input. It's disabled when no chat is selected, the chat is archived, or the chat has no messages yet.

<!-- screenshot-pending: Composer telemetry row showing the copy transcript button -->

## How to use it
1. Click the copy transcript icon to open the confirmation popover.
2. Click **Copy handoff Markdown** to copy the visible transcript to your clipboard.
3. Watch for the inline status message confirming how many messages were copied (and any omissions, such as content that couldn't be included).
4. A checkmark briefly appears on the button to confirm the copy succeeded; press **Escape** or click outside the popover to dismiss it.

You can also assign a custom keyboard shortcut to the **Copy transcript** command from the Keyboard Shortcuts settings tab — it has no default binding.

## Tips & related
- [Keyboard shortcuts tab](../settings-and-configuration/keyboard-shortcuts-tab.md) — bind a hotkey to the Copy transcript command.
- [Goal button](../composer/goal-button.md) — another control in the same composer telemetry row.
- [Transcript message stream](transcript-message-stream.md) — the message content this button copies.
