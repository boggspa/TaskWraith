# How to: Providers tab

**Platform:** Electron

## What it is
The Providers tab is where you sign in to each AI provider, manage per-provider API keys and CLI paths, and set the agentic policies, pause/reroute rules, and audit-orchestration options that apply to every provider run.

## Where to find it
Open **Settings → AI & Providers → Providers**.

![Providers tab showing provider sign-in cards and agentic policy matrix](../images/settings-and-configuration__providers-tab.png)

## How to use it
1. Open **Settings → AI & Providers → Providers** to see the **Provider sign-in** checklist — one card each for Codex, Claude, Kimi, Cursor, Grok, and Ollama. Expand **Need to install a CLI?** for the official install command per provider.
2. Sign in to a provider from its card: Codex, Cursor, Grok, and Ollama use **Open Terminal to sign in / sign out** (runs the provider's own CLI login), Claude uses **Login with Claude** (opens a browser) or an API key, and Kimi uses **Open Terminal to sign in** for the current Kimi Code ACP transport.
3. Under **Agentic services**, set the policy (ask, always allow, or block) for shell commands, file changes, provider tools, sub-thread delegation, canvas interaction, media editing, and network access — see [Provider Agentic Policies](../approvals-and-permissions/provider-agentic-policies.md) for the full matrix.
4. Set **Codex sandbox fallback** to control whether TaskWraith offers to rerun a Codex command from the host process after a Swift/Xcode sandbox collision.
5. Under **Audit role providers** and **Audit budget**, choose which providers `/audit` can fall back to beyond the parent chat's provider, and optionally cap the max agents or tokens an audit run can spend.
6. Scroll to each provider's own section (Claude, Kimi, Local/Ollama) to review its transport-specific controls or override its CLI binary path. Kimi can retain a Moonshot API key for legacy Wire/print paths, but current ACP seats use `kimi login`. Ollama also has an **endpoint** field and a **Default local model** picker pulled from your locally installed models.
7. On any provider card, use **Pause new runs** to stop new dispatches to that provider while leaving sign-in and active runs untouched — optionally set an **Until** time, a **Reason**, and a **Reroute while paused** provider/model/approval fallback so new runs go elsewhere automatically.

## Tips & related
- [Provider Agentic Policies](../approvals-and-permissions/provider-agentic-policies.md) — full detail on the Agentic services policy matrix edited here.
- [Provider Tools tab](provider-tools-tab.md) — MCP bridge status, built-in tool catalog, and image-generation key card (Settings → Integrations).
- [Safety and privacy tab](safety-and-privacy-tab.md) — read-only risk-posture summary with deep-links back to this tab.
- [Model usage tab](model-usage-tab.md) — token/cost activity for providers you sign in to here.
