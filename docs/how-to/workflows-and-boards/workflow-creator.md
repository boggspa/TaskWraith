# How to: Workflow Creator

**Platform:** Electron

## What it is
Turns a normal chat into a repeatable run template. Opens a fresh chat with workflow-specific welcome, the composer's **Ensemble** On/Off control, and a workflow settings row for cadence, interval, daily run limit, and unattended permission level. The first message saves it as a workflow and becomes its running thread.

## Where to find it
Select **Code**, then click **+** (New workflow) in the sidebar's **Workflows** section. Disabled until you have at least one workspace, since workflows run inside workspaces.

![New workflow draft with inline workflow and Ensemble controls](../images/workflows-and-boards__workflow-creator.png)

## How to use it
1. Select **Code**, then click **+** beside **Workflows** in the sidebar. This opens a new chat in compose mode with workflow controls below the composer.
2. If Ensemble mode is enabled, set **Ensemble** to **On** or **Off**. Switching keeps your drafted prompt.
3. Set **Cadence** to **Manual** (run yourself) or **Every** with a number of minutes.
4. Set **Max runs per day** to cap how often it can run.
5. Choose **Unattended permissions** — **Safe** (read-only), **Default permissions**, or **Full Access** — for runs without you present.
6. Type the agent's prompt and send. This saves the prompt and settings as a workflow definition — no run dispatches from this first send.

## Tips & related
- [Workflows Sidebar Section](workflows-sidebar-section.md) — manage, enable/disable, and view workflow history
- [Workflow Compose Controls](workflow-compose-controls.md) — details on cadence, interval, and permission controls
- [Permission Elevation Sheet](../approvals-and-permissions/permission-elevation-sheet.md) — confirms non-Safe unattended levels after saving
