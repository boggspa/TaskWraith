# How to: Ensemble Orchestration Row

**Platform:** Electron

> **The Turn / Continuous mode picker documented here was retired.** Ensembles
> now always run **Continuous** — agents hand work back and forth across
> bounded continuation turns, and the round keeps going until the goal
> completes, someone yields to the user, or the Turn Budget runs out. Older
> chats that still record a "Turn" setting are treated as Continuous. To get
> the old strict one-pass feel, keep the Turn Budget low and leave Fan-Out
> off.

## What the row holds now

The second row of the Roster Presets section above the composer input groups
the remaining orchestration controls:

- **Fan-Out** — an On/Off toggle for parallel lanes. On enables read/review
  fan-out plus Boss-triggered writer lanes with explicit writeScopes (or the
  user-preflight writer path when no Boss is assigned). See
  [Fan-Out Toggle](../ensemble-mode/fan-out.md).
- **Isolate** — Shared / Worktrees / Any: where fan-out lanes do their work.
- **Turn Budget** — the `n/m` continuation-hops meter. See
  [Continuous Hops Meter](../ensemble-mode/continuous-hops-meter.md).

The chat-wide **Shared History Budget (Chars) slider is gone too**: each
participant's transcript ingest is now sized automatically from its model's
context window, so capable models receive the full shared history. Only Codex
GPT-5.3 Spark and 4B–12B-parameter local Ollama models keep a hand-tunable
budget — a per-model slider on their rows in the composer's
**Context · per participant** panel.

## Tips & related

- [Create an Ensemble Chat](../ensemble-mode/create-ensemble-chat.md) — start an ensemble chat before this row becomes available.
- [Fan-Out Toggle](../ensemble-mode/fan-out.md) — the On/Off parallel-lanes control on this row.
- [Continuous Hops Meter](../ensemble-mode/continuous-hops-meter.md) — tracks remaining continuation turns.
- [Participant Chip Strip](../ensemble-mode/participant-chip-strip.md) — manage who's in the round above the composer.
