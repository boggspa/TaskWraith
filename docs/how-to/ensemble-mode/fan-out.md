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
picker and the **Turns** meter.

![Fan-out toggle in the roster presets second row](../images/ensemble-mode__fan-out.png)

## How to use it

1. Click **Off** to keep participants running serially, one at a time (the
   default).
2. Click **On** to enable parallel lanes. Read-only scouts fan out at the start of the round and reviewers can run
     as a parallel wave later; every seat keeps its permission
     level. Parallel lanes must be enabled in settings — if disabled, rounds fall back to running one at a time.
   - Writer seats can also run in parallel lanes. With an assigned Boss, that Boss
     must start the parallel run with explicit write scopes;
     otherwise a write-scope check runs before any writer lane.
3. Hover the toggle, or the running round's status, to see the active fan-out
   summary. A round that is already running shows the policy it was admitted
   with; a change applies from the next round.
4. To keep a participant out of normal rotation, set its Stage to **BG**. A
   unique `@Background`, `@Role`, or `@Model` mention starts that
   seat in the background through the same lane system. `@BG` is different — it
   starts **every** background seat, never just one.
   Background lanes need parallel lanes enabled, and the seat must not already be active. Automatic mention/yield launches are
   read-only; scoped background edits need a Boss-started
   parallel run with explicit write scopes.

## Tips & related

- [Ensemble Orchestration Row](../composer/ensemble-mode-picker.md) — the composer row this toggle lives on.
- [Continuous Hops Meter](continuous-hops-meter.md) — the handoff-budget chip beside it.
- [Create an Ensemble Chat](create-ensemble-chat.md) — start an ensemble chat before this toggle becomes available.
- [Participant Chip Strip](participant-chip-strip.md) — manage which participants are read-only vs. writer-capable, which determines what each fan-out lane can do.
- Normal round completion waits for live BG lanes, while Stop/cancellation closes immediately and cancels them with the rest of the round.
- BG lanes never inherit Full Access and cannot own Boss/Captain/synthesizer authority.
