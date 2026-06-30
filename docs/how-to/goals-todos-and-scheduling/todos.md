# How to: To-dos

**Platform:** Both

## What it is
A To-do is a checklist of plan steps that an agent publishes as it works (via a todo-write tool call, or Codex's native plan output), each with a status of pending, in progress, completed, or cancelled. In ensemble chats each participant keeps its own checklist ("lane"), so you can see every agent's plan side by side. To-dos are read-only — they reflect what the agent is doing, not a list you check off yourself.

## Where to find it
A checklist appears inline in the transcript on the tool-activity row where the agent published it, and a **Plan** button (checklist icon) in the composer's telemetry row opens a popover with every lane's full checklist.

<!-- TODO(screenshot): TodoChecklistCard showing multiple items with status badges -->

## How to use it
1. Watch for a checklist card to appear under an agent's tool activity in the transcript — it shows up to 5 items collapsed, with a count of how many more are hidden.
2. Click that activity row to expand it and see the full checklist with every step's status glyph (pending, in progress, completed, cancelled).
3. Click the **Plan** button in the composer (next to the Goal button) to open a popover with the complete, up-to-date checklist for every active lane.
4. In an ensemble chat, look for the lane header (provider/role name and color dot) above each section of the popover to tell participants' plans apart.
5. Watch the Plan button itself: it shows a dot while a step is in progress and a check mark once all active steps are complete, so you can track progress without opening the popover.

## Tips & related
- [Goals](./goals.md) — the composer's other tracking control, for the thread's overall objective rather than step-by-step progress.
- [Routines and scheduled tasks](./routines-and-scheduled-tasks.md) — for recurring or time-based automation rather than in-session plan steps.
- [Composer: Goal button](../composer/goal-button.md) — sits beside the Plan button in the composer telemetry row.
