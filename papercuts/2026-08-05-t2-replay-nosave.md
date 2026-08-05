# 2026-08-05 — The T2 replay that never saved anything

Every T2 "authoritative" replay before 2026-08-05 06:07 BST measured **zero
persistence**. All of the driver's saveChat calls except the seed were rejected
by the app and silently swallowed by the harness, so the runs replayed
thousands of events against a store that never ran. This includes the
2026-08-04 T2 baseline (`perf-t2-30seat-42-9977a712b741` @ `06778017e`) whose
decay curve (6.9 → 1.41 evt/s over 9,835.7 s) has been quoted as the
epic's replay-side evidence: that curve is the cost of parsing ever-larger
CDP `Runtime.evaluate` expressions, not of writing chats. The live-app
measurements (8–14 rewrites/10 s window, footprints, checkpoint amplification)
were taken separately against the real app and are unaffected.

## The three stacked defects

1. **The CDP evaluate adapter swallowed page failures.** A rejected
   `window.api.saveChat(...)` promise arrives as `exceptionDetails`; the
   adapter returned `null`, so `applyReplayEvent` completed the event. Nothing
   in the run distinguished "saved" from "rejected". (`replayDriver.cjs`,
   fixed in `ea421e326`.)
2. **Fixture chats failed the save-scope gate.** `sanitizeChatForSave`
   (src/main/index.ts) throws `Workspace chat must include a workspace id and
   path.` for any chat that is neither `scope:'global'` nor stamped with a
   registered workspace. Fixture chats carried neither, so every save threw at
   the IPC boundary. (`fixtureGenerator.cjs` now emits `scope:'global'`;
   `ea421e326`.)
3. **The driver synthesized persistenceRevision.** `ChatService.
   saveChatInternal` is a compare-and-swap: a save whose revision differs from
   canonical is dropped by returning the current record — no error — and main
   assigns canonical = previous + 1 on acceptance. The driver computed
   `fixture + savedCount + 1`, so once defect 2 was fixed, the seed landed and
   every later save CAS-rejected: 300+ events completed against a coalescer
   whose `scheduled` counter read **1**. (`8ab809e59`: the driver stamps the
   canonical revision it last observed, consumes the returned revision as a
   compact `{persistenceRevision, updatedAt}` ack, and throws
   `T2_REPLAY_SAVE_REJECTED` when an ack fails to advance.)

## How it was caught

The pass-11 comparison rerun kept failing/looking wrong in ways the progress
journal could not explain. The T9a `__TASKWRAITH_PERF_STATS__` handle, sampled
live over the main inspector mid-replay, showed `reasonMix` all-zero and five
`writeJson` calls total while hundreds of events "completed"; a one-shot
renderer CDP probe of `window.api.saveChat` then returned the workspace-scope
rejection verbatim, and `getChat` showed `persistenceRevision` still at 1
thousands of events in. Each fix was proven red-first in
`perfHarness.test.ts` (now 80 tests), including a ChatService-shaped CAS fake
that replays the full schedule and requires zero rejections.

## Consequences for evidence already on the blackboard

- The 2026-08-04 T2 baseline **cannot** serve as the persistence denominator.
  Its report was already lost ("shell-only" tree); its numbers should not be
  re-quoted as save-path evidence. Boss had pre-ruled `gPerf=false` expected
  for the comparison; that ruling stands for the right reason now.
- Acceptance for the seed-42 comparison rests on the after-report alone: flat
  replay throughput, a measured `main.saveChat.coalescing` block
  (schema.cjs refuses an absent block), `metricsCollected: true`, profiles +
  clean teardown.
- Attempt-1's `T2_REPLAY_STALL_TIMEOUT` at event 3633 (300 s of no progress on
  a save that could not have been in the store) happened while no persistence
  ran, so it was a harness/renderer-side seizure, not an app deadlock. It has
  not recurred with real saves; if it does, harness stdio is now captured
  (`harness-attempt*.log`) and the fail-loud adapter will name the page error.
- Attempt evidence archived in the run worktree:
  `perf-t2-progress.stall-0407Z.json`, `…killed-attempt2.json`,
  `…killed-attempt3.json`, plus the `.stall-0407Z`, `.attempt2-nosaves`, and
  `.attempt3-casreject` userData snapshots under `perf-homes/`.
- Attempt 4 runs at amended pin `03be9dca8` = `83970a4c4` + the two
  harness-only fixes; the product tree is byte-identical to `83970a4c4`
  (verified `git diff … ':(exclude)scripts/perf'` empty), so the comparison
  still measures exactly the pinned product code. Fixture fingerprint is
  shape-derived and unchanged (`9977a712b741`).

First live counters with real saves (attempt 4, ~424 events in): 424
scheduled / 414 coalesced / 9 flushed, all ceiling-forced — the T3a-1
write-amplification design working as specified, measured for the first time.

Lesson, same as the doctrine the harness itself asserts elsewhere: **a
completed event is not evidence of work performed — every layer that can say
"no" must be able to make the run say it out loud.**
