# How to: Workflows Sidebar Section

**Platform:** Electron

## What it is
Lists your automated workflows — saved prompts that run manually, once, or on an interval. Each entry shows its name, trigger cadence, and status, and expands into controls for managing it.

## Where to find it
Select **Code**, then find **Workflows** in the sidebar. Click the header to expand or collapse the section, or click a workflow to open its chat and detail panel.

![Expanded Workflows section in its empty state with the New workflow button](../images/workflows-and-boards__workflows-sidebar-section.png)

## How to use it
1. Click **+** beside **Workflows** to start a new workflow (requires a workspace — workflows run inside workspaces).
2. Click a workflow row to open its chat and expand its detail panel, showing next run time, last run status, and history.
3. In the detail panel, use the icon strip to **Run now**, **Add to Workspace Board**, **Pause/Resume**, set/change **interval**, or grant/revoke **unattended permissions**. Currently, only interval can be edited.
4. A **Cancel** action appears in the strip while a workflow is running.
5. Click **Delete** to remove a workflow.
6. Each row shows its status (e.g. paused, queued, running) and, for loop-based workflows, the iteration count from its last run.

## Tips & related
- [Workflow Creator](workflow-creator.md) — the first-send flow to create a new workflow
- [Workflow Compose Controls](workflow-compose-controls.md) — cadence, interval, and unattended-level controls
- [Workspace Boards](workspace-boards.md) — add workflows to boards alongside chats
- [Add workspace](../getting-started/add-workspace.md) — workflows need a workspace
