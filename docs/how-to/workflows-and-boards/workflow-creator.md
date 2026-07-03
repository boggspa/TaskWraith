# How to: Workflow Creator

**Platform:** Electron

## What it is
The workflow creator turns a normal chat into a repeatable run template. It opens a fresh chat whose welcome screen swaps the usual starter prompts for workflow controls (run-as-ensemble, cadence, interval, daily run limit, and unattended permission level); sending your first message saves it as a `WorkflowDefinition` and the chat becomes that workflow's thread.

## Where to find it
In the sidebar's **Workflows** section, click the **+** ("New workflow") button. It's disabled until you have at least one workspace, since workflows always run inside a workspace.

<!-- screenshot-pending: Workflow creator modal with name, prompt, and cadence fields -->

## How to use it
1. Click **+** next to **Workflows** in the sidebar. This opens a new chat in compose mode with the workflow controls under the composer.
2. If ensemble mode is enabled in settings, choose **Run as ensemble** (On/Off) — this is locked once the workflow has started.
3. Set **Cadence** to **Manual** (run it yourself) or **Every** with a number of minutes for recurring runs.
4. Set **Max runs per day** to cap how often the workflow can fire.
5. Choose **Unattended permissions** — Safe (read-only), Default permissions, or Full Workspace Access — for runs that happen without you present.
6. Type the prompt the agent should run each time, then send it. This save acts as creation: the prompt and settings become a saved workflow, and no run is dispatched from this first send.

## Tips & related
- [Workflows Sidebar Section](workflows-sidebar-section.md) — manage, enable/disable, and view history for workflows you've created.
- [Workflow Compose Controls](workflow-compose-controls.md) — details on the cadence/interval/permission controls shown during creation.
- [Permission Elevation Sheet](../approvals-and-permissions/permission-elevation-sheet.md) — confirms non-safe unattended permission levels after the workflow is saved.
