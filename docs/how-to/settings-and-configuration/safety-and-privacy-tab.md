# How to: Safety and privacy tab

**Platform:** Electron

## What it is
The Safety & Privacy tab is a read-only overview of TaskWraith's risk posture: a summary of agentic policy settings, saved workspace grants, provider/MCP surfaces, paired-device visibility, and local history — with deep-link buttons to the tabs that actually own each setting.

## Where to find it
Open **Settings → Data → Safety & Privacy**.

<!-- TODO(screenshot): Safety and privacy tab showing risk posture overview and deep-links -->

## How to use it
1. Open **Settings → Data → Safety & Privacy** to see the summary cards: always-allow policy count, saved workspace grants, provider surfaces signed in or usage-visible, MCP bridge connection count, user MCP server count, and (if device pairing is visible) remote workspace count.
2. Review **Policy posture** for a scope-tagged readout of each agentic service — Shell commands, File changes, Provider tools, Sub-thread delegation, Canvas interaction, Media editing, and Network access — with a tone pill showing whether it's set to always-allow, ask, or block. Click **Edit policies** to jump to the Providers tab and change these.
3. Review **Data surfaces** for plain-language explanations of where TaskWraith keeps local history, provider sign-in state, MCP tool surfaces, user-managed MCP servers, paired-device visibility, and Canvas/Screen Watch capture — each card has a button (e.g. **Open General**, **Open Providers**, **Open Provider Tools**, **Open MCP Servers**, **Open Devices**, **Open Approvals**) that jumps to the owning tab.
4. Review **Provider data flow** to see each provider's (Codex, Claude, Kimi, Cursor, Grok, Ollama) local sign-in/availability status — a reminder that transcript content is still sent to whichever provider runtime you choose for a run.
5. Click **Open grants** in the header to jump straight to Approvals & Grants and revoke any saved workspace grant.

## Tips & related
- [Provider Agentic Policies](../approvals-and-permissions/provider-agentic-policies.md) — where the policy matrix shown here is actually edited.
- [Approval Ledger](../approvals-and-permissions/approval-ledger.md) — full audit log and workspace grant revocation.
- [Providers tab](providers-tab.md) — provider sign-in and agentic service settings.
- [Provider Tools tab](provider-tools-tab.md) — MCP bridge status and built-in tool catalog detail.
