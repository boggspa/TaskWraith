# How to: Run cockpit panel

**Platform:** Electron

## What it is
The run cockpit (Run rail) is a right-dock panel that gives you a cross-chat view of every run in flight — active launches, queued/scheduled/failed runs, an AI-generated analysis of the selected run, the run's event timeline, and any draft handoffs — without leaving the chat you're in.

## Where to find it
Click the **Run** tab on the right-dock rim (or use the "Open Run rail" toggle) to open it for the current pane. It shows provider counts across all runs, a list of tracked launch processes, a list of run lanes you can click to select, and the selected run's analysis, timeline, and handoffs.

<!-- screenshot-pending: Run cockpit panel in the right dock -->

## How to use it
1. Open the **Run** tab in the right dock to see live counts of active, waiting, and failed runs, plus per-provider run counts along the top strip.
2. Under **Launches**, review any tracked launch processes (command, workspace, branch, output preview); click **Open** to visit a detected preview URL, **Thread** to jump to its chat, or **Stop** to cancel it.
3. Under **Runs**, click a lane to select it — this drives the Analyst and timeline sections below.
4. The Analyst section shows a deterministic local summary, risks, and next steps for the selected run automatically. Click **Local AI** to request a richer analysis from Apple Foundation Models on this Mac via the TaskWraith bridge daemon; if Foundation Models are unavailable or the request fails, the panel shows an error/unavailable notice instead of the AI analysis (select a different run and back to restore the deterministic summary).
5. Use **Open**, **Cancel**, **Retry**, **Duplicate**, or **Handoff** to act on the selected run directly from the panel.
6. Scroll down to the embedded timeline for the selected run's recorded events, and to **Handoffs** to dispatch or archive any draft handoff cards.

## Tips & related
- [Right dock rim](right-dock-rim.md) — the contextual Home/Chat/Run/Media/Notes/Files/Inspect/Term strip that the Run tab lives on.
- [Inspector panel](inspector-panel.md) — open the Inspect tab for the full diff/raw/delegation/timeline/safety view of a run.
- [Activity stack](activity-stack.md) — the inline tool-call trace for a run, shown in the transcript itself.
