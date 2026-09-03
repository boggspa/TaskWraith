# How to: Ensemble Orchestration Row

**Platform:** Electron

## What it is
A row of three controls that set how an Ensemble round runs: **Fan-Out**, **Isolate**, and **Turns**. Ensembles always run continuously — agents hand work back and forth until the goal is done or the turn count runs out — so there is no longer a Turn/Continuous choice to make.

## Where to find it
In the **Roster Presets** section above the composer input, on the second row. It only appears in an Ensemble chat.

![Ensemble Orchestration Row showing the Fan-Out, Isolate, and Turns controls above the composer](../images/composer__ensemble-mode-picker.png)

## How to use it
1. Click **Fan-Out** and pick **On** to let agents work in parallel lanes, or **Off** to keep them strictly one at a time.
2. Click **Isolate** to choose where those lanes work: **Shared** (the live checkout), **Worktrees** (a separate copy each), or **Any**.
3. Read the **Turns** chip as `n/m` — handoffs used out of the limit for this round.
4. Click **Turns** and set **Max handoff turns** to give the round more or less room, then save.

## Tips & related
- To keep a round short, lower **Max handoff turns** and leave **Fan-Out** off.
- Each agent's share of the shared history is now sized automatically from its model's context window. Only a few models keep a manual slider, on their row in the **Context · per participant** panel.
- [Create an Ensemble Chat](../ensemble-mode/create-ensemble-chat.md) — start an ensemble chat before this row appears.
- [Fan-Out Toggle](../ensemble-mode/fan-out.md) — what parallel lanes actually do.
- [Continuous Hops Meter](../ensemble-mode/continuous-hops-meter.md) — more on the Turns meter.
- [Participant Chip Strip](../ensemble-mode/participant-chip-strip.md) — manage who is in the round.
