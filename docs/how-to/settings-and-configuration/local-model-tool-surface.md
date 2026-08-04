# How to: Local model (Ollama) tool surface

**Platform:** Electron + iOS (behavior applies to any local Ollama-backed participant)

## What it is
Local models run through Ollama use the same TaskWraith capability catalog and permission gates as cloud providers, but the top-level tool list stays compact. The current gateway profile advertises **41 direct tools** plus `capability_search` and `capability_invoke`. Specialized tools remain available behind the gateway instead of inflating the model's function list.

<!-- screenshot-pending: Provider Tools view showing Ollama's gateway profile and compact direct tool surface -->

## How the surface is shaped
1. **Direct surface (41 tools).** Common workspace reads and edits, shell and Git actions, user decisions, goals/todos, delegation, and Ensemble coordination are callable by their own names.
2. **Discovery gateway.** For a specialized capability, the model calls `capability_search` with a short description. The result includes exact names and schemas that are eligible for that run.
3. **Hidden-tool invocation.** The model passes a discovered name and arguments to `capability_invoke`. The target keeps its original approval policy, workspace and network guards, write locks, budgets, media handling, and audit identity.
4. **Legacy lookup.** Ollama still accepts `tool_help` for backwards-compatible schema lookup, but new prompts teach `capability_search` followed by `capability_invoke`.
5. **Constrained decoding.** On the text/JSON protocol, the top-level grammar contains the direct tools, the two gateway tools, and legacy `tool_help`. Hidden tool names travel as `capability_invoke` arguments; they do not expand the top-level grammar.

## What the run's permission role changes
- **Network denied:** network targets such as `web_search` and `web_fetch` are not eligible through the gateway, matching the run's network gate.
- **Read-only / plan run:** the 39-tool baseline is intersected with the shared read-only profile; edit and shell actions are not directly advertised, and mutating hidden targets remain ineligible.
- **Default / workspace-write / trusted postures:** the full direct profile is available; edits and shell either prompt or run according to the effective permission policy.

## If a local model misbehaves
- **It "forgets" a tool exists** → the specialized tail is intentionally hidden. Ask it to use `capability_search`, then `capability_invoke` with the returned schema.
- **It loops on empty/garbled turns** → a retry ceiling stops it after a few non-productive turns rather than nudging forever.
- **It calls a hidden tool directly** → the runtime rejects the direct call and tells the model to use the capability gateway.
- **It names a tool that doesn't exist** → discovery or invocation returns a specific validation error rather than silently dropping the call.

## Tips & related
- [Provider tools tab](provider-tools-tab.md) — audit the full TaskWraith tool catalog and per-provider bridge status.
- [Providers tab](providers-tab.md) — sign in and check runtime health for Ollama and the cloud providers.
- [Provider, model, and permissions pickers](../composer/provider-model-permissions-pickers.md) — choose the run's Plan, Ask, Accept Edits, Full WS Access, or Full Access posture.
- [Providers tab](providers-tab.md) — configure the Ollama endpoint and default local model.
