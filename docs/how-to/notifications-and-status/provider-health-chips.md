# How to: Provider health chips

**Platform:** Electron

## What it is
Provider health chips are small status pills in the composer that warn you when the current chat's provider isn't ready to run — for example the provider's CLI isn't installed or signed in, an API key is missing, network access is blocked, or a tool category is blocked by your settings.

## Where to find it
Chips appear in the **composer chips row**, just above the prompt input, alongside the queued-run-count chip. The row only renders when there's something to show.

<!-- screenshot-pending: OllamaHealthChip showing green/connected state next to provider picker -->

## How to use it
1. Glance at the chips row before sending a message — a warning chip means the active provider has a problem.
2. Hover a chip to read the full tooltip: what's wrong and what it affects.
3. Fix the underlying issue — install or sign in to the provider's CLI, start the local Ollama server, select an installed model, or adjust the agentic service policy — and the chip clears automatically once the provider reports healthy.

## Tips & related
- For Ollama, readiness appears alongside the standard permission picker (Plan, Ask, Accept Edits, Full WS Access, or Full Access) and the run-profile control — local models use the same permission roles as cloud providers.
- Cursor becomes runnable once `cursor-agent` is installed and signed in; its chips report ordinary setup, binary, and login readiness.
- [Provider, Model, and Permissions Pickers](../composer/provider-model-permissions-pickers.md) — the composer chips these health warnings sit alongside.
- [Participant health](participant-health.md) — the equivalent per-participant check inside Ensemble chats.
- [Provider agentic policies](../approvals-and-permissions/provider-agentic-policies.md) — the settings behind blocked-tool and blocked-network warnings.
- [Providers tab](../settings-and-configuration/providers-tab.md) — sign in to a provider a chip reports as unavailable.
