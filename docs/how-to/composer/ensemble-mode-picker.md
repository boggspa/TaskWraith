# How to: Ensemble Mode Picker

**Platform:** Electron

## What it is
The Ensemble Mode picker is the composer control that sets how participants take turns in an ensemble chat: **Turn** (each agent speaks once per round), **Continuous** (agents can hand work back and forth within a round), or **Work Session** (opens the supervised, multi-round autonomy setup sheet). A separate Off/Read/Writers fan-out toggle sits beside it for running read-only participants in parallel.

## Where to find it
In an **ensemble chat**, look at the **composer's action row** above the input box. The picker appears as a labeled button (showing the current mode — "Turn", "Continuous", or "Work Session") next to the Off/Read/Writers fan-out chip. It only shows up once a chat is already in ensemble mode.

<!-- TODO(screenshot): Composer ensemble mode picker showing Turn / Continuous / Work Session options -->

## How to use it
1. Click the mode button (labeled with the current mode) to open the picker popover.
2. Choose **Turn** for strict round-robin, or **Continuous** to let agents hand off mid-round via `@mentions` or `ensemble_yield`.
3. Choose **Work Session** to open the setup sheet for supervised, multi-round autonomy with an objective, acceptance criteria, and a budget.
4. In the same popover, drag the **shared history budget** slider to control how many characters of recent panel history each participant receives.
5. Use the **Off / Read / Writers** buttons beside the picker to enable parallel fan-out for read-only (or, where unlocked, writer) participants.

## Tips & related
- [Create an Ensemble Chat](../ensemble-mode/create-ensemble-chat.md) — start an ensemble chat before this picker becomes available.
- [Fan-Out Toggle](../ensemble-mode/fan-out.md) — more on the Off/Read/Writers chip beside this picker.
- [Continuous Hops Meter](../ensemble-mode/continuous-hops-meter.md) — tracks remaining handoffs when using Continuous mode.
- [Participant Chip Strip](../ensemble-mode/participant-chip-strip.md) — manage who's in the round above the composer.
