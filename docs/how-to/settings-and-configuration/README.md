# Settings & Configuration

Settings is a full-app takeover panel where you configure everything about TaskWraith — app behavior, appearance, AI providers, automation, workspaces, integrations, and data. Open it with the **Settings** (gear) button in the sidebar footer, **Cmd+,** on macOS, or **Ctrl+,** on Windows/Linux; use the search box to filter tabs by name or keyword, then click **Back to app** (or press **Escape**) to return. The sidebar rail groups tabs into six sections: **App**, **AI & Providers**, **Automation**, **Workspaces**, **Integrations**, and **Data**.

## Guides

### App
- [General tab](general-tab.md) — core app behavior, dashboard defaults, approval timeouts, the chat-history danger zone, and advanced troubleshooting/audit exports.
- [Appearance tab](appearance-tab.md) — themes, composer shells, fonts, density, motion, transparency, and visual effects.
- [Keyboard shortcuts tab](keyboard-shortcuts-tab.md) — editable app keybindings and command shortcuts.
- **About & Licenses** — TaskWraith licensing, exact packaged dependency notices, and Chromium attribution.

### AI & Providers
- [Providers tab](providers-tab.md) — provider sign-in, runtime health, CLI/API setup, and agentic service policies.
- [Saved Roster Presets](../ensemble-mode/saved-roster-presets.md) — the **Ensemble roster** tab for reusable multi-provider participant sets.
- **Agent pool** — reusable agent identities, models, roles, icons, hues, and their all-time pool-linked run statistics.

### Automation
- [Approval ledger](../approvals-and-permissions/approval-ledger.md) — the **Approvals & Grants** tab for decisions, audit entries, and saved grants.
- [Thread introspection](../../THREAD_INTROSPECTION.md) — review generated memory proposals and apply supported workspace conventions after approval.

### Workspaces
- [Workspaces tab](workspaces-tab.md) — registered workspaces, launch targets, pinning, removal, and paired-device access.

### Integrations
- [Provider Tools tab](provider-tools-tab.md) — the TaskWraith MCP bridge, built-in tool catalog, provider surfaces, and policy audit.
- **Runtime profiles** — provider binaries, workspace modes, environment variables, encrypted environment references, and permission/network defaults.
- [MCP Servers tab](mcp-servers-tab.md) — user-managed MCP server definitions, transport, commands, URLs, and env vars.
- [Plugins tab](plugins-tab.md) — declarative capability bundles, installed state, and marketplace metadata.
- **Custom Instructions** — standing prompt preferences: the global instructions document and the workspace `TASKWRAITH.md` layer.
- **Skills** — user and workspace skill libraries: enablement, create, delete, and Finder roots.
- **Hooks** — host-mediated shell hooks for SessionStart, PreToolUse, PostToolUse, and Stop lifecycle events.
- [Local servers tab](local-servers-tab.md) — dev servers and watchers running under workspaces, with lifecycle controls.
- [Devices tab](devices-tab.md) — iPhone/iPad pairing, remote workspace access, Tailscale, bridge networking, and push wake.
- [Channels tab](channels-tab.md) — global overview of hosted and joined channels: members, revoke, close, audit.
- [Local model tool surface](local-model-tool-surface.md) — how Ollama exposes the compact gateway profile and reaches specialized tools on demand.

### Data
- [Safety & Privacy tab](safety-and-privacy-tab.md) — risk posture, local history, provider data flow, mobile visibility, and grant status.
- **Notification banners** — wording of run-complete notifications on paired iPhone and iPad (hidden when iOS remote is off).
- **Archived** — restore, permanently delete, or export archived conversation threads.
- [Model usage tab](model-usage-tab.md) — cross-provider quota, token, usage, cost, and context snapshots.

## Cross-links

Some settings surfaces are also documented in their feature sections:

- [Settings entry](../sidebar-navigation/settings-entry.md) — the sidebar footer button that opens Settings.
- [Pinned messages](../chats-and-threads/pinned-messages.md) — the **Pinned messages** tab (Data group).
