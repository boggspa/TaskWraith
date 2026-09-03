# How to: Copy transcript button

**Platform:** Electron

## What it is
Exports the current chat so you can paste it elsewhere or share it. Offers Markdown, raw messages, or a downloaded file, within a chosen scope.

## Where to find it
In the composer's bottom row, next to the timecode, Goal button, and layout picker. Disabled when no chat is selected, the chat is archived, or it has no messages.

<!-- screenshot-pending: Composer telemetry row showing the copy transcript button -->

## How to use it
1. Click the copy transcript icon to open the popover.
2. Pick a scope: **Current round**, **Previous round**, **Choose round**, or **Entire task**.
3. Choose an export:
   - **Copy Markdown** — copies safe Markdown to your clipboard
   - **Copy Messages** — copies raw messages only
   - **Download** — saves as a `.md` file
4. Check the status message for confirmation and any omissions.
5. A checkmark appears briefly on the button. Press **Escape**, click **Close**, or click outside to dismiss.

Assign a custom keyboard shortcut from Settings → Keyboard Shortcuts.

## Tips & related
- [Keyboard shortcuts tab](../settings-and-configuration/keyboard-shortcuts-tab.md) — bind a hotkey to Copy transcript
- [Goal button](../composer/goal-button.md) — another control in the same row
- [Transcript message stream](transcript-message-stream.md) — the content this button copies
