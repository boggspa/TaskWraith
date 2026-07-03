# How to: Create an Ensemble Chat

**Platform:** Electron

## What it is
An Ensemble chat is a single thread where multiple provider agents (Claude, Codex, Kimi, Grok, Cursor, and/or local Ollama models) take part in the same conversation and respond in turn, instead of you running separate single-provider chats.

## Where to find it
Sidebar **+ New → New Ensemble**, or the **+** button in the sidebar's **Ensembles** section header.

<!-- screenshot-pending: Sidebar overflow menu showing "New ensemble" option -->

## How to use it
1. Click **+ New** in the sidebar masthead and choose **New Ensemble** (or click the **+** on the **Ensembles** section header). The chat is created immediately — there's no setup modal.
2. The new chat opens with a default panel of participants already enabled (one per configured provider, or the full roster if fewer than two providers are configured), shown as a chip strip above the composer.
3. Click a chip to select that participant; the composer's model and permissions pickers below now read and write that participant's settings. Click the selected chip again to open its overflow popover, where you can enable/disable it, rename its role, or edit its brief.
4. Drag a chip to reorder the speaking sequence, then type your prompt and send — each enabled participant responds in turn according to that order.

## Tips & related
- [Participant Chip Strip](participant-chip-strip.md) — full detail on selecting, reordering, and editing participants.
- [Saved Roster Presets](saved-roster-presets.md) — apply a saved line-up instead of editing the default panel by hand.
- [Ensemble Mode Picker](../composer/ensemble-mode-picker.md) — choose Turn, Continuous, or Work Session orchestration for the chat.
- [Round Cards in Transcript](round-cards.md) — how completed rounds are displayed once the ensemble starts responding.
