# How to: Goals

**Platform:** Both

## What it is
A thread-level objective and stopping condition for a single chat. It has a status — active, paused, blocked, or completed — and is either handled by TaskWraith or tracked natively by the provider.

## Where to find it
In the composer's control row, click the target-shaped **Goal** button to open the popover. The button is disabled until a chat is open.

![Goal popover showing objective text and lifecycle status dropdown](../images/goals-todos-and-scheduling__goals.png)

## How to use it
1. Click **Goal** and type the objective and stopping condition, then click **Set goal**.
2. The header shows a mode chip indicating if the provider or TaskWraith tracks it.
3. Reopen anytime to **Edit** the objective, **Pause**/**Resume** it, **Mark blocked** (with reason), **Mark complete**, or **Clear** it.
4. The button shows a dot when active, paused, or blocked, and a checkmark when complete.
5. Use `/goal <objective>` to set one from the composer, or `/goal pause`, `/goal resume`, `/goal block <reason>`, `/goal complete`, `/goal clear`.

## Tips & related
- [Goal Button](../composer/goal-button.md) — full detail on the popover and mode chip
- [Slash Commands](../composer/slash-commands.md) — the `/goal` command does the same as the button
- [To-dos](./todos.md) — checklist items agents post while working toward a goal
- [Routines and Scheduled Tasks](./routines-and-scheduled-tasks.md) — recurring runs, separate from chat Goals
