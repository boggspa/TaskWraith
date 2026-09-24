# How to: Queued messages row

**Platform:** Electron

## What it is
Shows prompts waiting to run for the current chat — messages you sent while a run was active, or scheduled messages. Each entry shows its provider, queue position, and Edit/Steer/Delete actions.

## Where to find it
Above the composer input, in the same stack as ensemble participant chips. Only appears when queued work is pending; up to 5 entries show, with the rest accessible by scrolling.

<!-- screenshot-pending: Queued messages row above the composer input -->

## How to use it
1. Send a message while a run is active (or schedule one) — it queues as a row instead of dispatching immediately.
2. Use **↑** / **↓** buttons, or drag a row, to reorder the queue.
3. Click **Edit** to load a queued prompt into the composer for revision.
4. Click **Steer** to cancel the active run and dispatch that queued message immediately.
5. Click **×** to delete a queued message from the queue.
6. For scheduled messages, a countdown badge replaces the Steer button.

## Tips & related
- [Schedule prompt](../composer/schedule-prompt.md) — schedule a prompt for later
- [Participant chip strip](../ensemble-mode/participant-chip-strip.md) — ensemble chips in the same above-composer stack
- [Transcript message stream](./transcript-message-stream.md) — queued jobs appear here after dispatching
