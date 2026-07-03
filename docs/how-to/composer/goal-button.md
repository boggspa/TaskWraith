# How to: Goal Button

**Platform:** Electron

## What it is
The Goal button lets you set an active "Goal" for a chat — an objective and stopping condition that steers the agent (or, where supported, is handed natively to the provider) until you mark it paused, blocked, or complete.

## Where to find it
In the **composer's telemetry row** (the icon row beneath the prompt box), next to the Screen Watch and schedule controls. Click the target-shaped goal icon to open the Goal popover.

<!-- screenshot-pending: Composer goal button popover showing objective and status -->

## How to use it
1. Click the **Goal** button (disabled until a chat is open).
2. If there's no active goal yet, type the objective and stopping condition in the textarea and click **Set goal**.
3. The popover header shows the mode chip (e.g. "Native Claude goal", "Native Codex goal", "Native Grok goal", "Ollama managed", or "Guided by TaskWraith") so you know whether the provider is handling the goal natively or TaskWraith is steering it.
4. Once a goal is active, reopen the button to **Edit** the objective, **Pause**/**Resume** it, **Mark blocked** (you'll be asked for a reason), **Mark complete**, or **Clear** it entirely.
5. The button shows a dot while the goal is active, paused, or blocked, and a checkmark once it's completed.
6. You can also manage the goal from the composer with `/goal`, e.g. `/goal pause`, `/goal resume`, `/goal clear`, `/goal complete`, `/goal blocked <reason>`, `/goal edit`, or `/goal <objective>` to set one directly.

## Tips & related
- [Slash Commands](slash-commands.md) — the `/goal` command drives the same actions as the button.
- [Schedule Prompt](schedule-prompt.md) — sits right next to the Goal button in the telemetry row.
- [Provider, Model, and Permissions Pickers](provider-model-permissions-pickers.md) — whether a goal runs "native" depends on the selected provider/model.
