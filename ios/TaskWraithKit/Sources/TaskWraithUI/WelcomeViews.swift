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

    private var failed: Bool { run.status == "failed" || run.status == "error" }

    /// One row shape for both wire sources (run.fileChanges.files / diff.files).
    private struct ChangedFileRow: Identifiable {
        let path: String
        let status: String?
        let additions: Int?
        let deletions: Int?
        var id: String { path }
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
        return []
    }

    private var totalAdditions: Int? { run.fileChanges?.additions ?? diff?.additions }
    private var totalDeletions: Int? { run.fileChanges?.deletions ?? diff?.deletions }
    /// True changed-file count — the row list is capped on the wire.
    private var totalFilesChanged: Int {
        run.fileChanges?.filesChanged ?? diff?.filesChanged ?? fileRows.count
    }

    private var title: String { failed ? "Run failed" : "Task complete" }

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

    private var tokensText: String? {
        if let tin = run.tokensIn, let tout = run.tokensOut, tin + tout > 0 {
            return "\(compact(tin)) in / \(compact(tout)) out"
        }
        return nil
    }

    private func compact(_ value: Int) -> String {
        if value >= 1_000_000 { return String(format: "%.1fM", Double(value) / 1_000_000) }
        if value >= 1_000 { return String(format: "%.0fk", Double(value) / 1_000) }
        return "\(value)"
    }

    var body: some View {
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
                Text(failed ? "See the transcript above for details." : "Awaiting your next prompt.")
                    .font(.caption)
                    .foregroundStyle(TWTheme.textMuted)
            }

            VStack(spacing: 0) {
                Text("Run details")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                detailRow("MODEL", run.model ?? run.provider ?? "—")
                detailRow("STATUS", (run.status ?? "—").capitalized)
                if let workedFor {
                    detailRow("DURATION", workedFor.replacingOccurrences(of: "Worked for ", with: ""))
                }
                if let tokensText { detailRow("TOKENS", tokensText) }
                if let total = run.totalTokens, total > 0 {
                    detailRow("TOTAL", "\(compact(total)) tokens")
                }
                if let cost = run.costText { detailRow("COST", cost) }
            }
            .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TWTheme.border))

            if !fileRows.isEmpty {
                VStack(spacing: 0) {
                    HStack {
                        Text("File changes")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(TWTheme.textPrimary)
                        Spacer()
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
                    ForEach(fileRows.prefix(8)) { file in
                        HStack(spacing: 6) {
                            Circle()
                                .fill(
                                    file.status == "created" || file.status == "untracked"
                                        ? TWTheme.statusSuccess
                                        : file.status == "deleted"
                                            ? TWTheme.statusFailed : TWTheme.chroma1
                                )
                                .frame(width: 5, height: 5)
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
                .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TWTheme.border))
            }
        }
        .padding(10)
        .background(TWTheme.appBg.opacity(0.6), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(TWTheme.border))
    }

    private func detailRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .font(.caption2.weight(.medium))
                .foregroundStyle(TWTheme.textMuted)
            Spacer()
            Text(value)
                .font(.caption.weight(.semibold))
                .foregroundStyle(TWTheme.textPrimary)
                .multilineTextAlignment(.trailing)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .overlay(alignment: .top) {
            Rectangle().fill(TWTheme.border).frame(height: 0.5)
        }
    }
}
