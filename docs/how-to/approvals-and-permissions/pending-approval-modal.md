# How to: Pending Approval Modal

**Platform:** Electron

## What it is
The pending approval card blocks the active chat turn when an agent requests a gated action (running a shell command, editing a file outside the workspace, calling an MCP tool, etc.). It shows the request details and lets you allow it once, allow it for the workspace or session, or deny it — with an optional auto-deny countdown.

## Where to find it
Appears automatically above the composer for the chat that triggered the request, whenever an agent's action needs your approval.

<!-- screenshot-pending: Pending approval modal showing Accept / Decline options with countdown -->

## How to use it
1. Read the request title, message, and any preview details (target path, command, or payload) shown on the card.
2. Optionally type a short note in the "why?" field to record your reasoning — it's saved with the decision.
3. Choose a response:
   - **Allow once** — approve just this request (becomes **Rerun outside sandbox** for sandbox-escape reruns).
   - **Use Provider Native** — hand the request to the provider CLI/SDK's own native approval flow instead of TaskWraith handling it (only offered when the request supports it).
   - **Use TaskWraith Sub-thread** — move the work into a TaskWraith sub-thread so it continues with isolated context and its own approval handling.
   - Under **Longer approval scopes**: **Allow … for session** — approve matching requests for the rest of the app session (restarting the app clears the grant) — and **Allow … in workspace** — approve this kind of request for the current workspace until you revoke it in Approvals & Grants. When the request names a service, both labels name that service.
   - **Start Full Access...** — raise only this chat, or the selected ensemble participant, to the Full Access preset and then approve this request once. It is lane-scoped: other chats and participants are unchanged, and it does not turn on process-wide auto-approval. The button reads **Full Access in main window** and is disabled when the change has to be made from the main window.
   - **Deny** — reject this specific request.
   - **Cancel run** — stop the run that's waiting on the approval.
4. If a countdown is shown ("Auto-denies in...") and you don't respond in time, the request is automatically denied.
5. If more approvals are queued behind this one, a "+N more" badge appears; the next request shows once you respond to the current one.

## Tips & related
- [Approval Ledger](approval-ledger.md) — full audit history of past approval decisions.
- [Approval Timeouts](approval-timeouts.md) — configure the per-provider auto-deny countdown.
- [Provider Agentic Policies](provider-agentic-policies.md) — set which services each provider can use without prompting.
- [Approvals Popover](../footer-control-row/approvals-popover.md) — view pending approvals across all chats from the sidebar footer.
