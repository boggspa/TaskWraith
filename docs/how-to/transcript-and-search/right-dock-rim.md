# How to: Right dock rim

**Platform:** Electron

## What it is
The right dock rim is the icon strip at the top of the right dock — the resizable panel docked to the right edge of the chat. It lets you switch between the dock's tabs (Chat, Run, Media, Notes, Files, Inspect) without leaving the transcript.

## Where to find it
It appears at the top of the right dock whenever the dock is open. The dock opens automatically when you open one of its panels (for example, clicking "Inspect" or opening the Run cockpit), and tabs for panels you haven't opened yet stay disabled until they have something to show.

<!-- screenshot-pending: Right dock rim tabs in the chat corner -->

## How to use it
1. Click a rim icon to switch the dock to that panel: **Chat** (an open side chat), **Run** (the run cockpit), **Media** (this chat's media), **Notes** (pinned messages), **Files** (the file editor), or **Inspect** (the inspector panel).
2. Switching tabs is exclusive — opening one panel closes whichever panel was open before, so only one shows at a time.
3. Disabled icons show why they're unavailable: **Chat** needs a side chat opened from a message first, **Files** needs a workspace bound to the chat, and **Notes** needs a chat open.
4. A badge on **Media** or **Notes** shows the current count of media items or pinned messages.
5. Click the **X** at the end of the rim to close the active panel (or hide the side chat if **Chat** is active).

## Tips & related
- [Run cockpit panel](run-cockpit-panel.md) — opened from the **Run** tab.
- [Inspector panel](inspector-panel.md) — opened from the **Inspect** tab; has its own set of sub-tabs.
- [File changes row](file-changes-row.md) — file diffs you can also review via the **Files** tab.
