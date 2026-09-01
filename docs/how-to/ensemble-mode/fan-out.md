# How to: Fan-Out Toggle

**Platform:** Electron

## What it is

The Fan-Out toggle is the **On / Off** control (labeled **Fan-Out**) that lets
an ensemble round dispatch multiple participants in parallel lanes instead of
one at a time, so they can investigate simultaneously and report back while
the round continues.

Earlier builds offered graded levels (Off / Read / Write / All). Those
collapsed to a single switch: **On is the old "All"** — read/review fan-out
plus writer lanes — because in practice rounds either want full parallel
behaviour or none. A chat saved with one of the old intermediate levels is
treated as On.

## Where to find it

In an ensemble chat, it sits in the labeled **Fan-Out** cell on the second row
of the Roster Presets section above the composer input, beside the Isolate
picker and the Turn Budget meter.

![Fan-out toggle in the roster presets second row](../images/ensemble-mode__fan-out.png)

## How to use it

1. Click **Off** to keep participants running serially, one at a time (the
   default).
2. Click **On** to enable parallel lanes:
   - Read-only scouts fan out at the start of the round and reviewers can run
     as a parallel wave later; every seat keeps its configured permission
     tier. Requires parallel lanes (`TASKWRAITH_CONCURRENT_LANES`, on by
     default) — if disabled, rounds fall back to serial dispatch.
   - Writer-capable participants can also run in parallel lanes, gated by
     `TASKWRAITH_CONCURRENT_WRITE_LANES`. With an assigned Boss, that Boss
     must call the `ensemble_fanout` tool with explicit write scopes;
     otherwise a user-enabled write-scope preflight (claim scopes, a host
     conflict check, then an acknowledgement) runs before any writer lane.
3. Hover the toggle, or the running round's status, to see the active fan-out
   summary. A round that is already running shows the policy it was admitted
   with; a change applies from the next round.
4. To keep a participant out of ordinary rotation, set its Stage to **BG**. A
   unique `@Background`, `@Role`, or `@Model` mention attempts to launch that
   seat asynchronously through the same lane executor. `@BG` is different — it
   is a group token that launches **every** enabled BG seat, never just one.
   Concurrent lanes must be enabled, the seat must not already be active, and
   admission/budget checks must pass. Automatic mention/yield launches are
   capped read-only; use the Boss-authorized
   `ensemble_fanout(mode=locked_writers, targetStage=backgrounds,
   writeScopes=...)` path when scoped background mutation is genuinely
   required.

## Tips & related

- [Ensemble Orchestration Row](../composer/ensemble-mode-picker.md) — the composer row this toggle lives on.
- [Continuous Hops Meter](continuous-hops-meter.md) — the handoff-budget chip beside it.
- [Create an Ensemble Chat](create-ensemble-chat.md) — start an ensemble chat before this toggle becomes available.
- [Participant Chip Strip](participant-chip-strip.md) — manage which participants are read-only vs. writer-capable, which determines what each fan-out lane can do.
- Normal round completion waits for live BG lanes, while Stop/cancellation closes immediately and cancels them with the rest of the round.
- BG lanes never inherit Full Access and cannot own Boss/Captain/synthesizer authority.
