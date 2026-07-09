# How to: Provider health chips

**Platform:** Electron

## What it is
Provider health chips are small status pills in the composer that report whether the current chat's provider is ready to run. For most providers (Codex, Claude, Kimi, Grok, Cursor) this is a warning chip that only appears when something needs attention — e.g. the provider binary or login isn't ready, network access is blocked, or a tool category is blocked by settings. For Ollama, readiness is shown alongside the normal permissions/runtime controls: the local model uses the same permission roles as cloud providers, while the Ollama run profile controls local prompting/runtime behavior.

## Where to find it
Warning chips appear in the **composer chips row**, just above the prompt input, alongside the queued-run-count chip — the row only renders when there's something to show. For Ollama specifically, status appears with the standard permission role and run-profile controls rather than a separate tool-tier picker.

<!-- screenshot-pending: OllamaHealthChip showing green/connected state next to provider picker -->

## How to use it
1. Glance at the composer chips row before sending a message — a warning chip means the active provider has a problem (unavailable, blocked tool category, or blocked network access).
2. Hover a warning chip to read its full tooltip message, which explains what's wrong and what it affects.
3. For Ollama, use the normal permission picker to choose Plan, Read-Only/Recon, Default Approval, Workspace Write, or Trusted Session, and use the run-profile control for local-model behavior.
4. If the Ollama trigger shows a ⚠, open it and check whether the local server/model is unavailable or a standard permission/network policy is blocking the requested capability.
5. Fix the underlying issue (sign in where relevant, start the local Ollama server, select an installed model, or adjust agentic service policy) and the chip clears automatically once the provider reports healthy.

## Tips & related
- [Provider, Model, and Permissions Pickers](../composer/provider-model-permissions-pickers.md) — the composer chips these health warnings sit alongside, including the standard permissions picker used by Ollama.
- [Participant health](participant-health.md) — the equivalent per-participant connectivity check inside Ensemble chats.
- [Provider agentic policies](../approvals-and-permissions/provider-agentic-policies.md) — the settings that drive blocked-tool and blocked-network warnings.
- [Providers tab](../settings-and-configuration/providers-tab.md) — sign in to a provider or check its setup state when a chip reports it unavailable.
