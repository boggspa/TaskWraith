# How to: Inspector panel

**Platform:** Electron

## What it is
The Inspector is the right-dock panel for digging into a chat's run details: file diffs, your unpushed commit stack, raw streamed events, and the composed prompt.

## Where to find it
Click **Inspect** in the right-dock rim (the icon strip at the edge of the chat) to open it. Inside the panel, four views are available: **Diff Studio**, **Commits**, **Raw Events**, and **Prompt**.

![Inspector panel showing the Diff Studio, Commits, Raw Events and Prompt views](../images/transcript-and-search__inspector-panel.png)

## How to use it
1. Open **Diff Studio** to review file changes for the current run or the whole workspace; if a run touched multiple write-enabled workspaces, a selector lets you switch between them.
2. Open **Commits** to browse the workspace's unpushed commit stack with per-commit attribution, group selected commits into a pull request, and manage that PR — open, update, and track it — through an audited GitHub lifecycle.
3. Open **Raw Events** to see the live, filterable stream of stdout/stderr/tool events as the agent runs — filter by `stdout`, `stderr`, or `tool`.
4. Open **Prompt** to inspect what the run was actually sent: a Layers view of the composed prompt envelope with per-layer digests, and a Wire view of the exact text dispatched at the transport's launch boundary.

## Tips & related
- [Activity stack](activity-stack.md) — the inline, collapsible tool-call rows in the transcript, where sub-agent and tool invocation detail now lives.
- [Diff hover preview](diff-hover-preview.md) — a quick popover preview of a diff; use Diff Studio here when you need the full view.
- [Sub-Thread Delegation](../chats-and-threads/sub-thread-delegation.md) — delegated sub-threads, shown in the transcript.
- Provider sandbox, approval policy, auth state and tooling now live in **Settings → Providers**, **Safety & Privacy**, and **Provider Tools**; `/status`, `/permissions`, `/model` and `/mcp` open them directly.
