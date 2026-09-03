# How to: Workflow Compose Controls

**Platform:** Electron

## What it is
The settings row under the composer when drafting a new workflow: cadence, interval, max runs per day, and unattended permission level. Ensemble On/Off is the composer's separate **Ensemble** control.

## Where to find it
Select **Code**, open **Workflows** in the sidebar, and click **+** (New workflow). This opens a fresh chat in workflow-compose mode, with the workflow hero above and controls below the composer.

![Workflow compose controls showing cadence and interval pickers](../images/workflows-and-boards__workflow-compose-controls.png)

## How to use it
1. Choose **Cadence**: **Manual** (runs when triggered) or **Every** (runs on a fixed interval).
2. If you chose **Every**, set the interval in **Minutes**.
3. Set **Max runs per day** to cap frequency.
4. Use the composer's **Ensemble** control: choose **On** for a multi-agent workflow — this converts the draft to an Ensemble chat.
5. Pick **Unattended permissions**: **Safe** (read-only), **Default permissions**, or **Full Access** for runs without you watching.
6. Type your prompt and send — the first send saves these settings as the workflow definition.

## Tips & related
- [Workflow Creator](workflow-creator.md) — the complete creation flow with these controls
- [Workflows Sidebar Section](workflows-sidebar-section.md) — manage workflows after creation
- [Permission Elevation Sheet](../approvals-and-permissions/permission-elevation-sheet.md) — unattended level details
- [Ensemble Orchestration Row](../composer/ensemble-mode-picker.md) — the Fan-Out, Isolate, and Turns controls shown once the draft is an Ensemble
