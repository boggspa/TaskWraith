# How to: Activity stack

**Platform:** Electron

## What it is
The activity stack is the collapsible list of tool calls (file reads, edits, shell commands, searches, web searches, reasoning traces) an agent performs during a turn. Consecutive same-type calls automatically fold into an expandable compact group (e.g. "Read 5 files") so a busy turn doesn't flood the transcript.

## Where to find it
Renders inline in the transcript, beneath an agent's turn, wherever the agent used tools.

<!-- screenshot-pending: Collapsible activity stack showing tool calls in the transcript -->

## How to use it
1. Click a row (or a compact group's header) to expand it and see details — file path, command, search query, diff preview, or full output.
2. Click an open row again to collapse it; by default opening a new row collapses the previous one.
3. Hold ⌘ (or Shift) while clicking to keep multiple rows open at once instead of single-open mode.
4. In an ensemble chat, watch for the "yielding to @\<name\>" row — it shows which participant is taking the next turn.
5. Enable **Live activity viewport** in Settings → Appearance → Effects & Material → Density to stream activity in a bounded, auto-scrolling panel while the agent is actively working.
6. Enable **Compact density** in the same section to collapse tool cards to a tighter one-line trace throughout the interface.

## Tips & related
- [Transcript message stream](transcript-message-stream.md) — the surrounding scroll the activity stack renders inside.
- [Inspector panel](inspector-panel.md) — open the raw events / diff / timeline view for full untruncated detail.
- [Diff hover preview](diff-hover-preview.md) — hover a file edit's diff preview without expanding the row.
- [File changes row](file-changes-row.md) — the composer-area summary of files an agent changed during the chat.
