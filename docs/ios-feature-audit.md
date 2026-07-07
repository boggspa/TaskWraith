# iOS Feature Solidity Matrix

> Round: iOS A/B/C/D + Batch-1 + Track-A stall recon — Goal D refresh
> Scope: solidity of **existing iOS features only**, plus the Batch-1 parity items and Track-A stall diagnosis now in-flight.
> Compiled from: Scout1/Scout2 recon, Batch-1 implementation + adversary sign-off, live transcript anchors, and the `ios/TaskWraithKit` source walk.
> Updated: Pass-5 — Batch-1 committed (`8bd8c0e9b`), TestFlight build 73 exported, Track-A stall diagnosis is the active goal blocker.

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
| **Home search (N1)** | solid | `HomeListViews.swift:168-198` (`.searchable` + `searchScopes`); ranked Results section; Active / All-incl-Archived scope chips; provider-label match covers divergent visible labels (`TWTheme.providerLabel`) | — | — |
| **Archived chats (N2)** | solid | `HomeListViews.swift` threadContextMenu → Pin/Unpin → Rename → Archive/Unarchive; collapsed "Archived (N)" section after General Chats; `RemoteSessionModel.swift` optimistic pin/archive with rollback via Codable round-trip; `setChatArchived` bridge action (`BridgeActionPayload.ts`, `index.ts`) | — | — |
| **Transcript rendering** | solid | `ThreadDetailViews.swift:898-1012`, `:2595-2626` (`LazyVStack` + `ThreadRowView.equatable()`); `RemoteSessionModel.swift:3950+`, `:3969+` (on-demand / paginated snapshots) | — | — |
| **Transcript streaming reconcile** | solid | `RemoteSessionModel.swift:2540`, `:2557`, `:2569`, `:2610-2621` (`reconcileStreamingState` wired at alias merge, empty-row, metadata-only, and terminal-summary paths) | — | — |
| **Composer (draft, @-mention, attachments)** | solid | `ComposerView.swift:139-141` (`twMentionCandidates`); `ComposerView.swift:118-852` (attachments / `PhotosPicker`); `TWDraftPersistence` (draft persistence) | — | — |
| **Add to prompt (T1)** | solid | `ThreadDetailViews.swift:2863-2882` context menu; append to live `followUp` with `\n\n` separator; existing `onChange` persists via `TWDraftPersistence` — survives thread-switch and theme teardown | — | — |
| **Copy full transcript (T2)** | solid | `ThreadDetailViews.swift` individual toolbar pill; `chatMarkdownTranscript` bridge action reuses desktop markdown builder (`App.tsx:15431-15436` equivalent); honest failure copy for archived / too-large / not-found | — | — |
| **Ensemble controls** | solid | `EnsembleRosterSheet.swift:329-338` (roster sheet + fan-out picker); `TWSharedViews.swift:7388+` (steer queue); `RemoteSessionModel.swift:4515` (`cancelRun`) | — | — |
| **Ensemble roster ordering** | solid | `RemoteTaskProjection.ts:1461` tie-break `(order, participantId)`; `Models.swift:1125-1147` `displayParticipants` sorted by `(order ?? Int.max, participantId)`; local sorts in `TWSharedViews`, `EnsembleRosterSheet`, `ComposerView`, `ThreadDetailViews` all participantId-tie-broken | — | — |
| **Ensemble mode chip (C1)** | solid | `TWSharedViews.swift` `EnsembleModeChipState` + `TelemetryFooterRail`; `ThreadDetailViews.swift:1593` wired beside `GoalRailControl`; explicit two-item menu → `updateEnsembleSettings(orchestrationMode:)`; hops chip only in continuous mode | — | — |
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
| **Settings null/placeholder values + dead read-only tabs** | solid | `TWSharedViews.swift:5294-5409` (`MobileSettingsSection` enum + default selection), `:5673-6104` (section builders). Implementation landed in `bff0e3fb1` per Design spec (`ios-settings-spec`): 14 → 9 tabs, dead read-only tabs removed, Safety & Privacy + About merged into "About & Privacy". | — | — |
| **Thinking viewport** | rough-edge | Host projects thinking through generic caps (`sanitizePreview` → `...`, `RemoteThreadProjection.ts:909-934`; tool-entry detail 90 chars `:1052`). iOS already has `expandRow` → 32k (`:72`, `:2373`). Needs a dedicated thinking field + collapsed-to-8-lines render (Design spec `ios-thinking-viewport-spec`). | Medium | WriteMain (wire) → WriteSwift (render) |
| **Track-A stall / disconnect** | hole | iOS loads/reads fine but live updates stall; disconnect/slow errors on good network. Root-cause candidates ranked in `ios-stall-investigation-brief` + Scout2 apply-path brief. Batch-1 did not introduce new background churn. | High | General (triage) → WriteMain/WriteSwift |
| **Canvas** | rough-edge | `CanvasPreviewCard.swift` only — preview card exists; no interactive DOM / drawing surface | Low | defer (out of iOS scope) |
| **Full-size media** | rough-edge | `ThreadDetailViews.swift` — fallback path renders `"Full image unavailable"` when full-resolution asset is absent | Low | WriteSwift or defer |

## Batch-1 landed summary

All five Batch-1 surfaces are committed to `master@8bd8c0e9b` and passed gates (`tsc`, vitest 311/311, Swift 309/309, `npm run ci` 8750 tests):

| ID | Surface | Files | Commit |
|----|---------|-------|--------|
| N1 | Home search | `HomeListViews.swift`, `IosParityFixesTests.swift` | `8bd8c0e9b` |
| N2 | Chat lifecycle (pin / rename / archive) | `Models.swift`, `RemoteSessionModel.swift`, `HomeListViews.swift` | `8bd8c0e9b` |
| T1 | Add to prompt | `ThreadDetailViews.swift` | `8bd8c0e9b` |
| T2 | Copy full transcript | `ThreadDetailViews.swift`, `RemoteSessionModel.swift` | `8bd8c0e9b` |
| C1 | Ensemble Turn/Continuous mode chip | `TWSharedViews.swift`, `ThreadDetailViews.swift` | `8bd8c0e9b` |

Host wires for N2/T2 plus roster tie-break:

| Commit | Slice |
|--------|-------|
| `f65db4ee9` | Roster sort participantId tie-break (`RemoteTaskProjection.ts` + test) |
| `8f1819c2f` | `setChatArchived` + `chatMarkdownTranscript` bridge actions (`BridgeActionPayload`/`Executor`/`Router` + `index.ts`) |

## Track-A stall / disconnect diagnosis

Status: **active blocker** — Batch-2 go/no-go waits on this diagnosis.

User symptom: iOS loads and reads chats fine, but live updates stall; repeated disconnect/slow errors even on confirmed-good network; sends succeed.

Top mechanisms (ranked by Scout2 iOS apply-path recon):

| Rank | Mechanism | Hypothesis | Verdict | Smallest-fix shape |
|------|-----------|------------|---------|--------------------|
| 1 | Serial `@MainActor` full-snapshot apply | H2 | Confirmed | Coalesce inbound full snapshots (50–150ms trailing-edge debounce); apply only latest envelope during active runs |
| 2 | Client pull amplification during streaming | H1 (iOS leg) | Confirmed | Skip / extend `requestThreadSnapshot` refresh pulls while `streamingRunIds[visibleThread] != nil`; keep short debounce only for `agent-exit` |
| 3 | Disconnect UX + reconnect re-hydration | H3 | Partial | Calm copy exists when `.connected`; `handleSocketClosed` still flips offline banner + re-pulls visible thread after 1.2s |
| 4 | Outbound ack timeouts vs inbound pushes | H3 | Refuted for pushes | Inbound broadcast is fire-and-forget; outbound ack 8s / send 12–16s; MainActor apply backlogs the consumer but does not block inbound acks |
| 5 | UI invalidation / Equatable | H2 (UI) | Gates intact | `ThreadRowView.equatable()` + `TranscriptToolRowGroupingCache` memo hold; churn remains from snapshot replacements |

Recommended next step (Boss-owned): triage Scout1 host-publish findings against the above and choose a pass-2.5 fix batch. Lowest-risk iOS-only mitigation is #2 (suppress agent-output refresh pulls during streaming); highest-impact is #1 + background decode, but touches the MainActor seam and needs adversary review.

## Batch-2 priority ladder (pending Track-A + user go/no-go)

From `ios-ux-gap-priority-ladder` and `ios-lifecycle-capability-ruling`. These are **explicitly deferred** until Track-A is resolved and the user agrees scope.

| Priority | Surface | Why Batch-2 | Smallest shape |
|----------|---------|-------------|----------------|
| 1 | Sub-thread delegation spawn | Needs new bridge action + iOS sheet | `createSubThread` bridge adapter over `ChatService.createSubThread` (`ChatService.ts:183-195`); iOS sheet mirrors `createSideChat` |
| 2 | Ensemble fan-out result cards | Lanes collapse into generic rows today | Forward `ensembleLaneId` / `ensembleLaneIntent` from orchestrator (`EnsembleOrchestrator.ts:838-847`) through `RemoteThreadRow` (`RemoteThreadProjection.ts`) |
| 3 | Document-picker attachments (non-photo) | PhotosPicker exists; file/document picker missing | `UIDocumentPickerViewController` integration in `ComposerView.swift` |
| 4 | Create-PR one-tap above-bar | Needs UI + action wiring | Toolbar pill → `externalPublish` PR flow, gated by capability |
| 5 | Workspace-board read-only drill-in | No iOS board view | Read-only board snapshot → card list → detail |
| 6 | Delete chat | Destructive; needs new capability + explicit opt-in | `deleteChat` capability (default OFF) + `ChatService.deleteChat` handler + confirmation dialog |
| 7 | Message-body search | iOS snapshot window too small for local search | `searchChats` read-only bridge action host-searches `AppStore` |

**Declined this session** (consistent with prior scope stance): slash-commands / Cmd-K, voice input, full external-path grant UI, interactive Canvas drawing surface.

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
| Batch-1 T1 draft append seam | ✅ solid | `ThreadDetailViews.swift:841-846` (live `followUp` append + `onChange` persist); no parallel `setDraft` |
| Batch-1 N2 optimistic pin/archive rollback | ✅ solid | `RemoteSessionModel.swift` Codable round-trip cardSettingFlag; `setChatArchived` gated on `pin` capability |
| Batch-1 N1 provider-label match | ✅ solid | `HomeListViews.swift` matches both raw `card.provider` and visible `TWTheme.providerLabel` |

## Disposition summary

- **Batch-1 is landed, committed, and pushed.** Home search, chat lifecycle, add-to-prompt, transcript copy, and ensemble mode chip are all solid end-to-end.
- **Track-A stall / disconnect is the active high-severity hole.** It blocks Batch-2 scope expansion. Scout2 has identified the ranked mechanisms; Boss triage is the next required step.
- **Thinking viewport truncation** is a medium rough-edge with a Design spec ready; it should ride the Track-A pass-2.5 batch (same files: `RemoteThreadProjection.ts` + `ThreadDetailViews.swift`) or immediately after.
- **No high-severity holes remain in the rest of the current iOS feature set.**
- **TestFlight status:** build 73 exported successfully with production entitlements; ASC upload rejected because build 73 already exists. To ship this tree, bump to build 74 and re-upload (release follow-up, not a UX-parity blocker).
