import Foundation
import TaskWraithKit

// Settled-stack collapse (desktop parity, 2026-07). Once the conversation
// has moved past a run of thinking + tool rows, the whole stack folds into a
// one-line summary ("Thought · Searched ×8 · Read 5 files"), expandable back
// to the untouched row rendering. Plain system notices fold the same way
// ("System · @-mention: extra turn appended…"). Pure row-level predicates and
// label builders live here so they unit-test without the view layer;
// ThreadDetailViews owns the display-item fold and the expansion state.

public struct TWCollapsedStackSummary: Equatable, Sendable {
    public let label: String
    public let errorCount: Int
    public let rowCount: Int
}

/// A row that carries ONLY a thinking trace (no answer body, no cards) —
/// absorbable into a settled stack alongside tool rows.
public func twIsThinkingOnlyRow(_ row: RemoteThreadSnapshot.Row) -> Bool {
    guard let preview = row.thinking?.preview, !preview.isEmpty else { return false }
    guard (row.preview ?? "").isEmpty else { return false }
    return row.agentQuestion == nil && row.proposedPlan == nil && row.participantHealth == nil
        && row.subThreadReturn == nil
}

/// Rows that may fold into a settled activity stack: tool rows (same gate as
/// tool-burst grouping) and thinking-only rows. Rows carrying interactive
/// cards keep their full rendering.
public func twCanCollapseIntoStack(_ row: RemoteThreadSnapshot.Row) -> Bool {
    if (row.role == "tool" || row.kind == "tool") && (row.toolSummary?.activityCount ?? 0) > 0 {
        return row.agentQuestion == nil && row.proposedPlan == nil && row.participantHealth == nil
            && row.subThreadReturn == nil
    }
    return twIsThinkingOnlyRow(row)
}

/// Plain system notices ("@-mention: extra turn appended…", round-close
/// markers) collapse to one line. Special system surfaces keep their full
/// rendering: context-compaction cards, question/plan/health/sub-thread
/// cards, and rows with media attachments.
public func twIsPlainSystemNoticeRow(_ row: RemoteThreadSnapshot.Row) -> Bool {
    guard row.role == "system" || row.kind == "system" else { return false }
    guard let preview = row.preview, !preview.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else { return false }
    guard row.agentQuestion == nil, row.proposedPlan == nil, row.participantHealth == nil,
        row.subThreadReturn == nil
    else { return false }
    guard (row.toolSummary?.activityCount ?? 0) == 0 else { return false }
    guard (row.thinking?.preview ?? "").isEmpty else { return false }
    guard (row.media ?? []).isEmpty, (row.imageThumbnails ?? []).isEmpty,
        (row.imageAttachmentCount ?? 0) == 0
    else { return false }
    guard !ContextCompactionSummaryCard.matches(preview: preview, role: row.role, kind: row.kind)
    else { return false }
    return true
}

/// One-line label for a collapsed system notice: the first non-empty line.
public func twCollapsedSystemNoticeLabel(_ preview: String?) -> String {
    for line in (preview ?? "").split(separator: "\n", omittingEmptySubsequences: false) {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if !trimmed.isEmpty { return trimmed }
    }
    return "System notice"
}

/// Build the one-line collapsed summary for a settled stack. Thinking leads
/// (it visually leads the expanded stack too); tool families follow in
/// first-appearance order so the summary reads in the same sequence the work
/// happened. Reads/edits count distinct files; entries the wire truncated
/// away (activityCount > tools.count) fold into a generic tools bucket.
public func twCollapsedStackSummary(rows: [RemoteThreadSnapshot.Row]) -> TWCollapsedStackSummary {
    var sawThinking = false
    var errorCount = 0
    var familyOrder: [String] = []
    var familyCounts: [String: Int] = [:]
    var familyFiles: [String: Set<String>] = [:]
    var genericToolCount = 0

    for row in rows {
        if twIsThinkingOnlyRow(row) {
            sawThinking = true
            continue
        }
        guard let summary = row.toolSummary else { continue }
        let entries = summary.tools ?? []
        if entries.isEmpty {
            if summary.status == "error" { errorCount += 1 }
            genericToolCount += max(1, summary.activityCount ?? 1)
            continue
        }
        for entry in entries {
            if entry.status == "error" { errorCount += 1 }
            let category = entry.category ?? ""
            guard ["read", "write", "search", "shell"].contains(category) else {
                genericToolCount += 1
                continue
            }
            if familyCounts[category] == nil { familyOrder.append(category) }
            familyCounts[category, default: 0] += 1
            if let file = entry.file, !file.isEmpty {
                familyFiles[category, default: []].insert(file)
            }
        }
        genericToolCount += max(0, (summary.activityCount ?? entries.count) - entries.count)
    }

    func plural(_ count: Int, _ singular: String) -> String {
        "\(count) \(count == 1 ? singular : singular + "s")"
    }

    var parts: [String] = []
    if sawThinking { parts.append("Thought") }
    for family in familyOrder {
        let count = familyCounts[family] ?? 0
        let files = familyFiles[family]?.count ?? 0
        switch family {
        case "read": parts.append(files > 0 ? "Read \(plural(files, "file"))" : "Read ×\(count)")
        case "write":
            parts.append(files > 0 ? "Edited \(plural(files, "file"))" : "Edited ×\(count)")
        case "search": parts.append(count == 1 ? "Searched once" : "Searched ×\(count)")
        case "shell": parts.append("Ran \(plural(count, "command"))")
        default: break
        }
    }
    if genericToolCount > 0 { parts.append("Used \(plural(genericToolCount, "tool"))") }
    if parts.isEmpty { parts.append("Activity") }
    if errorCount > 0 { parts.append(plural(errorCount, "error")) }

    return TWCollapsedStackSummary(
        label: parts.joined(separator: " · "), errorCount: errorCount, rowCount: rows.count)
}
