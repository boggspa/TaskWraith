# How to: General tab

**Platform:** Electron

## What it is
The General tab holds TaskWraith's core behavior settings: your display name, conversation context length, display currency, Task Complete and Ensemble round cards, welcome-screen heatmaps and dashboard stats, the Kimi compatibility filter, approval timeouts, and product operations like auto-update, diagnostics export, and a danger-zone chat history wipe.

## Where to find it
Open **Settings → App → General**.

<!-- TODO(screenshot): General tab showing behavior settings, context turns slider, and product ops section -->

## How to use it
1. Set **Your name** so New General Chat greetings can address you by name.
2. Choose **Conversation context turns** to control how many recent user/assistant turns are sent with each prompt (0 sends only the current message).
3. Pick a **Display currency** (USD, GBP, or EUR) for cost chips, refresh exchange rates, and optionally dial in a **Conservative overestimate** percentage (0–25%) so displayed costs over-shoot the real bill.
4. Toggle **Show Task Complete summary cards** and **Collapse older Ensemble rounds** to control how finished runs and ensemble rounds are presented in the transcript.
5. Under **Welcome activity heatmaps** and **Dashboard statistics**, show or hide individual heatmaps and stat chips on the new-chat welcome screen, control the Workspaces and Providers dashboard tabs (including auto-cycle timing), and reset dashboard stats back to today.
6. Enable the **Kimi compatibility filter** to redact known Moonshot-rejected topics from prompts sent to Kimi ensemble participants only — your transcript itself is never modified; optionally turn on the classifier retry pass and add custom trigger phrases.
7. Turn on **Auto-deny approvals after a timeout** and set per-provider timeout windows (Codex, Claude, Kimi, plus Main authority) so unanswered approvals don't block a run indefinitely.
8. Under **Product operations**, enable Auto-Update and pick an update channel, then use **Refresh health**, **Export diagnostics**, or **Repair install** as needed.
9. Use **Delete chat history** in the danger zone to permanently remove local chat transcripts and run history from this Mac — workspaces and settings are left intact.

## Tips & related
- [Appearance tab](appearance-tab.md) — visual/theme settings, also under Settings → App.
- [Keyboard shortcuts tab](keyboard-shortcuts-tab.md) — another Settings → App tab.
- [Safety and privacy tab](safety-and-privacy-tab.md) — approval and permission policy settings beyond timeouts.
- [Welcome Screen](../getting-started/welcome-screen.md) — where the heatmaps and dashboard stats you configure here are displayed.
