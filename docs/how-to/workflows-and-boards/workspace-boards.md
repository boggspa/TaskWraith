# How to: Workspace Boards

**Platform:** Electron

## What it is
A kanban-style view scoped to one workspace. Columns include Inbox, Ready, Running, Needs Input, Blocked, Review Ready, and Done. Cards can be standalone or link to a chat, workflow, scheduled task, run-queue job, or local server, and linked cards inherit live status from their targets.

## Where to find it
Select **Code**, then open **Workspace Boards** in the sidebar. Click a board to open it in the center stage. Create a new one from the sidebar **New Workspace Board** menu (requires at least one workspace).

![Workspace board view with kanban columns and cards](../images/workflows-and-boards__workspace-boards.png)

## How to use it
1. Select **Code**, then open a board from the **Workspace Boards** section in the sidebar.
2. If the board shows "N untracked workspace items," click **Create N cards** to auto-populate with the workspace's threads, workflows, tasks, jobs, and servers.
3. Add a card manually using the **Add board card** form (title, optional note and link); new cards land in Inbox.
4. Move a card by dragging it to another column, using the column dropdown, or **Up**/**Down** buttons.
5. Click **Details** on a card to edit its title, body, owner, labels, blocked reason, next step, or reminder, or to unlink it.
6. Click **Open** on a linked card to jump to its chat, workflow, or local server.
7. Use **Search cards** or **Needs attention** to filter by running, needs-input, blocked, review-ready, or stale states.
8. Click **Archive** to hide a card (use **Undo archive** to restore the last archived card), or delete permanently from Details.

## Tips & related
- [Workflows Sidebar Section](workflows-sidebar-section.md) — manage workflows that board cards can link to
- [Board Overflow Actions](board-overflow-actions.md) — pin, rename, duplicate, or archive a board
- [Workflow Creator](workflow-creator.md) — create workflows for your boards
