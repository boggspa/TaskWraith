# How to: Permission Elevation Sheet

**Platform:** Electron

## What it is
The permission elevation sheet is a confirmation dialog shown when you raise an agent's permission preset to a riskier level — **Default Approval** or **Full Workspace Access**. It warns you about what the agent can now do before the change takes effect, so a one-click preset change can't silently grant broad file access.

## Where to find it
Appears automatically over the current chat when you raise the **permissions chip** in the composer (or the side-chat composer) to Default Approval or Full Workspace Access. Raising to **Default Approval** shows a smaller notice once per workspace+provider combination; raising to **Full Workspace Access** shows a larger warning every time, with an explicit risk acknowledgement. Lowering the permission level (e.g. back to Plan or Read-only) never triggers this sheet.

<!-- screenshot-pending: Permission elevation sheet showing posture options -->

## How to use it
1. Open the **permissions chip** in the composer and pick **Default Approval** or **Full Workspace Access**.
2. Read the warning: Default Approval lets the agent create, edit, and delete files in the workspace without per-step prompts; Full Workspace Access goes further, additionally letting the agent run files, with no per-step confirmation at all.
3. For **Full Workspace Access**, check **"I understand the risks and am on a disposable or recoverable device"** — the **Enable Full Access** button stays disabled until you do.
4. Click **Continue** (Default Approval) or **Enable Full Access** (Full Workspace Access) to apply the change, or **Cancel** (or press Esc) to stay at the current, safer mode.
5. You can revoke an elevated permission at any time by reopening the permissions chip and picking a lower preset — no warning is shown when lowering.

## Tips & related
- [Provider, Model, and Permissions Pickers](../composer/provider-model-permissions-pickers.md) — the composer chip that triggers this sheet.
- [Pending Approval Modal](pending-approval-modal.md) — the per-action approval prompt you still see for individual gated actions even after elevating.
- [Approval Ledger](approval-ledger.md) — audit history that records permission elevation decisions.
- [Provider Agentic Policies](provider-agentic-policies.md) — controls which services and actions require approval in the first place.
