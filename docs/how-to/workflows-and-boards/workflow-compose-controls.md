# How to: Workflow Compose Controls

**Platform:** Electron

## What it is
The Workflow Compose Controls are the settings row under the composer when you're drafting a new workflow: cadence (manual or interval), max runs per day, an ensemble on/off toggle, and the unattended permission level the workflow runs with.

## Where to find it
Open the **Workflows** section in the sidebar and click the **+** (New workflow) button. This opens a fresh chat in workflow-compose mode, and the controls appear under the composer in place of the usual starter-prompt suggestions.

<!-- screenshot-pending: Workflow compose controls showing cadence and interval pickers -->

## How to use it
1. Choose a **cadence**: **Manual** (the workflow only runs when you trigger it) or **Every** (runs on a fixed interval).
2. If you chose **Every**, set the interval in **Minutes**.
3. Set **Max runs per day** to cap how often the workflow can fire.
4. Optionally turn on **Run as ensemble** to make this a multi-agent workflow instead of a single-provider one — this swaps the draft to an ensemble chat and carries over any prompt you've already typed.
5. Pick the **Unattended permissions** level the workflow is allowed to use when it runs without you watching: **Safe (read-only)**, **Default permissions**, or **Full Workspace Access**.
6. Type your prompt in the composer and send it — the first send saves these settings as the workflow's definition and turns this chat into the workflow's thread.

## Tips & related
- [Workflow Creator](workflow-creator.md) — the modal alternative for creating a workflow with the same cadence and max-runs settings.
- [Workflows Sidebar Section](workflows-sidebar-section.md) — manage, run, and edit workflows after they're created.
- [Permission Elevation Sheet](../approvals-and-permissions/permission-elevation-sheet.md) — more on unattended elevation levels and how they cap permissions.
- [Ensemble Mode Picker](../composer/ensemble-mode-picker.md) — the composer control behind "Run as ensemble".
