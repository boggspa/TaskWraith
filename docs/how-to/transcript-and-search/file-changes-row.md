# How to: File changes row

**Platform:** Electron

## What it is
A summary card showing every file an agent created, edited, or deleted in the current chat, with counts, line totals, and previews.

## Where to find it
At the bottom of the transcript, above the composer, in any chat with file changes.

![File changes row showing pending diffs above the composer](../images/transcript-and-search__file-changes-row.png)

## How to use it
1. Check the header for file counts and total added/deleted lines.
2. Hover a file row to preview its diff without leaving the transcript.
3. Click a file row or its **Diff** button to open the full diff in a popout window.
4. Click **Show N more files** to expand a collapsed list, or **Show fewer files** to collapse it.
5. If a run touched many files, a line shows how many are omitted.

## Tips & related
- [Diff hover preview](diff-hover-preview.md) — the popover shown on hover
- [Activity stack](activity-stack.md) — tool-call rows where individual edits appear
- [Transcript message stream](transcript-message-stream.md) — the chat view this card sits within
