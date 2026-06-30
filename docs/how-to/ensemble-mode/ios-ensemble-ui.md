# How to: iOS Ensemble UI

**Platform:** iOS

## What it is
In an Ensemble chat on the iOS companion app, a horizontal strip of participant chips sits above the message composer. Each chip shows a provider, a status indicator, and (for the Boss participant) a crown badge. Tapping any chip opens the full-page **Roster** editor, where you add, remove, reorder, and configure participants, and load or save roster presets shared with your Mac.

## Where to find it
Open any Ensemble chat on the companion app — the chip strip appears automatically in the composer, above the message field. Tap a chip, or tap the **Roster** icon in the thread's toolbar, to open the Roster page.

<!-- TODO(screenshot): iOS companion showing ensemble strip and roster sheet -->

## How to use it
1. In an Ensemble chat, view the participant chips above the composer; each shows the provider's glyph, role/provider label, and a status mark (checkmark when done, a waveform while speaking, a lock for a retired provider).
2. Tap the **+** at the end of the strip to add a participant from any connected provider, or tap an existing chip to open the Roster page focused on that participant.
3. In the Roster page, drag a participant's row to reorder turn order, swipe to remove it, or tap **Edit** to enable/disable it.
4. Tap a participant row to edit its model, reasoning effort, permissions, role, and brief in the chip editor sheet; mark one participant **Boss** there if you want a designated decision-maker.
5. Tap **Add participant** at the bottom of the Roster page to add another provider to the lineup.
6. Use the **Presets** section at the top of the Roster page to save the current roster as a reusable preset (shared with your Mac), or tap a saved preset to replace the current roster with it.
7. Tap **Done** to close the Roster page and return to the chat.

## Tips & related
- [Create an Ensemble Chat](create-ensemble-chat.md) — start a multi-provider chat to use the ensemble UI on.
- [Participant Chip Strip](participant-chip-strip.md) — the Electron equivalent of the chip strip.
- [Saved Roster Presets](saved-roster-presets.md) — more on how presets are built and shared between Mac and iOS.
- [Mention & Yield Routing](mention-yield-routing.md) — how `@Role` mentions change who speaks next, independent of chip order.
