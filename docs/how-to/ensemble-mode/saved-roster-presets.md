# How to: Saved Roster Presets

**Platform:** Electron

## What it is
A roster preset is a saved ensemble line-up — provider, model, reasoning, permissions, role, and brief for each participant, plus turn order and max-participant settings — that you can apply to start a new ensemble chat or swap into an existing one without rebuilding it by hand.

On a fresh preset store, TaskWraith adds six editable starter panels with 3, 4, 5, 6, 8, and 10 seats. It builds them only after configured-provider discovery is ready, uses only providers available to that user, and repeats those providers with their own default models when a panel needs more seats. Every starter seat begins at **Accept Edits**; none starts with Full WS Access, Full Access, or custom permission overrides.

## Where to find it
Settings → **AI & Providers → Ensemble roster** for the full editor (create, duplicate, rename, delete, and edit every participant). A compact picker for applying a saved preset is also available from the composer's ensemble controls when starting or editing a chat.

![Ensemble roster settings panel with saved presets](../images/ensemble-mode__saved-roster-presets.png)

## How to use it
1. Open **Settings → AI & Providers → Ensemble roster**. The left pane lists your saved presets, including the six starter panels on a fresh store; click **+ New** to create another. A new custom preset starts as a three-seat Boss + Captain + Specialist panel, with room for a second specialist and an optional outsider, or you can select an existing preset to edit it.
2. In the right-hand editor, set **Turn order** (turn-based or continuous) and **Max participants**, then add, remove, or reorder participants with the row controls.
3. For each participant, pick a provider/model and permissions, write a **Role / nickname** and **Brief / goal**, toggle **Enabled**, and optionally assign one **Boss** plus one **Captain** as second-in-command.
4. Use **☆ Save to pool** on a row to turn that participant into a reusable Agent, or **+ Add from pool** to drop a saved Agent into the roster; pooled Agents stay linked, so editing the Agent later updates every preset that uses it.
5. Use **Duplicate** to branch a variation of a preset, or **Delete** to remove one you no longer need.
6. Apply a preset from the composer's roster picker to load its participants into the current or a new ensemble chat.

## Starter panel roles

| Panel | Included roles |
| --- | --- |
| 3-seat Core | Orchestrator, Advisor, Work1 |
| 4-seat Review | Orchestrator, Advisor, Work1, Challenge1 |
| 5-seat Balanced | Orchestrator, Advisor, Scout1, Work1, Challenge1 |
| 6-seat Delivery | Orchestrator, Advisor, Scout1, Work1, Work2, Challenge1 |
| 8-seat Extended | Orchestrator, Advisor, Boardmaster, Scout1, Scout2, Work1, Work2, Challenge1 |
| 10-seat Full Panel | Orchestrator, Advisor, Boardmaster, Scout1, Scout2, Work1, Work2, Work3, Challenge1, Challenge2 |

Orchestrator is the Boss. Advisor and Boardmaster are management Captains when present. Scouts, Workers, and Challengers are tagged for scout, worker, and reviewer fan-out stages respectively. Each seat receives the shared panel map plus a role-specific, task-agnostic assignment.

Starter panels are ordinary saved roster JSON after creation: you can edit, duplicate, export, import, rename, or delete them. TaskWraith seeds only when the roster storage key has never been initialized, so deleting every preset does not make them return on restart.

## Tips & related
- Keep a panel small unless the task benefits from explicit reconnaissance, parallel workstreams, or independent challenge; larger panels add coordination and token cost.
- [Create an Ensemble Chat](create-ensemble-chat.md) — start a multi-provider chat that a roster preset can populate.
- [Ensemble Orchestration Row](../composer/ensemble-mode-picker.md) — the fan-out, isolation, and turn-budget controls presets capture.
- [Participant Chip Strip](participant-chip-strip.md) — the in-chat strip for adjusting participants once a chat is running.
- [Providers tab](../settings-and-configuration/providers-tab.md) — sign in to the providers a roster preset references.
