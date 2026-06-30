# How to: Channels tab

**Platform:** Electron

## What it is
The Channels tab manages TaskWraith's local/self-hosted message channel gateway. It lets you bind an external messaging conversation (iMessage, Telegram, Matrix, or local web chat) to a TaskWraith chat, so a trusted operator can send commands like `tw status` from their phone and TaskWraith dispatches them through your normal approval and permission policy — no TaskWraith-hosted relay involved.

## Where to find it
Go to **Settings → Channels**. This tab only appears when the channel gateway build flag is enabled; on a default build it is hidden.

<!-- TODO(screenshot): Channels tab showing bridge configuration and gateway status -->

## How to use it
1. Check the **Adapters** section to see which channel adapters are available: iMessage (macOS-only, reads `~/Library/Messages/chat.db`), Telegram (needs a bot token configured via environment variable), Matrix (needs a homeserver URL and access token), and local web chat.
2. For iMessage, grant **Full Disk Access** to TaskWraith from the setup card, then click **Scan recent** to list recent conversations and pick the one where your phone messages the TaskWraith contact.
3. Fill in the **New binding** form: choose the channel, give it a label, set the account/conversation identifiers, pick the **operator channel** (the TaskWraith chat it routes into), choose a **provider** and **route target**, and set a **trigger prefix** (default `tw`) so only prefixed messages dispatch.
4. Set **Allowed handles** to the exact sender handle(s) permitted to use this binding, then save the binding.
5. Send a test message to confirm macOS Messages automation consent (iMessage only), then text the trigger command (e.g. `tw status`) from your phone and click **Poll binding** (or enable **Scheduled polling** with a poll interval) to confirm TaskWraith receives and dispatches it.
6. Use the **First-run validation** checklist to track setup progress step by step, and **Inspect rows** or the audit log to debug delivery issues. Archive a binding or use **Start over** to reset setup.

## Tips & related
- [Devices tab](devices-tab.md) — manage iPhone/iPad pairing and remote access separately from message channel bindings.
- [Safety and privacy tab](safety-and-privacy-tab.md) — review risk posture and grant status that govern what a channel-dispatched run can do.
- [Approval ledger](../approvals-and-permissions/approval-ledger.md) — channel commands still flow through the same approval policy as any other run.
- [Provider agentic policies](../approvals-and-permissions/provider-agentic-policies.md) — controls the permissions a channel-routed provider run is granted.
