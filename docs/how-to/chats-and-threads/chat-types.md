# How to: Chat Types

**Platform:** Electron

## What it is
TaskWraith organizes work into several chat types: workspace chats and General chats (scoped to a project folder or not), single-provider chats and Ensembles (multiple agents in one thread), Workflows (scheduled, multi-stage chats), and linked child chats — sub-threads (agent-delegated) and side chats (user-opened) — plus Shared chats that a host can share with collaborators.

## Where to find it
The sidebar groups chats into sections: **Pinned**, **Recents**, **Ensembles**, **Workspaces** (each with its own chat list and Workflows/Workspace Boards), **Chats** (General chats not tied to a workspace), and **Shared**. Use the **+ New** button in the sidebar masthead to create a chat of a specific type.

<!-- screenshot-pending: Sidebar showing various chat types (workspace, ensemble, shared, workflow) -->

## How to use it
1. Click **+ New** in the sidebar masthead, then pick a type: **New Chat** (workspace or General, depending on context), **New Workflow**, **New Workspace Board**, or one of the **Shared** variants (General, Workspace, or Ensemble). To start an Ensemble, create a new draft and turn on the **Ensemble** button in the composer's bottom row before your first send, or use the **+** button in the sidebar's **Ensembles** section.
2. Workspace chats appear under that workspace in the **Workspaces** section; chats not tied to a workspace appear under **Chats** as General chats.
3. Ensembles (chats running more than one agent) get their own row in the **Ensembles** section — they don't appear in the workspace or **Chats** (General) lists, but a pinned or recently active ensemble also surfaces in **Pinned** or **Recents**.
4. To branch off an existing chat without losing context, open a side chat from the message context menu, or let an agent delegate part of its work to a sub-thread — both appear nested under their parent chat and are limited to one level deep.
5. To collaborate with others, create a Shared chat from the **+ New** menu, or use **Join Shared Chat** to follow along on one someone else shared with you; shared chats live in the **Shared** sidebar section.

## Tips & related
- [Sidebar sections](../sidebar-navigation/sidebar-sections.md) — how Pinned, Recents, Ensembles, Workspaces, Chats, and Shared are organized.
- [Workspace and chat tree](../sidebar-navigation/workspace-and-chat-tree.md) — how chats nest under workspaces.
- [Create an Ensemble chat](../ensemble-mode/create-ensemble-chat.md) — running multiple agents in one chat.
- [Sub-thread delegation](sub-thread-delegation.md) and [Side chat](side-chat.md) — linked child chats branched off a parent.
- [Shares popover](../footer-control-row/shares-popover.md) — managing chats you've shared with others.
