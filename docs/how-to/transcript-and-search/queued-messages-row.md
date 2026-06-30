# How to: Queued messages row

**Platform:** Electron

## What it is
The queued messages row shows the prompts waiting to run for the current chat — messages you sent while a run was already active, plus any messages you scheduled for later. Each entry appears as its own bubble with its provider, position in the queue, and Edit / Steer / Delete actions.

## Where to find it
Above the composer input, in the same stack that holds the ensemble participant chips and the Create-PR row. It only appears when the chat has pending queued work; up to 5 entries show at once, with the rest reachable by scrolling the list.

<!-- TODO(screenshot): Queued messages row above the composer input -->

## How to use it
1. Send a prompt while a run is already in progress (or schedule one for later) — it appears as a row in the queue instead of dispatching immediately.
2. Use the **↑** / **↓** buttons, or drag a row by its body, to reorder the queue.
3. Click **Edit** to load that queued prompt back into the composer and remove it from the queue so you can revise and resend it.
4. Click **↳ Steer** to cancel the chat's active run and dispatch that queued message immediately.
5. Click **✕** to delete a queued message and drop it from the queue.
6. For a scheduled message, the row shows a countdown badge instead of the Steer button, counting down to its dispatch time.

## Tips & related
- [Schedule prompt](../composer/schedule-prompt.md) — schedule a prompt for later; it shows up here as a countdown pill until it fires.
- [Participant chip strip](../ensemble-mode/participant-chip-strip.md) — the ensemble chip strip that shares this same above-composer stack.
- [Transcript message stream](./transcript-message-stream.md) — once a queued job dispatches, it appears in the transcript as a normal message.
