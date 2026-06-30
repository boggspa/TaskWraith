# How to: Plugins tab

**Platform:** Electron

## What it is
The Plugins tab is a catalog of declarative capability bundles — manifests that describe MCP server presets, tool bundles, and metadata. You can browse, install, enable, update, and uninstall plugins here, but in the current version installed/enabled state is tracked separately from app settings and enabling a plugin does not yet run anything on its own; its only live effect is letting you materialize the MCP server presets it declares.

## Where to find it
**Settings → Integrations → Plugins**

<!-- TODO(screenshot): Plugins tab showing marketplace and installed plugin list -->

## How to use it
1. Use the search box to filter plugins by name, publisher, capability, or category.
2. Check the summary cards (Available, Installed, Enabled, Repairable, Updates, Blocked, Schema) for an at-a-glance view of the catalog.
3. Click **Install** on a plugin to add it; once installed, use the **Enable** toggle on its row.
4. If a plugin declares MCP server presets, click **Add MCP preset: \<name\>** to materialize one into your MCP Servers list.
5. Expand **Capability changes** or **Provenance JSON** on a row to inspect what a plugin update changes or how its trust/preflight data is sourced.
6. Click **Update** when a plugin shows "update available", or **Uninstall** to remove it.

## Tips & related
- [MCP servers tab](mcp-servers-tab.md) — manage the user-defined MCP servers that plugin presets get added to.
- [Provider Tools tab](provider-tools-tab.md) — TaskWraith's own built-in MCP bridge and tool catalog, separate from plugin-provided servers.
- [Providers tab](providers-tab.md) — sign in and configure the Codex, Claude, Kimi, Grok, Cursor, and Ollama providers that plugin-added MCP servers attach to.
