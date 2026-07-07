# iOS Feature Solidity Matrix

> Round: iOS A/B/C/D investigation — Goal D
> Scope: solidity of **existing iOS features only**. No new Electron-feature proposals.
> Compiled from: Scout2 D-audit brief, Scout1 C-delta evidence, live transcript anchors, and the `ios/TaskWraithKit` source walk.
> Updated: Pass-4 — C4 host wire committed, question-answer capability payload verified, Settings dispositions spec'd.

## Legend

| Status | Meaning |
|--------|---------|
| **solid** | Feature is wired end-to-end and behaves correctly on iOS. |
| **rough-edge** | Feature works, but has a polish/usability/continuity gap that is acceptable today and should be dispositioned before calling the surface “done”. |
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
| **Archived chats** | rough-edge | `HomeListViews.swift:123` (archived threads filtered out of list); **no** archive / unarchive / browse UI on phone | Low | WriteSwift (copy/browse UI) or defer |
| **Transcript rendering** | solid | `ThreadDetailViews.swift:898-1012`, `:2595-2626` (`LazyVStack` + `ThreadRowView.equatable()`); `RemoteSessionModel.swift:3950+`, `:3969+` (on-demand / paginated snapshots) | — | — |
| **Transcript streaming reconcile** | solid | `RemoteSessionModel.swift:2540`, `:2557`, `:2569`, `:2610-2621` (`reconcileStreamingState` wired at alias merge, empty-row, metadata-only, and terminal-summary paths) | — | — |
| **Composer (draft, @-mention, attachments)** | solid | `ComposerView.swift:139-141` (`twMentionCandidates`); `ComposerView.swift:118-852` (attachments / `PhotosPicker`); `TWDraftPersistence` (draft persistence) | — | — |
| **Ensemble controls** | solid | `EnsembleRosterSheet.swift:329-338` (roster sheet + fan-out picker); `TWSharedViews.swift:7388+` (steer queue); `RemoteSessionModel.swift:4515` (`cancelRun`) | — | — |
| **Ensemble system-row identity (C4)** | solid | Host seeds frozen seat labels in `RemoteThreadProjection.ts:1432-1470` (`ensembleSystemSeatLabel`) and `RemoteThreadProjection.ts:1561-1562` (`buildRow`); iOS consumes via `ThreadDetailViews.swift:2860-2876` (`baseLabel`/`label` using `twSettledRowSpeakerSplit`) | — | — |
| **Approvals + auto-deny countdown** | solid | `AttentionRows.swift:44-53` (Mac `expiresAt`); `AttentionRows.swift:487-490` (live countdown) | — | — |
| **Question / answer card capability** | solid | Host always materializes `capabilities.answer` as a boolean: `BridgeBroadcaster.ts:612`, `src/main/index.ts:25869`; iOS reads it at `AttentionRows.swift:367-370` (`canAnswerQuestion`). The earlier `nil` fail-close is now unreachable in practice. | — | — |
| **Diff Studio + Files** | solid | `RemoteSessionModel.swift:3214-3231` (capability gates); `AppShell.swift:308-357` (compact + split modes) | — | — |
| **Workflows view** | solid (read-only) | `HomeListViews.swift:474-823` (list + open chat); `NewChatCanvas.swift` (create via canvas); `Models.swift:441-442` (edit schedule Mac-owned by design) | — | — |
| **Goal / plan rail** | solid | `GoalRailControl` / `TWSharedViews.swift:4042+` (editable goal); `TWSharedViews.swift:4195-4199` (read-only plan) | — | — |
| **Push / APNs** | solid | `RemoteSessionModel.swift:323-377` (pending token + post-connect register); `RemoteSessionModel.swift:4271-4309` (notification action wake) | — | — |
| **Usage / context meter** | solid | `ComposerView.swift:591-599` (composer popover); `TWSharedViews.swift:5803+` (Settings usage section) | — | — |
| **Side chats** | solid | `RemoteSessionModel.swift:3705+` (`createSideChat`); `TWSharedViews.swift:7848+` (side-chat list); `GuestCardLifecycleTests.swift` (guest legacy lifecycle) | — | — |
| **Git workflows (stage/commit/PR)** | solid when granted | `GitWorkflowViews.swift:1-10`; `RemoteSessionModel.swift:3247` (`externalPublish` gate) | — | — |
| **Settings scope / Mac-owned tabs** | solid (intentional) | `TWSharedViews.swift:5482-5491` (Mac-owned callouts); `TWSharedViews.swift:5682` (approval timeouts) | — | intentional defer |
| **Settings null/placeholder values + dead read-only tabs** | rough-edge → dispositioned | `TWSharedViews.swift:5294-5409` (`MobileSettingsSection` enum + default selection), `:5673-6104` (section builders). Design spec (`ios-settings-spec`) dispositions every tab: 4 REMOVE, 2 MERGE→1, 4 KEEP+FIX, 4 KEEP. Implementation queued for WriteSwift pass-4. | Medium | Design (spec ✓), WriteSwift (pass-4 implementation) |
| **Canvas** | rough-edge | `CanvasPreviewCard.swift` only — preview card exists; no interactive DOM / drawing surface | Low | defer (out of iOS scope) |
| **Full-size media** | rough-edge | `ThreadDetailViews.swift` — fallback path renders `"Full image unavailable"` when full-resolution asset is absent | Low | WriteSwift or defer |

## Settings tab disposition (from `ios-settings-spec`)

Audited all 14 `MobileSettingsSection` tabs. Net: **14 → 9 tabs**; zero action-less read-only tabs remain.

| Tab | Disposition | Rationale |
|---|---|---|
| General | **REMOVE** | Zero actions; values duplicated in Appearance / Composer |
| Ensemble Roster | **REMOVE** | Prose-only; real roster lives in per-chat `EnsembleRosterSheet` |
| Tools & MCPs | **REMOVE** | Read-only remote view; MCP mention folds into Providers footer |
| Local Servers | **REMOVE** | Duplicates Providers' Ollama readiness row + placeholder |
| Safety & Privacy + About | **MERGE → "About & Privacy"** | Single honest tab with version row (`Bundle.main`) and privacy prose |
| Providers | **KEEP + FIX** | Real telemetry; collapse placeholder skeleton cards to one waiting row |
| Approvals | **KEEP + FIX** | Live counts; make summary rows tappable via existing notification-wake path; fix provider-label fallback |
| Devices & Hosts | **KEEP + FIX** | Add Switch/Forget context menu using existing `switchHost`/`forgetHost` |
| Model Usage | **KEEP + FIX** | Rich dashboard; replace "Quota providers: 0" with waiting row when snapshot nil |
| Appearance / Composer / Workspaces / Guide | **KEEP** | Fully actionable |

**Landmine ③ note:** Removals only *reduce* `@State`; no new must-survive state introduced.

## Known-risk wiring — verification

| Check | Verdict | Evidence |
|-------|---------|----------|
| `reconcileStreamingState` wired in `mergeThreadSnapshot` | ✅ solid | `RemoteSessionModel.swift:2540` (alias merge), `:2557` (empty-row), `:2569` (metadata-only), `:2610-2621` (terminal summary match) |
| Follow-pin deferred via next runloop | ✅ solid | `ThreadDetailViews.swift:1691-1695` (`awaitNextMainRunloop` → `DispatchQueue.main.async`); `TWSharedViews.swift:8131-8134` (side chat `twAwaitNextMainRunloop`) |
| `ThreadRowView` / `ToolBurstRowView` Equatable gates | ✅ solid | `ThreadDetailViews.swift:2618-2626`, `:3337-3339` |
| Timeout banner `.connected` guards | ✅ solid | snapshot fetch `ThreadDetailViews.swift:3959-3961`; previous-rows `:3989`; file/media actions `:3141`, `:3184`; generic ack `:4811` |
| C1 speaker label / model chip single-source | ✅ solid | `TWSharedViews.swift:814-829` (`twSettledRowSpeakerSplit`); `ThreadDetailViews.swift:2860-2876` (consumes `split.label` when chip present) |
| C4 ensemble system-row speaker seeding | ✅ solid | `RemoteThreadProjection.ts:1432-1470` (`ensembleSystemSeatLabel`), `:1561-1562` (`buildRow`) |
| Question-card `capabilities.answer` payload | ✅ solid | `BridgeBroadcaster.ts:612`, `src/main/index.ts:25869` (always boolean); `AttentionRows.swift:367-370` (consumes) |

## Disposition summary

- **No high-severity holes found** in the current iOS feature set.
- **C4 (ensemble system-row identity)** is now end-to-end solid: host seeds frozen seat labels and iOS renders them through the same single-source speaker split used for C1.
- **Question / answer card capability** is solid: the host always projects a boolean `capabilities.answer`, so iOS's `nil` fail-close is no longer reachable in practice.
- **Settings cleanup** is the largest remaining rough-edge. It is fully dispositioned (14→9 tabs) and queued for WriteSwift implementation; once implemented it moves to **solid**.
- **Remaining low-severity rough-edges** (archived chats, Canvas preview-only, full-size media fallback) are acceptable and can be deferred or handled in small follow-ups.
