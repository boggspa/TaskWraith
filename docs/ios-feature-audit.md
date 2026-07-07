# iOS Feature Solidity Matrix

> Round: Cross-platform perf session — **pass-5** epic perf + de-vibe (H5/H6/H7 host, iOS5 pull audit)
> Scope: solidity of **existing iOS features only**, plus Batch-1 parity, Track-A resolution, and perf-session residuals.
> Compiled from: Scout1/Scout2 recon, pass-1/2/2.5/3/4/5 implementation, adversary review, and `ios/TaskWraithKit` source walk.
> Updated: Pass-9 ledger open (2026-07-07) — pass-4 fully banked (`47512fb91` iOS + `f6be9a9b0` docs); pass-5 active.

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
| **Track-A stall / live-update lag** | solid | Pass-2.5 host flood cut + iOS coalescer + stream-pull suppression; pass-3 S3 pull-audit; pass-4 `StreamingPublishGate` (80ms invalidation-coalesce) + B2 bandwidth filter. User smoke tests (19:02, 19:03) report heavy ensemble runs with no lag ("chugging"). | — | — |
| **Canvas** | rough-edge | `CanvasPreviewCard.swift` only — preview card exists; no interactive DOM / drawing surface | Low | defer |
| **Full-size media** | rough-edge | `ThreadDetailViews.swift` — fallback path renders `"Full image unavailable"` when full-resolution asset is absent | Low | defer |

## Pass-8 gate ledger (pass-4 closeout — archived, 2026-07-07)

User-directed continuation on local baseline (18+ commits, nothing pushed). Every landed perf slice names the trigger it cuts. De-vibe boundary: session-touched surfaces + adversary nits only — not a repo-wide slop hunt.

### Architectural symmetry (Design P4 philosophy)

Streaming smoothness is now symmetric across all three surfaces:

| Surface | Mechanism | What it bounds |
|---------|-----------|----------------|
| **Electron renderer** | rAF coalescer + token-drop gate (`TranscriptPanel`) | React commit churn per token |
| **Host** | Trailing-flush throttle (`BridgeBroadcaster`) + B2 pre-encode filter | Full-snapshot + runEvent encode/send |
| **iOS** | `StreamingPublishGate` (80ms invalidation-coalesce) | `@Published` dict invalidation per token |

All three preserve leading-edge immediacy (first token visible at latency 0) while coalescing the expensive half of burst traffic.

### Pass-4 wave summary

| Track | Owner | SHA / state | Adversary | Trigger cut |
|-------|-------|-------------|-----------|-------------|
| **E2** renderer memo | WriteRender | **Committed** `f683bfda7` | ✅ pre-commit | `auxiliaryChatsSignature` + `runningChatIdsSignature` stop sibling-pane re-renders on streaming-only churn; `stableEmpties` de-vibe |
| **H3** residual rebuild cuts | WriteMain | **Committed** `08f9081c6` | ✅ F1+F2 fixed | Tier-1/2 delta drops; workflow IPC shared helper; taskCard delta for goal sync |
| **S3** pull-site audit | WriteSwift | **Committed** `7670c38fd` | ✅ F-S1+F-S2 fixed | `shouldSuppressOnDemandSnapshotPull`; ~25 sites; agent-exit fire-through |
| **B2** runEvent interest filter | WriteMain | **Committed** `c87eb98b8` | ✅ retroactive audit clean | Host sink filter before JSON encode; `setWatchedThread` wire; fail-open until phone asserts |
| **F3** git-refresh coalesce | WriteMain | **Committed** `c87eb98b8` | ✅ | `createRemoteLiveGitRefreshScheduler` — one tick per trailing window on streaming cadence |
| **H4** pin/archive dedupe | WriteMain | **Committed** `c87eb98b8` | ✅ | `broadcastThreadUpdate(..., { remoteProjectionSnapshot: false })` — list publish already carries full |
| **S3-batching** invalidation-coalesce | WriteSwift | **Committed** `47512fb91` | ✅ exit pins | `StreamingPublishGate` 80ms window; staging buffer; `flushBeforeTerminal` before agent-exit capture |
| **B2** phone assertion | WriteSwift | **Committed** `47512fb91` (same 4-file slice) | ✅ | `setWatchedThread` on `visibleThreadId` didSet, null on home/background, re-assert on `.established` |

**Pass-4 closeout:** CheckCommit gated `47512fb91` (4 iOS files). Swift **339/339** green at bank time. No push.

### Pass-4 landed detail

#### E2 — renderer identity churn (`f683bfda7`)

`TranscriptPanel` compares `transcriptAuxiliaryChatsSignature` (delegation-visible fields + `updatedAt`) and `runningChatIdsSignature` (dedupe+sort set) instead of raw `chats` / `runningChatIds` references. Cuts sibling/side pane re-renders on unrelated streaming token churn — rAF coalesced flushes do not bump `updatedAt`, so the win is real and under-invalidation is impossible for rendered fields. `MainAppLayout` uses shared `stableEmpties.ts` exports (de-vibe).

Files: `TranscriptPanel.tsx`, `TranscriptPanelFileChanges.test.ts`, `MainAppLayout.tsx`, `stableEmpties.ts`. Gates: typecheck node+web; vitest 6/6.

#### B2 — runEvent interest filter (`c87eb98b8` host + `47512fb91` iOS)

**Host:** `createRemoteBridgeRunEventInterestFilter` at `RemoteBridgeRunEventFilter.ts`. Filter wired at host sink (`runEventFilter` on `RemoteBridgeRuntime`) — eliminates JSON encode for unwatched classifiable `agent-output`. Rules: `agent-exit` always forwarded; fail-open when `hasWatchCapability=false` (post-establish reset); fail-open when `connectedDeviceCount > 1`; unclassifiable `threadId` (null) always passes. Watch state resets inside existing `onDeviceEstablished` callback (Adversary1 A1 — no phantom generation). Single global watch slot (A2).

**Phone (`47512fb91`):** `BridgeAction.setWatchedThread { appChatId: string | null }` — model-owned assertion on `visibleThreadId` didSet, null on home/background (`AppShell` scenePhase), re-assert on `.established`. Teardown safety: `clearCachedProjectionState` calls `streamingPublishGate.resetAll()`.

Files (host): 14 files incl. `RemoteBridgeRunEventFilter.ts`, `BridgeActionPayload.ts`, `index.ts`, `BridgeRunEventSink.ts`. Files (iOS): `Models.swift`, `RemoteSessionModel.swift`, `AppShell.swift`, `IosParityFixesTests.swift`.

#### S3-batching — invalidation-coalesce (iOS, `47512fb91`)

`StreamingPublishGate` at `RemoteSessionModel.swift:118+`. `appendStreamingDeltas` parses per-event into a non-published staging buffer; leading edge publishes immediately (first-token latency 0) + arms 80ms `streamingPublishCoalesceWindowNs`; within window accumulate; window fire publishes iff changed. Exit-contract pin: `flushBeforeTerminal` runs **before** terminal capture (`:2519` before `:2522`). Tool/new-run paths bypass coalesce (immediate publish). S3-DELTA (off-main ordered envelopes) **killed** — ordered `runEvent`/`threadSnapshot` contract differs from IF3 full-snapshot idempotence.

Named tests: burst coalesce, leading-edge immediacy, exit-flush ordering, `setWatchedThread` payload shape.

#### F3 — git-refresh coalesce (`c87eb98b8`)

`createRemoteLiveGitRefreshScheduler` mirrors live-snapshot trailing pattern. Agent-output live push path (`index.ts` ~`:25899`) now calls `remoteLiveGitRefreshScheduler.schedule(workspaceId)` instead of immediate `scheduleRemoteGitSnapshotRefresh`. Agent-exit path unchanged (still `force: true` at `:25928`).

#### H4 — pin/archive dedupe (`c87eb98b8`)

Pin and archive handlers dropped redundant `broadcastThreadUpdate` full-snapshot chain — `broadcastThreadList()` already carries the coalesced full projection. One-line justification per site: "The following list publish already carries the coalesced full snapshot."

#### H3 — host residual rebuild cuts (`08f9081c6`, pass-3)

Tier-1 delta-able drops (composerPrompt-failure, question registry), Tier-2 coalesce-OK conversions, `scheduledWorkflowHandlers.ts` shared `broadcastCoalescedRemoteProjectionAfterIpcMutation` helper (11 IPC save sites), F1 taskCard fix for goal-metadata sync. Agent-exit full rebuild **kept** — no airtight terminal-convergence test yet (Pass-5 Track-H5).

Files: `index.ts`, `scheduledWorkflowHandlers.ts`, `RemoteBridgePerfTuning.ts`, `RemoteBridgePerfTuning.test.ts`.

#### S3 — iOS pull-site audit (`7670c38fd`, pass-3)

Centralized `shouldSuppressOnDemandSnapshotPull` wired into `scheduleThreadRefresh` + `requestThreadSnapshot`. ~25 composer/ensemble/approval/goal/roster sites suppressed when visible thread is actively streaming. F-S1 fix: agent-exit bypass forwarded through debounced fire path. F-S2 fix: dead `isTerminalRefresh` param removed.

Covering path: `appendStreamingDeltas` live buffer + host 600ms thread deltas + inbound runEvent deltas.

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

## Perf pass-2 (committed locally, 2026-07-07)

| SHA | Track | Files | Trigger cut |
|-----|-------|-------|-------------|
| `f765f4ad9` | **IF3 — iOS** | `RemoteSessionModel.swift`, `IosParityFixesTests.swift` | Full projection JSON decode off MainActor; coalescer generation guard; teardown `reset()` (landmine ③) |
| `4edad9087` | **H2 — host** | `index.ts`, `RemoteBridgePerfTuning.test.ts` | Meta-helpers delta-first; redundant full-snapshot dedupe in same branch |

## Perf pass-3 (committed locally, 2026-07-07)

| SHA | Track | Files | Trigger cut |
|-----|-------|-------|-------------|
| `08f9081c6` | **H3 — host** | `index.ts`, `scheduledWorkflowHandlers.ts`, `RemoteBridgePerfTuning.ts` | Tier-1/2 delta drops; workflow IPC de-vibe; taskCard goal sync |
| `7670c38fd` | **S3 — iOS pull-audit** | `RemoteSessionModel.swift`, `IosParityFixesTests.swift` | Centralized on-demand pull suppression; agent-exit fire-through |
| `3e52e8f30` | **Docs pass-7** | `docs/ios-feature-audit.md` | Gate ledger + validation checklist |

## Perf pass-4 (committed locally, 2026-07-07)

| SHA | Track | Files | Trigger cut |
|-----|-------|-------|-------------|
| `f683bfda7` | **E2 — renderer** | `TranscriptPanel.tsx`, `TranscriptPanelFileChanges.test.ts`, `MainAppLayout.tsx`, `stableEmpties.ts` | Delegation-aware memo signatures; stableEmpties de-vibe |
| `c87eb98b8` | **B2+F3+H4 — host** | 14 files incl. `RemoteBridgeRunEventFilter.ts`, `index.ts` | Pre-encode interest filter; git-refresh coalesce; pin/archive dedupe |
| `47512fb91` | **S3-batching+B2 — iOS** | `Models.swift`, `RemoteSessionModel.swift`, `AppShell.swift`, `IosParityFixesTests.swift` | `StreamingPublishGate` 80ms; `setWatchedThread` assertion |
| `f6be9a9b0` | **Docs pass-8** | `docs/ios-feature-audit.md` | Pass-4 gate ledger |

## Pass-5 gate ledger (active, 2026-07-07)

User opened pass-5 ("another epic performance and de-vibe code pass"). Do **not** redo pass-2.5, pass-1, H2, IF3, S3 pull-audit, S3-batching, or B2 wire — all closed. Pass-5 targets what pass-4 explicitly kept or deferred.

### Baseline SHAs (do not redo)

| Wave | SHAs |
|------|------|
| Pass-2.5 → Pass-3 | `3a49cd83c`…`7670c38fd`, `08f9081c6` |
| E2 | `f683bfda7` |
| Pass-4 host (B2/F3/H4) | `c87eb98b8` |
| Pass-4 iOS (S3 batching + B2 phone) | `47512fb91` |
| Pass-8 ledger | `f6be9a9b0` |

Standing: no push, no stash, pathspec-only commits, iOS landmines ①–⑥. Branch ~33 commits ahead of origin.

### Priority stack

| Track | Owner | Amplifier | Binding | Notes |
|-------|-------|-----------|---------|-------|
| **H5** agent-exit full rebuild | WriteMain | #1 host amplifier | Drop `index.ts` `:25927` **only** with airtight terminal-convergence test | Every run end: thread+diff deltas then inline `broadcastRemoteProjectionSnapshot()`. Test seam: extend `RemoteBridgePerfTuning.test.ts` — grep finds **no** terminal-convergence test in `src/main/**/*.test.ts` today |
| **H6** dishonest "coalesced" helpers | WriteMain | De-vibe + encode storm | Rename and/or dedupe — **do not** add second coalesce beside `BridgeBroadcaster` | `index.ts:1160-1162` `broadcastCoalescedRemoteProjectionSnapshot` (6 sites: `:5371`, `:9770`, `:27756`, `:29641`, `:31603`, `:32064`); `scheduledWorkflowHandlers.ts:131-135` `broadcastCoalescedRemoteProjectionAfterIpcMutation` (11× IPC saves). `BridgeBroadcaster.broadcastRemoteProjectionSnapshot()` already trailing-coalesces at `:505-514` |
| **H7** residual full-snapshot map | WriteMain | ~11 encode attempts | Refresh Scout1 classification post-`c87eb98b8` | 5 direct `broadcastRemoteProjectionSnapshot()` in `index.ts` (`:22980`, `:22999`, `:25927`, `:27567` + meta-helper chain) plus 6 via H6 wrapper |
| **iOS5** pull-path audit round 2 | WriteSwift | 27 `scheduleThreadRefresh(` sites | Extend pass-3 `shouldSuppressOnDemandSnapshotPull` discipline | Central gate `:2281-2285`; debounce `:3288-3307` (450ms). Scout2 suspects composer-send, media acks, pin/archive bypass streaming buffer |
| **B2-follow** bandwidth validation | Scout1/Scout2 | Measurement | Read-only | Filter landed; validate encode reduction on device (home screen + background thread streaming) |

### Closed before pass-5 opens (do not re-assign)

| Item | SHA | Note |
|------|-----|------|
| IF3 stale-generation `finishDecode` branch | `f765f4ad9` | `drainIfIdle` on stale-gen when `pending != nil`; test `coalescerResetThenEnqueueDuringInFlightDecodeStillDrains` |
| Pass-4 iOS S3-batching + B2 phone | `47512fb91` | 339/339 swift green |

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

Pair **TestFlight build 74** with a Mac host running this checkout (pass-2.5 + pass-1 + pass-2/3). iOS-only TestFlight without updated Mac host leaves old publish patterns on the relay side.

| Check | Pass criteria | Notes |
|-------|---------------|-------|
| Heavy ensemble streaming | Transcript updates smoothly; no "chonking" | User smoke 19:02 ✅ on dev build |
| Thinking rows | Collapsed 8-line fade; expand in-place | `ThinkingViewportView` |
| Diff pill / git refresh | Pill updates without full-snapshot stall | Delta-only git publish (`3a49cd83c`) |
| Reconnect after theme change | Snapshot applies; no indefinite stale UI | IF3 committed — off-MainActor decode |
| Agent-exit handoff prompt (visible thread) | Terminal re-pull reaches wire; final bubble not stale | F-S1 fixed (`7670c38fd`); S3-batching exit-flush (`flushBeforeTerminal`) landed `47512fb91` |
| S3-batching type-out feel | First token immediate; burst coalesced ≤80ms staleness | `StreamingPublishGate` leading-edge + window tests (`47512fb91`) |
| B2 bandwidth (home screen) | Unwatched thread agent-output not encoded | Host filter (`c87eb98b8`) + phone assert (`47512fb91`); re-assert on `.established` |
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
| IF2 + S3 on-demand pull suppression | ✅ solid | F-S1 fire-through fixed (`7670c38fd`); centralized gate at `:2281` |
| S3-batching `StreamingPublishGate` | ✅ committed | `47512fb91`; exit-flush before terminal capture |
| B2 `setWatchedThread` assertion | ✅ committed | `47512fb91`; model-owned; teardown via `clearCachedProjectionState.resetAll()` |
| IF3 off-MainActor decode | ✅ committed | `f765f4ad9` |
| MarkdownLite LRU + participants key | ✅ solid | landmine ⑥ — `c5372ca88` tests prove FIFO fails |
| C1 speaker label / model chip single-source | ✅ solid | `twSettledRowSpeakerSplit` |
| Theme teardown must-survive state | ✅ solid | landmine ③ — state on `RemoteSessionModel`, not `@State` |

## Residuals ledger

| ID | Item | Disposition |
|----|------|-------------|
| N1 | Provider-label search | **Closed** — `c5372ca88` |
| R1 wording | Throttle keyed on active threads vs streaming-only | **Closed** — `44feed71e` |
| IF3 | Off-MainActor decode | **Closed** — `f765f4ad9` |
| S3 F-S1/F-S2 | Exit bypass fire-through + dead param | **Closed** — `7670c38fd` |
| H3 F1/F2 | Codex goal sync taskCard coverage | **Closed** — `08f9081c6` |
| E2 hold | TranscriptPanel foreign hunks | **Closed** — `f683bfda7` (hover-preview baseline `10892a307`) |
| B2 host filter | RunEvent interest filter | **Closed** — `c87eb98b8` |
| B2 phone assertion | `setWatchedThread` wire | **Closed** — `47512fb91` |
| S3-batching | Invalidation-coalesce | **Closed** — `47512fb91` |
| F3 | Git-refresh coalesce | **Closed** — `c87eb98b8` |
| H4 | Pin/archive dedupe | **Closed** — `c87eb98b8` |
| S3-DELTA | Off-main ordered envelopes | **Killed** — Design verdict |
| IF3 stale-gen drain | `finishDecode` stale branch | **Closed** — `f765f4ad9` |
| H5 | Agent-exit full rebuild | **Active** — Pass-5 Track #1 (`index.ts` `:25927`) |
| H6 | Misnamed coalesced helpers | **Active** — Pass-5 de-vibe |
| H7 | Residual full-snapshot map | **Active** — Pass-5 refresh |
| iOS5 | Residual pull amplification | **Active** — Pass-5; 27 `scheduleThreadRefresh` sites |
| B3 | `resetThrottle` caller audit (H2) | Deferred |
| Socket-close banner copy | Polish | Deferred |

## Disposition summary

- **Track-A stall is resolved** across all three surfaces. Pass-2.5 cut the host flood; pass-1 tightened cadence/throttle/memo/LRU; pass-3 added residual rebuild cuts + pull-audit; pass-4 added B2 bandwidth filter, S3 invalidation-coalesce, E2 renderer memo, F3 git coalesce, H4 dedupe. User reports heavy ensemble runs now "chug" smoothly (19:02–19:03 smoke tests).
- **Pass-4 is closed.** iOS slice banked at `47512fb91` (339/339 swift); ledger at `f6be9a9b0` / this pass-9 update.
- **Pass-5 is active** — priority: H5 agent-exit rebuild (WriteMain + convergence test), H6 honest naming/dedupe, H7 residual map, iOS5 pull audit (WriteSwift). @Captain stands assignments; @Adversary1 pre-commit on judgment-call slices; @CheckCommit LOCAL waves only.
- **Done criteria (pass-5):** H5 dropped-or-kept with test evidence; H6 renamed/deduped without double-coalesce; H7 every site converted-or-declared; iOS5 inventory with per-site verdicts; gates green; this ledger updated; @General summary → user acceptance → `goal_complete`.
- **TestFlight build 74** is committed locally (`fd4c63e29`) and uploaded; device validation verdict **pending** user input on build 74 + updated Mac host pairing.
- **Batch-2** is unblocked by Track-A but still needs explicit user go/no-go.
- **No high-severity holes** remain in the current iOS feature set.