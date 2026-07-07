# iOS Feature Solidity Matrix

> Round: Cross-platform perf session — pass-2.5 stall fix + pass-1 knobs (Track-H/S/E)
> Scope: solidity of **existing iOS features only**, plus Batch-1 parity, Track-A resolution, and perf-session residuals.
> Compiled from: Scout1/Scout2 recon, pass-2.5 + pass-1 implementation, adversary review, and `ios/TaskWraithKit` source walk.
> Updated: Pass-6 — pass-2.5 committed locally (`3a49cd83c`–`438141f6e`), pass-1 perf slices committed (`44feed71e`/`a971e7bbe`/`c5372ca88`), TestFlight build **74** uploaded; IF3 S2 pending adversary fix.

## Legend

| Status | Meaning |
|--------|---------|
| **solid** | Feature is wired end-to-end and behaves correctly on iOS. |
| **rough-edge** | Feature works, but has a polish/usability/continuity gap that is acceptable today and should be dispositioned before calling the surface "done". |
| **hole** | Feature is materially incomplete or missing on iOS. |

| Severity | Meaning |
|----------|---------|
| Low | Cosmetic / edge-case; safe to defer. |
| Medium | Visible in normal use or causes a dead-end; fix in a follow-up pass. |
| High | Broken or missing core path; must fix before release. |

## Feature matrix

| Surface | Status | Evidence file:line | Severity | Proposed owner |
|---------|--------|--------------------|----------|----------------|
| **Pairing / multi-host** | solid | `PairingViews.swift` (QR + confirm flow); `RemoteSessionModel.swift:1917-1957` (`switchHost`/`forgetHost`); `HomeListViews.swift:335-343` (header switcher) | — | — |
| **Thread list (active)** | solid | `HomeListViews.swift:376-392` (hydration ticker gate); `Models.swift:616-619` (archived filtering mirrors desktop) | — | — |
| **Home search (N1)** | solid | `HomeListViews.swift` delegates to `HomeSearchRanker`; ranked Results section; Active / All-incl-Archived scope chips; matches raw `card.provider` **and** `TWTheme.providerLabel` (`c5372ca88` real-path tests) | — | — |
| **Archived chats (N2)** | solid | `HomeListViews.swift` threadContextMenu → Pin/Unpin → Rename → Archive/Unarchive; collapsed "Archived (N)" section after General Chats; `RemoteSessionModel.swift` optimistic pin/archive with rollback via Codable round-trip; `setChatArchived` bridge action | — | — |
| **Transcript rendering** | solid | `ThreadDetailViews.swift:898-1012`, `:2595-2626` (`LazyVStack` + `ThreadRowView.equatable()`); `RemoteSessionModel.swift:3950+`, `:3969+` (on-demand / paginated snapshots) | — | — |
| **Transcript streaming reconcile** | solid | `RemoteSessionModel.swift:2540`, `:2557`, `:2569`, `:2610-2621` (`reconcileStreamingState` wired at alias merge, empty-row, metadata-only, and terminal-summary paths) | — | — |
| **Composer (draft, @-mention, attachments)** | solid | `ComposerView.swift:139-141` (`twMentionCandidates`); `ComposerView.swift:118-852` (attachments / `PhotosPicker`); `TWDraftPersistence` (draft persistence) | — | — |
| **Add to prompt (T1)** | solid | `ThreadDetailViews.swift:2863-2882` context menu; append to live `followUp` with `\n\n` separator; existing `onChange` persists via `TWDraftPersistence` — survives thread-switch and theme teardown | — | — |
| **Copy full transcript (T2)** | solid | `ThreadDetailViews.swift` individual toolbar pill; `chatMarkdownTranscript` bridge action; honest failure copy for archived / too-large / not-found; host cap 750KB (`3a49cd83c`) | — | — |
| **Ensemble controls** | solid | `EnsembleRosterSheet.swift:329-338` (roster sheet + fan-out picker + Turn/Continuous mode); `TWSharedViews.swift:7388+` (steer queue); `RemoteSessionModel.swift:4515` (`cancelRun`) | — | — |
| **Ensemble roster ordering** | solid | `RemoteTaskProjection.ts:1461` tie-break `(order, participantId)`; `Models.swift:1125-1147` `displayParticipants` sorted by `(order ?? Int.max, participantId)` | — | — |
| **Ensemble mode chip (C1)** | rough-edge | Per-thread Turn/Continuous control moved from transcript footer to `EnsembleRosterSheet` only (`ccfba8017` removed composer chip). Mode still reachable; discoverability slightly reduced. | Low | defer or restore footer chip |
| **Ensemble system-row identity (C4)** | solid | `RemoteThreadProjection.ts:1432-1470` (`ensembleSystemSeatLabel`), `:1561-1562` (`buildRow`); iOS consumes via `ThreadDetailViews.swift:2860-2876` (`twSettledRowSpeakerSplit`) | — | — |
| **Approvals + auto-deny countdown** | solid | `AttentionRows.swift:44-53` (Mac `expiresAt`); `AttentionRows.swift:487-490` (live countdown) | — | — |
| **Question / answer card capability** | solid | Host always materializes `capabilities.answer` as a boolean; iOS reads it at `AttentionRows.swift:367-370` | — | — |
| **Diff Studio + Files** | solid | `RemoteSessionModel.swift:3214-3231` (capability gates); `AppShell.swift:308-357` (compact + split modes) | — | — |
| **Workflows view** | solid (read-only) | `HomeListViews.swift:474-823` (list + open chat); `NewChatCanvas.swift` (create via canvas) | — | — |
| **Goal / plan rail** | solid | `GoalRailControl` / `TWSharedViews.swift:4042+` (editable goal); `TWSharedViews.swift:4195-4199` (read-only plan) | — | — |
| **Push / APNs** | solid | `RemoteSessionModel.swift:323-377` (pending token + post-connect register); `RemoteSessionModel.swift:4271-4309` (notification action wake) | — | — |
| **Usage / context meter** | solid | `ComposerView.swift:591-599` (composer popover); `TWSharedViews.swift:5803+` (Settings usage section) | — | — |
| **Side chats** | solid | `RemoteSessionModel.swift:3705+` (`createSideChat`); `TWSharedViews.swift:7848+` (side-chat list) | — | — |
| **Git workflows (stage/commit/PR)** | solid when granted | `GitWorkflowViews.swift:1-10`; `RemoteSessionModel.swift:3247` (`externalPublish` gate) | — | — |
| **Settings scope / Mac-owned tabs** | solid (intentional) | `TWSharedViews.swift:5482-5491` (Mac-owned callouts); `TWSharedViews.swift:5682` (approval timeouts) | — | intentional defer |
| **Settings null/placeholder values + dead read-only tabs** | solid | 14 → 9 tabs per `ios-settings-spec` (`bff0e3fb1`); Safety & Privacy + About merged into "About & Privacy" | — | — |
| **Thinking viewport** | solid | Host projects dedicated `thinking` field capped ≈4000 (`3ec96cc0c`); iOS `ThinkingViewportView` — collapsed 8 lines + bottom fade + "Show thinking" chip, in-place expand via `expandRow` (`438141f6e`) | — | — |
| **Track-A stall / live-update lag** | solid | Pass-2.5 host flood cut + iOS coalescer + stream-pull suppression landed; pass-1 further tightens cadence. User smoke test (19:02) reports heavy ensemble run with no lag. IF3 off-MainActor decode landed uncommitted — one adversary fix pending before commit. | — | — |
| **Canvas** | rough-edge | `CanvasPreviewCard.swift` only — preview card exists; no interactive DOM / drawing surface | Low | defer |
| **Full-size media** | rough-edge | `ThreadDetailViews.swift` — fallback path renders `"Full image unavailable"` when full-resolution asset is absent | Low | defer |

## Pass-2.5 Track-A resolution (committed locally)

Root cause was compound host publish flood + serial MainActor full-snapshot apply — not network. Pass-2.5 cut the flood and coalesced iOS applies; pass-1 tightened remaining knobs.

### Host slice (`3a49cd83c`, `3ec96cc0c`)

| Fix | Trigger cut | Evidence |
|-----|-------------|----------|
| Trailing-edge full-snapshot throttle | Leading-edge drops terminal state inside window | `BridgeBroadcaster.ts` trailing flush; 1000ms idle / 2500ms while streaming |
| Git refresh delta-only | `resetThrottle()` + full rebroadcast on every git tick (~1/s) | `publishRemoteGitSnapshotCache` → delta envelope |
| Live thread rows 40→24 | Oversized live deltas every 350ms | `pushRemoteThreadSnapshot` cap |
| Dedicated `thinking` field | Generic preview truncation | `RemoteThreadProjection.ts` ≈4000 cap |
| Transcript cap 750KB | Oversized ack payloads | `chatMarkdownTranscript` honest too-large failure |
| Archived transcript lift | Refusal when archived but builder safe | Bridge handler only |

### iOS slice (`438141f6e`)

| Fix | Trigger cut | Evidence |
|-----|-------------|----------|
| IF1 full-snapshot coalescer | N queued full snapshots → N serial applies | `ProjectionSnapshotCoalescer` newest-only |
| IF2 stream-pull suppression | Agent-output `requestThreadSnapshot` during visible-thread streaming | `RemoteSessionModel.swift` ~:2287, ~:2954 |
| Thinking viewport | Truncated thinking in generic preview | `ThinkingViewportView` + `expandRow` |

## Perf pass-1 (committed locally, 2026-07-07)

Gates at commit time: typecheck node+web, vitest 8761/8761, swift 316/316, lint+guards green. **Nothing pushed to origin.**

| SHA | Track | Files | Trigger cut |
|-----|-------|-------|-------------|
| `44feed71e` | **H — host** | `index.ts`, `RemoteBridgePerfTuning.ts`, `RemoteBridgePerfTuning.test.ts` | Agent-output live pushes: 350ms drop-window → 600ms trailing coalesce/thread; full-snapshot interval keyed on **running chat streams** not any active thread; safe `resetThrottle` bypass removals |
| `a971e7bbe` | **E — renderer** | `MainAppLayout.tsx` | Fresh inline callbacks / `[]` props defeating `TranscriptPanel` memo during unrelated streaming |
| `c5372ca88` | **S — iOS** | `HomeListViews.swift`, `TWSharedViews.swift`, `IosParityFixesTests.swift` | MarkdownLite FIFO eviction → LRU touch-on-hit (participants key preserved); `HomeSearchRanker` matches `TWTheme.providerLabel` |

### IF3 S2 — off-MainActor decode (uncommitted, gates IF3 commit)

Landed by WriteSwift; **blocked on Adversary1 fix** before CheckCommit pathspec commit.

| Item | Status |
|------|--------|
| Decode in `Task.detached(.userInitiated)` inside `ProjectionSnapshotCoalescer` | ✅ landed |
| `reset()` wired in `teardown()` (landmine ③) | ✅ landed |
| Skip-stale-apply when newer pending mid-decode | ✅ landed |
| **Stale-generation branch strands post-reset `pending`** (`finishDecode` :2245-2248) | ❌ **fix required** — mirror `:2249` drain path; add `coalescerResetThenEnqueueDuringInFlightDecodeStillDrains` test |

Files for CheckCommit (after fix): `RemoteSessionModel.swift`, `IosParityFixesTests.swift`.

## Batch-1 landed summary

All five Batch-1 surfaces committed at `8bd8c0e9b`:

| ID | Surface | Commit |
|----|---------|--------|
| N1 | Home search | `8bd8c0e9b` |
| N2 | Chat lifecycle (pin / rename / archive) | `8bd8c0e9b` |
| T1 | Add to prompt | `8bd8c0e9b` |
| T2 | Copy full transcript | `8bd8c0e9b` |
| C1 | Ensemble Turn/Continuous mode chip | `8bd8c0e9b` (footer chip later removed → roster sheet) |

## Batch-2 priority ladder (unblocked — awaiting user go/no-go)

Track-A is resolved. Batch-2 items remain deferred until user accepts perf-session outcome and agrees scope.

| Priority | Surface | Smallest shape |
|----------|---------|----------------|
| 1 | Sub-thread delegation spawn | `createSubThread` bridge adapter + iOS sheet |
| 2 | Ensemble fan-out result cards | Forward `ensembleLaneId` through `RemoteThreadRow` |
| 3 | Document-picker attachments | `UIDocumentPickerViewController` in `ComposerView.swift` |
| 4 | Create-PR one-tap above-bar | Toolbar pill → `externalPublish` PR flow |
| 5 | Workspace-board read-only drill-in | Read-only board snapshot → card list |
| 6 | Delete chat | `deleteChat` capability (default OFF) + confirmation |
| 7 | Message-body search | `searchChats` read-only bridge action |

## Build-74 device validation checklist

Pair **TestFlight build 74** with a Mac host running this checkout (pass-2.5 + pass-1). iOS-only TestFlight without updated Mac host leaves old publish patterns on the relay side.

| Check | Pass criteria | Notes |
|-------|---------------|-------|
| Heavy ensemble streaming | Transcript updates smoothly; no "chonking" | User smoke 19:02 ✅ on dev build |
| Thinking rows | Collapsed 8-line fade; expand in-place | `ThinkingViewportView` |
| Diff pill / git refresh | Pill updates without full-snapshot stall | Delta-only git publish (`3a49cd83c`) |
| Reconnect after theme change | Snapshot applies; no indefinite stale UI | **IF3 fix required** for quiet single-snapshot reconnect |
| Ensemble roster edit ack | Roster change visible on phone ≤2.5s during unrelated streaming | Adversary1 flag: `resetThrottle` removal on roster edit may lag full-projection readers |
| Home search by provider label | e.g. "Codex" finds cards labeled "GPT 5.5" | `HomeSearchRanker` (`c5372ca88`) |
| Copy full transcript | Works under 750KB; honest error above | |
| Archived chat copy | Allowed when builder safe | |

## Measurement stance (M-slice)

**Decision:** reuse existing renderer `runs[-1].stats.streamMetrics` for before/after; skip unified dashboard this pass.

| Platform | Read today | Optional add |
|----------|------------|--------------|
| Renderer | `streamMetrics` rates (events/s, chars/s, markdown parse ms, react commit ms) | React Profiler commit-count on `MainAppLayout` memo cut |
| Host | Vitest cadence tests + debug throttle logs | Thin `sendNotify` counters (deferred H2) |
| iOS | Coalescer `applyCount` in tests | `os_signpost` on apply duration (deferred) |

## Known-risk wiring — verification

| Check | Verdict | Evidence |
|-------|---------|----------|
| `reconcileStreamingState` wired in `mergeThreadSnapshot` | ✅ solid | `RemoteSessionModel.swift:2540+` |
| Follow-pin deferred via next runloop | ✅ solid | `ThreadDetailViews.swift:1691-1695`; landmine ② — never `Task.yield` |
| `ThreadRowView` / `ToolBurstRowView` Equatable gates | ✅ solid | landmine ① — load-bearing streaming perf |
| IF1 coalescer newest-only | ✅ solid | burst test in `IosParityFixesTests.swift` |
| IF2 no stream-pull during visible streaming | ✅ solid | `IosParityFixesTests.swift` |
| MarkdownLite LRU + participants key | ✅ solid | landmine ⑥ — `c5372ca88` tests prove FIFO fails |
| C1 speaker label / model chip single-source | ✅ solid | `twSettledRowSpeakerSplit` |
| Theme teardown must-survive state | ✅ solid | landmine ③ — state on `RemoteSessionModel`, not `@State` |

## Residuals ledger (low — none block commit)

| ID | Item | Disposition |
|----|------|-------------|
| N1 | Provider-label search | **Closed** — `c5372ca88` |
| R1 wording | Throttle keyed on active threads vs streaming-only | **Closed** — `44feed71e` keys on running chat streams |
| IF3 | Off-MainActor decode | **In flight** — fix stale-gen branch, then commit |
| B3 | `resetThrottle` caller audit (H2) | Deferred — awaits Scout1 classification |
| runEvent micro-batching | Streaming-latency trade | Deferred |
| Socket-close banner copy | Polish | Deferred |

## Disposition summary

- **Track-A stall is resolved** in local commits. Pass-2.5 cut the host flood; pass-1 tightened cadence/throttle/memo/LRU. User reports heavy ensemble runs now "chug" smoothly.
- **Thinking viewport is solid** end-to-end (host wire + iOS render).
- **IF3 S2 is the remaining iOS perf commit** — one 3-line adversary fix + named test before CheckCommit gates it.
- **TestFlight build 74** is committed locally (`fd4c63e29`) and uploaded; device validation verdict **pending** user input on build 74 + updated Mac host pairing.
- **Batch-2** is unblocked by Track-A but still needs explicit user go/no-go.
- **No high-severity holes** remain in the current iOS feature set.