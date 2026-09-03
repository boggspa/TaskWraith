# How to: Proposed plan cards

**Platform:** Electron

## What it is
A collapsible plan panel that appears in the transcript when an agent in Plan mode proposes a plan. You can approve it, edit it first, dismiss it, or ask for changes.

## Where to find it
In the transcript, attached to an assistant message, when the composer's permission preset is set to **Plan** and the agent's reply contains a plan.

<!-- screenshot-pending: Proposed plan card in the transcript -->

## How to use it
1. Set the composer's permissions chip to **Plan** and send a message to request a plan.
2. When the plan card appears, click its header or chevron to expand or collapse it.
3. Click **Approve & implement** to accept the plan. This switches to write-access mode and re-runs the agent to carry it out.
4. Click **Edit** to change the plan text, then **Approve edited plan** to implement your version.
5. Click **Respond** to type feedback asking the agent to revise it.
6. Click **Dismiss** to reject the plan without implementing it.
7. After approving or dismissing, the card shows a read-only outcome badge.

## Tips & related
- [Provider, model, and permissions pickers](../composer/provider-model-permissions-pickers.md) — where to switch to **Plan** mode
- [Permission elevation sheet](../approvals-and-permissions/permission-elevation-sheet.md) — related approval prompts
