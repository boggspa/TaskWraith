# How to: Local servers tab

**Platform:** Electron

## What it is
The Local servers tab lists dev servers and watchers (Next.js, Vite, and similar) running under your workspaces — both the ones agents start to test their changes and any you started yourself — grouped by workspace, with controls to stop them.

## Where to find it
**Settings → Integrations → Local servers**

<!-- screenshot-pending: Local servers tab showing dev server list with workspace associations -->

## How to use it
1. Open **Settings → Integrations → Local servers** to see how many servers are currently running, grouped by workspace.
2. Click a server's port badge (e.g. `:3000`) to open it in your browser.
3. Click **Stop** on a single server, or **Stop all** to shut down every listed server at once (you'll be asked to confirm).
4. Click **Refresh** to re-scan if the list looks out of date.
5. Toggle **Run agent commands in their own process group** if you want Stop to kill the whole process tree (e.g. npm → node → workers) instead of just the wrapper process. This is off by default.
6. Toggle **Stop agent-spawned servers when TaskWraith quits** to have TaskWraith automatically clean up servers its agents started when you close the app. This is also off by default.

## Tips & related
- Servers TaskWraith's agents started are labeled with an **agent** badge so you can tell them apart from ones you launched yourself.
- On platforms where automatic process detection isn't available, only agent-spawned servers (the ones TaskWraith tracked itself) are shown.
- [Workspaces tab](workspaces-tab.md) — manage the workspaces these servers run under.
- [MCP servers tab](mcp-servers-tab.md) — another Integrations entry for managing external tool connections.
- [Devices tab](devices-tab.md) — Integrations tab for iOS pairing and remote access.
