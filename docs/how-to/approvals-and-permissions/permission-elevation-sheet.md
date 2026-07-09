# How to: Permission Elevation Sheet

**Platform:** Electron

## What it is
The permission elevation sheet is a confirmation dialog shown when you raise an agent's permission preset to **Trusted Session** — TaskWraith's highest local authority. It spells out exactly what that chat or participant lane can now do before the change takes effect, so a one-click preset change can't silently grant host-level access.

## Where to find it
Appears automatically over the current chat when you raise the **permissions chip** in the composer (or the side-chat composer) to **Trusted Session**. Moving between the lower presets (Plan, Read-Only/Recon, Default Approval, Workspace Write) applies immediately without a confirmation, and lowering the permission level never triggers this sheet.

![Trusted Session confirmation sheet with risk acknowledgement checkbox](../images/approvals-and-permissions__permission-elevation-sheet.png)

## How to use it
1. Open the **permissions chip** in the composer and pick **Trusted Session**.
2. Read the warning: a Trusted Session raises **only this chat or participant lane** to TaskWraith's highest local authority — it may allow shell commands without the workspace sandbox, signing or keychain-backed tools, and files outside the workspace when the provider adapter supports it.
3. Note what stays protected: other chats and ensemble participants are unchanged, and TaskWraith still prompts or denies for external publishing, Canvas eval, media recording, per-call-only prompts, and anything blocked by global policy.
4. Check **"I understand this applies only to … and stays active until I lower that lane's permission"** — the **Start Trusted Session** button stays disabled until you do.
5. Click **Start Trusted Session** to apply the change, or **Cancel** (or press Esc) to stay at the current, safer preset.
6. You can revoke it at any time by reopening the permissions chip and picking a lower preset — no warning is shown when lowering.

## Tips & related
- [Provider, Model, and Permissions Pickers](../composer/provider-model-permissions-pickers.md) — the composer chip that triggers this sheet.
- [Pending Approval Modal](pending-approval-modal.md) — the per-action approval prompt you still see for individual gated actions even after elevating.
- [Approval Ledger](approval-ledger.md) — audit history that records permission elevation decisions.
- [Provider Agentic Policies](provider-agentic-policies.md) — controls which services and actions require approval in the first place.
