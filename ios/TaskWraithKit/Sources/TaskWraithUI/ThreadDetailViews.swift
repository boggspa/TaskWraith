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
    import PhotosUI
    import UIKit
#endif

/// Coalesces transcript follow-pin requests (see ThreadDetailView.requestFollowPin).
/// A reference type so toggling `scheduled` never triggers a View re-render —
/// during streaming the body already recomputes on every token.
private final class TranscriptFollowPin {
    var scheduled = false
}

struct ThreadDetailView: View {
    @ObservedObject var model: RemoteSessionModel
    let taskId: String
    @State private var followUp = ""
    /// Mirrors the Composer's expanded state (focused / drafting / queued /
    /// ensemble) so the host hides the secondary rows + telemetry rail when the
    /// composer is idle — i.e. the compact one-line composer.
    @State private var composerFocused = false
    /// Follow the transcript tail as content streams in. Driven by the bottom
    /// sentinel's visibility (on screen ⇒ follow); the jump-to-latest pill and
    /// thread-open also re-arm it.
    @State private var autoFollow = true
    /// One-scroll-per-turn coalescer for the follow-pin (kills stacked scrolls).
    @State private var followPin = TranscriptFollowPin()
    @State private var keyboardVisible = false
    /// Secondary workspace granted to subsequent runs (rail picker), keyed by
    /// thread so navigation away and back does not drop an unsent choice.
    @SceneStorage("taskwraith.secondaryWorkspaceSelections")
    private var secondaryWorkspaceSelectionStore = "{}"

    private var card: RemoteTaskCard? { model.taskCards.first { $0.id == taskId } }
    private var snapshot: RemoteThreadSnapshot? { model.threadSnapshots[taskId] }
    private var thinkingProvider: String? {
        if let state = model.ensembleStates[taskId],
            let activeId = state.activeParticipantId
        {
            if let provider = state.participants?.first(where: { $0.participantId == activeId })?.provider,
                !provider.isEmpty
            {
                return provider
            }
            if let provider = state.roster?.first(where: { $0.id == activeId })?.provider,
                !provider.isEmpty
            {
                return provider
            }
        }
        return snapshot?.runSummary?.provider ?? card?.provider
    }
    private var thinkingModel: String? {
        guard let state = model.ensembleStates[taskId],
            let activeId = state.activeParticipantId,
            let model = state.roster?.first(where: { $0.id == activeId })?.model,
            !model.isEmpty
        else {
            return snapshot?.runSummary?.model
        }
        return model
    }
    private var liveProvider: String? {
        model.streamingProviders[taskId] ?? thinkingProvider
    }
    private var liveModel: String? {
        if liveProvider == thinkingProvider { return thinkingModel }
        if snapshot?.runSummary?.provider == liveProvider { return snapshot?.runSummary?.model }
        return nil
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
        guard let live = model.streamingTexts[taskId], !live.isEmpty else { return nil }
        return model.streamingRunIds[taskId]
    }
    private var threadAgentIdentity: ThreadAgentIdentity? {
        ThreadAgentIdentity(card: card)
    }
    private var allowsFirstTurnProviderChange: Bool {
        guard card?.isEnsemble != true, !isRunning else { return false }
        guard let snapshot else { return false }
        let rows = snapshot.rows ?? []
        return rows.isEmpty && (snapshot.totalRows ?? 0) == 0
    }
    private var showsEmptyWelcomeCanvas: Bool {
        guard card != nil, !isRunning else { return false }
        guard let snapshot else { return false }
        return (snapshot.rows ?? []).isEmpty && (snapshot.totalRows ?? 0) == 0
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

    /// Render-only grouping for finished snapshot rows. The wire projection
    /// stays one-message-one-row; this folds only adjacent tool-activity rows
    /// from the same run/speaker so a tool burst reads as one compact region.
    private enum TranscriptDisplayItem: Identifiable {
        case row(RemoteThreadSnapshot.Row)
        case toolBurst(
            id: String, rows: [RemoteThreadSnapshot.Row], lastRow: RemoteThreadSnapshot.Row)

        var id: String {
            switch self {
            case .row(let row): return row.id
            case .toolBurst(let id, _, _): return id
            }
        }

        var lastRow: RemoteThreadSnapshot.Row {
            switch self {
            case .row(let row): return row
            case .toolBurst(_, _, let lastRow): return lastRow
            }
        }
    }

    private var visibleDisplayItems: [TranscriptDisplayItem] {
        groupAdjacentToolRows(visibleRows)
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
        let segments = model.streamingSegments[taskId] ?? [model.streamingTexts[taskId] ?? ""]
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
        guard let first = rows.first, let last = rows.last else { return "tool-burst-empty" }
        return "tool-burst-\(first.id)-\(last.id)-\(rows.count)"
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
        guard let state = model.ensembleStates[taskId], state.roundId == roundId else {
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
        model.approvals.filter { $0.threadId == taskId }
    }
    private var threadQuestions: [MobileQuestionCard] {
        model.questions.filter { $0.threadId == taskId }
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
        List {
            Section {
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
                ForEach(visibleDisplayItems) { item in
                    Group {
                        switch item {
                        case .row(let row):
                            ThreadRowView(
                                model: model, threadId: taskId,
                                row: model.resolvedRow(row, threadId: taskId),
                                threadProvider: card?.provider,
                                agentIdentity: threadAgentIdentity)
                        case .toolBurst(_, let rows, _):
                            ToolBurstRowView(
                                rows: rows.map { model.resolvedRow($0, threadId: taskId) },
                                agentIdentity: threadAgentIdentity)
                        }
                    }
                        .listRowInsets(EdgeInsets(top: 2, leading: 12, bottom: 2, trailing: 12))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                    // Desktop parity: each run's Task-complete card follows
                    // its final transcript row, persisting in the thread.
                    if let runCard = runCardSummary(after: item.lastRow) {
                        // Legacy diff lane keyed to ITS OWN run — a stale
                        // envelope from an older run must not decorate a
                        // newer no-edit card. run.fileChanges (per-run, in
                        // the snapshot) is the primary source either way.
                        TaskCompleteCard(
                            run: runCard,
                            diff: model.diffSummaries[taskId]?.runId == runCard.runId
                                ? model.diffSummaries[taskId] : nil
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
                } else if isRunning {
                    ThinkingRow(
                        provider: thinkingProvider,
                        model: thinkingModel,
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
                    if (snapshot?.totalRows ?? 0) > 0 {
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
                if let run = unanchoredRunCardSummary {
                    TaskCompleteCard(
                        run: run,
                        diff: model.diffSummaries[taskId]?.runId == run.runId
                            ? model.diffSummaries[taskId] : nil
                    )
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
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
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(TWTheme.appBg)
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 4) {
                topActionBanner
                attentionBanner
            }
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
                    .transition(.scale.combined(with: .opacity))
                }
                #if canImport(UIKit)
                    if keyboardVisible {
                        Button {
                            dismissKeyboard()
                        } label: {
                            floatingTranscriptPill(systemName: "keyboard.chevron.compact.down")
                        }
                        .buttonStyle(.plain)
                        .transition(.scale.combined(with: .opacity))
                    }
                #endif
            }
            .padding(.bottom, 14)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            // AnyView stage-break: the shell stack (banner + changes rows +
            // roster row + composer + rail) exceeds xcodebuild's stricter
            // type-check budget when inlined into the List chain.
            if !showsEmptyWelcomeCanvas {
                AnyView(composerShellStack)
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
        case .toolRow(let row):
            ThreadRowView(
                model: model, threadId: taskId,
                row: model.resolvedRow(row, threadId: taskId),
                threadProvider: card?.provider,
                agentIdentity: threadAgentIdentity)
        case .text(_, let content, let isTail):
            StreamingSegmentRow(
                text: content,
                isTail: isTail,
                agentIdentity: threadAgentIdentity,
                participants: model.ensembleStates[taskId]?.participants ?? [],
                onRevealFrame: {
                    requestFollowPin(proxy)
                })
        }
    }

    private func floatingTranscriptPill(systemName: String) -> some View {
        Image(systemName: systemName)
            .font(.system(size: 15, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: 34, height: 34)
            .background(Circle().fill(Color.black.opacity(0.85)))
            .overlay(Circle().strokeBorder(Color.white.opacity(0.35), lineWidth: 1))
            .shadow(color: .black.opacity(0.45), radius: 7, y: 2)
    }

    @ViewBuilder
    private var composerShellStack: some View {
            VStack(spacing: 4) {
                if let card {
                    // T72 — global chats keep the full composer: the Mac
                    // clamps phone-origin turns to plan mode (no file
                    // mutation), and the composer pins its picker to match.
                    let diff = model.diffSummaries[taskId]
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
                    // Composer and RESETS its @FocusState — so for grok (the only
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
                    let pillFilesChanged = primaryGitSnapshot?.counts?.changed ?? changedFileCount
                    let pillAdditions =
                        primaryGitSnapshot?.lineStats?.additions ?? diff?.additions ?? 0
                    let pillDeletions =
                        primaryGitSnapshot?.lineStats?.deletions ?? diff?.deletions ?? 0
                    if !composerFocused,
                        pillFilesChanged > 0 || pillAdditions > 0 || pillDeletions > 0
                    {
                        ComposerDiffPill(
                            filesChanged: pillFilesChanged,
                            additions: pillAdditions,
                            deletions: pillDeletions,
                            onTap: { openComposerDiff(workspaceId: primaryWorkspaceId) }
                        )
                        .padding(.horizontal, 10)
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
                                ) { openComposerDiff(workspaceId: workspaceId) }
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
                            ) { openComposerDiff(workspaceId: primaryWorkspaceId) }
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
                            ) { openComposerDiff(workspaceId: row.workspaceId) }
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
                            ) { openComposerDiff(workspaceId: secondaryWorkspaceId) }
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
                            }
                            Composer(
                                model: model, card: card, runModel: snapshot?.runSummary?.model,
                                runStatus: snapshot?.runSummary?.status,
                                attachedTop: (detached || tuckedTab)
                                    ? false
                                    : hasAboveContent,
                                // Idle (rail hidden) → round the composer's bottom;
                                // focused (rail present) → flatten to fuse the rail.
                                attachedBottom: composerFocused,
                                extraWorkspaceIds: extraWorkspaceIdsForSend(card: card),
                                allowsProviderChange: allowsFirstTurnProviderChange,
                                onFocusChange: { composerFocused = $0 },
                                // Every chat (incl. ensemble) collapses to one line
                                // when the keyboard drops — above rows + telemetry
                                // follow focus, not draft/queue presence.
                                forcesExpanded: false,
                                text: $followUp)
                            if composerFocused {
                                if !bareTelemetry {
                                    Rectangle().fill(TWTheme.border).frame(height: 1)
                                }
                                TelemetryFooterRail(
                                    run: snapshot?.runSummary,
                                    workspaceName: model.workspaceName(for: card.workspaceId),
                                    workspaceOptions: model.workspaces.map {
                                        (id: $0.id, name: $0.displayName)
                                    },
                                    primaryWorkspaceId: card.workspaceId,
                                    secondaryWorkspaceId: secondaryWorkspaceBinding,
                                    activeGoal: card.activeGoal,
                                    onGoalUpdate: { op, objective, reason in
                                        model.updateGoal(
                                            card, op: op, objective: objective, reason: reason)
                                    },
                                    planLanes: card.todoLanes ?? [])
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
        if card.isEnsemble,
            let queued = model.ensembleStates[taskId]?.queuedPrompts,
            !queued.isEmpty
        {
            // Stacked queued prompts (desktop parity) — one shared Mac-side
            // queue, any-device origin.
            QueuedPromptsStack(
                model: model, card: card, prompts: queued,
                isShellTop: !hasAttachedRows, onOwnCard: suppressFill
            ) { queuedText in
                followUp = queuedText
            }
            .composerShellIf(onOwnCards, resolved)
            if !onOwnCards {
                Rectangle().fill(TWTheme.border).frame(height: 1)
            }
        }
        if !card.isEnsemble,
            let queued = card.queuedComposerPrompts,
            !queued.isEmpty
        {
            QueuedComposerPromptsStack(
                model: model, card: card, prompts: queued,
                isShellTop: !hasAttachedRows, onOwnCard: suppressFill
            ) { queuedText in
                followUp = queuedText
            }
            .composerShellIf(onOwnCards, resolved)
            if !onOwnCards {
                Rectangle().fill(TWTheme.border).frame(height: 1)
            }
        }
        if card.isEnsemble, let wsId = card.workspaceId {
            // Roster row lives IN the shell, under the changes row(s).
            EditableRosterStrip(
                model: model, threadId: taskId, workspaceId: wsId,
                attached: true,
                isShellTop: !hasAttachedRows
                    && (model.ensembleStates[taskId]?.queuedPrompts ?? [])
                        .isEmpty,
                onOwnCard: suppressFill)
            .composerShellIf(onOwnCards, resolved)
            if !onOwnCards {
                Rectangle().fill(TWTheme.border).frame(height: 1)
            }
        }
    }

    private func openComposerDiff(workspaceId: String?) {
        if model.workspaceCanReviewDiffs(workspaceId) {
            model.requestDiffMode(workspaceId: workspaceId)
        } else {
            model.inspectorPresented = true
        }
    }

    private func navigationChrome(_ base: AnyView, proxy: ScrollViewProxy) -> some View {
        base
        .navigationTitle(card?.title ?? "Chat")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .task(id: taskId) {
            // On-demand transcript window — chats outside the recent-N
            // periodic snapshot have no rows until we ask. Also drop any
            // stale ack banner from the previously-open thread.
            model.clearActionMessage()
            model.visibleThreadId = taskId
            model.requestThreadSnapshot(taskId)
            autoFollow = true
            try? await Task.sleep(nanoseconds: 350_000_000)
            requestFollowPin(proxy, force: true)
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
        .onChange(of: model.streamingTexts[taskId] ?? "") { _, _ in
            guard autoFollow else { return }
            requestFollowPin(proxy, force: true)
        }
    }

    /// The single follow-pin path. Every streaming trigger — the pump's reveal
    /// frame (~24fps), each wire token batch, a new row, an ensemble participant
    /// switch — routes here, and they COALESCE to one scroll per runloop turn.
    /// The old code fired up to three concurrent scrolls (an animated 0.2s leap
    /// racing instant snaps), which is what jittered and skated the view past
    /// whole messages during fast ensemble passes / big Kimi chunks. Instant +
    /// coalesced + the pump's small reveal steps reads as a smooth glide.
    ///
    /// The scroll is deferred a main-actor turn so the List's backing
    /// UICollectionView has COMMITTED the new item set first — scrolling to an
    /// index path that isn't valid yet raised NSInternalInconsistencyException
    /// from `_validateScrollingTargetIndexPath:` (the cellular-only crash at the
    /// "Task complete" transition). `force` re-pins through a transient sentinel
    /// flip during a big (cellular-batched) update so following can't get stuck.
    private func requestFollowPin(_ proxy: ScrollViewProxy, force: Bool = false) {
        guard force || autoFollow else { return }
        guard !followPin.scheduled else { return }
        followPin.scheduled = true
        Task { @MainActor in
            // `defer` guarantees the coalescer re-arms no matter how the closure
            // exits, so the flag can never stick and wedge follow off.
            defer { followPin.scheduled = false }
            await Task.yield()
            guard force || autoFollow else { return }
            scrollSentinelToBottomNow(proxy)
            // Settle pass: a big layout (long message / a new participant's
            // block) can land the first scroll a hair short.
            await Task.yield()
            if force || autoFollow { scrollSentinelToBottomNow(proxy) }
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
            if let workspaceId = card?.workspaceId, model.workspaceCanEditFiles(workspaceId) {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        model.requestFilesMode(workspaceId: workspaceId)
                    } label: {
                        Label("Files", systemImage: "folder")
                    }
                }
            }
            if let workspaceId = card?.workspaceId, model.workspaceCanReviewDiffs(workspaceId) {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        model.requestDiffMode(workspaceId: workspaceId)
                    } label: {
                        Label("Diffs", systemImage: "plus.forwardslash.minus")
                    }
                }
            }
            ToolbarItem(placement: .primaryAction) {
                Button {
                    model.inspectorPresented.toggle()
                } label: {
                    Label("Inspector", systemImage: "sidebar.right")
                }
            }
        }

    }
}

struct ThreadEmptyWelcomeCanvas: View {
    @ObservedObject var model: RemoteSessionModel
    let card: RemoteTaskCard
    @Binding var draft: String
    @State private var draftProvider = ""
    @Environment(\.horizontalSizeClass) private var hSizeClass
    /// iPhone portrait = compact width; iPad (and landscape regular) = regular.
    private var isCompactWidth: Bool { hSizeClass == .compact }

    private var isGlobal: Bool { card.isGlobalScope }
    private var canSwitchPrimaryWorkspace: Bool { !isGlobal && !model.workspaces.isEmpty }
    private var accent: Color {
        if card.isEnsemble { return TWTheme.chroma2 }
        if isGlobal { return TWTheme.chroma3 }
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
    private var draftVariant: String { card.isEnsemble ? "ensemble" : "workspace" }
    private var currentDraftProvider: String? {
        let provider = draftProvider.trimmingCharacters(in: .whitespacesAndNewlines)
        return provider.isEmpty ? card.provider : provider
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
                if !isCompactWidth {
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
    }

    private var hero: some View {
        VStack(spacing: 10) {
            GhostMonolineMarkView(size: 46)
                .shadow(color: accent.opacity(0.45), radius: 18)
            Group {
                switch titleParts {
                case .scoped(let prefix, let name):
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
                }
            }
            .font(.title3)
            .multilineTextAlignment(.center)
            Text(blurb)
                .font(.footnote)
                .foregroundStyle(TWTheme.textTertiary)
                .multilineTextAlignment(.center)
        }
    }

    private enum TitleParts {
        case scoped(prefix: String, name: String)
        case plain(String)
    }

    private var titleParts: TitleParts {
        if card.isEnsemble {
            return .scoped(prefix: "New ensemble for ", name: workspaceName)
        }
        if isGlobal {
            return .plain("New global chat.")
        }
        return .scoped(prefix: "New chat for ", name: workspaceName)
    }

    private var blurb: String {
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
            title: card.title ?? "New Chat")
    }

    // CS-DASH — the Electron 4-tab welcome stats dashboard, ported to iOS. Sits
    // between the composer and the activity heatmap; the welcome VStack's maxWidth
    // 560 + ScrollView give it dynamic sizing (1-col stats on a phone, 2 on iPad).
    // Slice A renders the fixture; slice C swaps in `model.welcomeDashboard` (live).
    @ViewBuilder private var dashboardCard: some View {
        if let data = model.welcomeDashboard, data.lifetimeHasActivity {
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
                title: isGlobal ? "Global Activity" : "Workspace Activity",
                caption: isGlobal ? "global chats" : "current workspace",
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
    let head = speaker.split(whereSeparator: { $0 == "·" || $0 == "/" }).first.map {
        String($0).trimmingCharacters(in: .whitespaces)
    }
    guard let head, !head.isEmpty else { return fallback }
    let known = ["gemini", "codex", "claude", "kimi", "grok", "cursor", "ollama", "qwen"]
    guard known.contains(head.lowercased()) else { return fallback }
    return TWTheme.providerAccent(head.lowercased())
}

struct ThreadAgentIdentity: Equatable {
    let name: String
    let accentHex: String?
    let slug: String?

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
    }

    @MainActor var accent: Color { twAgentAccentColor(accentHex) }
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
                AgentIdentityBadge(
                    name: identity.name,
                    accentHex: identity.accentHex,
                    slug: identity.slug,
                    size: 20
                )
                .padding(.top, 1)
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

private struct AgentTranscriptRimModifier: ViewModifier {
    let identity: ThreadAgentIdentity?
    let enabled: Bool

    func body(content: Content) -> some View {
        if let identity, enabled {
            content
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(
                    LinearGradient(
                        colors: [identity.accent.opacity(0.14), TWTheme.surface1.opacity(0.56)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ),
                    in: RoundedRectangle(cornerRadius: 12)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .strokeBorder(identity.accent.opacity(0.56), lineWidth: 1.2)
                )
        } else {
            content
        }
    }
}

private extension View {
    func agentTranscriptRim(_ identity: ThreadAgentIdentity?, enabled: Bool = true) -> some View {
        modifier(AgentTranscriptRimModifier(identity: identity, enabled: enabled))
    }
}

struct ParticipantHealthSummaryCard: View {
    let summary: RemoteThreadSnapshot.Row.ParticipantHealth

    private var entries: [RemoteThreadSnapshot.Row.ParticipantHealth.Entry] {
        summary.entries ?? []
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
        let provider = entry.provider
        let providerAccent = TWTheme.providerAccent(provider)
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
                Text(TWTheme.providerLabel(provider))
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

struct ThreadRowView: View {
    @ObservedObject var model: RemoteSessionModel
    let threadId: String
    let row: RemoteThreadSnapshot.Row
    var threadProvider: String? = nil
    var agentIdentity: ThreadAgentIdentity? = nil

    private var isUser: Bool { row.role == "user" }
    private var isTool: Bool { row.role == "tool" || row.kind == "tool" }
    private var showExpand: Bool { row.truncated == true && !hasParticipantHealthCard }
    private var isExpanding: Bool { model.expandingRows.contains(row.id) }
    private var hasParticipantHealthCard: Bool {
        !(row.participantHealth?.entries?.isEmpty ?? true)
    }
    private var hasSubThreadReturnCard: Bool { row.subThreadReturn != nil }
    private var ensembleParticipants: [RemoteEnsembleState.Participant] {
        model.ensembleStates[threadId]?.participants ?? []
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            AgentTranscriptLeadingMark(
                identity: activeAgentIdentity,
                fallbackAccent: accentColor,
                hidden: isUser || hasParticipantHealthCard)
            VStack(alignment: .leading, spacing: 4) {
                if !hasParticipantHealthCard && !hasSubThreadReturnCard {
                    Text(label)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(labelColor)
                }
                if let health = row.participantHealth,
                    let entries = health.entries, !entries.isEmpty
                {
                    ParticipantHealthSummaryCard(summary: health)
                } else if let subThreadReturn = row.subThreadReturn {
                    SubThreadReturnSummaryCard(
                        summary: subThreadReturn,
                        resultText: row.preview ?? "",
                        participants: ensembleParticipants
                    )
                    .contextMenu {
                        Section(deliveredCaption ?? "") {
                            Button {
                                #if canImport(UIKit)
                                    UIPasteboard.general.string = row.preview ?? ""
                                #endif
                            } label: {
                                Label("Copy result", systemImage: "doc.on.doc")
                            }
                            if let card = model.taskCards.first(where: { $0.id == threadId }) {
                                Button {
                                    model.toggleMessagePin(card, messageId: row.id, pinned: true)
                                } label: {
                                    Label("Pin result", systemImage: "pin")
                                }
                            }
                        }
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
                if let thumbs = row.imageThumbnails, !thumbs.isEmpty {
                    #if canImport(UIKit)
                        TranscriptImageThumbnails(thumbnails: thumbs)
                    #else
                        imageAttachmentChip(thumbs.count)
                    #endif
                } else if let count = row.imageAttachmentCount, count > 0 {
                    imageAttachmentChip(count)
                }
                if !hasParticipantHealthCard && !hasSubThreadReturnCard,
                    let preview = row.preview, !preview.isEmpty
                {
                    MarkdownLite(
                        preview,
                        participants: ensembleParticipants,
                        baseColor: bodyColor
                    )
                    .textSelection(.enabled)
                    .contextMenu {
                        // Read-only delivery moment rides as the section
                        // header; the actions sit beneath it.
                        Section(deliveredCaption ?? "") {
                            Button {
                                #if canImport(UIKit)
                                    UIPasteboard.general.string = preview
                                #endif
                            } label: {
                                Label("Copy message", systemImage: "doc.on.doc")
                            }
                            if let card = model.taskCards.first(where: { $0.id == threadId }) {
                                Button {
                                    model.toggleMessagePin(card, messageId: row.id, pinned: true)
                                } label: {
                                    Label("Pin message", systemImage: "pin")
                                }
                            }
                        }
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
                    .disabled(isExpanding)
                }
            }
            .agentTranscriptRim(activeAgentIdentity)
            .frame(maxWidth: .infinity, alignment: .leading)
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
        guard let timestamp = row.timestamp, let date = twParseISODate(timestamp)
        else { return nil }
        let formatter = DateFormatter()
        formatter.dateFormat = Calendar.current.isDateInToday(date) ? "HH:mm" : "d MMM, HH:mm"
        return "Delivered \(formatter.string(from: date))"
    }

    private var activeAgentIdentity: ThreadAgentIdentity? {
        isUser ? nil : agentIdentity
    }

    private var baseLabel: String {
        if let speaker = row.speaker, !speaker.isEmpty { return speaker }
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

struct ToolBurstRowView: View {
    let rows: [RemoteThreadSnapshot.Row]
    var agentIdentity: ThreadAgentIdentity? = nil

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
            }
            .agentTranscriptRim(agentIdentity)
            .frame(maxWidth: .infinity, alignment: .leading)
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
    var agentIdentity: ThreadAgentIdentity? = nil

    private var accent: Color { agentIdentity?.accent ?? TWTheme.providerAccent(provider) }

    var body: some View {
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
                TokenRevealText(
                    target: text,
                    font: TWFont.transcript(),
                    color: TWTheme.textPrimary)
            }
            .agentTranscriptRim(agentIdentity)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 5)
    }

    private var headerLabel: String {
        if let agentIdentity {
            return agentIdentity.name
        }
        return model.map { "\(TWTheme.providerLabel(provider)) · \($0)" }
            ?? TWTheme.providerLabel(provider)
    }
}

/// Header line of the live streaming block — provider identity + activity
/// dots, pinned above the interleaved segments/tool rows. The body rows
/// below it (StreamingSegmentRow / ThreadRowView) carry the content.

struct StreamingLiveHeader: View {
    let provider: String?
    var model: String? = nil
    var agentIdentity: ThreadAgentIdentity? = nil

    private var accent: Color { agentIdentity?.accent ?? TWTheme.providerAccent(provider) }

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
            }
            .agentTranscriptRim(agentIdentity)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.top, 5)
    }

    private var headerLabel: String {
        agentIdentity?.name
            ?? model.map { "\(TWTheme.providerLabel(provider)) · \($0)" }
            ?? TWTheme.providerLabel(provider)
    }

    private var providerModelLabel: String {
        model.map { "\(TWTheme.providerLabel(provider)) · \($0)" }
            ?? TWTheme.providerLabel(provider)
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
    var onRevealFrame: (() -> Void)? = nil

    var body: some View {
        let parts =
            isTail
            ? StreamingMarkdownSplitter.split(text)
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
                        onRevealFrame: onRevealFrame)
                }
            }
            .agentTranscriptRim(agentIdentity)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 5)
    }
}

/// "Thinking…" indicator shown while a run is active but no content has
/// streamed yet — replaces the static status chip during runs (desktop
/// parity with the transcript's thinking element).

struct ThinkingRow: View {
    let provider: String?
    var model: String? = nil
    var agentIdentity: ThreadAgentIdentity? = nil

    private var accent: Color { agentIdentity?.accent ?? TWTheme.providerAccent(provider) }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            AgentTranscriptLeadingMark(
                identity: agentIdentity,
                fallbackAccent: accent,
                hidden: false)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(agentIdentity?.name ?? TWTheme.providerLabel(provider))
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(accent)
                    if let model, !model.isEmpty {
                        Text(model)
                            .font(.caption2.weight(.semibold))
                            .lineLimit(1)
                            .foregroundStyle(TWTheme.textTertiary)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(TWTheme.surface3, in: Capsule())
                    }
                }
                HStack(alignment: .center, spacing: 8) {
                    ShimmerThinkingText()
                    StreamingDots(color: TWTheme.textSecondary)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
            }
            .agentTranscriptRim(agentIdentity)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 5)
    }
}

/// Desktop-style shimmer sweep for the transcript's in-flight "Thinking" label.
struct ShimmerThinkingText: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase: CGFloat = -1.2

    var body: some View {
        Group {
            if reduceMotion {
                Text("Thinking")
                    .font(TWFont.transcript(16, weight: .medium))
                    .foregroundStyle(TWTheme.textPrimary)
            } else {
                Text("Thinking")
                    .font(TWFont.transcript(16, weight: .medium))
                    .foregroundStyle(
                        LinearGradient(
                            stops: [
                                .init(color: TWTheme.textSecondary.opacity(0.7), location: 0.0),
                                .init(color: TWTheme.textSecondary.opacity(0.7), location: 0.35),
                                .init(color: TWTheme.textPrimary, location: 0.5),
                                .init(color: TWTheme.textSecondary.opacity(0.7), location: 0.65),
                                .init(color: TWTheme.textSecondary.opacity(0.7), location: 1.0)
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
    }
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
