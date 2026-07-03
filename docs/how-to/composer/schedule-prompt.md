# How to: Schedule Prompt

**Platform:** Electron

## What it is
The schedule control lets you queue a composer prompt to run automatically at a future date and time instead of sending it right away. The prompt waits in the run queue and fires on its own once the scheduled time arrives.

## Where to find it
In the **composer's control row** (the icon row beneath the prompt box), next to the Goal button. Click the **clock icon** to open the schedule popover.

<!-- screenshot-pending: Composer schedule button with quick offset options -->

## How to use it
1. Type your prompt in the composer as normal.
2. Click the **clock icon** to open the schedule popover.
3. Pick a date and time, or use a quick preset — **15m**, **1h**, **Tonight**, or **Tomorrow**.
4. Click **Schedule** to confirm the time (or **Clear** to remove it).
5. Press **Run**/send as usual — instead of dispatching immediately, your prompt is queued for the chosen time and the composer's draft is cleared.
6. While a run is scheduled, it shows as a pill above the composer with the provider, run time, and countdown. Click the **X** on the pill to cancel it before it fires.

Scheduling requires an open, workspace-backed chat — the clock icon is disabled on global chats or when no chat is open.

## Tips & related
- [Goal Button](goal-button.md) — sits right next to the schedule control in the same row.
- [Routines and Scheduled Tasks](../goals-todos-and-scheduling/routines-and-scheduled-tasks.md) — the broader scheduling system this one-shot schedule plugs into, including recurring workflows.
- [Slash Commands](slash-commands.md) — other composer-driven controls alongside scheduling.
