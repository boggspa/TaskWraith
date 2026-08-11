// SwiftUI surface for the TaskWraith companion.
//
// Design direction (see ios/DESIGN.md): borrow the *format* of the Claude /
// Codex iOS apps — workspaces-as-projects home, thread view with collapsed
// history + tool chips, pill composer — but skinned entirely in TaskWraith's
// own theme tokens (TWTheme mirrors the desktop theme.css). iPhone focuses on
// solid thread management; iPad gets the sidebar (NavigationSplitView) where
// advanced affordances will live. Pure SwiftUI so `swift build` compile-checks
// on macOS; QR camera scanning is the one `#if os(iOS)` extra.

import SwiftUI
import TaskWraithKit

#if canImport(UIKit)
    import PhotosUI
    import UIKit
#endif

struct RunSummaryChip: View {
    let run: RemoteThreadSnapshot.RunSummary

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(TWTheme.statusColor(run.status)).frame(width: 6, height: 6)
            Text([run.provider, run.model, run.status].compactMap { $0 }.joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(TWTheme.textSecondary)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(TWTheme.surface2, in: Capsule())
    }
}

/// Bottom composer shell — the Swift equivalent of the desktop's per-provider
/// composer chrome: accent-tinted provider pill + border + send, provider-
/// addressed placeholder ("Ask Codex anything…"), and a model pill when the
/// thread's last run reported one.

/// Desktop "Task complete" card — appears after each run's final transcript
/// row and persists per thread (existing chats AND phone-initiated runs).
struct TaskCompleteCard: View {
    let run: RemoteThreadSnapshot.RunSummary
    /// Legacy file-change lane: the latest run's diffSummary envelope.
    /// `run.fileChanges` (per-run, every card) wins when the Mac sends it.
    var diff: MobileDiffSummary? = nil
    /// Recent per-run summaries from the Mac snapshot. Ensemble cards use this
    /// to fold every participant in the completed round into one token table
    /// when the Mac has not yet projected closeoutParticipantTable.
    var runSummaries: [RemoteThreadSnapshot.RunSummary] = []
    /// Current ensemble roster, already enriched with model ids by the session
    /// model so provider marks and Ollama display branding stay accurate.
    var participants: [RemoteEnsembleState.Participant] = []
    /// Tombstoned Participants table from the round/run close-out (desktop epic
    /// stack). When present, replaces the legacy P# Run-details grid.
    var closeoutParticipantTable: RemoteThreadSnapshot.Row.CloseoutParticipantTable? = nil
    /// Tombstoned Commits rows from the close-out (desktop epic stack).
    var closeoutCommits: [RemoteThreadSnapshot.Row.CloseoutCommit]? = nil
    /// Tombstoned File Changes rows from the close-out (desktop epic stack).
    /// Used when `run.fileChanges` / legacy diff are empty.
    var closeoutFileChanges: [RemoteThreadSnapshot.Row.CloseoutFileChange]? = nil
    /// Tombstoned Sub-threads rows from the close-out (desktop epic stack).
    var closeoutSubThreads: [RemoteThreadSnapshot.Row.CloseoutSubThread]? = nil
    /// Whether the transcript above actually carries this run's failure
    /// explanation (`twRunHasFailureExplanation`). A failed run used to be able
    /// to reach the phone with an empty tail — a bridge run that finalized with
    /// no errorMessage, or a run the stale-run reconciler settled — and this
    /// card sent the user looking for details that were never written.
    /// Defaults to the historical copy so fixtures/previews are unaffected.
    var hasFailureDetail: Bool = true

    private var usesEpicStack: Bool {
        (closeoutParticipantTable?.rows?.isEmpty == false)
            || (closeoutCommits?.isEmpty == false)
            || (closeoutFileChanges?.isEmpty == false)
            || (closeoutSubThreads?.isEmpty == false)
    }

    private var failed: Bool { run.status == "failed" || run.status == "error" }

    /// One row shape for both wire sources (run.fileChanges.files / diff.files).
    private struct ChangedFileRow: Identifiable {
        let path: String
        let status: String?
        let additions: Int?
        let deletions: Int?
        var id: String { path }
    }

    private struct IndexedRun {
        let index: Int
        let summary: RemoteThreadSnapshot.RunSummary
    }

    private struct TokenParticipant: Identifiable {
        let id: String
        let provider: String?
        let model: String?
        let numberLabel: String
        let roleLabel: String
        let tokens: Int?
    }

    private var fileRows: [ChangedFileRow] {
        if let files = run.fileChanges?.files, !files.isEmpty {
            return files.map {
                ChangedFileRow(
                    path: $0.path, status: $0.status,
                    additions: $0.additions, deletions: $0.deletions)
            }
        }
        if let files = diff?.files, !files.isEmpty {
            return files.map {
                ChangedFileRow(
                    path: $0.path, status: $0.status,
                    additions: $0.additions, deletions: $0.deletions)
            }
        }
        if let files = closeoutFileChanges, !files.isEmpty {
            return files.compactMap { file in
                guard let path = file.path, !path.isEmpty else { return nil }
                return ChangedFileRow(
                    path: path, status: file.status,
                    additions: file.additions, deletions: file.deletions)
            }
        }
        return []
    }

    private var totalAdditions: Int? {
        if let additions = run.fileChanges?.additions ?? diff?.additions { return additions }
        guard !(closeoutFileChanges?.isEmpty ?? true) else { return nil }
        return fileRows.compactMap(\.additions).reduce(0, +)
    }
    private var totalDeletions: Int? {
        if let deletions = run.fileChanges?.deletions ?? diff?.deletions { return deletions }
        guard !(closeoutFileChanges?.isEmpty ?? true) else { return nil }
        return fileRows.compactMap(\.deletions).reduce(0, +)
    }
    /// True changed-file count — the row list is capped on the wire.
    private var totalFilesChanged: Int {
        run.fileChanges?.filesChanged ?? diff?.filesChanged ?? fileRows.count
    }
    private var hasFileChangeSummary: Bool {
        run.fileChanges != nil || diff != nil || !(closeoutFileChanges?.isEmpty ?? true)
    }

    private var fileChangesMeta: String {
        if run.fileChanges != nil || diff != nil {
            let created = run.fileChanges?.createdFiles ?? 0
            let deleted = run.fileChanges?.deletedFiles ?? 0
            let modified =
                run.fileChanges?.modifiedFiles
                ?? max(0, totalFilesChanged - created - deleted)
            return "Created \(created) · Edited \(modified) · Deleted \(deleted)"
        }
        let created = fileRows.filter {
            $0.status == "created" || $0.status == "untracked"
        }.count
        let deleted = fileRows.filter { $0.status == "deleted" }.count
        let modified = max(0, fileRows.count - created - deleted)
        return "Created \(created) · Edited \(modified) · Deleted \(deleted)"
    }

    private var title: String { failed ? "Run failed" : "Task complete" }

    /// Failure-only footer — success no longer adds an "awaiting" row.
    private var runFooterLine: String? {
        guard failed else { return nil }
        return hasFailureDetail
            ? "See the transcript above for details."
            : "No failure details were recorded for this run."
    }

    private var workedFor: String? {
        guard let ms = run.durationMs else { return nil }
        let total = ms / 1000
        if total >= 3600 {
            return "Worked for \(total / 3600)h \((total % 3600) / 60)m"
        }
        if total >= 60 {
            return "Worked for \(total / 60) minute\(total / 60 == 1 ? "" : "s") \(total % 60) seconds"
        }
        return "Worked for \(total) seconds"
    }

    private var endedTime: String? {
        guard let ended = run.endedAt, let date = twParseISODate(ended) else { return nil }
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter.string(from: date)
    }

    private func compact(_ value: Int) -> String {
        if value >= 1_000_000 { return String(format: "%.1fM", Double(value) / 1_000_000) }
        if value >= 1_000 { return String(format: "%.0fk", Double(value) / 1_000) }
        return "\(value)"
    }

    private func clean(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
            !value.isEmpty
        else { return nil }
        return value
    }

    private func normalized(_ value: String?) -> String {
        clean(value)?.lowercased() ?? ""
    }

    private var relatedRuns: [RemoteThreadSnapshot.RunSummary] {
        guard let roundId = clean(run.ensembleRoundId) else { return [run] }
        let matches = runSummaries.filter { clean($0.ensembleRoundId) == roundId }
        return matches.isEmpty ? [run] : matches
    }

    private func tokenCount(_ summary: RemoteThreadSnapshot.RunSummary) -> Int? {
        let total = summary.totalTokens ?? ((summary.tokensIn ?? 0) + (summary.tokensOut ?? 0))
        return total > 0 ? total : nil
    }

    private var roundTotalTokens: Int? {
        let related = relatedRuns
        let summed = related.compactMap(tokenCount).reduce(0, +)
        if related.count > 1, summed > 0 { return summed }
        return tokenCount(run) ?? (summed > 0 ? summed : nil)
    }

    private var sortedParticipants: [RemoteEnsembleState.Participant] {
        participants.sorted {
            let leftOrder = $0.order ?? Int.max
            let rightOrder = $1.order ?? Int.max
            if leftOrder != rightOrder { return leftOrder < rightOrder }
            return $0.participantId < $1.participantId
        }
    }

    private func participantNumber(order: Int?, fallbackIndex: Int) -> String {
        if let order, order > 0 { return "P\(order)" }
        return "P\(fallbackIndex + 1)"
    }

    private func participantRoleLabel(
        provider: String?, model: String?, role: String?
    ) -> String {
        if let role = clean(role) { return role }
        return TWTheme.providerLabel(provider, modelId: model, modelLabel: model)
    }

    private func matches(
        _ summary: RemoteThreadSnapshot.RunSummary, participant: RemoteEnsembleState.Participant
    ) -> Bool {
        guard normalized(summary.provider) == normalized(participant.provider) else { return false }
        let summaryModel = normalized(summary.model)
        let participantModel = normalized(participant.model)
        if !summaryModel.isEmpty, !participantModel.isEmpty {
            return summaryModel == participantModel
        }
        return true
    }

    private func tokenSum(_ runs: [IndexedRun]) -> Int? {
        let total = runs.compactMap { tokenCount($0.summary) }.reduce(0, +)
        return total > 0 ? total : nil
    }

    private func cell(
        for participant: RemoteEnsembleState.Participant,
        assignedRuns: [IndexedRun],
        fallbackIndex: Int
    ) -> TokenParticipant {
        let representative = assignedRuns.first?.summary
        let provider = clean(participant.provider) ?? clean(representative?.provider)
        let model = clean(participant.model) ?? clean(representative?.model)
        let role = clean(participant.role) ?? clean(representative?.ensembleRole)
        return TokenParticipant(
            id: participant.participantId,
            provider: provider,
            model: model,
            numberLabel: participantNumber(order: participant.order, fallbackIndex: fallbackIndex),
            roleLabel: participantRoleLabel(provider: provider, model: model, role: role),
            tokens: tokenSum(assignedRuns))
    }

    private func derivedCell(for indexed: IndexedRun, fallbackIndex: Int) -> TokenParticipant {
        let summary = indexed.summary
        let provider = clean(summary.provider)
        let model = clean(summary.model)
        let role = clean(summary.ensembleRole)
        return TokenParticipant(
            id: clean(summary.ensembleParticipantId) ?? clean(summary.runId) ?? "run-\(indexed.index)",
            provider: provider,
            model: model,
            numberLabel: participantNumber(order: summary.ensembleOrder, fallbackIndex: fallbackIndex),
            roleLabel: participantRoleLabel(provider: provider, model: model, role: role),
            tokens: tokenCount(summary))
    }

    private var tokenParticipants: [TokenParticipant] {
        let indexedRuns = relatedRuns.enumerated().map { IndexedRun(index: $0.offset, summary: $0.element) }
        guard !sortedParticipants.isEmpty else {
            return indexedRuns.enumerated().map { offset, indexed in
                derivedCell(for: indexed, fallbackIndex: offset)
            }
        }

        var runsByParticipant: [String: [IndexedRun]] = [:]
        for indexed in indexedRuns {
            if let participantId = clean(indexed.summary.ensembleParticipantId) {
                runsByParticipant[participantId, default: []].append(indexed)
            }
        }

        var consumed = Set<Int>()
        var cells: [TokenParticipant] = []
        for (index, participant) in sortedParticipants.enumerated() {
            var assigned = runsByParticipant[participant.participantId] ?? []
            if assigned.isEmpty,
                let fallback = indexedRuns.first(where: {
                    !consumed.contains($0.index)
                        && clean($0.summary.ensembleParticipantId) == nil
                        && matches($0.summary, participant: participant)
                })
            {
                assigned = [fallback]
            }
            for item in assigned { consumed.insert(item.index) }
            cells.append(cell(for: participant, assignedRuns: assigned, fallbackIndex: index))
        }

        for indexed in indexedRuns where !consumed.contains(indexed.index) {
            cells.append(derivedCell(for: indexed, fallbackIndex: cells.count))
        }
        return cells
    }

    private func accent(for cell: TokenParticipant) -> Color {
        TWTheme.providerAccent(cell.provider, modelId: cell.model, modelLabel: cell.model)
    }

    private func participantColumnWidth(available: CGFloat, count: Int, dense: Bool) -> CGFloat {
        let totalWidth: CGFloat = dense ? 78 : 92
        let minWidth: CGFloat = dense ? 64 : 112
        let fill = (available - totalWidth) / CGFloat(max(count, 1))
        return max(minWidth, fill.rounded(.down))
    }

    private func tokenHeaderCell(_ cell: TokenParticipant, dense: Bool) -> some View {
        let accent = accent(for: cell)
        return HStack(spacing: 5) {
            // Satellite mark: no tinted chip behind the logo. The 18pt frame
            // is the old container's footprint, kept so the participant
            // columns don't reflow; the logo grows into the space the chip
            // used to occupy rather than shrinking to fit inside it.
            ProviderLogoIcon(provider: cell.provider, modelId: cell.model, size: 16)
                .frame(width: 18, height: 18)
            Text(dense ? cell.numberLabel : "\(cell.numberLabel) \(cell.roleLabel)")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(accent)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .overlay(alignment: .trailing) {
            Rectangle().fill(TWTheme.border).frame(width: 0.5)
        }
    }

    private func tokenValueCell(_ cell: TokenParticipant) -> some View {
        Text(cell.tokens.map(compact) ?? "-")
            .font(.caption.monospacedDigit())
            .foregroundStyle(cell.tokens == nil ? TWTheme.textMuted : TWTheme.textPrimary)
            .lineLimit(1)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            .overlay(alignment: .top) {
                Rectangle().fill(TWTheme.border).frame(height: 0.5)
            }
            .overlay(alignment: .trailing) {
                Rectangle().fill(TWTheme.border).frame(width: 0.5)
            }
    }

    private func roundTotalHeaderCell() -> some View {
        Text("ROUND TOTAL")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(TWTheme.textMuted)
            .lineLimit(1)
            .minimumScaleFactor(0.72)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }

    private func roundTotalValueCell(_ total: Int?) -> some View {
        Text(total.map(compact) ?? "-")
            .font(.caption.monospacedDigit())
            .foregroundStyle(total == nil ? TWTheme.textMuted : TWTheme.textPrimary)
            .lineLimit(1)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            .overlay(alignment: .top) {
                Rectangle().fill(TWTheme.border).frame(height: 0.5)
            }
    }

    private func runDetailsTokenTable(
        cells: [TokenParticipant], roundTotal: Int?, dense: Bool
    ) -> some View {
        GeometryReader { proxy in
            let totalWidth: CGFloat = dense ? 78 : 92
            let participantWidth = participantColumnWidth(
                available: proxy.size.width, count: cells.count, dense: dense)
            let tableWidth = participantWidth * CGFloat(max(cells.count, 1)) + totalWidth
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(horizontalSpacing: 0, verticalSpacing: 0) {
                    GridRow {
                        ForEach(cells) { cell in
                            tokenHeaderCell(cell, dense: dense)
                                .frame(width: participantWidth, height: dense ? 30 : 34)
                        }
                        roundTotalHeaderCell()
                            .frame(width: totalWidth, height: dense ? 30 : 34)
                    }
                    GridRow {
                        ForEach(cells) { cell in
                            tokenValueCell(cell)
                                .frame(width: participantWidth, height: 32)
                        }
                        roundTotalValueCell(roundTotal)
                            .frame(width: totalWidth, height: 32)
                    }
                }
                .frame(width: max(proxy.size.width, tableWidth), alignment: .leading)
            }
        }
        .frame(height: dense ? 62 : 66)
    }

    @ViewBuilder
    private var fileChangesSection: some View {
        if hasFileChangeSummary {
            VStack(spacing: 0) {
                HStack {
                    Text("File changes")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TWTheme.textPrimary)
                    Spacer()
                    Text(fileChangesMeta)
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textMuted)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    if let additions = totalAdditions, additions > 0 {
                        Text("+\(additions)")
                            .font(.caption2.monospacedDigit().weight(.semibold))
                            .foregroundStyle(TWTheme.statusSuccess)
                    }
                    if let deletions = totalDeletions, deletions > 0 {
                        Text("−\(deletions)")
                            .font(.caption2.monospacedDigit().weight(.semibold))
                            .foregroundStyle(TWTheme.statusFailed)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                if fileRows.isEmpty {
                    Text(
                        totalFilesChanged > 0
                            ? "\(totalFilesChanged) file\(totalFilesChanged == 1 ? "" : "s") changed."
                            : "No file changes detected."
                    )
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                } else {
                    ForEach(Array(fileRows.prefix(8).enumerated()), id: \.element.id) { _, file in
                        HStack(spacing: 6) {
                            Circle()
                                .fill(
                                    file.status == "created" || file.status == "untracked"
                                        ? TWTheme.statusSuccess
                                        : file.status == "deleted"
                                            ? TWTheme.statusFailed : TWTheme.chroma1
                                )
                                .frame(width: 5, height: 5)
                            Text(file.status?.capitalized ?? "Edited")
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(TWTheme.chroma1)
                                .frame(width: 52, alignment: .leading)
                            Text(file.path)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(TWTheme.textSecondary)
                                .lineLimit(1)
                                .truncationMode(.head)
                            Spacer(minLength: 4)
                            if let additions = file.additions, additions > 0 {
                                Text("+\(additions)")
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(TWTheme.statusSuccess)
                            }
                            if let deletions = file.deletions, deletions > 0 {
                                Text("−\(deletions)")
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(TWTheme.statusFailed)
                            }
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(TWTheme.surface2.opacity(0.55))
                    }
                    if totalFilesChanged > min(8, fileRows.count) {
                        Text("+\(totalFilesChanged - min(8, fileRows.count)) more files changed")
                            .font(.caption2)
                            .foregroundStyle(TWTheme.textMuted)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 10)
                            .padding(.bottom, 6)
                    }
                }
            }
            .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TWTheme.border))
        }
    }

    var body: some View {
        let cells = tokenParticipants
        let dense = cells.count >= 6
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(failed ? TWTheme.statusFailed : TWTheme.textPrimary)
                HStack(spacing: 4) {
                    if let endedTime {
                        Text(endedTime).foregroundStyle(TWTheme.textTertiary)
                        Text("|").foregroundStyle(TWTheme.textMuted)
                    }
                    if let workedFor {
                        Text(workedFor).foregroundStyle(TWTheme.textTertiary)
                    }
                }
                .font(.caption)
                if let runFooterLine {
                    Text(runFooterLine)
                        .font(.caption)
                        .foregroundStyle(TWTheme.textMuted)
                }
            }

            if usesEpicStack {
                RunCompleteEpicStack(
                    participantTable: closeoutParticipantTable,
                    commits: closeoutCommits,
                    subThreads: closeoutSubThreads
                ) {
                    fileChangesSection
                }
            } else {
                // Legacy Mac / pre-epic snapshot: keep the P# token grid so
                // older transcripts still show a Participants-like summary.
                VStack(spacing: 0) {
                    Text("Run details")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TWTheme.textPrimary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                    runDetailsTokenTable(cells: cells, roundTotal: roundTotalTokens, dense: dense)
                }
                .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TWTheme.border))

                fileChangesSection
            }
        }
        .padding(10)
        .background(TWTheme.appBg.opacity(0.6), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(TWTheme.border))
    }
}
