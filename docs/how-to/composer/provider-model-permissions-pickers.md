# How to: Provider, Model, and Permissions Pickers

**Platform:** Electron

## What it is
Two chips under the prompt box decide how your next message runs. The **model chip** shows the provider logo, the model name, and the reasoning level. The **permissions chip** shows what the agent may do — **Plan**, **Ask**, **Accept Edits**, **Full WS Access**, or **Full Access**.

## Where to find it
On the composer's picker row, just below the prompt input. In an Ensemble chat with a participant selected, the chips change that participant instead of the whole chat.

![Composer inline pickers row with provider, model+reasoning, and permissions chips](../images/composer__provider-model-permissions-pickers.png)

## How to use it
1. Click the **model chip**. Providers and their models are listed on the left; the **Reasoning** ladder is on the right.
2. Pick a provider and a model. A model that cannot run says why, and one being retired shows its date.
3. Drag the **Reasoning** slider. Its stops climb **Off → Light → Medium → High → Extra → Max → Ultracode → persistent → UltraTask**, and the thumb only stops where your model actually supports it.
4. Toggle **Fast** below the ladder to use the paid fast tier. Models that support it show a lightning bolt.
5. Click the **permissions chip** and pick a mode. Lowering applies straight away; **Accept Edits** warns once per workspace, and **Full WS Access** or **Full Access** ask you to confirm every time.

## Tips & related
- Change a chip while a turn is running and it applies at the end of that turn — the run is never interrupted.
- In an Ensemble, the permissions popover adds **Apply to all participants** to copy one mode across the roster.
- [Model Catalogue](../../MODEL_CATALOGUE.md) — every model, its reasoning levels, and Fast support.
- [Permission Elevation Sheet](../approvals-and-permissions/permission-elevation-sheet.md) — the confirmation shown when you raise permissions.
- [Ensemble Orchestration Row](ensemble-orchestration-row.md) — the row where these chips edit one participant.
