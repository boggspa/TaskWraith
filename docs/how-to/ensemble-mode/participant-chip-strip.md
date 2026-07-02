# How to: Participant Chip Strip

**Platform:** Electron

## What it is
The chip strip shows every participant in an ensemble chat as a row of chips. Click a chip to select it and edit its settings, drag to reorder the speaking sequence, and use the per-chip overflow popover to enable/disable a participant, rename their role, or assign them as Boss.

## Where to find it
In an ensemble chat, the strip sits in the composer's above-row stack: below the branch / files-changed / Create PR row (and any external-path rows), and above the message textarea. It also renders on the welcome state for a new ensemble chat so you can configure participants before sending the first prompt.

<!-- TODO(screenshot): Participant chip strip above composer with multiple provider chips -->

## How to use it
1. Click a chip to select it. The selected chip gets a highlighted border, and the composer's model and permissions pickers below now read/write that participant's settings.
2. Click the already-selected chip a second time to open its overflow popover, where you can toggle **Enabled in ensemble rounds**, assign **Boss** (and optionally allow Boss auto-approvals), change the **Role** preset (or type a custom one), and edit the **Goal / brief**.
3. Press and drag a chip horizontally to reorder the speaking sequence; drop it on or near another chip to move it there.
4. Use the **+** button at the end of the strip to add a participant (pick a provider from the popover), or select a chip and use the **−** button to remove it. Ensembles require at least 2 participants, and the strip caps out at 20. From 6 participants the strip splits into balanced rows of at most 5 chips (e.g. 7 → 3+4, 13 → 4+4+5, 20 → 5+5+5+5), so role names stay readable.
5. Each chip shows a status icon (idle, speaking, answered, yielded, failed, skipped, sleeping, unreachable, cancelled). A failed or unreachable chip shows an inline retry button; a sleeping chip's popover offers **Wake now** / **Cancel wakeup**.
6. While a round is running, membership changes are locked — you can still select chips to inspect them, and a **Skip** button appears to advance past the currently-speaking participant without cancelling the whole round.

## Tips & related
- [Create an Ensemble Chat](create-ensemble-chat.md) to get an ensemble chat with a chip strip in the first place.
- [Saved Roster Presets](saved-roster-presets.md) to apply or save a participant lineup instead of building one chip at a time.
- [Mention & Yield Routing](mention-yield-routing.md) for how `@Role` mentions and explicit yields change who speaks next, independent of chip order.
- [Continuous Hops Meter](continuous-hops-meter.md) for the related handoff-budget control shown alongside the strip in Continuous mode.
