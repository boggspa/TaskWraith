# How to: Diff hover preview

**Platform:** Electron

## What it is
The diff hover preview is a floating popover that shows a code diff (added/removed lines, with a `+X -Y` summary) for a file change without leaving the transcript. It appears when you hover, focus, or tap a diff-capable row, and can include a button to jump into the full diff view.

## Where to find it
It attaches to two places in the transcript:
- Rows in the **File changes** card above the composer (each changed-file row and its "Diff" bubble).
- Individual tool-call rows in the **activity stack** that represent a write/edit action (e.g. a file edit), shown when that row has captured diff text.

<!-- screenshot-pending: Hovering over a diff in the transcript to show the preview -->

## How to use it
1. Hover your mouse over a changed-file row or an edit-type activity row; the preview opens above or below the row depending on available space.
2. Keep the preview open by moving your pointer onto the popover itself — it stays open until you leave both the row and the popover, then closes after a short delay.
3. Use Tab to focus the row instead of hovering; the preview opens the same way and can be dismissed with **Escape**.
4. If an "Open Diff Studio" (or similar) action is shown in the footer, click it to jump to the full diff in the workbench/inspector; otherwise the popover is preview-only.
5. Scrolling the transcript or resizing the window closes the preview automatically.

## Tips & related
- [File changes row](file-changes-row.md) — the per-run summary card that hosts most diff hover previews.
- [Activity stack](activity-stack.md) — collapsible tool-call rows where edit/write actions also trigger the hover preview.
- [Inspector panel](inspector-panel.md) — open the full Diff tab when you need more than the hover preview shows.
