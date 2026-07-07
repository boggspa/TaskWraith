# iOS Feature Solidity Matrix

> Round: iOS A/B/C/D investigation — Goal D  
> Scope: solidity of **existing iOS features only**. No new Electron-feature proposals.  
> Compiled from: Scout2 D-audit brief, Scout1 C-delta evidence, live transcript anchors, and the `ios/TaskWraithKit` source walk.

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
| **Approvals + auto-deny countdown** | solid | `AttentionRows.swift:44-53` (Mac `expiresAt`); `AttentionRows.swift:487-490` (live countdown) | — | — |
| **Question / answer card capability** | rough-edge | `AttentionRows.swift:367-370` — iOS fail-closes on `capabilities.answer == nil`; answer UI missing if host card omits the flag | Low–Medium | WriteMain (verify payload always includes `capabilities.answer` when answerable) |
| **Diff Studio + Files** | solid | `RemoteSessionModel.swift:3214-3231` (capability gates); `AppShell.swift:308-357` (compact + split modes) | — | — |
| **Workflows view** | solid (read-only) | `HomeListViews.swift:474-823` (list + open chat); `NewChatCanvas.swift` (create via canvas); `Models.swift:441-442` (edit schedule Mac-owned by design) | — | — |
| **Goal / plan rail** | solid | `GoalRailControl` / `TWSharedViews.swift:4042+` (editable goal); `TWSharedViews.swift:4195-4199` (read-only plan) | — | — |
| **Push / APNs** | solid | `RemoteSessionModel.swift:323-377` (pending token + post-connect register); `RemoteSessionModel.swift:4271-4309` (notification action wake) | — | — |
| **Usage / context meter** | solid | `ComposerView.swift:591-599` (composer popover); `TWSharedViews.swift:5803+` (Settings usage section) | — | — |
| **Side chats** | solid | `RemoteSessionModel.swift:3705+` (`createSideChat`); `TWSharedViews.swift:7848+` (side-chat list); `GuestCardLifecycleTests.swift` (guest legacy lifecycle) | — | — |
| **Git workflows (stage/commit/PR)** | solid when granted | `GitWorkflowViews.swift:1-10`; `RemoteSessionModel.swift:3247` (`externalPublish` gate) | — | — |
| **Settings scope / Mac-owned tabs** | solid (intentional) | `TWSharedViews.swift:5482-5491` (Mac-owned callouts); `TWSharedViews.swift:5682` (approval timeouts) | — | intentional defer |
| **Settings null/placeholder values + dead read-only tabs** | rough-edge | `TWSharedViews.swift:5482+` (Settings sections); `TWSharedViews.swift:5803+` (usage); audit shows placeholder/null values and tabs with no usable actions or telemetry | Medium | Design (disposition FIX/MERGE/REMOVE spec), WriteSwift (pass-3 implementation) |
| **Canvas** | rough-edge | `CanvasPreviewCard.swift` only — preview card exists; no interactive DOM / drawing surface | Low | defer (out of iOS scope) |
| **Full-size media** | rough-edge | `ThreadDetailViews.swift` — fallback path renders `"Full image unavailable"` when full-resolution asset is absent | Low | WriteSwift or defer |

## Known-risk wiring — verification

| Check | Verdict | Evidence |
|-------|---------|----------|
| `reconcileStreamingState` wired in `mergeThreadSnapshot` | ✅ solid | `RemoteSessionModel.swift:2540` (alias merge), `:2557` (empty-row), `:2569` (metadata-only), `:2610-2621` (terminal summary match) |
| Follow-pin deferred via next runloop | ✅ solid | `ThreadDetailViews.swift:1691-1695` (`awaitNextMainRunloop` → `DispatchQueue.main.async`); `TWSharedViews.swift:8131-8134` (side chat `twAwaitNextMainRunloop`) |
| `ThreadRowView` / `ToolBurstRowView` Equatable gates | ✅ solid | `ThreadDetailViews.swift:2618-2626`, `:3337-3339` |
| Timeout banner `.connected` guards | ✅ solid | snapshot fetch `ThreadDetailViews.swift:3959-3961`; previous-rows `:3989`; file/media actions `:3141`, `:3184`; generic ack `:4811` |

## Disposition summary

- **No high-severity holes found** in the current iOS feature set.
- **Five rough-edges** identified; ranked by visibility:
  1. **Settings cleanup** (Medium) — user explicitly asked to remove/fix dead read-only tabs and placeholder/null values. `@Design` is speccing this pass; `@WriteSwift` implements pass-3.
  2. **Question answer capability** (Low–Medium) — iOS fail-closes if the host card omits `capabilities.answer`. `@WriteMain` is verifying host-side payload wiring this pass.
  3. **Archived chats** (Low) — no browse/unarchive UI on phone; safe to defer or handle with small copy change.
  4. **Canvas** (Low) — preview-only by design; out of iOS scope for now.
  5. **Full-size media fallback** (Low) — graceful but user-visible dead-end when full asset is unavailable.
