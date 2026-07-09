# How to: Approval Ledger

**Platform:** Electron

## What it is
The Approval Ledger is an audit log of every approval decision TaskWraith has recorded — manual accept/decline, auto-allow by policy, and auto-deny by timeout — across all providers and chats. It also lists durable workspace grants you've issued and lets you revoke them.

## Where to find it
**Settings → Automation → Approvals & Grants.**

![Approval Ledger panel with filter and export controls](../images/approvals-and-permissions__approval-ledger.png)

## How to use it
1. Open **Settings → Automation → Approvals & Grants** to see the **Workspace grants** list at the top — durable grants that stay active until revoked (session and per-run grants expire automatically and aren't listed here).
2. Click **Revoke** on a workspace grant to remove it, or use **Forget all sub-thread delegations for this workspace** to bulk-revoke delegation grants tied to the workspace you're currently viewing.
3. Filter the ledger below by **provider**, **time range** (last 24 hours / 7 days / 30 days / all time), or the status chips (pending, approved, denied, cancelled, expired), and use the search box to match an approval id, title, or workspace.
4. Click a row to expand it and see details: method, service, decision, decision source, granted scope, any attached note, timestamps, run/chat ids, and the full request body or metadata.
5. Click **Refresh** to pull the latest decisions, or **Export JSON** to download the currently-filtered records for sharing or forensics. Treat the export as sensitive: approval rows can include request bodies, command previews, file paths, prompt snippets, metadata, decision notes, and workspace identifiers.

## Tips & related
- [Pending Approval Modal](pending-approval-modal.md) — where the original accept/decline decisions are made.
- [Permission Elevation Sheet](permission-elevation-sheet.md) — prompts for raising approval posture, also recorded here.
- [Provider Agentic Policies](provider-agentic-policies.md) — the per-provider policies that drive auto-allow/auto-deny decisions.
- [Approvals Popover](../footer-control-row/approvals-popover.md) — sidebar footer queue that deep-links into this same panel.
