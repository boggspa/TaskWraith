# How to: Sub-thread status ticker

**Platform:** Electron

## What it is
The sub-thread status ticker is a slim status strip that lists which of the current chat's sub-threads are actively running, so you can see delegated work in progress without leaving the parent chat.

## Where to find it
It renders inline above the transcript of the parent chat, and only appears while at least one of that chat's sub-threads is running — it disappears again once all sub-threads finish or stop.

<!-- TODO(screenshot): SubThreadStatusTicker showing running/completed sub-thread states -->

## How to use it
1. Delegate work to a sub-thread (see Sub-Thread Delegation) from a chat — once it starts running, the ticker appears above the transcript.
2. Read the ticker: the left side shows the parent agent "orchestrating," and the right side lists a chip per active sub-thread, each labeled with its provider (Codex, Claude, Kimi, Grok, Cursor, or a local Ollama model).
3. Click a sub-thread chip to jump to that sub-thread's chat.
4. Let it run — the ticker clears on its own once every sub-thread of the current chat finishes.

## Tips & related
- [Sub-Thread Delegation](../chats-and-threads/sub-thread-delegation.md) — how sub-threads get created in the first place.
- [Side Chat](../chats-and-threads/side-chat.md) — a related but separate kind of linked chat.
- [Participant health](participant-health.md) — status cards for ensemble participants.
- [Provider health chips](provider-health-chips.md) — connectivity/model-load state chips.
