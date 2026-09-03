# How to: Pending Approval Modal

**Platform:** Electron

## What it is
A card that pauses the chat when an agent wants to do something gated — run a shell command, edit a file outside the workspace, call an MCP tool. It shows what was asked for and lets you allow it, widen the allowance, or refuse.

## Where to find it
It appears by itself above the composer of the chat that asked, whenever an agent's action needs your approval.

<!-- screenshot-pending: Pending approval modal showing Accept / Decline options with countdown -->

## How to use it
1. Read the title, message, and details — the path, command, or payload being requested.
2. Optionally type a short note in the **why?** field; it is saved with your decision.
3. Click **Allow once** to approve just this request. Everything similar still asks next time. For a sandbox escape this button reads **Rerun outside sandbox**.
4. To allow more than one, use the wider choice below: **Allow matching requests for this run** lasts until the run ends, and **Allow matching requests in this workspace** lasts until you revoke it in Approvals & Grants. When the request names a service, both read "Allow all *service*…" instead.
5. Click **Deny** to refuse this one request, or **Cancel run** to stop the run waiting on it.

## Tips & related
- For a shell request TaskWraith can pin exactly, you get **Add exact command to Allowlist** in place of the for-this-run button. It allows only that literal command, and you can revoke it later.
- **Use Provider Native** hands the request to the provider's own approval flow; **Use TaskWraith Sub-thread** moves the work into a sub-thread instead. Both appear only when the request supports them.
- **Start Full Access...** raises just this chat, or the selected participant, then approves. It never turns on auto-approval anywhere else. It reads **Full Access in main window** and is disabled when the change must be made there.
- If a countdown is showing ("Auto-denies in…") and you do nothing, the request is denied for you. A **+N more** badge means more are queued behind it.
- [Approval Ledger](approval-ledger.md) — full audit history of past approval decisions.
- [Approval Timeouts](approval-timeouts.md) — configure the per-provider auto-deny countdown.
- [Provider Agentic Policies](provider-agentic-policies.md) — set which services each provider can use without prompting.
- [Approvals Popover](../footer-control-row/approvals-popover.md) — pending approvals across all chats.
