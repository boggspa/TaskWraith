# iOS Feature Solidity Matrix

> Round: Cross-platform perf session — **pass-3** residual rebuild cuts + de-vibe + interest-filter specs
> Scope: solidity of **existing iOS features only**, plus Batch-1 parity, Track-A resolution, and perf-session residuals.
> Compiled from: Scout1/Scout2 recon, pass-1/2/2.5/3 implementation, adversary review, and `ios/TaskWraithKit` source walk.
> Updated: Pass-7 — pass-3 in flight (2026-07-07); IF3 committed (`f765f4ad9`); S3/H3/E2 landed uncommitted pending adversary fixes; B2 + S3-batching specs boarded.

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
| **Track-A stall / live-update lag** | solid | Pass-2.5 host flood cut + iOS coalescer + stream-pull suppression; pass-1 tightened cadence; pass-3 S3 centralizes on-demand pull suppression. User smoke test (19:02) reports heavy ensemble run with no lag ("chugging"). | — | — |
| **Canvas** | rough-edge | `CanvasPreviewCard.swift` only — preview card exists; no interactive DOM / drawing surface | Low | defer |
| **Full-size media** | rough-edge | `ThreadDetailViews.swift` — fallback path renders `"Full image unavailable"` when full-resolution asset is absent | Low | defer |

## Pass-3 gate ledger (in flight, 2026-07-07)

User-directed continuation on 18-commit local baseline. Every landed perf slice names the trigger it cuts. De-vibe boundary: session-touched surfaces + adversary nits only — not a repo-wide slop hunt.

| Track | Owner | Status | Adversary gate | Trigger / scope |
|-------|-------|--------|----------------|-----------------|
| **IF3** off-MainActor decode | WriteSwift | **Committed** `f765f4ad9` | ✅ unanimous (pass-2) | JSON decode off MainActor; coalescer generation guard; teardown `reset()` |
| **H2** meta-helper delta-first | WriteMain | **Committed** `4edad9087` | ✅ | `broadcastThreadUpdate` / `broadcastThreadList` skip chained full when delta covers |
| **H3** residual full-rebuild cuts | WriteMain | Landed uncommitted | ❌ F1+F2 pending | Tier-1/2 delta drops; workflow IPC de-vibe helper; agent-exit decision; git-refresh coalesce |
| **E2** renderer identity churn | WriteRender | Landed uncommitted | ✅ code approved · **ON HOLD** | `TranscriptPanel` delegation signature memo; `stableEmpties` de-vibe — blocked on external-session foreign hunks in `TranscriptPanel.tsx` |
| **S3** pull-site audit | WriteSwift | Landed uncommitted | ❌ F-S1+F-S2 pending | Centralized `shouldSuppressOnDemandSnapshotPull`; ~25 schedule sites suppressed mid-stream |
| **B2** runEvent interest filter | Design → Boss ruling | Spec boarded | ✅ amended (A1/A2) | Host sink filter; `setWatchedThread` wire; fail-open on missing signal |
| **S3-batching** invalidation-coalesce | Design → Boss ruling | Spec boarded | ✅ exit pins | 80ms publish window; S3-DELTA **killed** (ordered envelope contract differs from IF3) |

### H3 adversary findings (WriteMain — one-liners required)

| ID | Defect | Fix |
|----|--------|-----|
| **F1** | `syncCodexGoalCapabilityMetadata` (`index.ts:16959`) pushes `threadSnapshot` but mutates `activeGoal` — phone reads goal from **taskCard** (`Models.swift:627`) | Replace with `pushRemoteTaskCardDelta` |
| **F2** | Pairing fix (Adversary1 low) | One-line companion to F1 |
| **F3** | Git-refresh coalesce gap | Boss ruling pending |

### S3 adversary findings (WriteSwift — fold into same two-file slice)

| ID | Defect | Fix |
|----|--------|-----|
| **F-S1** | Agent-exit `bypassVisibleStreamSuppression` skips outer gate but debounced fire at `:3129` calls `requestThreadSnapshot(threadId)` **without** forwarding bypass → inner gate re-suppresses terminal re-pull | Forward bypass through debounced task + fire-through test |
| **F-S2** | `isTerminalRefresh` param on gate is dead (zero production callers) | Delete param or route bypass through gate as single decision point |

**CheckCommit correction:** IF3 is committed at `f765f4ad9`. Working `RemoteSessionModel.swift` diff is **S3-only** (not IF3+S3 combined).

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

## Perf pass-3 landed detail (uncommitted — pending adversary fixes + CheckCommit wave)

### S3 — iOS pull-site audit (WriteSwift)

Centralized `shouldSuppressOnDemandSnapshotPull` wired into `scheduleThreadRefresh` + `requestThreadSnapshot` (head pulls only). ~25 composer/ensemble/approval/goal/roster sites now suppressed when visible thread is actively streaming. Covering path: `appendStreamingDeltas` live buffer + host 600ms thread deltas.

| Trigger | Verdict |
|---------|---------|
| IF2 `agent-output` schedule | Already suppressed (unchanged) |
| `scheduleThreadRefresh` → head snapshot (~25 sites) | **Suppressed** when visible + streaming |
| `.established` visible refresh | **Suppressed** mid-stream |
| `agent-exit` schedule | **Kept** — terminal convergence (F-S1 fix required for fire-through) |
| Off-screen / pagination / scenePhase / side-chat | **Kept** |

Files: `RemoteSessionModel.swift`, `IosParityFixesTests.swift`. Gates: swift 326/326 at land time.

### E2 — renderer identity churn (WriteRender)

`TranscriptPanel` compares `transcriptAuxiliaryChatsSignature` (delegation-visible fields + `updatedAt`) and running-id set signature instead of raw `chats` / `runningChatIds` references. Cuts sibling/side pane re-renders on unrelated streaming token churn (rAF coalesced flushes do not bump `updatedAt`). `MainAppLayout` uses shared `stableEmpties.ts` exports.

Files: `TranscriptPanel.tsx`, `TranscriptPanelFileChanges.test.ts`, `MainAppLayout.tsx`, `stableEmpties.ts`. **Held:** external session interleaved hover-preview hunks in `TranscriptPanel.tsx`.

### H3 — host residual rebuild cuts (WriteMain)

Tier-1 delta-able drops, Tier-2 coalesce-OK conversions, `scheduledWorkflowHandlers.ts` shared `broadcastCoalescedRemoteProjectionAfterIpcMutation` helper (11 IPC save sites), agent-exit full-rebuild evaluation. **Blocked:** F1 taskCard coverage hole on codex goal sync.

Files (partial): `index.ts`, `scheduledWorkflowHandlers.ts`, `RemoteBridgePerfTuning.ts`, `RemoteBridgePerfTuning.test.ts`.

## Pass-3 spec deferrals (implementation awaits Boss ruling)

| Spec | Verdict | Notes |
|------|---------|-------|
| **B2** runEvent interest filter | Boarded + Adversary1-amended | A1: reset watch on `onDeviceEstablished` (no phantom generation); A2: single global watch slot + `connectedDeviceCount > 1 → fail-open` |
| **S3-batching** invalidation-coalesce | Boarded + approved | 80ms `streamingPublishCoalesceWindow`; leading-edge immediate publish preserves type-out feel |
| **S3-DELTA** off-main ordered envelopes | **Killed** | IF3 safety from full-snapshot idempotence; ordered `runEvent`/`threadSnapshot` envelopes are a different contract |

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
| Agent-exit handoff prompt (visible thread) | Terminal re-pull reaches wire | **F-S1 fix required** before S3 commit |
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
| IF2 + S3 on-demand pull suppression | ⚠️ F-S1 pending | Gate sound; exit bypass must fire-through at `:3129` |
| IF3 off-MainActor decode | ✅ committed | `f765f4ad9` |
| MarkdownLite LRU + participants key | ✅ solid | landmine ⑥ — `c5372ca88` tests prove FIFO fails |
| C1 speaker label / model chip single-source | ✅ solid | `twSettledRowSpeakerSplit` |
| Theme teardown must-survive state | ✅ solid | landmine ③ — state on `RemoteSessionModel`, not `@State` |

## Residuals ledger

| ID | Item | Disposition |
|----|------|-------------|
| N1 | Provider-label search | **Closed** — `c5372ca88` |
| R1 wording | Throttle keyed on active threads vs streaming-only | **Closed** — `44feed71e` keys on running chat streams |
| IF3 | Off-MainActor decode | **Closed** — `f765f4ad9` |
| S3 F-S1/F-S2 | Exit bypass fire-through + dead param | **In flight** — WriteSwift this pass |
| H3 F1/F2 | Codex goal sync taskCard coverage | **In flight** — WriteMain this pass |
| E2 hold | TranscriptPanel foreign hunks | **Held** — external session commit first |
| B2 / S3-batching | Interest filter + invalidation-coalesce | **Spec only** — Boss implement-vs-defer ruling |
| S3-DELTA | Off-main ordered envelopes | **Killed** — Design verdict |
| B3 | `resetThrottle` caller audit (H2) | Deferred — Scout1 classification done |
| runEvent micro-batching | Streaming-latency trade | Deferred (B2 spec is separate) |
| Socket-close banner copy | Polish | Deferred |

## Disposition summary

- **Track-A stall is resolved** in local commits. Pass-2.5 cut the host flood; pass-1 tightened cadence/throttle/memo/LRU; pass-3 adds residual rebuild cuts + pull-audit suppression. User reports heavy ensemble runs now "chug" smoothly.
- **IF3 is committed** (`f765f4ad9`). S3 pull-audit is the remaining iOS perf slice — two adversary one-liners (F-S1+F-S2) before CheckCommit.
- **H3 host slice** landed but blocked on F1 taskCard fix before commit.
- **E2 renderer slice** code-approved; held on external-session collision in `TranscriptPanel.tsx`.
- **TestFlight build 74** is committed locally (`fd4c63e29`) and uploaded; device validation verdict **pending** user input on build 74 + updated Mac host pairing.
- **Batch-2** is unblocked by Track-A but still needs explicit user go/no-go.
- **No high-severity holes** remain in the current iOS feature set.
- **Pass-3 completion** requires: adversary fixes landed → CheckCommit LOCAL wave → honest pass summary → user acceptance → `goal_complete`.