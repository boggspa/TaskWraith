# How to: Sub-thread status ticker

**Platform:** Electron

## What it is
The sub-thread status ticker is a subtle status strip above the parent chat's
transcript. While at least one of the parent's directly delegated sub-threads
is running, it shows the parent seat as "orchestrating" plus one provider chip
per active sub-thread; when no direct sub-thread is running it disappears
entirely.

## Where to find it
Open a parent chat while one of its sub-threads is running. The ticker renders
above the transcript in the main chat view, in the side-chat pane, and inside
Multiview panes.

## How to use it
1. Delegate work from a parent chat; the child appears nested beneath it in the
   sidebar and, while it runs, as a ticker entry above the parent transcript.
2. Click a ticker entry to open that sub-thread.
3. When a child finishes, its entry leaves the ticker. A typed terminal return
   card appears in the parent when result return is enabled.
4. An idle parent shows no ticker — the sidebar's nested child rows remain the
   place to inspect finished or queued sub-threads.

## Tips & related
- [Sub-Thread Delegation](../chats-and-threads/sub-thread-delegation.md) — how sub-threads get created in the first place.
- [Side Chat](../chats-and-threads/side-chat.md) — a related but separate kind of linked chat.
- [Participant health](participant-health.md) — status cards for ensemble participants.
- [Provider health chips](provider-health-chips.md) — connectivity/model-load state chips.
