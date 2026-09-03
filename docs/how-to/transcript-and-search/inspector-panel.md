# How to: Inspector panel

**Platform:** Electron

## What it is
A right-dock panel for examining run details: file diffs, unpushed commits, raw events, and the composed prompt.

## Where to find it
Click **Inspect** in the right-dock rim (the icon strip at the chat edge) to open it. Four views are available: **Diff Studio**, **Commits**, **Raw Events**, and **Prompt**.

![Inspector panel showing the Diff Studio, Commits, Raw Events and Prompt views](../images/transcript-and-search__inspector-panel.png)

## How to use it
1. Open **Diff Studio** to review file changes for the current run or workspace. Use the workspace selector if the run touched multiple workspaces.
2. Open **Commits** to browse unpushed commits, group selected commits into a PR, and manage that PR.
3. Open **Raw Events** to see the live, filterable stream of stdout, stderr, and tool events.
4. Open **Prompt** to inspect what the run was sent: Layers view shows structure, Wire view shows exact text.

## Tips & related
- [Activity stack](activity-stack.md) — inline collapsible tool-call rows in the transcript
- [Diff hover preview](diff-hover-preview.md) — quick popover preview of a diff
- [Sub-Thread Delegation](../chats-and-threads/sub-thread-delegation.md) — delegated sub-threads in the transcript
- Provider settings now live in **Settings → Providers** and **Safety & Privacy**
