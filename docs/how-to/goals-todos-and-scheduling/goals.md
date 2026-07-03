# How to: Goals

**Platform:** Both

## What it is
A Goal is a thread-level objective and stopping condition attached to a single chat. It carries a lifecycle status — active, paused, blocked, or completed — and, depending on the selected provider, is either steered by TaskWraith or handed off natively to the provider (Codex, Claude, or Grok) to track itself.

## Where to find it
In the **composer's control row**, click the target-shaped **Goal** button to open the Goal popover. The button is disabled until a chat is open.

<!-- screenshot-pending: Goal popover showing objective text and lifecycle status dropdown -->

## How to use it
1. Click the **Goal** button and type the objective and stopping condition, then click **Set goal**.
2. The popover header shows a mode chip — "Native Codex goal," "Native Claude goal," "Native Grok goal," "Ollama managed," or "Guided by TaskWraith" — telling you whether the provider tracks the goal itself or TaskWraith is steering it.
3. Reopen the button anytime to **Edit** the objective, **Pause**/**Resume** it, **Mark blocked** (you'll be prompted for a reason), **Mark complete**, or **Clear** it.
4. The button shows a dot while the goal is active, paused, or blocked, and a checkmark once completed.
5. You can also drive the same actions from the composer with `/goal`: `/goal <objective>` to set one, plus `/goal pause`, `/goal resume`, `/goal block <reason>`, `/goal complete`, and `/goal clear`.

## Tips & related
- [Goal Button](../composer/goal-button.md) — full detail on the popover controls and mode chip.
- [Slash Commands](../composer/slash-commands.md) — the `/goal` command drives the same actions as the button.
- [To-dos](./todos.md) — checklist items an agent posts while working toward a goal.
- [Routines and Scheduled Tasks](./routines-and-scheduled-tasks.md) — recurring runs are a separate mechanism from a chat's Goal.
