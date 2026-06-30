# How to: MCP servers tab

**Platform:** Electron

## What it is
The MCP Servers tab is where you add, edit, and manage your own MCP (Model Context Protocol) server definitions — stdio commands, HTTP endpoints, or SSE endpoints. Enabled stdio and HTTP servers attach to Codex and Claude launches and to contained Cursor write-mode runs; SSE servers attach to Claude only. These are separate from TaskWraith's own built-in MCP bridge and tool catalog, which live on the Provider Tools tab.

## Where to find it
**Settings → Integrations → MCP Servers**

<!-- TODO(screenshot): MCP servers tab showing server list with add/edit/import controls -->

## How to use it
1. Click **Add server**, give it a name, choose a transport (stdio, HTTP, or SSE), and fill in the command (stdio) or URL (HTTP/SSE).
2. For stdio servers, add arguments and environment variables; for HTTP/SSE servers, add headers and an optional bearer token environment variable.
3. Toggle **Enabled** so the server is offered to provider runs, then click **Save server**.
4. Use **Import config** to paste a Claude or Cursor JSON `mcpServers` block, or a Codex TOML `mcp_servers` snippet, and add those servers in bulk.
5. Check each server's readiness badge (ready, disabled, or needs attention) to see if it's missing a command, URL, or other required field.
6. Use the **Copy audit JSON**, **Copy Claude JSON**, **Copy Cursor JSON**, and **Copy Codex TOML** buttons to export your server definitions into another tool's config format; stored values are redacted in the on-screen previews.
7. Use **Edit** or **Delete** on an individual server row to update or remove it.

## Tips & related
- [Provider Tools tab](provider-tools-tab.md) — TaskWraith's own built-in MCP bridge status and tool catalog, separate from your user-managed servers here.
- [Providers tab](providers-tab.md) — sign in and configure the Codex, Claude, Kimi, Grok, Cursor, and Ollama providers that these MCP servers attach to.
- [Local servers tab](local-servers-tab.md) — manage dev servers and watchers running under your workspaces, a different kind of "server" from MCP definitions.
- [Plugins tab](plugins-tab.md) — another integrations surface for extending TaskWraith's capabilities.
