# How to: Continuous Hops Meter

**Platform:** Electron

## What it is
The Continuous Hops Meter is the `n/m` chip that tracks extra handoff turns used in a Continuous-mode ensemble round — for example `2/6` means 2 of a 6-handoff budget have been used. Click the chip to open a small popover and change the max (`m`); the current count (`n`) is read-only.

## Where to find it
In the labeled **Turn Budget** cell on the second row of the Roster Presets section above the composer input, next to the Turn / Continuous / Work Session mode picker and Fan-Out toggle, whenever Continuous mode is active for the current round.

<!-- screenshot-pending: Continuous hops meter chip showing "2/6" in the Turn Budget cell -->

## How to use it
1. Switch the ensemble chat's orchestration mode to **Continuous** so participants can hand work back and forth (via `@mentions` or the `ensemble_yield` tool) instead of each speaking once.
2. Watch the **Turn Budget** chip — it shows handoffs used so far out of the current cap, e.g. `2/6`.
3. Click the chip to open the "Max handoff turns" popover, type a new limit (1–500), and click **Set**.
4. If a round is already in flight, the new cap applies to that round immediately; when idle, the chip's denominator reflects your new setting right away.

## Tips & related
- [Mention & Yield Routing](mention-yield-routing.md) — how participants hand off work to trigger a hop.
- [Create an Ensemble Chat](create-ensemble-chat.md) — start a chat that can use Continuous mode.
- [Fan-Out Toggle](fan-out.md) — the separate parallel-lanes control that composes with orchestration mode.
- [Round Cards in Transcript](round-cards.md) — see how a continuous round's handoffs appear in the transcript.
