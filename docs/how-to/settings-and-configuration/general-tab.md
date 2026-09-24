# How to: General tab

**Platform:** Electron

## What it is
The General tab holds TaskWraith's core behavior settings: your display name, conversation context length, display currency, Task Complete and Ensemble round cards, welcome-screen heatmaps and dashboard stats, the Kimi compatibility filter, approval timeouts, a danger-zone chat history wipe, and a collapsed disclosure of troubleshooting and audit-export actions.

## Where to find it
Open **Settings → App → General**.

![General tab showing behavior settings, context turns slider, and product ops section](../images/settings-and-configuration__general-tab.png)

## How to use it
1. Set **Your name** so new-chat greetings can address you by name.
2. Choose **Conversation context turns** to control how many recent turns are sent with each prompt (0 sends only the current message).
3. Pick a **Display currency** (USD, GBP, or EUR) for cost chips and optionally a **Conservative overestimate** percentage (0–25%) so displayed costs over-shoot the real bill.
4. Toggle **Show Task Complete summary cards** and **Collapse older Ensemble rounds** to control how finished runs and rounds appear in the transcript; under **Welcome activity heatmaps** and **Dashboard statistics**, show or hide heatmaps and stat chips on the new-chat welcome screen.
5. Enable the **Kimi compatibility filter** to redact known Moonshot-rejected topics from prompts sent to Kimi ensemble participants only — your transcript is never modified.
6. Turn on **Auto-deny approvals after a timeout** and set a window per provider so unanswered approvals don't block a run. Defaults: Codex 60 seconds; Kimi, Mistral, and Main authority 120 seconds; the other providers 240 seconds. Custom values range from 5 seconds to 60 minutes.
7. Use **Delete chat history** in the danger zone to permanently remove TaskWraith-owned local chats and run history. Provider sign-ins, workspace files, and settings are left intact — see [Trust & Safety](../../TRUST_AND_SAFETY.md#what-data-stays-local) for what stays local.
8. Expand **Advanced troubleshooting & audit data** at the bottom for support actions: **Refresh health**, **Export diagnostics**, **Export full audit bundle**, **Verify audit bundle**, **Repair install**, and scoped export bundles. Updates are managed from the sidebar update pill, not here.

## Tips & related
- [Appearance tab](appearance-tab.md) — visual/theme settings, also under Settings → App.
- [Keyboard shortcuts tab](keyboard-shortcuts-tab.md) — another Settings → App tab.
- [Safety and privacy tab](safety-and-privacy-tab.md) — approval and permission policy settings beyond timeouts.
- [Welcome Screen](../getting-started/welcome-screen.md) — where the heatmaps and dashboard stats you configure here are displayed.
