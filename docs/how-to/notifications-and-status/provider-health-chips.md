# How to: Provider health chips

**Platform:** Electron

## What it is
Provider health chips are small status pills in the composer that report whether the current chat's provider is ready to run. For most providers (Codex, Claude, Kimi, Grok, Cursor) this is a warning chip that only appears when something needs attention — e.g. the provider binary or login isn't ready, network access is blocked, or a tool category is blocked by settings. For Ollama, the chip is folded into the runtime picker itself: its trigger shows the active tool tier and run profile, with a ⚠ badge when the selected tier isn't actually in effect.

## Where to find it
Warning chips appear in the **composer chips row**, just above the prompt input, alongside the queued-run-count chip — the row only renders when there's something to show. For Ollama specifically, status is shown on the **permissions/runtime control** in the composer's bottom controls row: its trigger label shows the tool tier (e.g. "read-only", "edits", "shell", "parity") and run profile, and a ⚠ icon appears on the trigger when Tier 4 (provider parity) is selected but not actually active for the current workspace.

<!-- TODO(screenshot): OllamaHealthChip showing green/connected state next to provider picker -->

## How to use it
1. Glance at the composer chips row before sending a message — a warning chip means the active provider has a problem (unavailable, blocked tool category, or blocked network access).
2. Hover a warning chip to read its full tooltip message, which explains what's wrong and what it affects.
3. For Ollama, open the permissions/runtime control to see the selected **tool tier** and **run profile** at a glance from its trigger label.
4. If the Ollama trigger shows a ⚠, open it and check the Tier 4 row — its sub-label explains whether you need to grant workspace parity in Settings or are in a global chat (which always runs read-only).
5. Fix the underlying issue (sign in, start the local Ollama server, adjust agentic service policy, or re-acknowledge Tier 4 for the workspace) and the chip clears automatically once the provider reports healthy.

## Tips & related
- [Provider, Model, and Permissions Pickers](../composer/provider-model-permissions-pickers.md) — the composer chips these health warnings sit alongside, including the permissions chip that Ollama's runtime picker replaces.
- [Participant health](participant-health.md) — the equivalent per-participant connectivity check inside Ensemble chats.
- [Provider agentic policies](../approvals-and-permissions/provider-agentic-policies.md) — the settings that drive blocked-tool and blocked-network warnings.
- [Providers tab](../settings-and-configuration/providers-tab.md) — sign in to a provider or check its setup state when a chip reports it unavailable.
