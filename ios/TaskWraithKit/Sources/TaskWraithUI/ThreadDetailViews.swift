// SwiftUI surface for the TaskWraith companion.
//
// Design direction (see ios/DESIGN.md): borrow the *format* of the Claude /
// Codex iOS apps — workspaces-as-projects home, thread view with collapsed
// history + tool chips, pill composer — but skinned entirely in TaskWraith's
// own theme tokens (TWTheme mirrors the desktop theme.css). iPhone focuses on
// solid thread management; iPad gets the sidebar (NavigationSplitView) where
// advanced affordances will live. Pure SwiftUI so `swift build` compile-checks
// on macOS; QR camera scanning is the one `#if os(iOS)` extra.

import Foundation
import SwiftUI
import TaskWraithKit

#if canImport(UIKit)
    import AVFoundation
    import AVKit
    import PhotosUI
    import UIKit
#endif

/// Coalesces transcript follow-pin requests (see ThreadDetailView.requestFollowPin).
/// A reference type so toggling `scheduled` never triggers a View re-render —
/// during streaming the body already recomputes on every token. Internal (not
/// `private`) so MiniThreadView (TWSharedViews.swift) — the ensemble side-chat
/// panel, which previously had NO auto-follow machinery at all — can reuse the
/// same coalescer instead of drifting its own copy out of sync.
final class TranscriptFollowPin {
    var scheduled = false
    /// Wall-clock of the last pin — throttles the ~24fps reveal-driven pins.
    var lastPinAt: Date = .distantPast
    /// Wall-clock of the last user touch on the transcript. Held HERE (a plain
    /// reference type), not in `@State`: the zero-distance DragGesture tracker
    /// stamps it on every touch-move sample, and an `@State` write would
    /// invalidate the whole ThreadDetailView.body — re-running it and
    /// Equatable-diffing every materialized row on essentially every scroll
    /// frame (the baseline scroll stutter, independent of streaming).
    var lastUserTouchAt: Date = .distantPast
}

enum TranscriptTouchTrackingPolicy {
    static func usesZeroDistanceDragTracker(isPadInterface: Bool) -> Bool {
        !isPadInterface
    }
}

/// Decides whether a deferred transcript follow-pin pass may move the scroll
/// position. `force` repairs a stale bottom-sentinel / auto-follow reading after
/// a large layout update, but it must never override an active user gesture.
enum TranscriptFollowPolicy {
    static let userTouchQuietPeriod: TimeInterval = 0.25

    static func shouldScroll(
        autoFollow: Bool,
        force: Bool,
        lastUserTouchAt: Date,
        now: Date = Date()
    ) -> Bool {
        guard force || autoFollow else { return false }
        return now.timeIntervalSince(lastUserTouchAt) >= userTouchQuietPeriod
    }
}

private extension View {
    @ViewBuilder
    func transcriptTouchTracking(enabled: Bool, onTouch: @escaping () -> Void) -> some View {
        if enabled {
            self.simultaneousGesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in onTouch() }
            )
        } else {
            self
        }
    }
}

enum ThreadSnapshotRequestPolicy {
    static func needsRefresh(
        _ snapshot: RemoteThreadSnapshot?,
        wakeGeneration: Int = 0,
        lastAppliedWakeGeneration: Int = 0
    ) -> Bool {
        // Slice 5 (RC4): a wake (notification tap / foreground) that advanced this
        // thread's generation forces a refetch even over a cached, NON-empty
        // transcript — the cache may be stale relative to the approval/summary the
        // push pointed at. The default args (0,0) keep every existing caller/test
        // behaviour-identical (0 != 0 is false → falls through to the row check).
        if wakeGeneration != lastAppliedWakeGeneration { return true }
        guard let snapshot else { return true }
        let rows = snapshot.rows ?? []
        if !rows.isEmpty { return false }
        if let totalRows = snapshot.totalRows { return totalRows > 0 }
        return snapshot.rows == nil
    }
}

private struct ComposerDiffPillMetrics: Equatable {
    var filesChanged: Int
    var additions: Int
    var deletions: Int
    var commitsAhead: Int

    var isVisible: Bool {
        filesChanged > 0 || additions > 0 || deletions > 0 || commitsAhead > 0
    }
}

/// Compact floating diff pill (blurred composer). Renders straight from the
/// shared `model.gitSnapshots` cache — ThreadDetailView owns the event-driven
/// refreshes (run-finish, foregrounding, diff-sheet open) that keep the cache
/// fresh for this pill AND the focused changes rows, so the two surfaces can
/// never disagree. The pill's old private refresh state made those triggers
/// pill-only (and unmounted whenever the composer was focused), leaving the
/// ChangesAttachedRow numbers stale.
private struct CachedComposerDiffPill: View {
    @ObservedObject var model: RemoteSessionModel
    let workspaceId: String?
    let fallbackFilesChanged: Int
    let fallbackAdditions: Int
    let fallbackDeletions: Int
    let fallbackCommitsAhead: Int
    let reduceMotion: Bool
    /// When true, renders an intrinsic chip for a shared above-composer pill row
    /// (tools pill on the right). Host owns padding/transition.
    var compactInline: Bool = true
    /// Liquid Glass morph namespace shared with the sibling tools pill.
    var glassNamespace: Namespace.ID? = nil
    let onTap: () -> Void

    private var snapshot: GitWorkspaceSnapshot? {
        workspaceId.flatMap { model.gitSnapshots[$0] }
    }

    private var metrics: ComposerDiffPillMetrics {
        ComposerDiffPillMetrics(
            filesChanged: snapshot?.counts?.changed ?? fallbackFilesChanged,
            additions: snapshot?.lineStats?.additions ?? fallbackAdditions,
            deletions: snapshot?.lineStats?.deletions ?? fallbackDeletions,
            commitsAhead: snapshot?.ahead ?? fallbackCommitsAhead)
    }

    var body: some View {
        if metrics.isVisible {
            ComposerDiffPill(
                filesChanged: metrics.filesChanged,
                additions: metrics.additions,
                deletions: metrics.deletions,
                commitsAhead: metrics.commitsAhead,
                onTap: onTap,
                compactInline: compactInline,
                glassNamespace: glassNamespace
            )
        }
    }
}

/// Hosts the floating above-composer chips in a `GlassEffectContainer` where
/// the OS has one, so sibling Liquid Glass surfaces blend at the edges when
/// they're close and separate as they move apart.
///
/// The availability branch is safe for view identity: the OS version is fixed
/// for the process lifetime, so this `if` never flips at runtime and can't tear
/// down and rebuild the chips (the failure mode called out on the composer
/// shell placement a few hundred lines below).
private struct ComposerPillGlassRow: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            // Spacing matches the row's own HStack spacing so the merge
            // threshold lines up with where the chips actually sit.
            GlassEffectContainer(spacing: 8) { content }
        } else {
            content
        }
    }
}

extension View {
    /// Host floating composer chips in a shared Liquid Glass container.
    fileprivate func composerPillGlassRow() -> some View {
        modifier(ComposerPillGlassRow())
    }
}

func twTimestampMs(_ value: String?) -> Double? {
    guard let value, !value.isEmpty else { return nil }
    let formatter = ISO8601DateFormatter()
    guard let date = formatter.date(from: value) else { return nil }
    return date.timeIntervalSince1970 * 1000
}

func twShouldRenderAfterLiveBlock(
    _ row: RemoteThreadSnapshot.Row,
    liveStartedAt: String?
) -> Bool {
    guard row.subThreadReturn != nil, row.runId == nil else { return false }
    guard let liveStartedAtMs = twTimestampMs(liveStartedAt) else { return false }
    guard let rowTimestampMs = twTimestampMs(row.timestamp) else { return false }
    return rowTimestampMs >= liveStartedAtMs
}

struct ThreadDetailView: View {
    // Plain reference (NOT @ObservedObject): the transcript's re-renders are gated
    // by `store` below, not by the monolithic RemoteSessionModel's whole-object
    // publish. `model` is still read directly (fresh each render) and used for
    // method calls; it just no longer drives invalidation.
    let model: RemoteSessionModel
    let taskId: String
    /// Per-thread re-render gate. Observing THIS instead of the raw model means a
    /// different thread's streamed token / a global refresh no longer re-evaluates
    /// the whole transcript body — only the open thread's own slices do. Bound to
    /// `taskId` synchronously via `.onAppear` + `.onChange(of: taskId)` in `body`.
    @StateObject private var store = ThreadTranscriptStore()
    /// Slice 5 (RC4): the wake generation this view last honored with a refetch.
    /// When the model's per-thread generation advances past this, needsRefresh
    /// forces a refresh even over a cached, non-empty transcript.
    @State private var lastAppliedWakeRefreshGeneration = 0
    /// Reduce Motion collapses the composer focus spring/slide to a short
    /// opacity crossfade (see ComposerMotion). Read here so the focus-gated row
    /// groups can pick their transition without a second source of truth.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.horizontalSizeClass) private var hSizeClass
    /// Shared morph identity for the two floating above-composer chips (diff +
    /// tools) so their Liquid Glass blends and separates as one system.
    @Namespace private var composerPillGlass
    @State private var followUp = ""
    /// Mirrors the Composer's expanded state (focused / drafting / queued /
    /// ensemble) so the host hides the secondary rows + telemetry rail when the
    /// composer is idle — i.e. the compact one-line composer.
    @State private var composerFocused = false
    @State private var renameSheetContext: ThreadRenameSheetContext?
    @State private var ensembleDisablePickerPresented = false
    @State private var ensembleDisableCard: RemoteTaskCard?
    @State private var ensembleSoloProviderChoices: [String] = []
    @StateObject private var composerDiffSheetState = MobileDiffStudioState()
    @State private var composerDiffSheetPresented = false
    @State private var diffPillRefreshGeneration = 0
    /// Drives the focus-independent git snapshot refresh on foregrounding —
    /// the compact pill (mounted only while the composer is blurred) can no
    /// longer own that trigger.
    @Environment(\.scenePhase) private var scenePhase
    /// Follow the transcript tail as content streams in. Driven by the bottom
    /// sentinel's visibility (on screen ⇒ follow); the jump-to-latest pill and
    /// thread-open also re-arm it.
    @State private var autoFollow = true
    /// One-scroll-per-turn coalescer for the follow-pin (kills stacked scrolls).
    @State private var followPin = TranscriptFollowPin()
    @State private var toolRowGroupingCache = TranscriptToolRowGroupingCache()
    /// Settled stacks / system notices the user re-opened after they folded
    /// into one-line summaries. Keyed by display-item id (anchored on the
    /// first constituent row id, stable across snapshot growth).
    @State private var expandedSettledStacks: Set<String> = []
    // Last user-touch wall-clock lives on `followPin` (a reference type) so the
    // per-touch-move tracker never re-renders the body. A forced follow-pin's
    // SETTLE pass reads it so it doesn't yank the scroll back to bottom while the
    // user is actively dragging to read older text (bug class `fafe49ef5`).
    @State private var keyboardVisible = false
    /// Secondary workspace granted to subsequent runs (rail picker), keyed by
    /// thread so navigation away and back does not drop an unsent choice.
    @SceneStorage("taskwraith.secondaryWorkspaceSelections")
    private var secondaryWorkspaceSelectionStore = "{}"

    private var card: RemoteTaskCard? {
        model.taskCards.first { $0.id == taskId || $0.threadId == taskId }
    }
    // Single alias-resolution algorithm, shared with `ThreadTranscriptStore` so
    // the per-thread re-render gate can never fire on a different key set than the
    // view actually reads (see ThreadTranscriptStore.resolvedThreadKeys).
    private var resolvedThreadKeys: [String] {
        ThreadTranscriptStore.resolvedThreadKeys(
            taskId: taskId, cards: model.taskCards, snapshots: model.threadSnapshots)
    }
    private func threadValue<T>(_ values: [String: T]) -> T? {
        for key in resolvedThreadKeys {
            if let value = values[key] { return value }
        }
        return nil
    }
    private var filesToolbarWorkspaceId: String? {
        guard let workspaceId = card?.workspaceId, model.workspaceCanEditFiles(workspaceId) else {
            return nil
        }
        return workspaceId
    }
    private var diffsToolbarWorkspaceId: String? {
        guard let workspaceId = card?.workspaceId, model.workspaceCanReviewDiffs(workspaceId) else {
            return nil
        }
        return workspaceId
    }
    private var showsRosterToolbarButton: Bool {
        card?.isEnsemble == true && card?.workspaceId != nil
    }
    private var isGlobalChat: Bool { card?.isGlobalScope == true }
    private var transcriptColumnMaxWidth: CGFloat? {
        guard isGlobalChat, hSizeClass == .regular else { return nil }
        return 760
    }
    private var isPadInterface: Bool {
        #if os(iOS)
            return UIDevice.current.userInterfaceIdiom == .pad
        #else
            return false
        #endif
    }
    private var snapshot: RemoteThreadSnapshot? { threadValue(model.threadSnapshots) }
    private var ensembleState: RemoteEnsembleState? { threadValue(model.ensembleStates) }
    private var diffSummary: MobileDiffSummary? { threadValue(model.diffSummaries) }
    private func isMessagePinned(_ messageId: String) -> Bool {
        snapshot?.pinnedRows?.contains(where: { $0.id == messageId }) == true
    }
    /// Slice 5 (RC4): this thread's current wake generation (bumped by a
    /// notification tap / foreground targeting it).
    private var wakeRefreshGeneration: Int { model.wakeRefreshGeneration[taskId] ?? 0 }
    private func requestSnapshotIfNeeded() {
        guard
            ThreadSnapshotRequestPolicy.needsRefresh(
                snapshot,
                wakeGeneration: wakeRefreshGeneration,
                lastAppliedWakeGeneration: lastAppliedWakeRefreshGeneration)
        else { return }
        // Write-back on ISSUE (not on arrival): otherwise a wake generation that
        // never advances lastApplied would keep re-firing on every subsequent
        // rows-count trigger change — a per-thread refetch loop.
        lastAppliedWakeRefreshGeneration = wakeRefreshGeneration
        model.requestThreadSnapshot(taskId)
    }
    private var snapshotRequestTrigger: String {
        let phaseKey: String
        if case .connected = model.phase {
            phaseKey = "connected"
        } else {
            phaseKey = "pending"
        }
        return [
            taskId,
            card?.id ?? "",
            card?.threadId ?? "",
            card?.workspaceId ?? "",
            "\(snapshot?.rows?.count ?? -1):\(snapshot?.totalRows ?? -1)",
            phaseKey,
            "wake:\(wakeRefreshGeneration)",
        ].joined(separator: "|")
    }
    private var showsRunCompleteSummary: Bool { snapshot?.showRunCompleteSummary != false }
    private var activeParticipant: RemoteEnsembleState.Participant? {
        guard let state = ensembleState, let activeId = state.activeParticipantId else { return nil }
        return state.displayParticipants.first(where: { $0.participantId == activeId })
            ?? state.participants?.first(where: { $0.participantId == activeId })
    }
    private var activeRosterEntry: RemoteEnsembleState.RosterEntry? {
        guard let state = ensembleState, let activeId = state.activeParticipantId else { return nil }
        return state.roster?.first(where: { $0.id == activeId })
    }
    private var thinkingProvider: String? {
        if let provider = activeParticipant?.provider, !provider.isEmpty {
            return provider
        }
        if let provider = activeRosterEntry?.provider, !provider.isEmpty {
            return provider
        }
        return snapshot?.runSummary?.provider ?? card?.provider
    }
    private var thinkingRole: String? {
        let role = (activeParticipant?.role ?? activeRosterEntry?.role)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return role?.isEmpty == false ? role : nil
    }
    private var thinkingModel: String? {
        if let model = activeParticipant?.model, !model.isEmpty {
            return model
        }
        if let model = activeRosterEntry?.model, !model.isEmpty {
            return model
        }
        return snapshot?.runSummary?.model
    }
    private var liveProvider: String? {
        threadValue(model.streamingProviders) ?? thinkingProvider
    }
    private var liveRole: String? {
        liveProvider == thinkingProvider ? thinkingRole : nil
    }
    private var liveModel: String? {
        if liveProvider == thinkingProvider { return thinkingModel }
        if snapshot?.runSummary?.provider == liveProvider { return snapshot?.runSummary?.model }
        return nil
    }
    private var transcriptParticipants: [RemoteEnsembleState.Participant] {
        ensembleState?.displayParticipants ?? []
    }
    private var liveAccent: Color {
        threadAgentIdentity?.accent
            ?? TWTheme.providerAccent(liveProvider, modelId: liveModel, modelLabel: liveModel)
    }

    private var secondaryWorkspaceSelections: [String: String] {
        get {
            guard let data = secondaryWorkspaceSelectionStore.data(using: .utf8),
                let selections = try? JSONDecoder().decode([String: String].self, from: data)
            else {
                return [:]
            }
            return selections
        }
        nonmutating set {
            guard let data = try? JSONEncoder().encode(newValue),
                let encoded = String(data: data, encoding: .utf8)
            else {
                return
            }
            secondaryWorkspaceSelectionStore = encoded
        }
    }

    private var secondaryWorkspaceId: String? {
        get {
            guard let selectedId = secondaryWorkspaceSelections[taskId], !selectedId.isEmpty else {
                return nil
            }
            if selectedId == card?.workspaceId { return nil }
            return selectedId
        }
        nonmutating set {
            var selections = secondaryWorkspaceSelections
            let trimmedId = newValue?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let trimmedId, !trimmedId.isEmpty {
                selections[taskId] = trimmedId
            } else {
                selections.removeValue(forKey: taskId)
            }
            secondaryWorkspaceSelections = selections
        }
    }

    private var secondaryWorkspaceBinding: Binding<String?> {
        Binding(
            get: { secondaryWorkspaceId },
            set: { secondaryWorkspaceId = $0 })
    }

    private struct ComposerAdditionalWorkspaceRow: Identifiable {
        let projected: RemoteTaskCard.AdditionalWorkspace
        let workspaceId: String?
        let displayName: String

        var id: String { projected.id }
        var canDispatchAsExtraWorkspace: Bool {
            workspaceId != nil && projected.access?.lowercased() == "write"
        }
        var showsWriteAccess: Bool {
            projected.access?.lowercased() == "write"
        }
    }

    private func additionalWorkspaceRows(
        for card: RemoteTaskCard
    ) -> [ComposerAdditionalWorkspaceRow] {
        (card.additionalWorkspaces ?? []).map { workspace in
            let workspaceId = model.workspaceId(forPath: workspace.path)
            let displayName =
                model.workspaceName(for: workspaceId)
                ?? workspace.path.split(separator: "/").last.map(String.init)
                ?? workspace.path
            return ComposerAdditionalWorkspaceRow(
                projected: workspace,
                workspaceId: workspaceId,
                displayName: displayName)
        }
    }

    private func extraWorkspaceIdsForSend(card: RemoteTaskCard) -> [String]? {
        var ids: [String] = []
        for row in additionalWorkspaceRows(for: card) {
            guard row.canDispatchAsExtraWorkspace,
                let workspaceId = row.workspaceId,
                model.workspaceCanEditFiles(workspaceId)
            else {
                continue
            }
            if workspaceId != card.workspaceId, !ids.contains(workspaceId) {
                ids.append(workspaceId)
            }
        }
        if let secondaryWorkspaceId,
            model.workspaceCanEditFiles(secondaryWorkspaceId),
            secondaryWorkspaceId != card.workspaceId,
            !ids.contains(secondaryWorkspaceId)
        {
            ids.append(secondaryWorkspaceId)
        }
        return ids.isEmpty ? nil : Array(ids.prefix(2))
    }

    private func composerGitWorkspaceIds(card: RemoteTaskCard) -> [String] {
        var ids: [String] = []
        func append(_ id: String?) {
            guard let id, !id.isEmpty, !ids.contains(id) else { return }
            ids.append(id)
        }
        append(card.workspaceId)
        for row in additionalWorkspaceRows(for: card) {
            append(row.workspaceId)
        }
        append(secondaryWorkspaceId)
        return ids
    }
    private var isRunning: Bool {
        // The thread snapshot's runSummary refreshes un-throttled on every
        // flush — trust it over the (snapshot-throttled) task card when
        // both exist, or a stale 'running' card pins the thinking row
        // after completion.
        if let runStatus = snapshot?.runSummary?.status {
            return runStatus == "running"
        }
        return card?.status == "running"
    }
    /// The run currently streaming into the live block (nil when idle).
    private var liveRunId: String? {
        guard let live = threadValue(model.streamingTexts), !live.isEmpty else { return nil }
        return threadValue(model.streamingRunIds)
    }
    private var threadAgentIdentity: ThreadAgentIdentity? {
        ThreadAgentIdentity(card: card)
    }
    /// Slice B: provider is switchable on any non-ensemble chat while idle,
    /// regardless of history (was first-turn-only: empty snapshot). A running
    /// chat still defers — iOS doesn't queue the switch itself; the host owns
    /// the queue-at-turn-end path and projects it back as
    /// `card.pendingProviderChange`, which the composer reflects. Ensemble seats
    /// keep their own seat-lock path (guarded out here).
    private var allowsIdleProviderChange: Bool {
        guard card?.isEnsemble != true, !isRunning else { return false }
        return true
    }
    private var showsEmptyWelcomeCanvas: Bool {
        guard card != nil, !isRunning else { return false }
        guard let snapshot else { return false }
        return (snapshot.rows ?? []).isEmpty && (snapshot.totalRows ?? 0) == 0
    }
    /// Mirrors desktop `ComposerEnsembleToggleButton` visibility — top-level chats
    /// only; linked children cannot change kind in place.
    private var showsComposerEnsembleToggle: Bool {
        guard let card else { return false }
        return !ChatKindBridge.isLinkedChild(card)
    }
    private var ensembleToggleTitle: String {
        if isRunning { return "Finish the current turn first to change chat mode." }
        return card?.isEnsemble == true ? "Ensemble on" : "Ensemble off"
    }

    private func handleComposerEnsembleToggle(
        for card: RemoteTaskCard, enabled: Bool, composerProvider: String?, composerModel: String? = nil
    ) {
        if enabled {
            model.toggleChatKind(
                card, enabled: true, composerProvider: composerProvider, composerModel: composerModel)
            return
        }
        let providers = model.ensembleToSoloProviders(for: card)
        if providers.count <= 1 {
            model.setChatKind(
                card, targetKind: "single",
                canonicalProvider: providers.first ?? composerProvider ?? card.provider)
            return
        }
        ensembleDisableCard = card
        ensembleSoloProviderChoices = providers
        ensembleDisablePickerPresented = true
    }

    /// While the live block streams a run, hide that run's in-flight
    /// snapshot assistant rows (the stream has fresher text) AND its tool
    /// rows — those re-render inside `liveElements`, interleaved with the
    /// streamed text at their true positions.
    private var visibleRows: [RemoteThreadSnapshot.Row] {
        let rows = snapshot?.rows ?? []
        guard let liveRunId else { return rows }
        return rows.filter { row in
            guard row.runId == liveRunId else { return true }
            return !(row.role == "assistant" || row.role == "tool" || row.kind == "tool")
        }
    }

    private var liveToolRows: [RemoteThreadSnapshot.Row] {
        guard let liveRunId else { return [] }
        return (snapshot?.rows ?? []).filter {
            $0.runId == liveRunId && ($0.role == "tool" || $0.kind == "tool")
        }
    }

    private var liveStartedAt: String? {
        guard let liveRunId else { return nil }
        return
            snapshot?.runSummaries?.last(where: { $0.runId == liveRunId })?.startedAt
            ?? ((snapshot?.runSummary?.runId == liveRunId) ? snapshot?.runSummary?.startedAt : nil)
    }

    private var settledRowsBeforeLive: [RemoteThreadSnapshot.Row] {
        guard let liveStartedAt else { return visibleRows }
        return visibleRows.filter { !twShouldRenderAfterLiveBlock($0, liveStartedAt: liveStartedAt) }
    }

    private var settledRowsAfterLive: [RemoteThreadSnapshot.Row] {
        guard let liveStartedAt else { return [] }
        return visibleRows.filter { twShouldRenderAfterLiveBlock($0, liveStartedAt: liveStartedAt) }
    }

    /// Render-only grouping for finished snapshot rows. The wire projection
    /// stays one-message-one-row; this folds only adjacent tool-activity rows
    /// from the same run/speaker so a tool burst reads as one compact region.
    private enum TranscriptDisplayItem: Identifiable {
        case row(RemoteThreadSnapshot.Row)
        case toolBurst(
            id: String, rows: [RemoteThreadSnapshot.Row], lastRow: RemoteThreadSnapshot.Row)
        /// Settled-stack collapse (desktop parity): a maximal run of
        /// thinking + tool rows folded behind a one-line summary. `items`
        /// preserves the ORIGINAL row/tool-burst rendering for the expanded
        /// state, so opening a stack shows exactly what renders today.
        case settledStack(
            id: String, items: [TranscriptDisplayItem], rows: [RemoteThreadSnapshot.Row],
            lastRow: RemoteThreadSnapshot.Row)
        /// Second-level fold: adjacent one-liners (same-speaker settled stacks
        /// + interleaved plain system notices) condensed behind ONE merged
        /// summary line. `members` preserve the one-liner items for the
        /// expanded state, each still expandable to its full stack.
        case superStack(
            id: String, members: [TranscriptDisplayItem],
            stackRows: [RemoteThreadSnapshot.Row], systemCount: Int,
            firstSystemPreview: String, lastRow: RemoteThreadSnapshot.Row)

        var id: String {
            switch self {
            case .row(let row): return row.id
            case .toolBurst(let id, _, _): return id
            case .settledStack(let id, _, _, _): return id
            case .superStack(let id, _, _, _, _, _): return id
            }
        }

        var lastRow: RemoteThreadSnapshot.Row {
            switch self {
            case .row(let row): return row
            case .toolBurst(_, _, let lastRow): return lastRow
            case .settledStack(_, _, _, let lastRow): return lastRow
            case .superStack(_, _, _, _, _, let lastRow): return lastRow
            }
        }
    }

    private var settledDisplayItemsBeforeLive: [TranscriptDisplayItem] {
        toolRowGroupingCache.items(
            segment: "before",
            rows: settledRowsBeforeLive,
            revision: snapshotRevisionToken,
            liveRunId: liveRunId,
            extraKey: pinnedRowsKey,
            group: { self.foldSuperGroups(self.buildSettledDisplayItems($0)) })
    }

    private var settledDisplayItemsAfterLive: [TranscriptDisplayItem] {
        toolRowGroupingCache.items(
            segment: "after",
            rows: settledRowsAfterLive,
            revision: snapshotRevisionToken,
            liveRunId: liveRunId,
            extraKey: pinnedRowsKey,
            group: { self.foldSuperGroups(self.buildSettledDisplayItems($0)) })
    }

    /// Second-level fold: consecutive one-liner items — settled stacks that
    /// share a speaker plus the plain system notices dispersed between them —
    /// condense into ONE merged `.superStack`. Pinned system rows break a run
    /// (they must stay visible), as does any non-foldable item.
    private func foldSuperGroups(_ items: [TranscriptDisplayItem]) -> [TranscriptDisplayItem] {
        enum MemberKind { case stack(speaker: String), system }
        func memberKind(_ item: TranscriptDisplayItem) -> MemberKind? {
            switch item {
            case .settledStack(_, _, let rows, _):
                return .stack(speaker: rows.first?.speaker ?? "")
            case .row(let row):
                guard twIsPlainSystemNoticeRow(row), !isMessagePinned(row.id) else { return nil }
                return .system
            default:
                return nil
            }
        }

        var out: [TranscriptDisplayItem] = []
        var pending: [TranscriptDisplayItem] = []
        var pendingSpeaker: String?

        func flush() {
            defer {
                pending.removeAll()
                pendingSpeaker = nil
            }
            guard pending.count >= 2 else {
                out.append(contentsOf: pending)
                return
            }
            var stackRows: [RemoteThreadSnapshot.Row] = []
            var systemCount = 0
            var firstSystemPreview = ""
            for member in pending {
                switch member {
                case .settledStack(_, _, let rows, _):
                    stackRows.append(contentsOf: rows)
                case .row(let row):
                    systemCount += 1
                    if firstSystemPreview.isEmpty {
                        firstSystemPreview = twCollapsedSystemNoticeLabel(row.preview)
                    }
                default:
                    break
                }
            }
            out.append(
                .superStack(
                    id: "super-stack-\(pending[0].id)",
                    members: pending,
                    stackRows: stackRows,
                    systemCount: systemCount,
                    firstSystemPreview: firstSystemPreview,
                    lastRow: pending[pending.count - 1].lastRow))
        }

        for item in items {
            guard let kind = memberKind(item) else {
                flush()
                out.append(item)
                continue
            }
            if case .stack(let speaker) = kind {
                if let current = pendingSpeaker, current != speaker {
                    flush()
                }
                pendingSpeaker = speaker
            }
            pending.append(item)
        }
        flush()
        return out
    }

    /// Settled-stack fold: maximal runs of thinking + tool rows (same
    /// run/speaker key as tool bursts) become one `.settledStack` item whose
    /// nested `items` keep the original row/burst rendering for the expanded
    /// state. Everything else passes through as `.row`.
    private func buildSettledDisplayItems(_ rows: [RemoteThreadSnapshot.Row])
        -> [TranscriptDisplayItem]
    {
        var out: [TranscriptDisplayItem] = []
        var pending: [RemoteThreadSnapshot.Row] = []

        func flush() {
            guard !pending.isEmpty else { return }
            out.append(
                .settledStack(
                    // Stable across growth for the same reason as toolBurstId:
                    // anchor identity on the FIRST row only.
                    id: "settled-stack-\(pending[0].id)",
                    items: groupAdjacentToolRows(pending),
                    rows: pending,
                    lastRow: pending[pending.count - 1]))
            pending.removeAll()
        }

        for row in rows {
            guard twCanCollapseIntoStack(row) else {
                flush()
                out.append(.row(row))
                continue
            }
            if let last = pending.last, toolBurstKey(last) != toolBurstKey(row) {
                flush()
            }
            pending.append(row)
        }
        flush()
        return out
    }

    /// The trailing display item never auto-collapses while nothing streams
    /// below it — a freshly-settled stack stays open until the next
    /// assistant/panel message actually arrives (desktop parity).
    private var tailForceExpandedItemId: String? {
        guard liveRunId == nil, !isRunning else { return nil }
        return visibleDisplayItems.last?.id
    }

    /// One settled transcript item. Settled stacks and plain system notices
    /// render as one-line summaries once the conversation has moved past
    /// them; tapping toggles back to the untouched full rendering below the
    /// (then-open) summary line.
    @ViewBuilder
    private func settledDisplayItemView(_ item: TranscriptDisplayItem) -> some View {
        switch item {
        case .row(let row):
            settledRowItemView(row, itemId: item.id)
        case .toolBurst:
            stackConstituentView(item)
        case .settledStack(let id, let items, let rows, _):
            settledStackItemView(id: id, items: items, rows: rows)
        case .superStack(
            let id, let members, let stackRows, let systemCount, let firstSystemPreview, _):
            let expanded = expandedSettledStacks.contains(id) || id == tailForceExpandedItemId
            let summary = twCollapsedSuperStackSummary(
                stackRows: stackRows, systemCount: systemCount,
                firstSystemPreview: firstSystemPreview)
            VStack(alignment: .leading, spacing: 4) {
                CollapsedTranscriptSummaryRow(
                    metaLabel: stackRows.isEmpty ? "System" : nil,
                    label: summary.label,
                    errored: summary.errorCount > 0,
                    expanded: expanded,
                    onToggle: { toggleSettledStackExpanded(id) })
                if expanded {
                    ForEach(members) { member in
                        superConstituentView(member)
                    }
                }
            }
        }
    }

    /// Constituent of an expanded super-group: the ordinary one-liner items,
    /// each still expandable individually. Never recurses into `.superStack`
    /// (the fold emits them only at the top level).
    @ViewBuilder
    private func superConstituentView(_ member: TranscriptDisplayItem) -> some View {
        switch member {
        case .row(let row):
            settledRowItemView(row, itemId: member.id)
        case .toolBurst:
            stackConstituentView(member)
        case .settledStack(let id, let items, let rows, _):
            settledStackItemView(id: id, items: items, rows: rows)
        case .superStack:
            EmptyView()
        }
    }

    /// A plain settled row: system notices fold to a one-liner, everything
    /// else renders as the ordinary ThreadRowView.
    @ViewBuilder
    private func settledRowItemView(_ row: RemoteThreadSnapshot.Row, itemId: String) -> some View {
        if twIsPlainSystemNoticeRow(row), !isMessagePinned(row.id),
            itemId != tailForceExpandedItemId
        {
            let expanded = expandedSettledStacks.contains(itemId)
            VStack(alignment: .leading, spacing: 4) {
                CollapsedTranscriptSummaryRow(
                    metaLabel: "System",
                    label: twCollapsedSystemNoticeLabel(row.preview),
                    errored: false,
                    expanded: expanded,
                    onToggle: { toggleSettledStackExpanded(itemId) })
                if expanded {
                    stackConstituentView(.row(row))
                }
            }
        } else {
            stackConstituentView(.row(row))
        }
    }

    /// One settled stack's one-liner (expandable to its row/burst rendering).
    @ViewBuilder
    private func settledStackItemView(
        id: String, items: [TranscriptDisplayItem], rows: [RemoteThreadSnapshot.Row]
    ) -> some View {
        let expanded = expandedSettledStacks.contains(id) || id == tailForceExpandedItemId
        let summary = twCollapsedStackSummary(rows: rows)
        VStack(alignment: .leading, spacing: 4) {
            CollapsedTranscriptSummaryRow(
                metaLabel: nil,
                label: summary.label,
                errored: summary.errorCount > 0,
                expanded: expanded,
                onToggle: { toggleSettledStackExpanded(id) })
            if expanded {
                ForEach(items) { nested in
                    stackConstituentView(nested)
                }
            }
        }
    }

    private func toggleSettledStackExpanded(_ id: String) {
        if expandedSettledStacks.contains(id) {
            expandedSettledStacks.remove(id)
        } else {
            expandedSettledStacks.insert(id)
        }
    }

    /// The pre-collapse row/burst rendering — exactly what the transcript
    /// showed before the settled-stack fold existed.
    @ViewBuilder
    private func stackConstituentView(_ item: TranscriptDisplayItem) -> some View {
        switch item {
        case .row(let row):
            ThreadRowView(
                model: model, threadId: taskId,
                row: model.resolvedRow(row, threadId: taskId),
                threadProvider: card?.provider,
                agentIdentity: threadAgentIdentity,
                isExpanding: model.expandingRows.contains(row.id),
                participants: transcriptParticipants,
                isPinned: isMessagePinned(row.id)
            )
            .equatable()
        case .toolBurst(_, let rows, _):
            ToolBurstRowView(
                rows: rows.map { model.resolvedRow($0, threadId: taskId) },
                agentIdentity: threadAgentIdentity)
            .equatable()
        case .superStack:
            EmptyView()
        case .settledStack(_, _, let rows, _):
            // Stacks never nest (buildSettledDisplayItems emits them only at
            // the top level); render raw rows defensively rather than
            // recursing — a recursive opaque-return builder cannot compile.
            ForEach(rows) { row in
                ThreadRowView(
                    model: model, threadId: taskId,
                    row: model.resolvedRow(row, threadId: taskId),
                    threadProvider: card?.provider,
                    agentIdentity: threadAgentIdentity,
                    isExpanding: model.expandingRows.contains(row.id),
                    participants: transcriptParticipants,
                    isPinned: isMessagePinned(row.id)
                )
                .equatable()
            }
        }
    }

    /// Pin/unpin changes super-group membership (pinned notices stay
    /// visible), so the grouping cache must key on it.
    private var pinnedRowsKey: String {
        (snapshot?.pinnedRows ?? []).map(\.id).sorted().joined(separator: ",")
    }

    private var snapshotRevisionToken: String {
        let rows = snapshot?.rows ?? []
        let lastId = rows.last?.id ?? ""
        return "\(rows.count)-\(lastId)-\(snapshot?.totalRows ?? 0)"
    }

    private var visibleDisplayItems: [TranscriptDisplayItem] {
        settledDisplayItemsBeforeLive + settledDisplayItemsAfterLive
    }

    /// Changes exactly when the settled fold shape changes — a stack or
    /// super-group forming/dissolving, the force-expanded tail moving on, or
    /// the user toggling a summary line — so the one-liner swap animates
    /// instead of teleporting, without ever animating streaming updates
    /// (display-item ids stay stable while text streams).
    private var settledFoldMotionSignature: String {
        var parts: [String] = [tailForceExpandedItemId ?? ""]
        for item in visibleDisplayItems {
            switch item {
            case .settledStack(let id, _, _, _): parts.append(id)
            case .superStack(let id, _, _, _, _, _): parts.append("super-\(id)")
            default: continue
            }
        }
        parts.append(contentsOf: expandedSettledStacks.sorted())
        return parts.joined(separator: "|")
    }

    /// One row of the LIVE block: a snapshot tool row or a streamed text
    /// segment, in finished-transcript order.
    private enum LiveElement: Identifiable {
        case toolRow(RemoteThreadSnapshot.Row)
        case text(id: String, content: String, isTail: Bool)
        var id: String {
            switch self {
            case .toolRow(let row): return "live-row-\(row.id)"
            case .text(let id, _, _): return id
            }
        }
    }

    private enum LiveDisplayElement: Identifiable {
        case toolRow(RemoteThreadSnapshot.Row)
        case toolBurst(id: String, rows: [RemoteThreadSnapshot.Row])
        case text(id: String, content: String, isTail: Bool)

        var id: String {
            switch self {
            case .toolRow(let row): return "live-row-\(row.id)"
            case .toolBurst(let id, _): return "live-burst-\(id)"
            case .text(let id, _, _): return id
            }
        }
    }

    /// Streamed segments interleaved with the live run's tool rows by
    /// cumulative tool count (StreamingInterleave) — the streaming view
    /// shows the same order the finished transcript will.
    private var liveElements: [LiveElement] {
        guard let liveRunId else { return [] }
        let segments = threadValue(model.streamingSegments) ?? [threadValue(model.streamingTexts) ?? ""]
        let rows = liveToolRows
        let counts = rows.map {
            max(1, $0.toolSummary?.activityCount ?? $0.toolSummary?.tools?.count ?? 1)
        }
        return StreamingInterleave.plan(segments: segments, toolCounts: counts).map { element in
            switch element {
            case .toolRow(let index):
                return .toolRow(rows[index])
            case .text(let segmentIndex, let isTail):
                return .text(
                    id: "live-seg-\(liveRunId)-\(segmentIndex)",
                    content: segments[segmentIndex],
                    isTail: isTail)
            }
        }
    }

    private var liveDisplayElements: [LiveDisplayElement] {
        var out: [LiveDisplayElement] = []
        var pending: [RemoteThreadSnapshot.Row] = []

        func flush() {
            guard !pending.isEmpty else { return }
            if pending.count == 1 {
                out.append(.toolRow(pending[0]))
            } else {
                out.append(.toolBurst(id: toolBurstId(pending), rows: pending))
            }
            pending.removeAll()
        }

        for element in liveElements {
            switch element {
            case .toolRow(let row):
                if !canGroupToolRow(row) {
                    flush()
                    out.append(.toolRow(row))
                    continue
                }
                if let last = pending.last, toolBurstKey(last) != toolBurstKey(row) {
                    flush()
                }
                pending.append(row)
            case .text(let id, let content, let isTail):
                flush()
                out.append(.text(id: id, content: content, isTail: isTail))
            }
        }
        flush()
        return out
    }

    private func groupAdjacentToolRows(_ rows: [RemoteThreadSnapshot.Row])
        -> [TranscriptDisplayItem]
    {
        var out: [TranscriptDisplayItem] = []
        var pending: [RemoteThreadSnapshot.Row] = []

        func flush() {
            guard !pending.isEmpty else { return }
            if pending.count == 1 {
                out.append(.row(pending[0]))
            } else {
                out.append(
                    .toolBurst(
                        id: toolBurstId(pending), rows: pending, lastRow: pending[pending.count - 1])
                )
            }
            pending.removeAll()
        }

        for row in rows {
            guard canGroupToolRow(row) else {
                flush()
                out.append(.row(row))
                continue
            }
            if let last = pending.last, toolBurstKey(last) != toolBurstKey(row) {
                flush()
            }
            pending.append(row)
        }
        flush()
        return out
    }

    private func canGroupToolRow(_ row: RemoteThreadSnapshot.Row) -> Bool {
        (row.role == "tool" || row.kind == "tool") && (row.toolSummary?.activityCount ?? 0) > 0
    }

    private func toolBurstKey(_ row: RemoteThreadSnapshot.Row) -> String {
        let runKey = row.runId ?? "row:\(row.id)"
        return "\(runKey)|\(row.speaker ?? "")"
    }

    private func toolBurstId(_ rows: [RemoteThreadSnapshot.Row]) -> String {
        // STABLE across burst growth: anchor on the FIRST row's id only. Baking in
        // `last.id` + `rows.count` changed the ForEach identity every time a new
        // tool row landed in a still-growing burst, forcing LazyVStack to
        // destroy+recreate that subtree instead of an Equatable-gated in-place
        // diff — the stutter that compounds during a live ensemble round (a
        // concurrent participant's burst regrows even in the "settled" region).
        // Content growth is still detected by ToolBurstRowView's `==` (compares
        // `rows`), so the burst re-renders on new rows without churning identity.
        guard let first = rows.first else { return "tool-burst-empty" }
        return "tool-burst-\(first.id)"
    }

    /// Memoizes adjacent tool-row grouping so long threads do not re-walk settled
    /// rows on every streaming token. Keyed by snapshot revision + live run id.
    private final class TranscriptToolRowGroupingCache {
        private var beforeKey = ""
        private var beforeItems: [TranscriptDisplayItem] = []
        private var afterKey = ""
        private var afterItems: [TranscriptDisplayItem] = []

        func items(
            segment: String,
            rows: [RemoteThreadSnapshot.Row],
            revision: String,
            liveRunId: String?,
            extraKey: String = "",
            group: ([RemoteThreadSnapshot.Row]) -> [TranscriptDisplayItem]
        ) -> [TranscriptDisplayItem] {
            let key = "\(revision)|\(liveRunId ?? "")|\(segment)|\(extraKey)"
            switch segment {
            case "before":
                if key == beforeKey { return beforeItems }
                beforeItems = group(rows)
                beforeKey = key
                return beforeItems
            case "after":
                if key == afterKey { return afterItems }
                afterItems = group(rows)
                afterKey = key
                return afterItems
            default:
                return group(rows)
            }
        }
    }

    /// runId → id of that run's LAST visible row (cards anchor there).
    private var runLastRowIds: [String: String] {
        var out: [String: String] = [:]
        for row in visibleRows {
            if let runId = row.runId { out[runId] = row.id }
        }
        return out
    }

    /// ensembleRoundId → id of that round's LAST visible row. Ensemble
    /// completion cards anchor here so participant runs do not split the
    /// transcript between speakers.
    private var ensembleRoundLastRowIds: [String: String] {
        var out: [String: String] = [:]
        for row in visibleRows {
            if let roundId = ensembleRoundId(for: row) { out[roundId] = row.id }
        }
        return out
    }

    private var runSummaries: [RemoteThreadSnapshot.RunSummary] {
        snapshot?.runSummaries ?? [snapshot?.runSummary].compactMap { $0 }
    }

    private var runSummaryById: [String: RemoteThreadSnapshot.RunSummary] {
        var out: [String: RemoteThreadSnapshot.RunSummary] = [:]
        for summary in runSummaries {
            if let runId = summary.runId { out[runId] = summary }
        }
        return out
    }

    private func ensembleRoundId(for row: RemoteThreadSnapshot.Row) -> String? {
        if let roundId = row.ensembleRoundId, !roundId.isEmpty { return roundId }
        guard let runId = row.runId else { return nil }
        return runSummaryById[runId]?.ensembleRoundId
    }

    private func isTerminalRunSummary(_ summary: RemoteThreadSnapshot.RunSummary) -> Bool {
        let status = summary.status ?? ""
        return !status.isEmpty && status != "running"
    }

    private func ensembleRoundIsActive(_ roundId: String) -> Bool {
        guard let state = ensembleState, state.roundId == roundId else {
            return false
        }
        let status = state.status ?? ""
        return !["idle", "completed", "cancelled", "failed", "error"].contains(status)
    }

    /// The terminal summary to show after this row, if it's a run's last row.
    private func runCardSummary(after row: RemoteThreadSnapshot.Row)
        -> RemoteThreadSnapshot.RunSummary?
    {
        if card?.isEnsemble == true, let roundId = ensembleRoundId(for: row) {
            guard ensembleRoundLastRowIds[roundId] == row.id else { return nil }
            guard !ensembleRoundIsActive(roundId) else { return nil }
            let summaries = runSummaries.filter { $0.ensembleRoundId == roundId }
            guard !summaries.contains(where: { $0.status == "running" }) else { return nil }
            return summaries.last(where: isTerminalRunSummary)
        }

        guard let runId = row.runId, runLastRowIds[runId] == row.id else { return nil }
        guard let summary = runSummaryById[runId] else { return nil }
        guard isTerminalRunSummary(summary) else { return nil }
        return summary
    }

    private var unanchoredRunCardSummary: RemoteThreadSnapshot.RunSummary? {
        guard let run = snapshot?.runSummary, !isRunning else { return nil }
        if card?.isEnsemble == true, let roundId = run.ensembleRoundId {
            guard ensembleRoundLastRowIds[roundId] == nil else { return nil }
            guard !ensembleRoundIsActive(roundId) else { return nil }
            let summaries = runSummaries.filter { $0.ensembleRoundId == roundId }
            guard !summaries.contains(where: { $0.status == "running" }) else { return nil }
            return summaries.last(where: isTerminalRunSummary)
        }
        guard runLastRowIds[run.runId ?? ""] == nil else { return nil }
        guard isTerminalRunSummary(run) else { return nil }
        return run
    }

    private var earlierCount: Int {
        guard let snapshot, snapshot.hasMoreAbove == true else { return 0 }
        if let windowStartIndex = snapshot.windowStartIndex {
            return max(0, windowStartIndex)
        }
        return max(0, (snapshot.totalRows ?? 0) - (snapshot.rows?.count ?? 0))
    }

    var body: some View {
        ScrollViewReader { proxy in
            transcriptList(proxy: proxy)
        }
        // Persist typed-but-unsent text. Restore on appear (keyed by taskId, so a
        // thread-switch or themes.revision teardown that recreates this view
        // re-hydrates the composer) and record every edit. `if followUp.isEmpty`
        // avoids clobbering text on a re-appear where @State survived. Covers BOTH
        // the main composer and the empty-thread welcome composer (they share
        // `followUp`). Send clears `followUp` → onChange prunes the stored draft.
        .onAppear {
            if followUp.isEmpty { followUp = TWDraftPersistence.draft(for: taskId) }
        }
        // Bind the per-thread re-render gate SYNCHRONOUSLY. `.onAppear` covers the
        // first mount (iPad recreate, compact push); `.onChange(of: taskId)` covers
        // the in-place `selectedTaskId` swap where the same view instance is reused.
        // Both run inside the SwiftUI update pass (no async `Task` hop), so no model
        // mutation can land in a gap between the view's first render and the wire-up
        // — closing the cold-start race where an early change was silently absorbed.
        .onAppear {
            store.bind(model: model, taskId: taskId)
        }
        .onChange(of: taskId) { _, newTaskId in
            store.bind(model: model, taskId: newTaskId)
        }
        .onChange(of: followUp) { _, newValue in
            TWDraftPersistence.setDraft(newValue, for: taskId)
        }
        // T1 "Add to prompt": append to the LIVE draft — TWDraftPersistence has
        // no store→view observation, so writing the store alone would change
        // nothing visible (ios-t1-draft-append-seam). Appending here lets the
        // onChange above persist it for free (teardown/thread-switch safe).
        // APPEND, never replace; \n\n separator only when a draft exists.
        .onChange(of: model.composerAppendRequest) { _, request in
            guard let request, request.threadId == taskId else { return }
            followUp = followUp.isEmpty ? request.text : followUp + "\n\n" + request.text
            model.composerAppendRequest = nil
        }
    }

    private func transcriptList(proxy: ScrollViewProxy) -> some View {
        // AnyView stage-breaks: the full modifier chain exceeded the
        // type-checker's budget once lifecycle modifiers joined it.
        toolbarChrome(
            AnyView(
                keyboardChrome(
                    AnyView(
                        followChrome(
                            AnyView(navigationChrome(AnyView(listCore(proxy: proxy)), proxy: proxy)),
                            proxy: proxy)))))
    }

    private var threadApprovals: [MobileApprovalCard] {
        let keys = Set(resolvedThreadKeys)
        return model.approvals.filter { approval in
            approval.threadId.map(keys.contains) ?? false
        }
    }
    private var threadQuestions: [MobileQuestionCard] {
        // Suppress a question from the TOP banner when its asking row is loaded
        // inline in the transcript (the inline card is now its home). Keep the
        // banner as a fallback for scrolled-off history or older-Mac rows that
        // don't carry the inline field.
        // INVARIANT: the asking row (role=system / kind=attention) always reaches
        // ThreadRowView — the visibleRows live-run filter only drops assistant/tool
        // rows — so "suppressed here" always pairs with "rendered inline". Preserve
        // that coupling if you ever change which rows are filtered from the list,
        // or a question could end up shown in NEITHER place.
        let inlinePromptIds = Set(
            (snapshot?.rows ?? [])
                .compactMap { $0.agentQuestion?.promptId })
        let keys = Set(resolvedThreadKeys)
        return model.questions.filter {
            ($0.threadId.map(keys.contains) ?? false)
                && !($0.resolvedId.map(inlinePromptIds.contains) ?? false)
        }
    }

    /// Pending approvals/questions pinned to the TOP OF THE SCREEN (safe-area
    /// inset above the transcript scroll). They used to be a List section that
    /// scrolled away with history — users had no idea an approval was waiting
    /// until they happened to scroll up. Hugs content height; past ~340pt the
    /// banner itself scrolls so a pile-up can't bury the transcript.
    @ViewBuilder
    private var attentionBanner: some View {
        if !threadApprovals.isEmpty || !threadQuestions.isEmpty {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if !threadApprovals.isEmpty {
                        Label("Needs your approval", systemImage: "exclamationmark.shield")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(TWTheme.statusAttention)
                        ForEach(threadApprovals, id: \.toolCallId) { approval in
                            ApprovalRow(model: model, card: approval)
                        }
                    }
                    if !threadQuestions.isEmpty {
                        Label("Questions", systemImage: "questionmark.bubble")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(TWTheme.chroma1)
                        ForEach(threadQuestions, id: \.stableId) { question in
                            QuestionRow(model: model, card: question)
                        }
                    }
                }
                .padding(12)
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxHeight: 340)
            .background(
                RoundedRectangle(cornerRadius: 14)
                    .fill(TWTheme.surface2)
                    .overlay(
                        RoundedRectangle(cornerRadius: 14)
                            .strokeBorder(TWTheme.statusAttention.opacity(0.35))
                    )
            )
            .padding(.horizontal, 10)
            .padding(.top, 4)
            .padding(.bottom, 6)
            .background(TWTheme.appBg.opacity(0.94))
            .transition(ComposerMotion.cardPresence(reduceMotion: reduceMotion))
        }
    }

    /// Transient action feedback (acks / errors / success) pinned to the TOP of
    /// the screen alongside the approvals banner. It previously sat above the
    /// composer, where it was easy to miss and crowded the input; all transient
    /// banners now live at the top. Glass + rim styling lives in StatusBanner /
    /// TWBannerGlassBackground.
    @ViewBuilder
    private var topActionBanner: some View {
        if let message = model.lastActionMessage, message != "Sent.", !model.isDemo {
            StatusBanner(message: message) {
                model.clearActionMessage()
            }
        }
    }

    private func listCore(proxy: ScrollViewProxy) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 4) {
                if earlierCount > 0 {
                    Button {
                        model.requestPreviousThreadRows(taskId)
                    } label: {
                        Label(
                            model.loadingPreviousThreadRows.contains(taskId)
                                ? "Loading previous messages..."
                                : "\(earlierCount) previous messages on your Mac",
                            systemImage: "chevron.up")
                    }
                        .buttonStyle(.plain)
                        .disabled(model.loadingPreviousThreadRows.contains(taskId))
                        .font(.caption)
                        .foregroundStyle(TWTheme.textTertiary)
                        .listRowBackground(Color.clear)
                }
                // P3: read-only "Canvas open" card for this chat's live web previews.
                if let canvases = card?.canvasPreviews, !canvases.isEmpty {
                    CanvasPreviewCard(model: model, threadId: taskId, previews: canvases)
                        .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }
                ForEach(settledDisplayItemsBeforeLive) { item in
                    settledDisplayItemView(item)
                        .listRowInsets(EdgeInsets(top: 2, leading: 12, bottom: 2, trailing: 12))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .animation(
                            ComposerMotion.inlineAnimation(reduceMotion: reduceMotion),
                            value: settledFoldMotionSignature)
                    // Desktop parity: each run's Task-complete card follows
                    // its final transcript row, persisting in the thread.
                    if showsRunCompleteSummary, let runCard = runCardSummary(after: item.lastRow) {
                        // Legacy diff lane keyed to ITS OWN run — a stale
                        // envelope from an older run must not decorate a
                        // newer no-edit card. run.fileChanges (per-run, in
                        // the snapshot) is the primary source either way.
                        TaskCompleteCard(
                            run: runCard,
                            diff: diffSummary?.runId == runCard.runId ? diffSummary : nil,
                            runSummaries: runSummaries,
                            participants: transcriptParticipants
                        )
                        .listRowInsets(
                            EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                    }
                }
                if liveRunId != nil, !liveElements.isEmpty {
                    StreamingLiveHeader(
                        provider: liveProvider,
                        model: liveModel,
                        role: liveRole,
                        agentIdentity: threadAgentIdentity)
                        .listRowInsets(EdgeInsets(top: 2, leading: 12, bottom: 2, trailing: 12))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                    ForEach(liveDisplayElements, id: \.id) { element in
                        liveDisplayElementRow(element, proxy: proxy)
                        .listRowInsets(EdgeInsets(top: 2, leading: 12, bottom: 2, trailing: 12))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                    }
                    // Tail anchor — keeps a "still working" mark pinned below the
                    // last tool/segment row while the run is live (tool bursts
                    // otherwise read as idle). Thinking-only runs use ThinkingRow.
                    if isRunning {
                        LiveActivityAnchor(accent: liveAccent)
                        // Stable identity so the lazy stack keeps ONE instance
                        // (preserving @State + the repeatForever pulse) as the live
                        // ForEach above it rebuilds each token — otherwise .onAppear
                        // re-fires and the pulse hitches.
                        .id("live-activity-anchor")
                        .listRowInsets(EdgeInsets(top: 2, leading: 12, bottom: 2, trailing: 12))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                    }
                    ForEach(settledDisplayItemsAfterLive) { item in
                        settledDisplayItemView(item)
                            .listRowInsets(EdgeInsets(top: 2, leading: 12, bottom: 2, trailing: 12))
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                            .animation(
                                ComposerMotion.inlineAnimation(reduceMotion: reduceMotion),
                                value: settledFoldMotionSignature)
                        if showsRunCompleteSummary, let runCard = runCardSummary(after: item.lastRow) {
                            TaskCompleteCard(
                                run: runCard,
                                diff: diffSummary?.runId == runCard.runId ? diffSummary : nil,
                                runSummaries: runSummaries,
                                participants: transcriptParticipants
                            )
                            .listRowInsets(
                                EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                        }
                    }
                } else if isRunning {
                    ThinkingRow(
                        provider: thinkingProvider,
                        model: thinkingModel,
                        role: thinkingRole,
                        agentIdentity: threadAgentIdentity)
                        .listRowInsets(EdgeInsets(top: 2, leading: 12, bottom: 2, trailing: 12))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }
                if showsEmptyWelcomeCanvas, let card {
                    ThreadEmptyWelcomeCanvas(model: model, card: card, draft: $followUp)
                        .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 12))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                } else if (snapshot?.rows ?? []).isEmpty, card != nil {
                    if snapshot == nil || (snapshot?.totalRows ?? 0) > 0 {
                        // History exists on the Mac — the window just hasn't
                        // arrived. A welcome card here masquerades an old
                        // chat as new; show the fetch state instead.
                        HStack(spacing: 8) {
                            StreamingDots(color: TWTheme.chroma1)
                            Text("Loading transcript from your Mac…")
                                .font(.footnote)
                                .foregroundStyle(TWTheme.textSecondary)
                        }
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .padding(.vertical, 10)
                    }
                } else if (snapshot?.rows ?? []).isEmpty {
                    Text("No transcript yet.").foregroundStyle(TWTheme.textSecondary)
                        .listRowBackground(Color.clear)
                }
                if showsRunCompleteSummary, let run = unanchoredRunCardSummary {
                    TaskCompleteCard(
                        run: run,
                        diff: diffSummary?.runId == run.runId ? diffSummary : nil,
                        runSummaries: runSummaries,
                        participants: transcriptParticipants
                    )
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                }
                // Queued messages — transcript-tail bubbles (Claude-app style).
                // Replaces the cramped composer above-row stacks: each pending
                // prompt reads as a dimmed dashed user bubble with a 3-dots
                // menu (Steer now / Add to Blackboard / Edit / Remove). The
                // queue itself stays Mac-owned — every action is a bridge op.
                // Must stay ABOVE the transcript-bottom sentinel so the
                // follow-pin's at-bottom detection includes the queued tail.
                if let card {
                    if card.isEnsemble {
                        ForEach(ensembleState?.queuedPrompts ?? []) { prompt in
                            QueuedMessageBubbleRow(
                                position: prompt.index + 1,
                                text: prompt.text,
                                scheduledRunAt: nil,
                                onSteer: {
                                    model.ensembleQueueItem(
                                        card, index: prompt.index, text: prompt.text,
                                        op: "steerNow")
                                },
                                onBlackboard: {
                                    model.ensembleQueueItem(
                                        card, index: prompt.index, text: prompt.text,
                                        op: "blackboard")
                                },
                                onEdit: {
                                    followUp = prompt.text
                                    model.ensembleQueueItem(
                                        card, index: prompt.index, text: prompt.text,
                                        op: "remove")
                                },
                                onRemove: {
                                    model.ensembleQueueItem(
                                        card, index: prompt.index, text: prompt.text,
                                        op: "remove")
                                }
                            )
                            .listRowInsets(EdgeInsets(top: 2, leading: 12, bottom: 2, trailing: 12))
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                            .animation(
                                ComposerMotion.inlineAnimation(reduceMotion: reduceMotion),
                                value: prompt.id)
                        }
                    } else {
                        ForEach(
                            Array((card.queuedComposerPrompts ?? []).enumerated()),
                            id: \.element.id
                        ) { pair in
                            QueuedMessageBubbleRow(
                                position: pair.offset + 1,
                                text: pair.element.text,
                                scheduledRunAt: pair.element.scheduledRunAt,
                                onSteer: {
                                    model.composerQueueItem(card, item: pair.element, op: "steerNow")
                                },
                                onBlackboard: nil,
                                onEdit: {
                                    followUp = pair.element.text
                                    model.composerQueueItem(card, item: pair.element, op: "remove")
                                },
                                onRemove: {
                                    model.composerQueueItem(card, item: pair.element, op: "remove")
                                }
                            )
                            .listRowInsets(EdgeInsets(top: 2, leading: 12, bottom: 2, trailing: 12))
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                            .animation(
                                ComposerMotion.inlineAnimation(reduceMotion: reduceMotion),
                                value: pair.element.id)
                        }
                    }
                }
                Color.clear
                    .frame(height: 1)
                    .id("transcript-bottom")
                    // The pill's single source of truth: visible ⇒ we're at the
                    // latest message (hide pill, keep following); off-screen ⇒
                    // the user scrolled up (show pill, stop following). Driving
                    // both edges from the sentinel makes the flag self-correct —
                    // the old drag heuristic set `false` with no way back to
                    // `true` while already at the bottom, so the pill stuck on.
                    .onAppear { autoFollow = true }
                    .onDisappear { autoFollow = false }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: transcriptColumnMaxWidth ?? .infinity, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .background(TWTheme.appBg)
        // Observe-only touch tracker (never claims the gesture on iPhone):
        // stamps `lastUserTouchAt` on every touch-down/move anywhere in the
        // transcript so a forced follow-pin's settle pass can tell a live
        // gesture from stale state. iPad disables this zero-distance recognizer
        // because inside NavigationSplitView it can starve the scroll view pan
        // recognizer and make the transcript immovable.
        .transcriptTouchTracking(
            enabled: TranscriptTouchTrackingPolicy.usesZeroDistanceDragTracker(
                isPadInterface: isPadInterface)
        ) {
            followPin.lastUserTouchAt = Date()
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 4) {
                topActionBanner
                attentionBanner
            }
            .animation(
                ComposerMotion.inlineAnimation(reduceMotion: reduceMotion),
                value: threadApprovals.count + threadQuestions.count
            )
        }
        .overlay(alignment: .bottom) {
            // Jump-to-latest: centered just above the composer shell (the
            // trailing spot sat on top of the roster's + button). Black
            // circle, white arrow, white rim.
            HStack(spacing: 10) {
                if !autoFollow {
                    Button {
                        autoFollow = true
                        withAnimation(.easeOut(duration: 0.25)) {
                            proxy.scrollTo("transcript-bottom", anchor: .bottom)
                        }
                    } label: {
                        floatingTranscriptPill(systemName: "arrow.down")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Jump to latest messages")
                    .transition(ComposerMotion.floatingChipTransition(reduceMotion: reduceMotion))
                }
                #if canImport(UIKit)
                    if keyboardVisible {
                        Button {
                            dismissKeyboard()
                        } label: {
                            floatingTranscriptPill(systemName: "keyboard.chevron.compact.down")
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Dismiss keyboard")
                        .transition(ComposerMotion.floatingChipTransition(reduceMotion: reduceMotion))
                    }
                #endif
            }
            .padding(.bottom, 14)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            // AnyView stage-break: the shell stack (banner + changes rows +
            // roster row + composer + rail) exceeds xcodebuild's stricter
            // type-check budget when inlined into the transcript chain.
            if !showsEmptyWelcomeCanvas {
                AnyView(composerShellStack)
                    .environment(\.composerRimChaseActive, card != nil && isRunning)
            }
        }
    }

    @ViewBuilder
    private func liveDisplayElementRow(_ element: LiveDisplayElement, proxy: ScrollViewProxy)
        -> some View
    {
        switch element {
        case .toolBurst(_, let rows):
            ToolBurstRowView(
                rows: rows.map { model.resolvedRow($0, threadId: taskId) },
                agentIdentity: threadAgentIdentity)
            .equatable()
        case .toolRow(let row):
            ThreadRowView(
                model: model, threadId: taskId,
                row: model.resolvedRow(row, threadId: taskId),
                threadProvider: card?.provider,
                agentIdentity: threadAgentIdentity,
                isExpanding: model.expandingRows.contains(row.id),
                participants: transcriptParticipants,
                isPinned: isMessagePinned(row.id)
            )
            .equatable()
        case .text(_, let content, let isTail):
            StreamingSegmentRow(
                text: content,
                isTail: isTail,
                agentIdentity: threadAgentIdentity,
                participants: transcriptParticipants,
                isComplete: resolvedThreadKeys.contains { model.streamingTerminalThreads.contains($0) },
                onRevealFrame: {
                    requestFollowPin(proxy)
                })
        }
    }

    private func floatingTranscriptPill(systemName: String) -> some View {
        Image(systemName: systemName)
            .toolbarIconPillChrome()
    }

    @ViewBuilder
    private var composerShellStack: some View {
            VStack(spacing: 4) {
                if let card {
                    // T72 — global chats keep the full composer: the Mac
                    // clamps phone-origin turns to plan mode (no file
                    // mutation), and the composer pins its picker to match.
                    let diff = diffSummary
                    let primaryWorkspaceId = card.workspaceId
                    let primaryGitSnapshot = primaryWorkspaceId.flatMap { model.gitSnapshots[$0] }
                    let secondaryGitSnapshot = secondaryWorkspaceId.flatMap {
                        model.gitSnapshots[$0]
                    }
                    let projectedAdditionalRows = additionalWorkspaceRows(for: card).filter {
                        $0.workspaceId != nil
                    }
                    let workspaceBreakdown = diff?.workspaces ?? []
                    let hasWorkspaceBreakdown = workspaceBreakdown.count > 1
                    let changedFileCount = diff?.filesChanged ?? diff?.files?.count ?? 0
                    let hasDiff = changedFileCount > 0
                    let renderedWorkspaceIds = Set(
                        workspaceBreakdown.compactMap {
                            $0.workspaceId ?? model.workspaceId(forPath: $0.workspacePath)
                        })
                    let visibleAdditionalRows = projectedAdditionalRows.filter { row in
                        guard let workspaceId = row.workspaceId else { return false }
                        return workspaceId != primaryWorkspaceId
                            && !renderedWorkspaceIds.contains(workspaceId)
                    }
                    let visibleAdditionalWorkspaceIds = Set(
                        visibleAdditionalRows.compactMap { $0.workspaceId })
                    let hasStandaloneSecondaryWorkspace =
                        secondaryWorkspaceId.map {
                            !renderedWorkspaceIds.contains($0)
                                && !visibleAdditionalWorkspaceIds.contains($0)
                        } ?? false
                    let hasAttachedRows =
                        hasWorkspaceBreakdown || hasDiff || primaryGitSnapshot != nil
                        || !visibleAdditionalRows.isEmpty || hasStandaloneSecondaryWorkspace
                    // Desktop composer-shell parity. MERGED (default + most
                    // shells): attached diff header (rounded top), composer body,
                    // telemetry rail (rounded bottom) in ONE bordered container.
                    // DETACHED (codex/cursor/…): each above-row + the composer
                    // core become their own floating card — gaps, no hairlines,
                    // a per-card shell surface. CS10.
                    let resolved = twResolvedComposerShell(model: model)
                    let detached = resolved.layout.detachedAboveRows
                    // codex: the SECONDARY rows (roster/queued) tuck INTO the core
                    // card; only the changes/PR rows pill out above it (CS11).
                    let tuck = detached && resolved.layout.tucksSecondaryRows
                    // CS12: input-owning shells (claude/gemini/cursor/obsidian/
                    // alabaster) frame ONLY the input; the control row + telemetry
                    // render BARE, so the core card is NOT wrapped and the
                    // input->telemetry divider drops. Transparent shells (satellite/
                    // modular) likewise float their telemetry free.
                    let inputOwnsSurface = resolved.layout.inputOwnsSurface
                    let bareTelemetry =
                        detached && (inputOwnsSurface || resolved.material == .transparent)
                    // CS13 — grok "tucked tabs": the above-rows form ONE inset card the
                    // composer-core overlaps by 10pt (a tab peeking behind). Gated on
                    // above-content (no empty tab). For non-tuck shells every condition
                    // below collapses to its current value → byte-identical layout.
                    // The above rows + telemetry collapse when the composer is not
                    // focused (keyboard down) — a blurred composer is just the
                    // one-line input + model pill + send. Focus is the gate, NOT
                    // composerExpanded (which lingers while a draft/queue exists).
                    let hasAboveContent =
                        composerFocused
                        && (hasAttachedRows || card.isEnsemble
                            || !(card.queuedComposerPrompts ?? []).isEmpty)
                    let tuckedTab = resolved.layout.tuckedAboveTab && hasAboveContent
                    // SHELL PLACEMENT must be focus-INDEPENDENT. The core/outer
                    // `.composerShellIf` below toggle a ViewModifier on/off; because
                    // `composerShellIf` is a @ViewBuilder if/else, flipping it changes
                    // the subtree's structural identity, which tears down + rebuilds the
                    // Composer and RESETS its focus state (the `inputFocused` @State +
                    // the text view's first responder) — so for grok (the only
                    // tuckedAboveTab shell) focus never latched and BOTH the above rows
                    // and the telemetry collapsed. Key placement off the STATIC recipe
                    // flag, not the focus-derived `tuckedTab`. (`tuckedTab` still drives
                    // the focus-gated tab geometry/spacing, which don't change identity.)
                    let tuckedShell = resolved.layout.tuckedAboveTab
                    // Blurred + active changes: the compact diff pill FLOATS above
                    // the composer for EVERY shell. It lives here in the outer
                    // (never-shelled) stack so the TaskWraith Native shell — whose
                    // surface wraps the VStack below — can't nest it inside the
                    // composer's above-section the way it used to. (Detached shells
                    // already floated it; this just makes Native match.)
                    //
                    // Source mirrors ChangesAttachedRow (the focused row): the
                    // working-tree git status is primary, the per-run diffSummary is
                    // the fallback. Gating on `hasDiff` (diffSummary) alone made the
                    // pill appear ONLY after an iOS-initiated run — never for the
                    // workspace's own uncommitted changes (which arrive as a git
                    // snapshot). That's why it only showed in demo (both seeded).
                    if !composerFocused {
                        // Diff pill (when active) + tools pill for Ensemble/Goal/Plan/
                        // Blackboard — the focused telemetry-rail icons hide when the
                        // composer collapses, so this row restores them.
                        HStack(spacing: 8) {
                            Spacer(minLength: 0)
                            CachedComposerDiffPill(
                                model: model,
                                workspaceId: primaryWorkspaceId,
                                fallbackFilesChanged: changedFileCount,
                                fallbackAdditions: diff?.additions ?? 0,
                                fallbackDeletions: diff?.deletions ?? 0,
                                fallbackCommitsAhead: 0,
                                reduceMotion: reduceMotion,
                                compactInline: true,
                                glassNamespace: composerPillGlass,
                                onTap: { openComposerDiffSheet(workspaceId: primaryWorkspaceId) }
                            )
                            ComposerToolsPill(
                                isEnsemble: card.isEnsemble,
                                ensembleToggleVisible: showsComposerEnsembleToggle,
                                ensembleToggleDisabled: isRunning,
                                ensembleToggleTitle: ensembleToggleTitle,
                                activeGoal: card.activeGoal,
                                planLanes: card.todoLanes ?? [],
                                blackboardEntries: snapshot?.blackboardEntries ?? [],
                                onEnsembleToggle: { enabled in
                                    handleComposerEnsembleToggle(
                                        for: card, enabled: enabled,
                                        composerProvider: card.provider)
                                },
                                onGoalUpdate: { op, objective, reason in
                                    model.updateGoal(
                                        card, op: op, objective: objective, reason: reason)
                                },
                                onBlackboardPost: card.isEnsemble
                                    ? { value, category, scope in
                                        model.postBlackboardEntry(
                                            card, value: value, category: category, scope: scope)
                                    }
                                    : nil,
                                glassNamespace: composerPillGlass
                            )
                            Spacer(minLength: 0)
                        }
                        // One Liquid Glass system, not two adjacent blurs: the
                        // chips' edges gel when they sit close and separate as
                        // they move apart. Independent `glassEffect`s can't do
                        // that however carefully they're styled.
                        .composerPillGlassRow()
                        .padding(.horizontal, 10)
                        .padding(.bottom, 2)
                        .transition(ComposerMotion.compactPillTransition(reduceMotion: reduceMotion))
                    }
                    VStack(spacing: tuckedTab ? -10 : (detached ? 6 : 0)) {
                        // Above-rows group: inner VStack spacing matches the outer so
                        // non-tuck stays identical; the grok tuck makes it the inset,
                        // overlapped tab card. INVARIANT (keep both true or this wrapper
                        // shifts non-tuck layout): the inner spacing MUST equal the outer
                        // (always an explicit 0/6, never adaptive), and every above-row
                        // must be full-width (else the inner VStack's .center re-centers).
                        // The whole above-rows group collapses with the keyboard
                        // (gated on focus); see hasAboveContent.
                        if composerFocused {
                        VStack(spacing: detached ? 6 : 0) {
                        if hasWorkspaceBreakdown {
                            // One attached row per granted workspace
                            // (primary + secondary), desktop-style.
                            ForEach(workspaceBreakdown) { workspace in
                                let workspaceId =
                                    workspace.workspaceId
                                    ?? model.workspaceId(forPath: workspace.workspacePath)
                                WorkspaceChangesAttachedRow(
                                    breakdown: workspace,
                                    workspaceName: model.workspaceName(for: workspaceId),
                                    gitSnapshot: workspaceId.flatMap {
                                        model.gitSnapshots[$0]
                                    },
                                    canWrite: model.workspaceCanEditFiles(workspaceId),
                                    onRemove: workspaceId == secondaryWorkspaceId
                                        ? { secondaryWorkspaceBinding.wrappedValue = nil } : nil
                                ) { openComposerDiffSheet(workspaceId: workspaceId) }
                                .composerShellIf(detached, resolved)
                                if !detached {
                                    Rectangle().fill(TWTheme.border).frame(height: 1)
                                }
                            }
                        } else if hasDiff || primaryGitSnapshot != nil {
                            ChangesAttachedRow(
                                diff: diff,
                                workspaceName: model.workspaceName(for: primaryWorkspaceId),
                                gitSnapshot: primaryGitSnapshot
                            ) { openComposerDiffSheet(workspaceId: primaryWorkspaceId) }
                            .composerShellIf(detached, resolved)
                            if !detached {
                                Rectangle().fill(TWTheme.border).frame(height: 1)
                            }
                        }
                        ForEach(visibleAdditionalRows) { row in
                            WorkspaceChangesAttachedRow(
                                breakdown: nil,
                                workspaceName: row.displayName,
                                gitSnapshot: row.workspaceId.flatMap { model.gitSnapshots[$0] },
                                canWrite: row.showsWriteAccess,
                                onRemove: nil
                            ) { openComposerDiffSheet(workspaceId: row.workspaceId) }
                            .composerShellIf(detached, resolved)
                            if !detached {
                                Rectangle().fill(TWTheme.border).frame(height: 1)
                            }
                        }
                        if hasStandaloneSecondaryWorkspace, let secondaryWorkspaceId {
                            WorkspaceChangesAttachedRow(
                                breakdown: nil,
                                workspaceName: model.workspaceName(for: secondaryWorkspaceId),
                                gitSnapshot: secondaryGitSnapshot,
                                canWrite: model.workspaceCanEditFiles(secondaryWorkspaceId),
                                onRemove: { secondaryWorkspaceBinding.wrappedValue = nil }
                            ) { openComposerDiffSheet(workspaceId: secondaryWorkspaceId) }
                            .composerShellIf(detached, resolved)
                            if !detached {
                                Rectangle().fill(TWTheme.border).frame(height: 1)
                            }
                        }
                        // Secondary rows (queued + roster). Detached shells float
                        // them as their own cards above the composer; codex (tuck)
                        // re-homes them into the core card below — so render them
                        // as siblings here only when NOT tucking.
                        if !tuck {
                            composerSecondaryRows(
                                card: card, hasAttachedRows: hasAttachedRows,
                                onOwnCards: detached,
                                suppressFill: detached && resolved.material != .transparent,
                                resolved: resolved)
                        }
                        }  // end above-rows group (CS13 grok tuck card)
                        // Desktop tab carries padding-top 6 / padding-bottom 14 so the
                        // -10 overlap eclipses PADDING, not the last row's content. The
                        // top/bottom padding is INSIDE the shell (the fill extends under
                        // it); the horizontal inset is OUTSIDE (it is the tab's margin).
                        .padding(.top, tuckedTab ? 6 : 0)
                        .padding(.bottom, tuckedTab ? 14 : 0)
                        .composerShellIf(tuckedTab, resolved, topCornersOnly: true)
                        .padding(.horizontal, tuckedTab ? 18 : 0)
                        // Explicit zIndex: the core below carries .zIndex(tuckedTab ? 1 : 0),
                        // and a conditionally-inserted sibling with an IMPLICIT zIndex
                        // renders behind an explicit-zIndex sibling on insertion — which
                        // ate grok's tucked tab when it returned on focus. Make it explicit.
                        .zIndex(0)
                        // Spring the whole above-rows card group up from behind
                        // the composer on focus; opacity-only on blur so a
                        // dropping keyboard never yanks rows down through the
                        // input. Applied to the (already-shelled) group, not its
                        // children — the shell mask would clip an inner slide.
                        .transition(ComposerMotion.aboveRowsTransition(reduceMotion: reduceMotion))
                        }  // end focus-gated above-rows group
                        // (the blurred diff pill now floats above the shell — see
                        // the outer stack above)
                        // Composer core (input + telemetry rail). In detached
                        // mode this is its OWN card under the floating above-rows;
                        // merged mode keeps it as the final segments of the one
                        // shared surface (nested zero-spacing VStack is layout-
                        // identical to the old inline siblings). CS12: bare-footer
                        // shells gap the input bubble from the bare telemetry rail.
                        VStack(spacing: bareTelemetry ? 6 : 0) {
                            // codex tucks the roster/queued rows INTO this core
                            // card (above the input), as merged segments.
                            if tuck && composerFocused {
                                composerSecondaryRows(
                                    card: card, hasAttachedRows: hasAttachedRows,
                                    onOwnCards: false, suppressFill: true,
                                    resolved: resolved)
                                // These tuck INSIDE the masked core card, so fade
                                // only — a slide would clip against the shell mask.
                                .transition(.opacity)
                            }
                            Composer(
                                model: model, card: card, runModel: snapshot?.runSummary?.model,
                                runStatus: snapshot?.runSummary?.status,
                                attachedTop: (detached || tuckedTab)
                                    ? false
                                    : hasAboveContent,
                                // Idle (rail hidden) rounds the composer's bottom;
                                // focused (rail present) flattens it to fuse the rail.
                                attachedBottom: composerFocused,
                                extraWorkspaceIds: extraWorkspaceIdsForSend(card: card),
                                allowsProviderChange: allowsIdleProviderChange,
                                onFocusChange: { focused in
                                    // Drive the focus-gated row transitions with a
                                    // damped spring (flat fade under Reduce Motion).
                                    // Follow-pin scrolls disable animation via their
                                    // own Transaction, so this never animates scroll.
                                    withAnimation(
                                        ComposerMotion.focusAnimation(reduceMotion: reduceMotion)
                                    ) {
                                        composerFocused = focused
                                    }
                                },
                                // Every chat (incl. ensemble) collapses to one line
                                // when the keyboard drops. Above rows and telemetry
                                // follow focus, not draft/queue presence.
                                forcesExpanded: false,
                                text: $followUp)
                            if composerFocused {
                                Group {
                                    if !bareTelemetry {
                                        Rectangle().fill(TWTheme.border).frame(height: 1)
                                    }
                                    TelemetryFooterRail(
                                        run: snapshot?.runSummary,
                                        conversationCostText: snapshot?.conversationCostText,
                                        workspaceName: model.workspaceName(for: card.workspaceId),
                                        workspaceOptions: model.workspaces.map {
                                            (id: $0.id, name: $0.displayName)
                                        },
                                        primaryWorkspaceId: card.workspaceId,
                                        secondaryWorkspaceId: secondaryWorkspaceBinding,
                                        ensembleToggleEnabled: card.isEnsemble,
                                        ensembleToggleVisible: showsComposerEnsembleToggle,
                                        ensembleToggleDisabled: isRunning,
                                        ensembleToggleTitle: ensembleToggleTitle,
                                        onEnsembleToggle: { enabled in
                                            handleComposerEnsembleToggle(
                                                for: card, enabled: enabled,
                                                composerProvider: card.provider)
                                        },
                                        activeGoal: card.activeGoal,
                                        onGoalUpdate: { op, objective, reason in
                                            model.updateGoal(
                                                card, op: op, objective: objective, reason: reason)
                                        },
                                        planLanes: card.todoLanes ?? [])
                                }
                                .transition(ComposerMotion.telemetryTransition(reduceMotion: reduceMotion))
                            }
                        }
                        .composerShellIf((detached && !inputOwnsSurface) || tuckedShell, resolved)
                        .zIndex(tuckedShell ? 1 : 0)
                    }
                    .composerShellIf(!detached && !tuckedShell, resolved)
                    .task(id: composerGitWorkspaceIds(card: card).joined(separator: "\n")) {
                        for workspaceId in composerGitWorkspaceIds(card: card) {
                            await model.refreshGitSnapshotCache(workspaceId: workspaceId)
                        }
                    }
                    // Event-driven git refreshes live HERE — focus-independent —
                    // not inside the compact pill, which is mounted only while
                    // the composer is blurred: a run finishing with the composer
                    // focused must still refresh the changes rows. The quiet
                    // variant lands results in the shared `gitSnapshots` cache
                    // both surfaces render from, without Mac-side rebroadcast,
                    // and never wipes the cache on a dropped ack.
                    .onChange(of: isRunning) { wasRunning, running in
                        guard wasRunning, !running else { return }
                        refreshComposerGitSnapshotsQuietly(card: card)
                    }
                    .onChange(of: scenePhase) { _, phase in
                        guard phase == .active else { return }
                        refreshComposerGitSnapshotsQuietly(card: card)
                    }
                    .onChange(of: diffPillRefreshGeneration) { _, _ in
                        refreshComposerGitSnapshotsQuietly(card: card)
                    }
                    .padding(.horizontal, 10).padding(.bottom, 6)
                }
            }
            .background(Color.clear)
    }

    /// The roster + queued "secondary" above-rows. `onOwnCards` drives the per-row
    /// .composerShell wrap + hairline (detached sibling cards vs merged segments).
    /// `suppressFill` (CS12d) INDEPENDENTLY clears the row's own opaque fill — true
    /// when a SOLID surface backs it (a detached-solid card, or the codex solid
    /// core), false for transparent shells (keep surface1 under Reduce Transparency)
    /// and merged-default segments.
    @ViewBuilder
    private func composerSecondaryRows(
        card: RemoteTaskCard, hasAttachedRows: Bool, onOwnCards: Bool,
        suppressFill: Bool, resolved: ResolvedComposerShell
    ) -> some View {
        // Queued prompts no longer render here — they read as dashed
        // transcript-tail bubbles with a per-row 3-dots menu (see
        // QueuedMessageBubbleRow in the transcript List). The side-chat
        // mini composer keeps its compact stack; the round HUD keeps the
        // QueuedPromptsChip count pill.
        if card.isEnsemble, let wsId = card.workspaceId {
            // Roster row lives IN the shell, under the changes row(s).
            EditableRosterStrip(
                model: model, threadId: taskId, workspaceId: wsId,
                attached: true,
                isShellTop: !hasAttachedRows,
                onOwnCard: suppressFill)
            .composerShellIf(onOwnCards, resolved)
            if !onOwnCards {
                Rectangle().fill(TWTheme.border).frame(height: 1)
            }
        }
    }

    private func refreshComposerGitSnapshotsQuietly(card: RemoteTaskCard) {
        let workspaceIds = composerGitWorkspaceIds(card: card)
        guard !workspaceIds.isEmpty else { return }
        Task {
            for workspaceId in workspaceIds {
                await model.refreshGitSnapshotCacheQuietly(workspaceId: workspaceId)
            }
        }
    }

    private func openComposerDiffSheet(workspaceId: String?) {
        diffPillRefreshGeneration += 1
        let resolvedWorkspaceId = workspaceId ?? model.diffReviewableWorkspaces.first?.id
        guard model.workspaceCanReviewDiffs(resolvedWorkspaceId) else {
            model.inspectorPresented = true
            return
        }
        #if canImport(UIKit)
            dismissKeyboard()
        #endif
        composerDiffSheetState.activate(model: model, preferredWorkspaceId: resolvedWorkspaceId)
        composerDiffSheetPresented = true
    }

    private func openComposerDiff(workspaceId: String?) {
        if model.workspaceCanReviewDiffs(workspaceId) {
            model.requestDiffMode(workspaceId: workspaceId)
        } else {
            model.inspectorPresented = true
        }
    }

    private var threadHeaderTitle: String {
        let title = (card?.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? "Chat" : title
    }

    private var threadHeaderSubtitle: String? {
        var parts: [String] = []
        if let workspaceName = model.workspaceName(for: card?.workspaceId)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !workspaceName.isEmpty
        {
            parts.append(workspaceName)
        }
        let hostName = model.macDisplayName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !hostName.isEmpty {
            parts.append(hostName)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " • ")
    }

    private func navigationChrome(_ base: AnyView, proxy: ScrollViewProxy) -> some View {
        base
        .navigationTitle(threadHeaderTitle)
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .task(id: taskId) {
            // On-demand transcript window — chats outside the recent-N
            // periodic snapshot have no rows until we ask. Also drop any
            // stale ack banner from the previously-open thread.
            model.clearActionMessage()
            model.visibleThreadId = taskId
            requestSnapshotIfNeeded()
            autoFollow = true
            try? await Task.sleep(nanoseconds: 350_000_000)
            requestFollowPin(proxy, force: true)
        }
        .task(id: snapshotRequestTrigger) {
            requestSnapshotIfNeeded()
        }
        .onDisappear {
            if model.visibleThreadId == taskId { model.visibleThreadId = nil }
        }
    }

    private func followChrome(_ base: AnyView, proxy: ScrollViewProxy) -> some View {
        base
        .onChange(of: snapshot?.rows?.count ?? 0) { _, _ in
            // `autoFollow` here reflects intent BEFORE this layout commits; if we
            // were following, force the re-pin so a transient sentinel flip
            // during a big (cellular-batched) update can't permanently stop it.
            guard autoFollow else { return }
            requestFollowPin(proxy, force: true)
        }
        .onChange(of: threadValue(model.streamingTexts) ?? "") { _, _ in
            guard autoFollow else { return }
            requestFollowPin(proxy, force: true)
        }
    }

    /// The single follow-pin path. Every streaming trigger — the pump's reveal
    /// frame (~24fps), each wire token batch, a new row, an ensemble participant
    /// switch — routes here, and they COALESCE to one scroll per runloop turn.
    /// The transcript uses ScrollView/LazyVStack rather than List so follow-pin
    /// scrolls never resolve through UICollectionView index paths while rows are
    /// being committed.
    ///
    /// The scroll is still deferred a main-runloop turn so the bottom sentinel
    /// has been materialized before we target it. `force` re-pins through a
    /// transient sentinel flip during a big update so following can't get stuck.
    private func requestFollowPin(_ proxy: ScrollViewProxy, force: Bool = false) {
        guard force || autoFollow else { return }
        // Throttle NON-forced pins (chiefly the ~24fps reveal pump's
        // onRevealFrame) to ~10fps. Continuous scrolling during a stream burned
        // CPU and — landing a scroll between a tap's touch-down and touch-up —
        // cancelled the "Show more" tap as a drag. Forced pins (new row, new
        // token batch via onChange(streamingTexts), agent-exit, thread open)
        // always fire, so the bottom is still reached exactly at every real
        // content change; the reveal pins only fill in between those.
        let now = Date()
        if !force, now.timeIntervalSince(followPin.lastPinAt) < 0.1 { return }
        followPin.lastPinAt = now
        guard !followPin.scheduled else { return }
        followPin.scheduled = true
        Task { @MainActor in
            // `defer` guarantees the coalescer re-arms no matter how the closure
            // exits, so the flag can never stick and wedge follow off.
            defer { followPin.scheduled = false }
            // Defer to the NEXT main-runloop iteration — NOT `Task.yield()`,
            // which is a cooperative suspension that can resume before SwiftUI
            // has materialized the new sentinel row for this update.
            await awaitNextMainRunloop()
            guard TranscriptFollowPolicy.shouldScroll(
                autoFollow: autoFollow,
                force: force,
                lastUserTouchAt: followPin.lastUserTouchAt
            ) else { return }
            scrollSentinelToBottomNow(proxy)
            // Settle pass: a big layout (long message / a new participant's
            // block) can land the first scroll a hair short — re-pin a runloop
            // later, again after the layout has committed. Re-check the same
            // policy so a touch that begins between passes suppresses this
            // correction too. `force` means "don't trust a possibly-stale
            // `autoFollow`", not "override the user's finger."
            await awaitNextMainRunloop()
            guard TranscriptFollowPolicy.shouldScroll(
                autoFollow: autoFollow,
                force: force,
                lastUserTouchAt: followPin.lastUserTouchAt
            ) else { return }
            scrollSentinelToBottomNow(proxy)
        }
    }

    /// Suspend until the next main-runloop iteration, after the current SwiftUI
    /// update has flushed. Used instead of `Task.yield()` so a follow-pin scroll
    /// targets the current bottom sentinel.
    @MainActor
    private func awaitNextMainRunloop() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.main.async { continuation.resume() }
        }
    }

    private func scrollSentinelToBottomNow(_ proxy: ScrollViewProxy) {
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            proxy.scrollTo("transcript-bottom", anchor: .bottom)
        }
    }

    private func keyboardChrome(_ base: AnyView) -> some View {
        #if canImport(UIKit)
            base
                // Arm the app-lifetime keyboard tracker here, from a view that
                // exists BEFORE the keyboard first rises. Popover panels clamp
                // their height against it; if its first touch were the popover
                // itself it would have missed the keyboard going up and report
                // zero. See TWKeyboardTracker.start().
                .onAppear { TWKeyboardTracker.shared.start() }
                .onReceive(NotificationCenter.default.publisher(
                    for: UIResponder.keyboardWillShowNotification
                )) { _ in keyboardVisible = true }
                .onReceive(NotificationCenter.default.publisher(
                    for: UIResponder.keyboardWillHideNotification
                )) { _ in keyboardVisible = false }
        #else
            base
        #endif
    }

    #if canImport(UIKit)
        private func dismissKeyboard() {
            UIApplication.shared.sendAction(
                #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        }
    #endif

    private func toolbarChrome(_ base: AnyView) -> some View {
        base
        .toolbar {
            #if os(iOS)
                ToolbarItem(placement: .principal) {
                    Button {
                        renameSheetContext = ThreadRenameSheetContext(
                            id: taskId,
                            title: threadHeaderTitle,
                            subtitle: threadHeaderSubtitle)
                    } label: {
                        TWPrincipalTitle(
                            title: threadHeaderTitle, subtitle: threadHeaderSubtitle)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(threadHeaderTitle)
                    .accessibilityValue(threadHeaderSubtitle ?? "")
                    .accessibilityHint("Opens rename sheet.")
                }
            #endif
            // Individual circular pills (matching the workspaces sidebar), NOT a
            // shared ToolbarIconPillGroup capsule — one consistent toolbar look
            // app-wide, and individual ToolbarItems overflow gracefully where a
            // rigid group would clip (see HomeListViews).
            if let workspaceId = filesToolbarWorkspaceId {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        model.requestFilesMode(workspaceId: workspaceId)
                    } label: {
                        ToolbarIconPillLabel("Files", systemImage: "folder")
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut("1", modifiers: [.command])
                    .accessibilityLabel("Open Files mode")
                    .accessibilityHint("Opens the workspace file browser and editor.")
                }
            }
            if let workspaceId = diffsToolbarWorkspaceId {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        model.requestDiffMode(workspaceId: workspaceId)
                    } label: {
                        ToolbarIconPillLabel("Diffs", systemImage: "plus.forwardslash.minus")
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut("2", modifiers: [.command])
                    .accessibilityLabel("Open Diff Studio")
                    .accessibilityHint("Opens the read-only workspace diff review.")
                }
            }
            // Roster — dedicated ensemble-only page (supersedes the cramped
            // per-chip editor). Only meaningful for ensemble chats.
            if showsRosterToolbarButton {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        model.rosterPresented = true
                    } label: {
                        ToolbarIconPillLabel("Roster", usesEnsembleGlyph: true)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Open Roster")
                    .accessibilityHint("Opens the ensemble participant roster.")
                }
            }
            // T2 — full-transcript export. The markdown comes from the Mac's
            // existing builder (desktop-identical bytes, paths scrubbed); a
            // local build over the 24-row snapshot window would silently
            // truncate (ios-t2-transcript-wire-ruling). Failure copy rides
            // the ack banner verbatim. Individual pill (landmine ④).
            // Use a Button (not a one-item Menu) so toolbar chrome matches
            // Files / Diffs / Inspector — Menu labels can drop the circular
            // pill treatment in the glass nav bar.
            if let card {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        model.fetchChatMarkdownTranscript(card) { transcript in
                            guard let transcript else { return }
                            #if canImport(UIKit)
                                UIPasteboard.general.string = transcript.markdown
                            #endif
                            // Ack banner copy ("Transcript copied.") is posted
                            // by the model's successLabel — the setter is
                            // private(set) out here by design.
                        }
                    } label: {
                        ToolbarIconPillLabel(
                            "Transcript", systemImage: "square.and.arrow.up.on.square")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Copy transcript")
                    .accessibilityHint("Copies the full chat transcript as Markdown.")
                }
            }
            ToolbarItem(placement: .primaryAction) {
                Button {
                    model.inspectorPresented.toggle()
                } label: {
                    ToolbarIconPillLabel(
                        "Inspector",
                        systemImage: "sidebar.right",
                        isActive: model.inspectorPresented
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open Inspector")
                .accessibilityHint("Opens the thread inspector sidebar.")
            }
        }
        .sheet(isPresented: Binding(get: { model.rosterPresented }, set: { model.rosterPresented = $0 })) {
            if let wsId = card?.workspaceId {
                EnsembleRosterSheet(model: model, threadId: taskId, workspaceId: wsId)
                    .twSheetLiquidGlass(detents: [.large])
            }
        }
        .sheet(item: $renameSheetContext) { context in
            ThreadRenameSheet(
                currentTitle: context.title,
                subtitle: context.subtitle
            ) { title in
                if let card {
                    model.renameThread(card, title: title)
                }
            }
            .twSheetLiquidGlass(detents: [.medium])
        }
        .sheet(isPresented: $composerDiffSheetPresented) {
            NavigationStack {
                DiffStudioCompactView(
                    model: model,
                    state: composerDiffSheetState,
                    onExpand: {
                        let workspaceId = composerDiffSheetState.selectedWorkspaceId
                        composerDiffSheetPresented = false
                        DispatchQueue.main.async {
                            model.requestDiffMode(workspaceId: workspaceId)
                        }
                    },
                    onOpenSelectedFile: { path in
                        let workspaceId = composerDiffSheetState.selectedWorkspaceId
                        composerDiffSheetPresented = false
                        DispatchQueue.main.async {
                            model.requestFilesMode(workspaceId: workspaceId, targetPath: path)
                        }
                    }
                ) {
                    composerDiffSheetPresented = false
                }
            }
            // Keep Nav host transparent so twSheetLiquidGlass backdrop shows through.
            .background(Color.clear)
            .composerDiffSheetChrome()
        }
        .confirmationDialog(
            "Keep which provider?",
            isPresented: $ensembleDisablePickerPresented,
            titleVisibility: .visible
        ) {
            ForEach(ensembleSoloProviderChoices, id: \.self) { provider in
                Button(TWTheme.providerLabel(provider)) {
                    if let card = ensembleDisableCard {
                        model.setChatKind(
                            card, targetKind: "single", canonicalProvider: provider)
                    }
                    ensembleDisableCard = nil
                    ensembleSoloProviderChoices = []
                }
            }
            Button("Cancel", role: .cancel) {
                ensembleDisableCard = nil
                ensembleSoloProviderChoices = []
            }
        } message: {
            Text("Ensemble will turn off and this chat will continue as a solo thread.")
        }

    }
}

struct ThreadEmptyWelcomeCanvas: View {
    @ObservedObject var model: RemoteSessionModel
    let card: RemoteTaskCard
    @Binding var draft: String
    @State private var draftProvider = ""
    @State private var ensembleDisablePickerPresented = false
    @State private var ensembleSoloProviderChoices: [String] = []
    /// 1.275x the .title3 base (~20pt) for the General-chat greeting heading
    /// only; @ScaledMetric keeps it responsive to the user's Dynamic Type setting.
    @ScaledMetric(relativeTo: .title3) private var globalGreetingFontSize: CGFloat = 25.5
    @Environment(\.horizontalSizeClass) private var hSizeClass
    /// iPhone portrait = compact width; iPad (and landscape regular) = regular.
    private var isCompactWidth: Bool { hSizeClass == .compact }

    private var isGlobal: Bool { card.isGlobalScope }
    private var canSwitchPrimaryWorkspace: Bool { !isGlobal && !model.workspaces.isEmpty }
    private var accent: Color {
        if card.isEnsemble { return TWTheme.providerAccent("ensemble") }
        // General chats now glow with the live provider hue too (was a flat
        // chroma3) so the greeting heading + ghost shadow track the composer
        // provider pill — the same mechanism workspace chats use below.
        // Follow the LIVE composer provider (echoed into `draftProvider` via the
        // composer's `providerEcho`), not the thread's frozen `card.provider`, so
        // the hero glow / title / scope chip / heatmap recolor the instant the
        // user changes provider in the composer — mirroring the composer pill.
        // `currentDraftProvider` falls back to `card.provider` until the first
        // echo lands, so provider-stamped threads never flash.
        return TWTheme.providerAccent(currentDraftProvider)
    }
    private var workspaceName: String {
        model.workspaceName(for: card.workspaceId) ?? "this workspace"
    }
    private var workflowForCard: RemoteWorkflow? {
        model.workflows.first { workflow in
            workflow.threadId == card.id || workflow.threadId == card.threadId
        }
    }
    private var isWorkflowWelcome: Bool { card.isWorkflowDraft || workflowForCard != nil }
    private var draftVariant: String {
        if card.isWorkflowDraft { return "workflow" }
        return card.isEnsemble ? "ensemble" : "workspace"
    }
    private var currentDraftProvider: String? {
        let provider = draftProvider.trimmingCharacters(in: .whitespacesAndNewlines)
        return provider.isEmpty ? card.provider : provider
    }
    private var showsComposerEnsembleToggle: Bool {
        !ChatKindBridge.isLinkedChild(card)
    }
    private var welcomeIsRunning: Bool { card.status == "running" }
    private var ensembleToggleTitle: String {
        if welcomeIsRunning { return "Finish the current turn first to change chat mode." }
        return card.isEnsemble ? "Ensemble on" : "Ensemble off"
    }

    private func handleComposerEnsembleToggle(enabled: Bool) {
        if enabled {
            model.toggleChatKind(
                card, enabled: true,
                composerProvider: currentDraftProvider,
                composerModel: card.customModel ?? card.selectedModelType)
            return
        }
        let providers = model.ensembleToSoloProviders(for: card)
        if providers.count <= 1 {
            model.setChatKind(
                card, targetKind: "single",
                canonicalProvider: providers.first ?? currentDraftProvider ?? card.provider)
            return
        }
        ensembleSoloProviderChoices = providers
        ensembleDisablePickerPresented = true
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                Spacer(minLength: 20)
                dashboardCard
                hero
                scopeChips
                composerBlock
                    .padding(.horizontal, 4)
                // iPhone (compact width) drops the bottom heatmap so the dashboard
                // above the ghost fits without a scroll screen — the dashboard's
                // Workspaces / Providers tabs already cover that activity. iPad keeps it.
                if !isCompactWidth && !isGlobal && !isWorkflowWelcome {
                    activityFooter
                        .padding(.top, 8)
                }
                Spacer(minLength: 24)
            }
            .padding(.horizontal, 18)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
            .frame(minHeight: 560)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .confirmationDialog(
            "Keep which provider?",
            isPresented: $ensembleDisablePickerPresented,
            titleVisibility: .visible
        ) {
            ForEach(ensembleSoloProviderChoices, id: \.self) { provider in
                Button(TWTheme.providerLabel(provider)) {
                    model.setChatKind(card, targetKind: "single", canonicalProvider: provider)
                    ensembleSoloProviderChoices = []
                }
            }
            Button("Cancel", role: .cancel) {
                ensembleSoloProviderChoices = []
            }
        } message: {
            Text("Ensemble will turn off and this chat will continue as a solo thread.")
        }
    }

    private var hero: some View {
        VStack(spacing: 10) {
            if isWorkflowWelcome {
                Image(systemName: "arrow.triangle.branch")
                    .font(.system(size: 38, weight: .semibold))
                    .foregroundStyle(accent)
                    .shadow(color: accent.opacity(0.45), radius: 18)
            } else {
                GhostMonolineMarkView(size: 46)
                    .shadow(color: accent.opacity(0.45), radius: 18)
            }
            Group {
                switch titleParts {
                case .scoped(let prefix, let name):
                    // workspace/ensemble: "New chat for <ws>." — name accent-glows.
                    Text(prefix)
                        .foregroundStyle(TWTheme.textSecondary)
                        + Text(name)
                        .foregroundStyle(accent)
                        .fontWeight(.semibold)
                        + Text(".")
                        .foregroundStyle(TWTheme.textSecondary)
                case .plain(let text):
                    Text(text)
                        .foregroundStyle(TWTheme.textSecondary)
                case .glow(let text):
                    // General greeting: the whole line in the provider accent.
                    Text(text)
                        .foregroundStyle(accent)
                        .fontWeight(.semibold)
                }
            }
            .font(isGlobal ? .system(size: globalGreetingFontSize) : .title3)
            .multilineTextAlignment(.center)
            if !isGlobal {
                Text(blurb)
                    .font(.footnote)
                    .foregroundStyle(TWTheme.textTertiary)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private enum TitleParts {
        case scoped(prefix: String, name: String)
        case plain(String)
        /// Whole-string provider glow (General greeting): the entire line is
        /// rendered in `accent`.
        case glow(String)
    }

    private var titleParts: TitleParts {
        if card.isWorkflowDraft {
            return .scoped(prefix: "New workflow for ", name: workspaceName)
        }
        if let workflow = workflowForCard {
            return .plain(workflow.name ?? "Workflow")
        }
        if card.isEnsemble {
            return .scoped(prefix: "New ensemble for ", name: workspaceName)
        }
        if isGlobal {
            // The WHOLE greeting glows (provider accent): "<greeting>, What's on
            // your mind[ <name>]?" rendered as one accent string (shared twin).
            let greeting = Greeting.build(
                forHour: Calendar.current.component(.hour, from: Date()),
                name: model.projectedUserName)
            return .glow(greeting)
        }
        return .scoped(prefix: "New chat for ", name: workspaceName)
    }

    private var blurb: String {
        if card.isWorkflowDraft {
            return "Describe the recurring task. Your Mac saves it as a workflow instead of starting a one-off run."
        }
        if let workflow = workflowForCard {
            if let schedule = workflow.schedule, !schedule.isEmpty {
                return "\(schedule) — runs will appear here."
            }
            return "Runs from your Mac. Workflow activity will appear here."
        }
        if card.isEnsemble {
            return "Participants take turns on your Mac. Send a prompt to start a round."
        }
        if isGlobal {
            return "Phone turns run in plan mode. Pick a provider and send your first prompt."
        }
        return "The run starts on your Mac and streams back here."
    }

    @ViewBuilder
    private var scopeChips: some View {
        if card.isEnsemble || !isGlobal {
            FlowChips(items: [workspaceName]) { name in
                Text(name)
                    .font(.caption.weight(.medium))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(accent.opacity(0.18), in: Capsule())
                    .overlay(Capsule().strokeBorder(accent.opacity(0.6)))
                    .foregroundStyle(accent)
            }
        }
    }

    private var composerBlock: some View {
        VStack(spacing: 0) {
            if card.isEnsemble, let workspaceId = card.workspaceId {
                EditableRosterStrip(
                    model: model,
                    threadId: card.id,
                    workspaceId: workspaceId,
                    attached: true,
                    isShellTop: true)
                Rectangle().fill(TWTheme.border).frame(height: 1)
            }
            Composer(
                model: model,
                card: card,
                attachedTop: card.isEnsemble,
                attachedBottom: true,
                providerEcho: $draftProvider,
                allowsProviderChange: !card.isEnsemble,
                // Welcome hero stays full (its roster + rail show unconditionally).
                forcesExpanded: true,
                text: $draft)
            Rectangle().fill(TWTheme.border).frame(height: 1)
            TelemetryFooterRail(
                run: nil,
                workspaceName: model.workspaceName(for: card.workspaceId),
                workspaceOptions: model.workspaces.map {
                    (id: $0.id, name: $0.displayName)
                },
                primaryWorkspaceId: card.workspaceId,
                onPrimaryWorkspaceSelect: canSwitchPrimaryWorkspace
                    ? { workspaceId in switchPrimaryWorkspace(to: workspaceId) } : nil,
                ensembleToggleEnabled: card.isEnsemble,
                ensembleToggleVisible: showsComposerEnsembleToggle,
                ensembleToggleDisabled: welcomeIsRunning,
                ensembleToggleTitle: ensembleToggleTitle,
                onEnsembleToggle: handleComposerEnsembleToggle,
                activeGoal: card.activeGoal,
                onGoalUpdate: { op, objective, reason in
                    model.updateGoal(card, op: op, objective: objective, reason: reason)
                },
                planLanes: card.todoLanes ?? [])
        }
        .composerShellUnlessInputOwns(twResolvedComposerShell(model: model, presentation: .welcome))
    }

    private func switchPrimaryWorkspace(to workspaceId: String) {
        let next = workspaceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !next.isEmpty, next != card.workspaceId else { return }
        model.createEmptyThread(
            workspaceId: next,
            variant: draftVariant,
            provider: currentDraftProvider,
            threadId: card.threadId ?? card.id,
            title: card.isWorkflowDraft ? "New Workflow" : (card.title ?? "New Chat"))
    }

    // CS-DASH — the Electron 4-tab welcome stats dashboard, ported to iOS. Sits
    // between the composer and the activity heatmap; the welcome VStack's maxWidth
    // 560 + ScrollView give it dynamic sizing (1-col stats on a phone, 2 on iPad).
    // Slice A renders the fixture; slice C swaps in `model.welcomeDashboard` (live).
    @ViewBuilder private var dashboardCard: some View {
        // Omitted on General chats — the stripped welcome is greeting + composer.
        if !isWorkflowWelcome, !isGlobal, let data = model.welcomeDashboard, data.lifetimeHasActivity {
            WelcomeUsageDashboardCard(dashboard: data, accent: accent)
        }
    }

    private var activityFooter: some View {
        let scopedCards: [RemoteTaskCard]
        if let workspaceId = card.workspaceId, !workspaceId.isEmpty {
            scopedCards = model.taskCards.filter { $0.workspaceId == workspaceId }
        } else {
            scopedCards = model.taskCards.filter { ($0.workspaceId ?? "").isEmpty }
        }
        return RotatingActivityHeatmap(flavors: [
            .init(
                id: "scope",
                title: isGlobal ? "General Activity" : "Workspace Activity",
                caption: isGlobal ? "general chats" : "current workspace",
                accent: accent,
                events: twActivityHeatmapEvents(from: scopedCards)),
            .init(
                id: "taskwraith",
                title: "TaskWraith Activity",
                caption: "all TaskWraith runs",
                accent: TWTheme.chroma1,
                events: twActivityHeatmapEvents(from: model.taskCards)),
        ], rollup: model.usageRollup)
    }
}

/// Satellite transcript row — inline label + body, no bubble chrome.
/// Provider parsed from a speaker label — "Codex · gpt-5.4" / "Gemini /
/// Researcher (2.5 Flash)" → accent color, mirroring the desktop's
/// provider-tinted transcript names.
@MainActor func providerAccentFromSpeaker(_ speaker: String?, fallback: Color) -> Color {
    guard let speaker, !speaker.isEmpty else { return fallback }
    let segments = speaker.split(whereSeparator: { $0 == "·" || $0 == "/" }).map {
        String($0).trimmingCharacters(in: .whitespaces)
    }
    guard let head = segments.first, !head.isEmpty else { return fallback }
    let headLower = head.lowercased()
    let rest = segments.dropFirst().joined(separator: " ")

    // Ollama speakers either carry the spoofed brand name in the head
    // (post brand-aware projection — "Alibaba · …") or the raw model in a
    // later segment ("Ollama · qwen3:4b"). Resolve either to the brand hue.
    if headLower == "ollama" {
        return TWTheme.providerAccent("ollama", modelId: rest, modelLabel: rest)
    }
    if let brand = OllamaDisplayBrands.all.first(where: {
        $0.providerLabel.lowercased() == headLower || $0.providerClass == headLower
    }) {
        return TWTheme.providerAccent(brand.providerClass)
    }
    let known = ["gemini", "codex", "claude", "kimi", "grok", "cursor", "ollama", "qwen", "ornith"]
    guard known.contains(headLower) else { return fallback }
    return TWTheme.providerAccent(headLower)
}

struct ThreadAgentIdentity: Equatable {
    let name: String
    let accentHex: String?
    let slug: String?
    /// When false, render the identity icon monochrome (ignore accent).
    let hueEnabled: Bool

    init?(card: RemoteTaskCard?) {
        guard let card,
            card.isSubThread || card.isGuestSideChat || card.isIsolatedSideChat
                || card.parentChatId != nil
        else { return nil }
        let trimmed = (card.agentName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        name = trimmed
        accentHex = card.agentAccent
        slug = card.agentSlug
        hueEnabled = true  // Sub-agent cards carry no pooled hue toggle — always tint.
    }

    init?(pooled: RemoteThreadSnapshot.Row.PooledAgentIdentity?) {
        let trimmed = (pooled?.nickname ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        name = trimmed
        accentHex = pooled?.accent
        slug = pooled?.slug
        hueEnabled = pooled?.hueEnabled ?? true  // Absent ⇒ tinted (pre-toggle default).
    }

    @MainActor var accent: Color { twAgentAccentColor(accentHex) }
}

/// Transcript-only identity mark: a bare glyph beside the sender name — no circle
/// fill/stroke ("box"), matching the Electron look. Honors `hueEnabled`: baked
/// named art shows its own colour when tinted and desaturates to a neutral wash
/// when hue is off; the procedural ghost inks with the accent (or a neutral tone).
private struct AgentTranscriptSatellite: View {
    let name: String
    let accentHex: String?
    let slug: String?
    let hueEnabled: Bool
    var size: CGFloat = 16

    private var ink: Color {
        hueEnabled ? twAgentAccentColor(accentHex) : TWTheme.textSecondary
    }

    var body: some View {
        Group {
            if let catalog = AgentIdentityBadge.catalogImage(for: slug) {
                catalog
                    .resizable()
                    .scaledToFit()
                    .saturation(hueEnabled ? 1 : 0)
                    .opacity(hueEnabled ? 1 : 0.75)
            } else {
                GhostMarkView(size: size)
                    .colorMultiply(ink)
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel(Text(name))
    }
}

private struct AgentTranscriptLeadingMark: View {
    let identity: ThreadAgentIdentity?
    let fallbackAccent: Color
    let hidden: Bool

    var body: some View {
        Group {
            if hidden {
                Color.clear.frame(width: 20, height: 20)
            } else if let identity {
                AgentTranscriptSatellite(
                    name: identity.name,
                    accentHex: identity.accentHex,
                    slug: identity.slug,
                    hueEnabled: identity.hueEnabled,
                    size: 14
                )
                .padding(.top, 1)
                .frame(width: 20, alignment: .leading)
            } else {
                Circle()
                    .fill(fallbackAccent)
                    .frame(width: 6, height: 6)
                    .padding(.top, 7)
                    .frame(width: 20, alignment: .leading)
            }
        }
    }
}

private extension View {
    @ViewBuilder
    func composerDiffSheetChrome() -> some View {
        #if os(iOS)
            twSheetLiquidGlass()
        #else
            self.frame(minWidth: 520, minHeight: 520)
        #endif
    }
}

struct ParticipantHealthSummaryCard: View {
    let summary: RemoteThreadSnapshot.Row.ParticipantHealth
    /// Roster-ordered participants for chip layout (matches chip strip).
    let rosterParticipants: [RemoteEnsembleState.Participant]

    init(
        summary: RemoteThreadSnapshot.Row.ParticipantHealth,
        rosterParticipants: [RemoteEnsembleState.Participant] = []
    ) {
        self.summary = summary
        self.rosterParticipants = rosterParticipants
    }

    private var entries: [RemoteThreadSnapshot.Row.ParticipantHealth.Entry] {
        let raw = summary.entries ?? []
        guard !rosterParticipants.isEmpty else { return raw }
        let orderIndex = Dictionary(
            uniqueKeysWithValues: rosterParticipants.enumerated().map { ($1.participantId, $0) }
        )
        return raw.sorted { lhs, rhs in
            let lhsId = lhs.participantId ?? ""
            let rhsId = rhs.participantId ?? ""
            let lhsIdx = orderIndex[lhsId] ?? Int.max
            let rhsIdx = orderIndex[rhsId] ?? Int.max
            if lhsIdx != rhsIdx { return lhsIdx < rhsIdx }
            return lhsId < rhsId
        }
    }
    private var okCount: Int {
        summary.okCount ?? entries.filter { $0.status?.lowercased() == "ok" }.count
    }
    private var totalCount: Int {
        max(summary.totalCount ?? entries.count, entries.count)
    }
    private var allReachable: Bool {
        totalCount > 0 && okCount >= totalCount
    }
    private var accent: Color {
        allReachable ? TWTheme.statusColor("success") : TWTheme.statusColor("failed")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: allReachable ? "checkmark.seal.fill" : "exclamationmark.triangle.fill")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(accent)
                    .frame(width: 20, height: 20)
                    .background(accent.opacity(0.14), in: Circle())
                VStack(alignment: .leading, spacing: 1) {
                    Text(allReachable ? "Participants reachable" : "Participant health")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TWTheme.textPrimary)
                    Text("\(okCount)/\(totalCount) ready")
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textTertiary)
                }
                Spacer(minLength: 8)
            }
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 124), spacing: 6, alignment: .leading)],
                alignment: .leading,
                spacing: 6
            ) {
                ForEach(entries) { entry in
                    participantChip(entry)
                }
            }
        }
        .padding(10)
        .background(
            LinearGradient(
                colors: [accent.opacity(0.12), TWTheme.surface1.opacity(0.78)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: 10)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(accent.opacity(allReachable ? 0.38 : 0.62), lineWidth: 1)
        )
    }

    private func participantChip(_ entry: RemoteThreadSnapshot.Row.ParticipantHealth.Entry)
        -> some View
    {
        let status = entry.status?.lowercased()
        let reachable = status == "ok"
        let presentation = participantHealthEntryPresentation(entry)
        let providerAccent = TWTheme.providerAccent(presentation.providerClass)
        let providerName = presentation.providerName
        let chipAccent = reachable ? providerAccent : TWTheme.statusColor("failed")
        let role = entry.role?.isEmpty == false ? entry.role ?? "Participant" : "Participant"
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 5) {
                Circle()
                    .fill(chipAccent)
                    .frame(width: 6, height: 6)
                Text(role)
                    .font(.caption2.weight(.semibold))
                    .lineLimit(1)
                    .foregroundStyle(TWTheme.textPrimary)
                Spacer(minLength: 4)
                Text(providerName)
                    .font(.caption2.weight(.semibold))
                    .lineLimit(1)
                    .foregroundStyle(providerAccent)
            }
            if !reachable, let reason = entry.reason, !reason.isEmpty {
                Text(reason)
                    .font(.caption2)
                    .lineLimit(2)
                    .foregroundStyle(TWTheme.textTertiary)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(
            chipAccent.opacity(reachable ? 0.12 : 0.16),
            in: RoundedRectangle(cornerRadius: 8)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(chipAccent.opacity(reachable ? 0.24 : 0.42), lineWidth: 1)
        )
    }
}

struct ParticipantHealthEntryPresentation: Equatable {
    let providerName: String
    let providerClass: String
}

func participantHealthEntryPresentation(
    _ entry: RemoteThreadSnapshot.Row.ParticipantHealth.Entry
) -> ParticipantHealthEntryPresentation {
    let provider = entry.provider
    let model = entry.model
    let stampedLabel = entry.displayProviderLabel?.trimmingCharacters(in: .whitespacesAndNewlines)
    let stampedClass = entry.displayHueClass?.trimmingCharacters(in: .whitespacesAndNewlines)
    let hasStampedLabel = stampedLabel?.isEmpty == false
    let hasStampedClass = stampedClass?.isEmpty == false
    let isOllama = provider?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "ollama"

    if isOllama, let brand = OllamaDisplayBrands.resolve(modelId: model, modelLabel: model) {
        let labelIsGeneric = stampedLabel?.lowercased() == "ollama"
        let classIsGeneric = stampedClass?.lowercased() == "ollama"
        if !hasStampedLabel || !hasStampedClass || labelIsGeneric || classIsGeneric {
            return ParticipantHealthEntryPresentation(
                providerName: labelIsGeneric || !hasStampedLabel
                    ? brand.providerLabel : stampedLabel!,
                providerClass: classIsGeneric || !hasStampedClass
                    ? brand.providerClass : stampedClass!)
        }
    }

    let providerName =
        hasStampedLabel
        ? stampedLabel!
        : TWTheme.providerLabel(provider, modelId: model, modelLabel: model)
    let providerClass =
        hasStampedClass
        ? stampedClass!
        : OllamaDisplayBrands.providerHueClass(provider: provider, modelId: model, modelLabel: model)
    return ParticipantHealthEntryPresentation(providerName: providerName, providerClass: providerClass)
}

struct SubThreadReturnSummaryCard: View {
    let summary: RemoteThreadSnapshot.Row.SubThreadReturn
    let resultText: String
    let participants: [RemoteEnsembleState.Participant]

    private var provider: String { summary.provider ?? "unknown" }
    private var title: String {
        let value = summary.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty ? "Untitled sub-thread" : value
    }
    private var accent: Color { TWTheme.providerAccent(provider) }
    private var displayBody: String {
        let value = resultText.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? "No returned output." : value
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            header
            ToolActivityViewport(
                maxHeight: 220,
                fadeHeight: 36,
                expandLabel: "Expand result",
                collapseLabel: "Collapse result"
            ) {
                MarkdownLite(
                    displayBody,
                    participants: participants,
                    baseColor: TWTheme.textPrimary
                )
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(10)
        .background(
            LinearGradient(
                colors: [accent.opacity(0.13), TWTheme.surface1.opacity(0.76)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: 12)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(accent.opacity(0.54), lineWidth: 1.2)
        )
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .center, spacing: 6) {
                Image(systemName: "arrow.turn.up.left")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(accent)
                Text("Invocation result from")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(TWTheme.textTertiary)
                    .lineLimit(1)
                Text("TaskWraith Sub-thread")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(TWTheme.textSecondary)
                    .lineLimit(1)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(TWTheme.surface3, in: Capsule())
            }
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(TWTheme.providerLabel(provider))
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(accent)
                    .lineLimit(1)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(accent.opacity(0.14), in: Capsule())
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
    }
}

// A VALUE-INPUT row, rendered `.equatable()` at every call site. It holds a
// PLAIN `model` reference (NOT @ObservedObject) so a per-token model change
// does NOT invalidate every settled row's body. The parent transcript view
// (which DOES observe the model) re-evaluates on each token, reconstructs
// these structs cheaply, and EquatableView skips body re-eval — and thus the
// MarkdownLite re-parse — for any row whose inputs are unchanged. The two
// formerly model-derived inputs (`isExpanding`, `participants`) are resolved
// at the call site and passed in, so they participate in equality.

/// Lightweight context-compaction card for system rows whose Mac preview is
/// `formatContextCompactionSummary` ("Context compacted · …").
struct ContextCompactionSummaryCard: View {
    let preview: String

    static func matches(preview: String?, role: String?, kind: String?) -> Bool {
        guard let preview, !preview.isEmpty else { return false }
        guard role == "system" || kind == "system" else { return false }
        let lower = preview.lowercased()
        return lower.hasPrefix("context compacted")
            || lower.hasPrefix("context compaction failed")
            || lower.hasPrefix("compacting context")
    }

    private var failed: Bool {
        preview.lowercased().hasPrefix("context compaction failed")
    }

    private var inProgress: Bool {
        preview.lowercased().hasPrefix("compacting context")
    }

    private var accent: Color {
        if failed { return TWTheme.statusFailed }
        if inProgress { return TWTheme.chroma1 }
        return TWTheme.statusSuccess
    }

    private var title: String {
        if failed { return "Context compaction failed" }
        if inProgress { return "Compacting context…" }
        return "Context compacted"
    }

    private var detail: String? {
        for separator in [" · ", " — "] {
            if let range = preview.range(of: separator) {
                let rest = String(preview[range.upperBound...])
                    .trimmingCharacters(in: .whitespaces)
                if !rest.isEmpty { return rest }
            }
        }
        return nil
    }

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            Image(
                systemName: failed
                    ? "exclamationmark.triangle.fill"
                    : "arrow.down.right.and.arrow.up.left"
            )
            .font(.caption.weight(.bold))
            .foregroundStyle(accent)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                if let detail {
                    Text(detail)
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(accent.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(accent.opacity(0.35), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel([title, detail].compactMap { $0 }.joined(separator: ". "))
    }
}

/// Compact always-visible message action strip — desktop MessageActionsChip
/// parity for iOS (copy / add-to-prompt / pin / open side chat).
struct MessageActionsBar: View {
    let isPinned: Bool
    let onCopy: () -> Void
    let onAddToPrompt: (() -> Void)?
    let onTogglePin: (() -> Void)?
    let onOpenSideChat: (() -> Void)?

    var body: some View {
        HStack(spacing: 2) {
            actionButton(systemImage: "doc.on.doc", label: "Copy", action: onCopy)
            if let onAddToPrompt {
                actionButton(
                    systemImage: "text.append", label: "Add to prompt",
                    action: onAddToPrompt)
            }
            if let onTogglePin {
                actionButton(
                    systemImage: isPinned ? "pin.fill" : "pin",
                    label: isPinned ? "Unpin" : "Pin",
                    accented: isPinned,
                    action: onTogglePin)
            }
            if let onOpenSideChat {
                actionButton(
                    systemImage: "rectangle.split.2x1",
                    label: "Open side chat",
                    action: onOpenSideChat)
            }
            Spacer(minLength: 0)
        }
        .padding(.top, 2)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Message actions")
    }

    private func actionButton(
        systemImage: String,
        label: String,
        accented: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(accented ? TWTheme.chroma1 : TWTheme.textTertiary)
                .frame(width: 28, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

struct ThreadRowView: View, Equatable {
    let model: RemoteSessionModel
    let threadId: String
    let row: RemoteThreadSnapshot.Row
    let threadProvider: String?
    let agentIdentity: ThreadAgentIdentity?
    let isExpanding: Bool
    let participants: [RemoteEnsembleState.Participant]
    let isPinned: Bool

    // Compare ONLY the inputs that change rendering. The `model` reference is
    // constant (same object) so it's excluded; participant `status`/`order`
    // are excluded via the signature (they churn every token mid-stream).
    // `row == row` covers preview↔full on "Show more": resolvedRow swaps in a
    // different Row value (Row is Equatable), so the gate re-renders then.
    // `nonisolated` because Equatable.== is a nonisolated requirement while a
    // SwiftUI View is implicitly @MainActor; every compared field is a `let`
    // of a Sendable type, so the cross-actor read is safe.
    nonisolated static func == (lhs: ThreadRowView, rhs: ThreadRowView) -> Bool {
        lhs.threadId == rhs.threadId
            && lhs.row == rhs.row
            && lhs.threadProvider == rhs.threadProvider
            && lhs.agentIdentity == rhs.agentIdentity
            && lhs.isExpanding == rhs.isExpanding
            && lhs.isPinned == rhs.isPinned
            && twParticipantsSignature(lhs.participants)
                == twParticipantsSignature(rhs.participants)
    }

    private var isUser: Bool { row.role == "user" }
    private var isTool: Bool { row.role == "tool" || row.kind == "tool" }
    private var showExpand: Bool {
        row.truncated == true && !hasParticipantHealthCard && !hasProposedPlanCard
            && !hasAgentQuestionCard && !hasContextCompactionCard
    }
    private var hasParticipantHealthCard: Bool {
        !(row.participantHealth?.entries?.isEmpty ?? true)
    }
    private var hasSubThreadReturnCard: Bool { row.subThreadReturn != nil }
    private var hasProposedPlanCard: Bool { row.proposedPlan != nil }
    private var hasAgentQuestionCard: Bool { row.agentQuestion?.promptId != nil }
    private var hasContextCompactionCard: Bool {
        ContextCompactionSummaryCard.matches(
            preview: row.preview, role: row.role, kind: row.kind)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            AgentTranscriptLeadingMark(
                identity: activeAgentIdentity,
                fallbackAccent: accentColor,
                hidden: isUser || hasParticipantHealthCard || hasContextCompactionCard)
            VStack(alignment: .leading, spacing: 4) {
                if !hasParticipantHealthCard && !hasSubThreadReturnCard && !hasProposedPlanCard
                    && !hasAgentQuestionCard && !hasContextCompactionCard
                {
                    HStack(spacing: 0) {
                        Text(label)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(labelColor)
                        if let modelChip = settledRowModelChip {
                            Text(" · \(modelChip)")
                                .font(.caption2.weight(.regular))
                                .foregroundStyle(labelColor.opacity(0.72))
                                .monospacedDigit()
                        }
                    }
                }
                if let agentQuestion = row.agentQuestion, agentQuestion.promptId != nil {
                    AgentQuestionRow(model: model, question: agentQuestion)
                } else if hasContextCompactionCard {
                    ContextCompactionSummaryCard(preview: row.preview ?? "")
                } else if let plan = row.proposedPlan {
                    ProposedPlanRow(
                        model: model, threadId: threadId, rowId: row.id, plan: plan)
                } else if let health = row.participantHealth,
                    let entries = health.entries, !entries.isEmpty
                {
                    ParticipantHealthSummaryCard(
                        summary: health, rosterParticipants: participants)
                } else if let subThreadReturn = row.subThreadReturn {
                    SubThreadReturnSummaryCard(
                        summary: subThreadReturn,
                        resultText: row.preview ?? "",
                        participants: participants
                    )
                    .contextMenu {
                        messageActionMenu(
                            content: row.preview ?? "",
                            copyLabel: "Copy result",
                            pinLabelPinned: "Unpin result",
                            pinLabelUnpinned: "Pin result",
                            showAddToPrompt: false,
                            showSideChat: true
                        )
                    }
                } else if let tools = row.toolSummary, let count = tools.activityCount, count > 0 {
                    if let entries = tools.tools, !entries.isEmpty {
                        ToolActivityCards(
                            entries: entries, totalCount: count, status: tools.status)
                    } else {
                        HStack(spacing: 5) {
                            Image(systemName: "wrench.and.screwdriver")
                            Text(toolLine(count: count, status: tools.status))
                            if let status = tools.status {
                                Circle().fill(TWTheme.statusColor(status))
                                    .frame(width: 5, height: 5)
                            }
                        }
                        .font(.caption)
                        .foregroundStyle(TWTheme.textTertiary)
                    }
                }
                // A proposed-plan row is a focused decision surface: suppress the
                // media strip too (alongside the label/preview/showExpand guards)
                // so an image attached to the plan turn can't render orphaned
                // beneath the card. Guard every branch — gating only the first
                // would fall through to the else-ifs.
                if !hasProposedPlanCard, !hasAgentQuestionCard, let media = row.media, !media.isEmpty
                {
                    #if canImport(UIKit)
                        TranscriptMediaStrip(
                            model: model, threadId: threadId, rowId: row.id, media: media)
                    #else
                        imageAttachmentChip(media.count)
                    #endif
                } else if !hasProposedPlanCard, !hasAgentQuestionCard,
                    let thumbs = row.imageThumbnails, !thumbs.isEmpty
                {
                    #if canImport(UIKit)
                        TranscriptImageThumbnails(thumbnails: thumbs)
                    #else
                        imageAttachmentChip(thumbs.count)
                    #endif
                } else if !hasProposedPlanCard, !hasAgentQuestionCard,
                    let count = row.imageAttachmentCount, count > 0
                {
                    imageAttachmentChip(count)
                }
                // TV (thinking viewport): dedicated bounded presentation for
                // the row's thinking trace — collapsed 8 lines + fade +
                // "Show thinking" chip, in-place expand, full text via the
                // existing expandRow path when host-truncated. Renders ABOVE
                // the answer body, mirroring desktop chronology.
                if !hasParticipantHealthCard && !hasSubThreadReturnCard && !hasProposedPlanCard
                    && !hasAgentQuestionCard,
                    let thinking = row.thinking,
                    let thinkingText = thinking.preview, !thinkingText.isEmpty
                {
                    ThinkingViewportView(
                        thinking: thinking,
                        isExpanding: isExpanding,
                        onExpandFullText: {
                            model.expandRow(threadId: threadId, rowId: row.id)
                        })
                }
                if !hasParticipantHealthCard && !hasSubThreadReturnCard && !hasProposedPlanCard
                    && !hasAgentQuestionCard && !hasContextCompactionCard,
                    let preview = row.preview, !preview.isEmpty
                {
                    VStack(alignment: .leading, spacing: 4) {
                        MarkdownLite(
                            preview,
                            participants: participants,
                            baseColor: bodyColor
                        )
                        .textSelection(.enabled)
                        if let footerTime = transcriptFooterTime {
                            Text(footerTime)
                                .font(.caption2)
                                .foregroundStyle(TWTheme.textMuted.opacity(0.88))
                                .monospacedDigit()
                        }
                        if showsMessageActionChrome {
                            MessageActionsBar(
                                isPinned: isPinned,
                                onCopy: { copyText(preview) },
                                onAddToPrompt: {
                                    model.requestComposerAppend(preview, threadId: threadId)
                                },
                                onTogglePin: { togglePin() },
                                onOpenSideChat: { openSideChatFromMessage() }
                            )
                        }
                    }
                    .contextMenu {
                        messageActionMenu(
                            content: preview,
                            copyLabel: "Copy message",
                            pinLabelPinned: "Unpin message",
                            pinLabelUnpinned: "Pin message",
                            showAddToPrompt: true,
                            showSideChat: true
                        )
                    }
                }
                if showExpand {
                    Button {
                        model.expandRow(threadId: threadId, rowId: row.id)
                    } label: {
                        if isExpanding {
                            Text("Loading…")
                        } else {
                            Text("Show more")
                        }
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.chroma1)
                    // Make the whole padded rectangle tappable (not just the
                    // caption glyphs) so the first tap lands even while the row
                    // is re-laying-out under the finger during a stream.
                    .padding(.vertical, 4)
                    .contentShape(Rectangle())
                    .buttonStyle(.plain)
                    .disabled(isExpanding)
                }
            }            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 5)
    }

    private func toolLine(count: Int, status: String?) -> String {
        let noun = "\(count) tool\(count == 1 ? "" : "s")"
        if let status, !status.isEmpty {
            return "\(noun) · \(status)"
        }
        return noun
    }

    /// Count-only attachment chip — the fallback when the Mac didn't ship
    /// thumbnails (historical rows) or on a non-UIKit build.
    @ViewBuilder
    private func imageAttachmentChip(_ count: Int) -> some View {
        HStack(spacing: 5) {
            Image(systemName: "photo.on.rectangle.angled")
            Text("\(count) image\(count == 1 ? "" : "s") attached")
        }
        .font(.caption)
        .foregroundStyle(TWTheme.textTertiary)
    }

    /// "Delivered 22:43" (today) / "Delivered 9 Jun, 22:43" — context-menu
    /// section header so the user can see when the message landed.
    private var deliveredCaption: String? {
        guard let timestamp = row.timestamp,
            let caption = TWTranscriptTimestampFormat.footerCaption(iso: timestamp)
        else { return nil }
        return "Delivered \(caption)"
    }

    /// User + assistant prose rows get the action chrome; special cards keep
    /// their own surface (plans, questions, health, pure tool chips).
    private var showsMessageActionChrome: Bool {
        !hasParticipantHealthCard && !hasSubThreadReturnCard && !hasProposedPlanCard
            && !hasAgentQuestionCard && !hasContextCompactionCard && !isTool
            && (row.role == "user" || row.role == "assistant" || row.kind == "assistant"
                || row.kind == "user" || row.kind == "message")
    }

    private var threadCard: RemoteTaskCard? {
        model.taskCards.first { $0.id == threadId || $0.threadId == threadId }
    }

    private func copyText(_ text: String) {
        #if canImport(UIKit)
            UIPasteboard.general.string = text
        #endif
    }

    private func togglePin() {
        guard let card = threadCard else { return }
        model.toggleMessagePin(card, messageId: row.id, pinned: !isPinned)
    }

    private func openSideChatFromMessage() {
        guard let card = threadCard else { return }
        let modelId: String?
        if card.selectedModelType == "custom" {
            modelId = card.customModel
        } else if let selected = card.selectedModelType, selected != "cli-default" {
            modelId = selected
        } else {
            modelId = nil
        }
        model.createSideChat(
            card,
            provider: card.provider ?? threadProvider,
            model: modelId,
            navigateOnAck: true
        )
    }

    @ViewBuilder
    private func messageActionMenu(
        content: String,
        copyLabel: String,
        pinLabelPinned: String,
        pinLabelUnpinned: String,
        showAddToPrompt: Bool,
        showSideChat: Bool
    ) -> some View {
        Section(deliveredCaption ?? "") {
            Button { copyText(content) } label: {
                Label(copyLabel, systemImage: "doc.on.doc")
            }
            if showAddToPrompt, !content.isEmpty {
                Button {
                    model.requestComposerAppend(content, threadId: threadId)
                } label: {
                    Label("Add to prompt", systemImage: "text.append")
                }
            }
            if threadCard != nil {
                Button { togglePin() } label: {
                    Label(
                        isPinned ? pinLabelPinned : pinLabelUnpinned,
                        systemImage: isPinned ? "pin.slash" : "pin")
                }
                if showSideChat {
                    Button { openSideChatFromMessage() } label: {
                        Label("Open side chat", systemImage: "rectangle.split.2x1")
                    }
                }
            }
        }
    }

    /// Always-visible footer time (Electron message-footer-time parity).
    private var transcriptFooterTime: String? {
        guard let timestamp = row.timestamp else { return nil }
        return TWTranscriptTimestampFormat.footerCaption(iso: timestamp)
    }

    private var settledRowModelChip: String? {
        twSettledRowModelChip(from: row.speaker)
    }

    private var activeAgentIdentity: ThreadAgentIdentity? {
        guard !isUser else { return nil }
        return ThreadAgentIdentity(pooled: row.pooledAgentIdentity) ?? agentIdentity
    }

    private var baseLabel: String {
        if let speaker = row.speaker, !speaker.isEmpty {
            let split = twSettledRowSpeakerSplit(from: speaker)
            return split.chip != nil ? split.label : speaker
        }
        switch row.role {
        case "user": return "You"
        case "assistant": return "Assistant"
        case "tool": return "Tools"
        case "error": return "Error"
        case "system": return "System"
        default: return row.kind ?? row.role ?? "Message"
        }
    }

    private var label: String {
        guard let identity = activeAgentIdentity else { return baseLabel }
        if isTool { return "\(identity.name) · Tools" }
        if row.role == "assistant" { return identity.name }
        return "\(identity.name) · \(baseLabel)"
    }

    private var accentColor: Color {
        if let identity = activeAgentIdentity {
            return identity.accent
        }
        if row.speaker != nil {
            return providerAccentFromSpeaker(row.speaker, fallback: TWTheme.chroma2)
        }
        if isTool { return TWTheme.textTertiary }
        if row.role == "assistant", let threadProvider {
            return TWTheme.providerAccent(threadProvider)
        }
        return TWTheme.textSecondary
    }

    private var labelColor: Color {
        if let identity = activeAgentIdentity {
            return identity.accent
        }
        if row.speaker != nil {
            return providerAccentFromSpeaker(row.speaker, fallback: TWTheme.chroma2)
        }
        switch row.role {
        case "user": return TWTheme.chroma1
        case "error": return TWTheme.statusFailed
        case "tool": return TWTheme.textTertiary
        case "assistant":
            if let threadProvider { return TWTheme.providerAccent(threadProvider) }
            return TWTheme.textSecondary
        default: return TWTheme.textSecondary
        }
    }

    private var bodyColor: Color {
        if row.kind == "attention" { return TWTheme.statusAttention }
        if row.role == "error" { return TWTheme.statusFailed }
        return TWTheme.textPrimary
    }
}

#if canImport(UIKit)
    private struct TranscriptMediaStrip: View {
        // Plain reference, NOT @ObservedObject: this strip only *calls* async
        // methods (fetchThreadMedia*) and passes `model` to its preview sheet — it
        // reads no @Published property, so observing the model would re-run this
        // strip's body on every streamed token (the per-token cascade ThreadRowView
        // was deliberately fixed to avoid), for every row that carries media.
        let model: RemoteSessionModel
        let threadId: String
        let rowId: String
        let media: [RemoteThreadSnapshot.Row.Media]
        @State private var fetchingMediaId: String?
        @State private var preview: TranscriptMediaPreview?
        @State private var errorText: String?

        var body: some View {
            VStack(alignment: .leading, spacing: 5) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: 6) {
                        ForEach(media) { item in
                            mediaTile(item)
                        }
                    }
                }
                if let errorText {
                    Text(errorText)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(TWTheme.statusFailed)
                        .lineLimit(2)
                }
            }
            .padding(.top, 2)
            .sheet(item: $preview) { preview in
                TranscriptMediaPreviewSheet(preview: preview, model: model)
            }
        }

        @ViewBuilder
        private func mediaTile(_ item: RemoteThreadSnapshot.Row.Media) -> some View {
            // Images fetch the full blob (→ UIImage). Audio/video now STREAM on
            // tap via the Pass-2 bridge resource loader (BridgeMediaResourceLoader
            // feeding an AVPlayer through a `twbridge-media://` URL) — no full
            // download, transport controls supplied by VideoPlayer. The tile is a
            // poster + kind badge + duration with a play affordance for AV.
            let isImage = item.kind == "image"
            let isAV = item.kind == "video" || item.kind == "audio"
            let statusOk = item.status == nil || item.status == "available"
            let canFetch = isImage && statusOk
            let canOpen = statusOk && (isImage || isAV)
            let isFetching = fetchingMediaId == item.id
            Button {
                if isImage {
                    startFetch(item)
                } else if isAV {
                    openAVPreview(item)
                }
            } label: {
                ZStack(alignment: .topLeading) {
                    ZStack(alignment: .bottomTrailing) {
                        mediaThumbnail(item)
                        if isFetching {
                            ZStack {
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .fill(Color.black.opacity(0.34))
                                ProgressView()
                                    .progressViewStyle(.circular)
                                    .tint(.white)
                            }
                        } else if canFetch {
                            Image(systemName: "magnifyingglass")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.white)
                                .padding(5)
                                .background(Color.black.opacity(0.55), in: Circle())
                                .padding(6)
                        } else if isAV && statusOk {
                            // AV affordance — tap streams the asset via the bridge
                            // resource loader into an AVPlayer (no full download).
                            Image(systemName: "play.circle.fill")
                                .font(.title3.weight(.semibold))
                                .foregroundStyle(.white)
                                .padding(5)
                                .background(Color.black.opacity(0.55), in: Circle())
                                .padding(6)
                        } else if let status = item.status, !status.isEmpty {
                            Text(statusLabel(status))
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 4)
                                .background(Color.black.opacity(0.55), in: Capsule())
                                .padding(6)
                        }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        if let badge = kindBadgeSymbol(item.kind) {
                            Image(systemName: badge)
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.white)
                                .padding(5)
                                .background(Color.black.opacity(0.55), in: Circle())
                        }
                        if let codecs = item.codecs, !codecs.isEmpty {
                            Text(codecs)
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundStyle(.white)
                                .lineLimit(1)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 2)
                                .background(Color.black.opacity(0.55), in: Capsule())
                        }
                    }
                    .padding(6)
                    if let duration = durationLabel(item.durationMs) {
                        VStack {
                            Spacer()
                            HStack {
                                Spacer()
                                Text(duration)
                                    .font(.system(size: 10, weight: .semibold).monospacedDigit())
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 2)
                                    .background(Color.black.opacity(0.6), in: Capsule())
                            }
                        }
                        .padding(6)
                    }
                    if let bytes = item.byteLength, bytes > 0 {
                        VStack {
                            Spacer()
                            HStack {
                                Text(MobileFileEditorState.formatBytes(bytes))
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 2)
                                    .background(Color.black.opacity(0.6), in: Capsule())
                                Spacer()
                            }
                        }
                        .padding(6)
                    }
                }
                .frame(width: 132, height: 132)
                .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(!canOpen || fetchingMediaId != nil)
            .accessibilityLabel(item.alt ?? item.caption ?? item.name)
        }

        /// SF Symbol overlaid top-leading to mark AV tiles distinct from images.
        private func kindBadgeSymbol(_ kind: String) -> String? {
            switch kind {
            case "audio": return "waveform"
            case "video": return "film"
            default: return nil
            }
        }

        /// Compact mm:ss from a millisecond duration; nil when absent/non-positive.
        private func durationLabel(_ durationMs: Int?) -> String? {
            guard let durationMs, durationMs > 0 else { return nil }
            let totalSeconds = durationMs / 1000
            return String(format: "%d:%02d", totalSeconds / 60, totalSeconds % 60)
        }

        @ViewBuilder
        private func mediaThumbnail(_ item: RemoteThreadSnapshot.Row.Media) -> some View {
            if let thumbnail = item.thumbnail, let image = Self.decode(thumbnail.dataBase64) {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: 132, height: 132)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(Color(UIColor.separator), lineWidth: 0.5)
                    )
            } else {
                VStack(spacing: 7) {
                    Image(systemName: placeholderSymbol(item.kind))
                        .font(.title2.weight(.semibold))
                    Text(item.name)
                        .font(.caption2.weight(.semibold))
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                        .padding(.horizontal, 8)
                }
                .foregroundStyle(TWTheme.textSecondary)
                .frame(width: 132, height: 132)
                .background(TWTheme.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color(UIColor.separator), lineWidth: 0.5)
                )
            }
        }

        /// Kind-appropriate placeholder glyph when no poster thumbnail is present.
        private func placeholderSymbol(_ kind: String) -> String {
            switch kind {
            case "audio": return "waveform"
            case "video": return "film"
            default: return "photo"
            }
        }

        private func startFetch(_ item: RemoteThreadSnapshot.Row.Media) {
            // Defensive: only images are fetchable today. AV tiles are gated
            // non-interactive at the Button (`canFetch`), but guard here too so a
            // stray invocation can never open the image-only "Preview unavailable".
            guard item.kind == "image" else { return }
            guard fetchingMediaId == nil else { return }
            fetchingMediaId = item.id
            errorText = nil
            Task {
                do {
                    let fetched = try await model.fetchThreadMedia(
                        threadId: threadId, rowId: rowId, mediaId: item.id,
                        variant: "full", maxBytes: 8 * 1024 * 1024)
                    await MainActor.run {
                        self.preview = TranscriptMediaPreview(payload: .image(fetched))
                        self.fetchingMediaId = nil
                    }
                } catch {
                    await MainActor.run {
                        self.errorText = "Full image unavailable"
                        self.fetchingMediaId = nil
                    }
                }
            }
        }

        /// Opens an AV asset for streaming. Unlike `startFetch`, this does NOT
        /// download the blob or spin `fetchingMediaId` — it hands a stream
        /// descriptor to the sheet, where AVStreamPreview builds the bridge
        /// resource loader and the player pulls bytes on demand.
        private func openAVPreview(_ item: RemoteThreadSnapshot.Row.Media) {
            guard item.kind == "video" || item.kind == "audio" else { return }
            let descriptor = AVStreamDescriptor(
                threadId: threadId,
                rowId: rowId,
                mediaId: item.id,
                mimeType: item.mimeType ?? (item.kind == "video" ? "video/mp4" : "audio/mpeg"),
                kind: item.kind,
                name: item.name,
                posterBase64: item.thumbnail?.dataBase64,
                durationMs: item.durationMs)
            preview = TranscriptMediaPreview(payload: .av(descriptor))
        }

        private func statusLabel(_ status: String) -> String {
            switch status {
            case "missing": return "Missing"
            case "denied": return "Denied"
            case "unsafe": return "Unsafe"
            default: return status
            }
        }

        private static func decode(_ base64: String) -> UIImage? {
            guard let data = Data(base64Encoded: base64) else { return nil }
            return UIImage(data: data)
        }
    }

    /// Immutable stream descriptor for an audio/video asset: the three bridge
    /// ids the resource loader needs, plus presentation metadata. Carries NO
    /// bytes — AVStreamPreview pulls them on demand through the loader.
    private struct AVStreamDescriptor {
        let threadId: String
        let rowId: String
        let mediaId: String
        let mimeType: String      // resolved with a fallback in openAVPreview
        let kind: String          // "video" | "audio"
        let name: String
        let posterBase64: String? // item.thumbnail?.dataBase64 (waveform/poster)
        let durationMs: Int?
    }

    private struct TranscriptMediaPreview: Identifiable {
        let id = UUID()
        /// Either a fully-fetched image blob, or a descriptor the AV player
        /// streams on demand.
        enum Payload {
            case image(TranscriptMediaFetchResult)
            case av(AVStreamDescriptor)
        }
        let payload: Payload
    }

    private struct TranscriptMediaPreviewSheet: View {
        let preview: TranscriptMediaPreview
        let model: RemoteSessionModel
        @Environment(\.dismiss) private var dismiss

        var body: some View {
            NavigationStack {
                Group {
                    switch preview.payload {
                    case .image(let result):
                        imageBody(result)
                    case .av(let descriptor):
                        AVStreamPreview(descriptor: descriptor, model: model)
                    }
                }
                .background(TWTheme.appBg.ignoresSafeArea())
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
            }
        }

        private var title: String {
            switch preview.payload {
            case .image(let result): return result.name ?? "Image"
            case .av(let descriptor): return descriptor.name
            }
        }

        @ViewBuilder
        private func imageBody(_ result: TranscriptMediaFetchResult) -> some View {
            if let image = Self.decodeImage(result.dataBase64) {
                ScrollView([.horizontal, .vertical]) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .padding()
                }
            } else {
                VStack(spacing: 10) {
                    Image(systemName: "photo")
                        .font(.largeTitle.weight(.semibold))
                    Text("Preview unavailable")
                        .font(.headline)
                }
                .foregroundStyle(TWTheme.textSecondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }

        private static func decodeImage(_ base64: String) -> UIImage? {
            guard let data = Data(base64Encoded: base64) else { return nil }
            return UIImage(data: data)
        }
    }

    /// Streams a transcript audio/video asset through the bridge resource loader
    /// into an AVPlayer. The VIEW owns the loader: `setDelegate(_:queue:)` holds
    /// the delegate WEAKLY, so the loader must live as long as the player or
    /// AVFoundation's load requests silently stall.
    private struct AVStreamPreview: View {
        let descriptor: AVStreamDescriptor
        let model: RemoteSessionModel
        @State private var player: AVPlayer?
        @State private var loader: BridgeMediaResourceLoader?

        var body: some View {
            Group {
                if let player {
                    if descriptor.kind == "video" {
                        VideoPlayer(player: player)
                            .ignoresSafeArea(.container, edges: .bottom)
                    } else {
                        VStack(spacing: 16) {
                            poster
                            VideoPlayer(player: player)
                                .frame(height: 90)
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                        .padding()
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
                    }
                } else {
                    ProgressView()
                        .progressViewStyle(.circular)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .onAppear { buildPlayerIfNeeded() }
            .onDisappear {
                player?.pause()
                player = nil
                loader = nil
            }
        }

        /// The waveform/poster for an audio asset, shown above the transport.
        @ViewBuilder
        private var poster: some View {
            if let base64 = descriptor.posterBase64,
               let image = Self.decodeImage(base64)
            {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 220)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            } else {
                VStack(spacing: 10) {
                    Image(systemName: "waveform")
                        .font(.system(size: 52, weight: .semibold))
                    Text(descriptor.name)
                        .font(.subheadline.weight(.semibold))
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                }
                .foregroundStyle(TWTheme.textSecondary)
                .frame(maxWidth: .infinity)
                .frame(height: 220)
                .background(TWTheme.surface2, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
        }

        /// Build the loader + player exactly once. The `@Sendable` fetch closure
        /// captures the @MainActor model (implicitly Sendable) and the descriptor
        /// ids; the view retains `loader` so the weakly-held delegate survives.
        private func buildPlayerIfNeeded() {
            guard player == nil else { return }
            let threadId = descriptor.threadId
            let rowId = descriptor.rowId
            let mediaId = descriptor.mediaId
            let fetch: @Sendable (_ offset: Int, _ length: Int) async throws -> (data: Data, totalBytes: Int) = { offset, length in
                try await model.fetchThreadMediaChunk(
                    threadId: threadId, rowId: rowId, mediaId: mediaId,
                    offset: offset, length: length)
            }
            let l = BridgeMediaResourceLoader(mimeType: descriptor.mimeType, fetchChunk: fetch)
            let url = BridgeMediaURL.make(threadId: threadId, rowId: rowId, mediaId: mediaId)
            let asset = AVURLAsset(url: url)
            asset.resourceLoader.setDelegate(l, queue: l.deliveryQueue)
            let item = AVPlayerItem(asset: asset)
            loader = l
            let p = AVPlayer(playerItem: item)
            player = p
            p.play()
        }

        private static func decodeImage(_ base64: String) -> UIImage? {
            guard let data = Data(base64Encoded: base64) else { return nil }
            return UIImage(data: data)
        }
    }
#endif

/// One-line summary chrome for a collapsed settled stack or system notice
/// (desktop `CollapsedTranscriptRow` parity): chevron + optional muted meta
/// prefix + ellipsized label. Tapping toggles; the expanded content renders
/// below this row, which stays visible as the re-collapse affordance.
struct CollapsedTranscriptSummaryRow: View {
    let metaLabel: String?
    let label: String
    let errored: Bool
    let expanded: Bool
    let onToggle: () -> Void

    var body: some View {
        Button(action: onToggle) {
            HStack(spacing: 6) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .rotationEffect(.degrees(expanded ? 90 : 0))
                    .foregroundStyle(TWTheme.textTertiary)
                if let metaLabel {
                    Text(metaLabel)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(TWTheme.textTertiary)
                }
                Text(label)
                    .font(.caption)
                    .foregroundStyle(errored ? TWTheme.statusColor("warning") : TWTheme.textSecondary)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            "\(expanded ? "Collapse" : "Expand") \(metaLabel.map { "\($0) " } ?? "")\(label)")
    }
}

struct ToolBurstRowView: View, Equatable {
    let rows: [RemoteThreadSnapshot.Row]
    var agentIdentity: ThreadAgentIdentity? = nil

    // Mirrors ThreadRowView's `.equatable()` gate (both `rows` and
    // `agentIdentity` are already proven Equatable there): skip body re-eval
    // — and the ToolActivityCards re-layout it drives — for a burst whose
    // rows/identity are unchanged, instead of re-rendering on every parent
    // @ObservedObject publish. `nonisolated` for the same reason as
    // ThreadRowView's `==`: Equatable is a nonisolated requirement, and every
    // compared field is a `let`/Sendable value.
    nonisolated static func == (lhs: ToolBurstRowView, rhs: ToolBurstRowView) -> Bool {
        lhs.rows == rhs.rows && lhs.agentIdentity == rhs.agentIdentity
    }

    private var firstRow: RemoteThreadSnapshot.Row? { rows.first }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            AgentTranscriptLeadingMark(
                identity: agentIdentity,
                fallbackAccent: accentColor,
                hidden: false)
            VStack(alignment: .leading, spacing: 4) {
                Text(label)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(labelColor)
                if !entries.isEmpty {
                    ToolActivityCards(entries: entries, totalCount: totalCount, status: status)
                } else {
                    HStack(spacing: 5) {
                        Image(systemName: "wrench.and.screwdriver")
                        Text(toolLine(count: totalCount, status: status))
                        if let status {
                            Circle().fill(TWTheme.statusColor(status))
                                .frame(width: 5, height: 5)
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(TWTheme.textTertiary)
                }
            }            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 5)
    }

    private var entries: [RemoteThreadSnapshot.Row.ToolEntry] {
        rows.flatMap { $0.toolSummary?.tools ?? [] }
    }

    private var totalCount: Int {
        rows.reduce(0) { total, row in
            total + max(0, row.toolSummary?.activityCount ?? row.toolSummary?.tools?.count ?? 0)
        }
    }

    private var status: String? {
        var hasRunning = false
        var hasError = false
        var hasSuccess = false
        var hasMixed = false
        for row in rows {
            switch row.toolSummary?.status {
            case "running": hasRunning = true
            case "error": hasError = true
            case "success": hasSuccess = true
            case "mixed": hasMixed = true
            default: break
            }
        }
        if hasRunning { return "running" }
        if hasMixed || (hasError && hasSuccess) { return "mixed" }
        if hasError { return "error" }
        if hasSuccess { return "success" }
        return firstRow?.toolSummary?.status
    }

    private var label: String {
        if let agentIdentity {
            return "\(agentIdentity.name) · Tools"
        }
        if let speaker = firstRow?.speaker, !speaker.isEmpty { return speaker }
        return "Tools"
    }

    private var accentColor: Color {
        if let agentIdentity {
            return agentIdentity.accent
        }
        if let speaker = firstRow?.speaker {
            return providerAccentFromSpeaker(speaker, fallback: TWTheme.chroma2)
        }
        return TWTheme.textTertiary
    }

    private var labelColor: Color {
        if let agentIdentity {
            return agentIdentity.accent
        }
        if let speaker = firstRow?.speaker {
            return providerAccentFromSpeaker(speaker, fallback: TWTheme.chroma2)
        }
        return TWTheme.textTertiary
    }

    private func toolLine(count: Int, status: String?) -> String {
        let noun = "\(count) tool\(count == 1 ? "" : "s")"
        if let status, !status.isEmpty {
            return "\(noun) · \(status)"
        }
        return noun
    }
}

/// Token-level live assistant bubble — grows as bridge.runEvent content
/// deltas arrive, superseding the in-flight snapshot row until the run
/// exits and the final snapshot takes over.

struct StreamingRowView: View {
    let text: String
    let provider: String?
    var model: String? = nil
    var role: String? = nil
    var agentIdentity: ThreadAgentIdentity? = nil
    var participants: [RemoteEnsembleState.Participant] = []
    /// Stream hit its terminal event — the reveal tail drains instead of
    /// continuing at streaming cadence (see TokenRevealText.isComplete).
    var isComplete: Bool = false
    @State private var streamingSplitCache = StreamingMarkdownSplitCacheBox()

    private var accent: Color {
        agentIdentity?.accent ?? TWTheme.providerAccent(provider, modelId: model, modelLabel: model)
    }

    var body: some View {
        // Route the settled prefix through the markdown pipeline (parity with
        // StreamingSegmentRow) so a half-typed `**bold` / `| cell` / ``` fence
        // never reveals as literal syntax in side chats; only the plain growing
        // tail gets the token-reveal shimmer.
        let parts = streamingSplitCache.parts(for: text)
        HStack(alignment: .top, spacing: 8) {
            AgentTranscriptLeadingMark(
                identity: agentIdentity,
                fallbackAccent: accent,
                hidden: false)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 5) {
                    Text(headerLabel)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(accent)
                    StreamingDots(color: accent)
                }
                if !parts.settled.isEmpty {
                    MarkdownLite(
                        parts.settled,
                        participants: participants,
                        baseColor: TWTheme.textPrimary
                    )
                    .textSelection(.enabled)
                }
                if !parts.tail.isEmpty {
                    TokenRevealText(
                        target: parts.tail,
                        font: TWFont.transcript(),
                        color: TWTheme.textPrimary,
                        isComplete: isComplete)
                }
            }            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 5)
    }

    private var headerLabel: String {
        if let agentIdentity {
            return agentIdentity.name
        }
        return twWorkingParticipantLabel(provider: provider, role: role, model: model)
    }
}

/// Header line of the live streaming block — provider identity + activity
/// dots, pinned above the interleaved segments/tool rows. The body rows
/// below it (StreamingSegmentRow / ThreadRowView) carry the content.

struct StreamingLiveHeader: View {
    let provider: String?
    var model: String? = nil
    var role: String? = nil
    var agentIdentity: ThreadAgentIdentity? = nil

    private var accent: Color {
        agentIdentity?.accent ?? TWTheme.providerAccent(provider, modelId: model, modelLabel: model)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            AgentTranscriptLeadingMark(
                identity: agentIdentity,
                fallbackAccent: accent,
                hidden: false)
            HStack(spacing: 5) {
                Text(headerLabel)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(accent)
                if agentIdentity != nil {
                    Text(providerModelLabel)
                        .font(.caption2.weight(.semibold))
                        .lineLimit(1)
                        .foregroundStyle(TWTheme.textTertiary)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(TWTheme.surface3, in: Capsule())
                }
                StreamingDots(color: accent)
            }            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.top, 5)
    }

    private var headerLabel: String {
        agentIdentity?.name
            ?? twWorkingParticipantLabel(provider: provider, role: role, model: model)
    }

    private var providerModelLabel: String {
        twWorkingParticipantLabel(provider: provider, model: model)
    }
}

/// One streamed text segment of the live block, rendered with finished-
/// transcript fidelity: the settled prefix (paragraphs that can no longer
/// change) goes through the same MarkdownLite pipeline as snapshot rows;
/// only the growing tail stays plain (with the token-reveal shimmer) until
/// its paragraph completes. Sealed segments (isTail=false) are entirely
/// settled — pure markdown.

struct StreamingSegmentRow: View {
    let text: String
    let isTail: Bool
    var agentIdentity: ThreadAgentIdentity? = nil
    var participants: [RemoteEnsembleState.Participant] = []
    /// Stream hit its terminal event — the reveal tail drains instead of
    /// continuing at streaming cadence (see TokenRevealText.isComplete).
    var isComplete: Bool = false
    var onRevealFrame: (() -> Void)? = nil
    @State private var streamingSplitCache = StreamingMarkdownSplitCacheBox()

    var body: some View {
        let parts =
            isTail
            ? streamingSplitCache.parts(for: text)
            : (settled: text, tail: "")
        HStack(alignment: .top, spacing: 8) {
            AgentTranscriptLeadingMark(
                identity: nil,
                fallbackAccent: agentIdentity?.accent ?? TWTheme.textTertiary,
                hidden: true)
            VStack(alignment: .leading, spacing: 7) {
                if !parts.settled.isEmpty {
                    MarkdownLite(
                        parts.settled,
                        participants: participants,
                        baseColor: TWTheme.textPrimary
                    )
                    .textSelection(.enabled)
                }
                if !parts.tail.isEmpty {
                    TokenRevealText(
                        target: parts.tail,
                        font: TWFont.transcript(),
                        color: TWTheme.textPrimary,
                        isComplete: isComplete,
                        onRevealFrame: onRevealFrame)
                }
            }            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 5)
    }
}

/// The running indicator: a provider-hued ghost mark (its halo tinted with the
/// accent), the "Working" label, and streaming dots — all pulsing in cadence.
/// This is the single busy element shared by the pre-stream `ThinkingRow` and
/// the streaming tail `LiveActivityAnchor`, so a live run reads identically
/// whether or not tokens have started flowing — the transcript never flips
/// between a "Thinking…" and a "Working…" visual mid-run. Desktop parity:
/// Electron's `ThinkingIndicator` mirrors this exact element (ghost + glow +
/// "Working" + dots). Holds the mark solid under Reduce Motion.
/// TV — bounded thinking viewport (ios-thinking-viewport-spec). Collapsed to
/// 8 lines with a bottom fade + "Show thinking" chip; tap expands IN PLACE
/// (the transcript's own scroll is the viewport — deliberately NO nested
/// inline ScrollView, which would fight transcript pan on touch). When the
/// host truncated the trace (cap ≈4000), expansion also requests the full
/// text through the EXISTING expandRow path — the merged snapshot re-renders
/// this row with the longer preview. Heights stay bounded: collapsed by
/// lineLimit, expanded by the host's expand ceiling.
struct ThinkingViewportView: View {
    let thinking: RemoteThreadSnapshot.Row.Thinking
    let isExpanding: Bool
    let onExpandFullText: () -> Void

    @State private var expanded = false

    private static let collapsedLineLimit = 8

    nonisolated static func chipTitle(expanded: Bool, isExpanding: Bool) -> String {
        if isExpanding { return "Loading…" }
        return expanded ? "Hide thinking" : "Show thinking"
    }

    /// Wire fetch fires only on expand of a host-truncated trace.
    nonisolated static func needsWireExpansion(expanding: Bool, truncated: Bool?) -> Bool {
        expanding && truncated == true
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                // Settled ghost mark, static + glow-off (landmine ⑤ concerns
                // the working indicator's tint/glow pair; this is the plain
                // mark family at rest).
                GhostMonolineMarkView(size: 14, glow: false)
                    .opacity(0.6)
                Text(thinking.title?.isEmpty == false ? thinking.title! : "Thinking")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textMuted)
            }
            Text(thinking.preview ?? "")
                .font(.callout)
                .foregroundStyle(TWTheme.textSecondary.opacity(0.85))
                .lineLimit(expanded ? nil : Self.collapsedLineLimit)
                .frame(maxWidth: .infinity, alignment: .leading)
                .mask(
                    // Bottom fade only while collapsed — signals more content
                    // without measuring text height.
                    Group {
                        if expanded {
                            Rectangle()
                        } else {
                            LinearGradient(
                                stops: [
                                    .init(color: .black, location: 0.0),
                                    .init(color: .black, location: 0.72),
                                    .init(color: .black.opacity(0.25), location: 1.0),
                                ],
                                startPoint: .top, endPoint: .bottom)
                        }
                    }
                )
                .textSelection(.enabled)
            Button {
                let next = !expanded
                expanded = next
                if Self.needsWireExpansion(expanding: next, truncated: thinking.truncated) {
                    onExpandFullText()
                }
            } label: {
                Text(Self.chipTitle(expanded: expanded, isExpanding: isExpanding))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(TWTheme.textMuted)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(TWTheme.surface2))
            }
            .buttonStyle(.plain)
            .disabled(isExpanding)
            .padding(.top, 2)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(expanded ? "Thinking, expanded" : "Thinking, collapsed")
    }
}

struct WorkingGhostIndicator: View {
    var accent: Color
    /// The tail anchor stretches full-width so the mark left-aligns under the
    /// last streamed row; the inline (pre-stream) use hugs its content.
    var expands: Bool = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulsing = false

    var body: some View {
        HStack(spacing: 8) {
            GhostMonolineMarkView(size: 18, glow: true, glowTint: accent)
                .opacity(reduceMotion || pulsing ? 1 : 0.45)
                .animation(
                    reduceMotion
                        ? nil
                        : .easeInOut(duration: 0.85).repeatForever(autoreverses: true),
                    value: pulsing)
            ShimmerWorkingLabel(accent: accent)
            StreamingDots(color: accent)
            if expands { Spacer(minLength: 0) }
        }
        .onAppear { pulsing = true }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Working")
        .accessibilityAddTraits(.updatesFrequently)
    }
}

/// The "Working" word with a specular shine sweeping left→right: the accent is
/// the base hue and a lightened-toward-white highlight travels across, matching
/// Electron's `.message-working-label` accent shimmer (a subtle accent glow sits
/// behind it too). Solid accent under Reduce Motion. Accessibility is owned by
/// the parent `WorkingGhostIndicator`, so this stays a11y-silent.
private struct ShimmerWorkingLabel: View {
    var accent: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase: CGFloat = -1.2

    var body: some View {
        Group {
            if reduceMotion {
                Text("Working").foregroundStyle(accent)
            } else {
                Text("Working")
                    .foregroundStyle(
                        LinearGradient(
                            stops: [
                                .init(color: accent.opacity(0.82), location: 0.0),
                                .init(color: accent.opacity(0.82), location: 0.38),
                                .init(color: Self.lightened(accent, by: 0.5), location: 0.5),
                                .init(color: accent.opacity(0.82), location: 0.62),
                                .init(color: accent.opacity(0.82), location: 1.0)
                            ],
                            startPoint: UnitPoint(x: phase, y: 0.5),
                            endPoint: UnitPoint(x: phase + 1.0, y: 0.5)
                        )
                    )
                    .onAppear {
                        phase = -1.2
                        withAnimation(.linear(duration: 2.4).repeatForever(autoreverses: false)) {
                            phase = 1.2
                        }
                    }
            }
        }
        .font(.caption2.weight(.semibold))
        .shadow(color: accent.opacity(0.24), radius: 5)
    }

    /// Mix `color` toward white by `amount` (0…1), preserving hue — the shimmer
    /// peak, matching Electron's `color-mix(in srgb, white 46%, accent)`.
    private static func lightened(_ color: Color, by amount: CGFloat) -> Color {
        #if canImport(UIKit)
        let ui = UIColor(color)
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        if ui.getRed(&r, green: &g, blue: &b, alpha: &a) {
            return Color(
                red: Double(r + (1 - r) * amount),
                green: Double(g + (1 - g) * amount),
                blue: Double(b + (1 - b) * amount),
                opacity: Double(a))
        }
        #endif
        return color
    }
}

/// Pre-stream running indicator: shown while a run is active but no content has
/// streamed yet. Identifies the active agent (leading mark + provider/model)
/// and pins the unified "[ghost] Working…" indicator beneath it — the very same
/// element the streaming tail (`LiveActivityAnchor`) uses, so the transcript
/// never swaps indicators mid-run.
/// Queued-message bubble at the transcript tail (Claude-app style) — the
/// pending prompt reads as a dimmed, dash-bordered user bubble with a
/// "Queued #n" caption and a trailing 3-dots menu: Steer now / Add to
/// Blackboard (ensemble only — `onBlackboard: nil` hides it for solo
/// chats) / Edit / Remove. Replaces the composer above-row queued stacks
/// on the thread detail screen; every action is a Mac-ward bridge op.
private struct QueuedMessageBubbleRow: View {
    let position: Int
    let text: String
    let scheduledRunAt: String?
    let onSteer: () -> Void
    let onBlackboard: (() -> Void)?
    let onEdit: () -> Void
    let onRemove: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: scheduledRunAt == nil ? "text.line.first.and.arrowtriangle.forward" : "clock")
                .font(.caption2)
                .foregroundStyle(scheduledRunAt == nil ? TWTheme.textTertiary : TWTheme.statusAttention)
                .padding(.top, 10)
            VStack(alignment: .leading, spacing: 3) {
                Text(scheduledCaption ?? "Queued #\(position)")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(TWTheme.textTertiary)
                Text(text)
                    .font(.callout)
                    .foregroundStyle(TWTheme.textSecondary)
                    .lineLimit(6)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(TWTheme.surface2.opacity(0.55))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(
                        TWTheme.border,
                        style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
            )
            Menu {
                Button {
                    onSteer()
                } label: {
                    Label("Steer now", systemImage: "arrow.uturn.forward")
                }
                if let onBlackboard {
                    Button {
                        onBlackboard()
                    } label: {
                        Label("Add to Blackboard", systemImage: "note.text.badge.plus")
                    }
                }
                Button {
                    onEdit()
                } label: {
                    Label("Edit", systemImage: "pencil")
                }
                Button(role: .destructive) {
                    onRemove()
                } label: {
                    Label("Remove from queue", systemImage: "trash")
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.caption)
                    .foregroundStyle(TWTheme.textTertiary)
                    .frame(width: 22, height: 22)
                    .contentShape(Rectangle())
            }
            .padding(.top, 6)
            .accessibilityLabel("Queued message \(position) actions")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 2)
        .transition(ComposerMotion.cardPresence(reduceMotion: reduceMotion, edge: .bottom))
    }

    private var scheduledCaption: String? {
        guard let date = twParseISODate(scheduledRunAt) else { return nil }
        let formatter = DateFormatter()
        formatter.dateFormat = Calendar.current.isDateInToday(date) ? "HH:mm" : "d MMM, HH:mm"
        return "Scheduled \(formatter.string(from: date))"
    }
}

struct ThinkingRow: View {
    let provider: String?
    var model: String? = nil
    var role: String? = nil
    var agentIdentity: ThreadAgentIdentity? = nil

    private var accent: Color {
        agentIdentity?.accent ?? TWTheme.providerAccent(provider, modelId: model, modelLabel: model)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            AgentTranscriptLeadingMark(
                identity: agentIdentity,
                fallbackAccent: accent,
                hidden: false)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(agentIdentity?.name ?? headerLabel)
                    .font(.caption2.weight(.semibold))
                    .lineLimit(1)
                    .foregroundStyle(accent)
                    if agentIdentity != nil {
                        Text(providerModelLabel)
                            .font(.caption2.weight(.semibold))
                            .lineLimit(1)
                            .foregroundStyle(TWTheme.textTertiary)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(TWTheme.surface3, in: Capsule())
                    }
                }
                WorkingGhostIndicator(accent: accent)
                    .padding(.vertical, 2)
            }            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 5)
    }

    private var headerLabel: String {
        twWorkingParticipantLabel(provider: provider, role: role, model: model)
    }

    private var providerModelLabel: String {
        twWorkingParticipantLabel(provider: provider, model: model)
    }
}

/// Bottom-of-transcript activity anchor shown during a live run once content or
/// tools are flowing. A burst of tool rows otherwise leaves the transcript
/// looking idle below the last row — you can't tell if it's still working. This
/// pins the unified "[ghost] Working…" indicator (`WorkingGhostIndicator`) to
/// the tail so the eye lands on the most-recent activity. iOS-only (it lives in
/// the iOS transcript).
struct LiveActivityAnchor: View {
    var accent: Color

    var body: some View {
        WorkingGhostIndicator(accent: accent, expands: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 4)
    }
}

private struct ThreadRenameSheetContext: Identifiable {
    let id: String
    let title: String
    let subtitle: String?
}

/// Three-dot pulse used by the thinking + streaming indicators.

struct StreamingDots: View {
    let color: Color
    @State private var phase = false

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(color)
                    .frame(width: 4, height: 4)
                    .opacity(phase ? 0.25 : 1)
                    .animation(
                        .easeInOut(duration: 0.6)
                            .repeatForever(autoreverses: true)
                            .delay(Double(index) * 0.2),
                        value: phase)
            }
        }
        .onAppear { phase = true }
    }
}

/// One consistent in-flight affordance for surfaces whose data hasn't
/// arrived from the Mac yet — dots + a caption saying WHAT is loading.
/// Use this instead of letting a view fall through to an authoritative
/// empty state during hydration.
struct HydrationTicker: View {
    let caption: String
    var accent: Color = TWTheme.chroma1

    init(_ caption: String, accent: Color = TWTheme.chroma1) {
        self.caption = caption
        self.accent = accent
    }

    var body: some View {
        HStack(spacing: 8) {
            StreamingDots(color: accent)
            Text(caption)
                .font(.footnote)
                .foregroundStyle(TWTheme.textSecondary)
        }
        .padding(.vertical, 10)
    }
}

/// Live ensemble roster — desktop composer roster-chip parity: one chip
/// per participant, provider-tinted, active speaker highlighted.
