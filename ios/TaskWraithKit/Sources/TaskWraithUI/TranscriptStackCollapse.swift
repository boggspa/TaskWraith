import Foundation
import TaskWraithKit

// Settled-stack collapse (desktop parity, 2026-07). Once the conversation
// has moved past a run of thinking + tool rows, the whole stack folds into a
// one-line summary ("Thought · Searched ×8 · Read 5 files"), expandable back
// to the untouched row rendering. Plain system notices fold the same way
// ("System · @-mention: extra turn appended…"). Pure row-level predicates and
// label builders live here so they unit-test without the view layer;
// ThreadDetailViews owns the display-item fold and the expansion state.

/// One " · "-joined segment of the collapsed summary line (desktop
/// `CollapsedStackLabelPart` parity). `verb` is the leading action word
/// ("Ran", "Edited") — the failure-accent target when `failed` is set; a
/// failed part with no verb (the error tally) accents the whole segment.
public struct TWCollapsedStackLabelPart: Equatable, Sendable {
    public let text: String
    public let verb: String
    /// True when an activity behind this segment exited with error status.
    public let failed: Bool

    public init(text: String, verb: String, failed: Bool) {
        self.text = text
        self.verb = verb
        self.failed = failed
    }
}

public struct TWCollapsedStackSummary: Equatable, Sendable {
    public let label: String
    /// The same line as segments with per-family failure attribution, so the
    /// row can paint just the verb of the family that failed. INVARIANT:
    /// `label` is exactly `parts.map(\.text).joined(separator: " · ")` —
    /// a11y strings and cross-surface parity rely on the byte equality.
    public let parts: [TWCollapsedStackLabelPart]
    public let errorCount: Int
    public let rowCount: Int

    public init(parts: [TWCollapsedStackLabelPart], errorCount: Int, rowCount: Int) {
        self.label = parts.map(\.text).joined(separator: " · ")
        self.parts = parts
        self.errorCount = errorCount
        self.rowCount = rowCount
    }
}

/// True when the row carries a card that must never be folded away into a
/// one-line summary. A fan-out lane result and a provider run failure join the
/// original four for different reasons: the fan-out card IS the only thing
/// attributing a lane to its seat, and a failure folded into "Used 3 tools"
/// would hide an error behind a summary that reads like success.
private func twCarriesUnfoldableCard(_ row: RemoteThreadSnapshot.Row) -> Bool {
    row.agentQuestion != nil || row.proposedPlan != nil || row.participantHealth != nil
        || row.subThreadReturn != nil || row.fanoutResult != nil || row.runFailure != nil
}

/// True when the transcript window carries a row that explains why `runId`
/// ended badly — the provider-failure card (bridge lane / stale-run settlement
/// / desktop stderr snippet all project one) or any plain error row belonging
/// to the run.
///
/// The Task-complete card's "See the transcript above for details." is only
/// honest when this holds. The Mac now always writes an explanation for a
/// failed run, but a run that failed under an OLDER build — or one whose
/// explanation sits above the loaded window — still has none, and the card
/// must say so rather than point at nothing.
public func twRunHasFailureExplanation(
    rows: [RemoteThreadSnapshot.Row], runId: String?
) -> Bool {
    guard let runId, !runId.isEmpty else { return false }
    return rows.contains { row in
        guard row.runId == runId else { return false }
        if row.runFailure != nil { return true }
        return row.role == "error" || row.kind == "error"
    }
}

/// A row that carries ONLY a thinking trace (no answer body, no cards) —
/// absorbable into a settled stack alongside tool rows.
public func twIsThinkingOnlyRow(_ row: RemoteThreadSnapshot.Row) -> Bool {
    guard let preview = row.thinking?.preview, !preview.isEmpty else { return false }
    guard (row.preview ?? "").isEmpty else { return false }
    return !twCarriesUnfoldableCard(row)
}

/// Rows that may fold into a settled activity stack: tool rows (same gate as
/// tool-burst grouping) and thinking-only rows. Rows carrying interactive
/// cards keep their full rendering.
public func twCanCollapseIntoStack(_ row: RemoteThreadSnapshot.Row) -> Bool {
    if (row.role == "tool" || row.kind == "tool") && (row.toolSummary?.activityCount ?? 0) > 0 {
        return !twCarriesUnfoldableCard(row)
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
    guard !twCarriesUnfoldableCard(row) else { return false }
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

/// Merged one-line label for a super-group of adjacent one-liners (desktop
/// `summarizeCollapsedSuperGroup` parity): member stacks merge through the
/// ordinary summarizer, then the interleaved system-notice count appends; an
/// all-system group leads with the count and the first notice's text.
public func twCollapsedSuperStackSummary(
    stackRows: [RemoteThreadSnapshot.Row],
    systemCount: Int,
    firstSystemPreview: String
) -> TWCollapsedStackSummary {
    let noticeSuffix =
        systemCount > 0 ? "\(systemCount) system \(systemCount == 1 ? "notice" : "notices")" : ""
    if stackRows.isEmpty {
        // All-system group: notices are never failure-accented.
        let parts = [
            noticeSuffix.isEmpty ? "System notices" : noticeSuffix,
            firstSystemPreview
        ]
        .filter { !$0.isEmpty }
        .map { TWCollapsedStackLabelPart(text: $0, verb: "", failed: false) }
        return TWCollapsedStackSummary(parts: parts, errorCount: 0, rowCount: 0)
    }
    let merged = twCollapsedStackSummary(rows: stackRows)
    guard !noticeSuffix.isEmpty else { return merged }
    return TWCollapsedStackSummary(
        parts: merged.parts + [TWCollapsedStackLabelPart(text: noticeSuffix, verb: "", failed: false)],
        errorCount: merged.errorCount,
        rowCount: merged.rowCount)
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
    var failedFamilies: Set<String> = []
    var genericToolCount = 0
    var genericFailed = false

    for row in rows {
        if twIsThinkingOnlyRow(row) {
            // The wire has no per-row status for thinking-only rows, so a
            // failed thought cannot be attributed here (desktop reads the
            // local activity status). If the projection grows one, thread it
            // into a `failed:` on the Thought part below.
            sawThinking = true
            continue
        }
        guard let summary = row.toolSummary else { continue }
        let entries = summary.tools ?? []
        if entries.isEmpty {
            if summary.status == "error" {
                errorCount += 1
                genericFailed = true
            }
            genericToolCount += max(1, summary.activityCount ?? 1)
            continue
        }
        for entry in entries {
            let failed = entry.status == "error"
            if failed { errorCount += 1 }
            let category = entry.category ?? ""
            guard ["read", "write", "search", "shell"].contains(category) else {
                genericToolCount += 1
                if failed { genericFailed = true }
                continue
            }
            if failed { failedFamilies.insert(category) }
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

    var parts: [TWCollapsedStackLabelPart] = []
    if sawThinking {
        parts.append(TWCollapsedStackLabelPart(text: "Thought", verb: "Thought", failed: false))
    }
    for family in familyOrder {
        let count = familyCounts[family] ?? 0
        let files = familyFiles[family]?.count ?? 0
        let failed = failedFamilies.contains(family)
        switch family {
        case "read":
            parts.append(
                TWCollapsedStackLabelPart(
                    text: files > 0 ? "Read \(plural(files, "file"))" : "Read ×\(count)",
                    verb: "Read", failed: failed))
        case "write":
            parts.append(
                TWCollapsedStackLabelPart(
                    text: files > 0 ? "Edited \(plural(files, "file"))" : "Edited ×\(count)",
                    verb: "Edited", failed: failed))
        case "search":
            parts.append(
                TWCollapsedStackLabelPart(
                    text: count == 1 ? "Searched once" : "Searched ×\(count)",
                    verb: "Searched", failed: failed))
        case "shell":
            parts.append(
                TWCollapsedStackLabelPart(
                    text: "Ran \(plural(count, "command"))", verb: "Ran", failed: failed))
        default: break
        }
    }
    if genericToolCount > 0 {
        parts.append(
            TWCollapsedStackLabelPart(
                text: "Used \(plural(genericToolCount, "tool"))", verb: "Used",
                failed: genericFailed))
    }
    if parts.isEmpty {
        parts.append(TWCollapsedStackLabelPart(text: "Activity", verb: "", failed: false))
    }
    if errorCount > 0 {
        // Verbless failed part — the row accents the whole segment.
        parts.append(
            TWCollapsedStackLabelPart(text: plural(errorCount, "error"), verb: "", failed: true))
    }

    return TWCollapsedStackSummary(parts: parts, errorCount: errorCount, rowCount: rows.count)
}
