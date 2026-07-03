# How to: Proposed plan cards

**Platform:** Electron

## What it is
A proposed plan card is a collapsible "Plan" panel that appears inline in the transcript when an agent running in **Plan** mode presents a plan for you to review. It lets you approve the plan (which re-runs the agent with write access to implement it), edit it before approving, dismiss it, or send free-text feedback so the agent revises it — all without leaving plan mode until you approve.

Plan mode uses a read-only execution posture for normal tools. Its only write carve-out is the product-managed markdown plan artifact saved under a validated workspace path for this approval flow; Read-only/Recon mode does not get that artifact write, and Plan mode does not permit arbitrary file edits or shell writes.

## Where to find it
Appears automatically in the **transcript**, attached to the assistant message that contains the plan, whenever the active permission preset is **Plan** (set via the composer's permissions chip) and the agent's reply is plan-shaped — either an explicit plan block, or (while in plan mode) a substantive turn with real structure.

<!-- screenshot-pending: Proposed plan card in the transcript -->

## How to use it
1. Send a message with the composer's permissions chip set to **Plan** so the agent runs read-only except for the markdown-plan artifact carve-out and is prompted to propose a plan.
2. When the plan card appears, click its header (or the chevron) to expand or collapse the plan body.
3. Click **Approve & implement** to accept the plan as-is — this switches the chat off plan mode to **Default Approval** and re-dispatches the thread with write access to implement it.
4. Click **Edit** to revise the plan text in place, then **Approve edited plan** to implement your edited version instead of the original.
5. Click **Respond…** to type free-text feedback (or press Cmd/Ctrl+Enter to send) asking the agent to revise the plan — this stays in plan mode and does not implement anything.
6. Click **Dismiss** to reject the plan without implementing it; the chat stays in plan mode.
7. Once you've approved or dismissed, the card collapses to a read-only outcome badge ("Approved" or "Dismissed") and the action row disappears.

## Tips & related
- [Provider, model, and permissions pickers](../composer/provider-model-permissions-pickers.md) — where you switch the composer to **Plan** to trigger these cards.
- [Permission elevation sheet](../approvals-and-permissions/permission-elevation-sheet.md) — related approval-posture prompts you may see when a run needs higher trust.
