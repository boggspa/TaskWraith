# How to: Workflows Sidebar Section

**Platform:** Electron

## What it is
The Workflows section lists your automated workflows — saved prompts that run manually, once, or on an interval instead of as a single one-off chat message. Reserved or imported cron definitions can be decoded and displayed, but the current scheduler does not evaluate cron expressions. Each entry shows its name, trigger cadence, and current status, and expands into controls for running, pausing, editing, and deleting it.

## Where to find it
Select **Code**, then find **Workflows** in the sidebar hierarchy. Click the header to collapse or expand the section, or click a workflow to open its chat and expand its detail panel.

![Expanded Workflows section in its empty state with the New workflow button](../images/workflows-and-boards__workflows-sidebar-section.png)

## How to use it
1. Click the **+** button beside the **Workflows** header to start a new workflow (requires at least one workspace — workflows run inside a workspace).
2. Click a workflow row to open its chat in the main pane and expand its detail panel, showing next run time, last run status, and recent run history.
3. In the expanded detail panel, use the icon strip to **Run now**, add the workflow to a **Workspace Board**, **Pause/Resume** it, set or change its **interval**, or grant/revoke **unattended permissions**. The current edit action is interval-only; it is not a full trigger editor.
4. While a workflow is actively running, a **Cancel** action appears in the icon strip.
5. Click **Delete** to remove a workflow.
6. Each workflow row shows its current status (e.g. paused, queued, running) and, for loop-based workflows, the iteration count from its last run.

## Tips & related
- [Workflow Creator](workflow-creator.md) — the inline first-send flow used to create a new workflow.
- [Workflow Compose Controls](workflow-compose-controls.md) — the cadence, interval, and unattended-level controls shown when composing a workflow.
- [Workspace Boards](workspace-boards.md) — use the workflow detail action strip to add it to a board alongside chats.
- [Add workspace](../getting-started/add-workspace.md) — workflows are workspace-scoped, so you need a workspace before creating one.
