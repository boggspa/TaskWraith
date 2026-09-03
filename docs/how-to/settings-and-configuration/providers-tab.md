# How to: Providers tab

**Platform:** Electron

## What it is
The Providers tab is where you sign in to each AI provider, manage API keys and CLI paths, and set the approval policies, pause rules, and audit options that apply to every run.

## Where to find it
Open **Settings → AI & Providers → Providers**.

![Providers tab showing provider sign-in cards and agentic policy matrix](../images/settings-and-configuration__providers-tab.png)

## How to use it
1. Review the provider cards — sign-in and setup controls plus current status for Codex, Claude, Kimi, Cursor, Grok, Ollama, Pi, Mistral, Muse, and Devin. AntiGravity appears after its consent and credential setup; the older standalone Gemini provider remains only as history. Expand **Need to install a CLI?** for the official install commands.
2. Sign in from a provider's card. Codex, Grok, Cursor, Ollama, Muse, and Devin use **Open Terminal to sign in / sign out** (runs the provider's own CLI login); Kimi uses **Open Terminal to sign in** for Kimi Code; Claude uses **Login with Claude** in the browser or an API key; AntiGravity uses your Gemini API key; Pi uses configured upstream API keys; Mistral sets up through its official Vibe wizard. For Codex, use the button once instead of a bare `codex login` — it keeps TaskWraith's state in its own home — then click **Refresh sign-in status**. Devin also accepts a `WINDSURF_API_KEY` / `DEVIN_API_KEY` from your environment and an optional custom API server URL (HTTPS only; HTTP on loopback).
3. Under **Agentic services**, set the policy (ask, always allow, or block) for shell commands, file changes, provider tools, sub-thread delegation, canvas interaction, media editing, and network access — see [Provider Agentic Policies](../approvals-and-permissions/provider-agentic-policies.md) for the full matrix.
4. Set **Codex sandbox fallback** to control whether TaskWraith offers to rerun a Codex command from the host after a Swift/Xcode sandbox collision.
5. Under **Audit role providers** and **Audit budget**, choose which providers `/audit` can fall back to and optionally cap what an audit run can spend.
6. Use **Pause new runs** on any card to stop new dispatches to that provider while sign-in and active runs continue — optionally set an **Until** time, a **Reason**, and a **Reroute while paused** fallback so new runs go elsewhere automatically.

## Tips & related
- Devin's default model is SWE-1.6 Slow; pick the model and reasoning effort per chat from the composer pickers.
- Ollama's card has an **Ollama endpoint** field (local service only) and a **Default Ollama model** picker split into **Ollama Cloud** and **Local models** groups.
- Muse's card also carries a monthly spend cap.
- [Provider Agentic Policies](../approvals-and-permissions/provider-agentic-policies.md) — full detail on the policy matrix edited here.
- [Provider Tools tab](provider-tools-tab.md) — MCP bridge status, built-in tool catalog, and image-generation key card (Settings → Integrations).
- [Safety and privacy tab](safety-and-privacy-tab.md) — read-only risk summary with deep-links back to this tab.
- [Model usage tab](model-usage-tab.md) — token/cost activity for providers you sign in to here.
