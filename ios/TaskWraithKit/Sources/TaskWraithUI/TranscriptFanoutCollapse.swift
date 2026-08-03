import Foundation
import TaskWraithKit

// Settled fan-out collapse (desktop parity, 2026-08). A completed fan-out
// wave is much easier to scan as one disclosure than as a wall of lane cards,
// but the active wave must stay open so its progress and ownership are visible.
// This module recovers those waves from the bounded remote transcript without
// changing the wire: a durable dispatch receipt opens a wave and its lane cards
// provide the attributed content. ThreadDetailViews owns expanded state and
// restores the untouched lane cards on demand.

enum TWFanoutViewportStage: String, Equatable, Sendable {
    case scout
    case work
    case review
    case background
    case all
    case specified

    var label: String {
        switch self {
        case .scout: return "Scout"
        case .work: return "Work"
        case .review: return "Review"
        case .background: return "BG"
        case .all: return "All"
        case .specified: return "Specified"
        }
    }
}

struct TWFanoutViewportAttribution: Equatable, Sendable, Identifiable {
    let participantId: String?
    let provider: String?
    let role: String?
    let model: String?

    var id: String {
        participantId ?? [provider ?? "", role ?? "", model ?? ""].joined(separator: "\u{0}")
    }
}

/// One fan-out pass that can safely render as a one-line disclosure. `laneRows`
/// deliberately preserves the original rows rather than producing a synthetic
/// transcript message; expanding a group therefore restores the exact cards
/// that appeared before collapse.
struct TWFanoutViewportGroup: Equatable, Sendable, Identifiable {
    let id: String
    let roundId: String?
    let anchorRowId: String
    let anchorIndex: Int
    let dispatchLabel: String?
    let stage: TWFanoutViewportStage
    let laneRows: [RemoteThreadSnapshot.Row]
    let laneCount: Int
    let attributions: [TWFanoutViewportAttribution]
    let lastRow: RemoteThreadSnapshot.Row
}

private let fanoutDispatchRegex = try! NSRegularExpression(
    pattern: "^(.*?) · (\\d+) (?:participant\\(s\\)|read-only participants) dispatched concurrently\\b")

private struct TWFanoutDispatchReceipt {
    let label: String
    let expectedLaneCount: Int
}

private struct TWFanoutIndexedLane {
    let row: RemoteThreadSnapshot.Row
    let index: Int
    let laneKey: String
}

private struct TWFanoutMutableGroup {
    let anchorRow: RemoteThreadSnapshot.Row
    let anchorIndex: Int
    let roundId: String?
    let dispatchLabel: String?
    let expectedLaneCount: Int?
    let stage: TWFanoutViewportStage
    var laneRows: [TWFanoutIndexedLane] = []
    var canonicalLaneKeys: [String] = []
    var latestLaneByKey: [String: TWFanoutIndexedLane] = [:]

    var laneCount: Int { canonicalLaneKeys.count }

    mutating func append(_ lane: TWFanoutIndexedLane) {
        laneRows.append(lane)
        if latestLaneByKey[lane.laneKey] == nil {
            canonicalLaneKeys.append(lane.laneKey)
        }
        latestLaneByKey[lane.laneKey] = lane
    }

    var canonicalLanes: [TWFanoutIndexedLane] {
        canonicalLaneKeys.compactMap { latestLaneByKey[$0] }
    }
}

private func twNonempty(_ value: String?) -> String? {
    guard let value else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
}

private func twFanoutDispatchReceipt(
    _ row: RemoteThreadSnapshot.Row
) -> TWFanoutDispatchReceipt? {
    guard row.role == "system" || row.kind == "system" else { return nil }
    guard let preview = twNonempty(row.preview) else { return nil }
    let range = NSRange(preview.startIndex..., in: preview)
    guard let match = fanoutDispatchRegex.firstMatch(in: preview, range: range), match.numberOfRanges == 3
    else { return nil }
    let label = (preview as NSString).substring(with: match.range(at: 1))
        .trimmingCharacters(in: .whitespacesAndNewlines)
    let countText = (preview as NSString).substring(with: match.range(at: 2))
    guard !label.isEmpty, let count = Int(countText), count > 0 else { return nil }
    return TWFanoutDispatchReceipt(label: label, expectedLaneCount: count)
}

private func twFanoutStage(dispatchLabel: String) -> TWFanoutViewportStage {
    let normalized = dispatchLabel.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if normalized.contains("scout") || normalized == "automatic read stage" { return .scout }
    if normalized.contains("review") { return .review }
    if normalized.contains("background") { return .background }
    if normalized == "full fan-out" || normalized == "ensemble fan-out" { return .all }
    if normalized.contains("worker") || normalized.contains("writer") || normalized.contains("write-scope") {
        return .work
    }
    return .specified
}

private func twFanoutLaneKey(_ row: RemoteThreadSnapshot.Row) -> String? {
    guard let laneId = twNonempty(row.fanoutResult?.laneId) else { return nil }
    return "\(row.runId ?? "")\u{0}\(laneId)"
}

private func twFanoutRoundId(
    _ row: RemoteThreadSnapshot.Row,
    summariesByRunId: [String: RemoteThreadSnapshot.RunSummary]
) -> String? {
    if let roundId = twNonempty(row.ensembleRoundId) { return roundId }
    guard let runId = twNonempty(row.runId) else { return nil }
    return twNonempty(summariesByRunId[runId]?.ensembleRoundId)
}

private func twFanoutGroups(
    rows: [RemoteThreadSnapshot.Row],
    summariesByRunId: [String: RemoteThreadSnapshot.RunSummary]
) -> [TWFanoutMutableGroup] {
    var groups: [TWFanoutMutableGroup] = []
    var openGroupIndexes: [Int] = []
    var groupByLaneKey: [String: Int] = [:]
    var legacyGroupIndex: Int?

    for (index, row) in rows.enumerated() {
        if let receipt = twFanoutDispatchReceipt(row) {
            groups.append(
                TWFanoutMutableGroup(
                    anchorRow: row,
                    anchorIndex: index,
                    roundId: twFanoutRoundId(row, summariesByRunId: summariesByRunId),
                    dispatchLabel: receipt.label,
                    expectedLaneCount: receipt.expectedLaneCount,
                    stage: twFanoutStage(dispatchLabel: receipt.label)))
            openGroupIndexes.append(groups.count - 1)
            continue
        }

        guard let laneKey = twFanoutLaneKey(row) else { continue }
        let lane = TWFanoutIndexedLane(row: row, index: index, laneKey: laneKey)
        if let existingGroupIndex = groupByLaneKey[laneKey] {
            groups[existingGroupIndex].append(lane)
            continue
        }

        let laneRoundId = twFanoutRoundId(row, summariesByRunId: summariesByRunId)
        let compatibleOpenIndexes = openGroupIndexes.filter { groupIndex in
            guard let groupRoundId = groups[groupIndex].roundId, let laneRoundId else { return true }
            return groupRoundId == laneRoundId
        }
        let targetIndex = compatibleOpenIndexes.first ?? openGroupIndexes.last ?? legacyGroupIndex
        let groupIndex: Int
        if let targetIndex {
            groupIndex = targetIndex
        } else {
            // Historical transcripts may predate the durable dispatch receipt.
            // Use the first lane as the replacement anchor, but remain just as
            // conservative about terminal state and a later handoff below.
            groups.append(
                TWFanoutMutableGroup(
                    anchorRow: row,
                    anchorIndex: index,
                    roundId: laneRoundId,
                    dispatchLabel: nil,
                    expectedLaneCount: nil,
                    stage: .specified))
            groupIndex = groups.count - 1
            legacyGroupIndex = groupIndex
        }

        groups[groupIndex].append(lane)
        groupByLaneKey[laneKey] = groupIndex
        if let expectedLaneCount = groups[groupIndex].expectedLaneCount,
            groups[groupIndex].laneCount >= expectedLaneCount,
            let openIndex = openGroupIndexes.firstIndex(of: groupIndex)
        {
            openGroupIndexes.remove(at: openIndex)
        }
    }

    return groups.filter { !$0.canonicalLanes.isEmpty }
}

private func twFanoutRunIsTerminal(_ summary: RemoteThreadSnapshot.RunSummary) -> Bool {
    let status = (summary.status ?? "").lowercased()
    if status == "running" || status == "sleeping" { return false }
    if twNonempty(summary.endedAt) != nil { return true }
    return ["success", "success_with_warnings", "failed", "cancelled"].contains(status)
}

private func twFanoutLaneIsTerminal(
    _ lane: TWFanoutIndexedLane,
    summariesByRunId: [String: RemoteThreadSnapshot.RunSummary]
) -> Bool {
    guard let runId = twNonempty(lane.row.runId), let summary = summariesByRunId[runId] else {
        // With no run summary the phone cannot safely claim a wave is done.
        return false
    }
    return twFanoutRunIsTerminal(summary)
}

private func twStartsLaterFanoutTranscriptTurn(
    _ row: RemoteThreadSnapshot.Row,
    laneRunIds: Set<String>
) -> Bool {
    if twFanoutDispatchReceipt(row) != nil { return true }
    guard twFanoutLaneKey(row) == nil else { return false }
    // The wire omits the Mac metadata kind, but a non-lane participant row is
    // still identifiable by its ensemble round + run. This is the remote-safe
    // equivalent of desktop's ensembleParticipant / participant-tools check.
    guard let runId = twNonempty(row.runId), !laneRunIds.contains(runId) else { return false }
    return twNonempty(row.ensembleRoundId) != nil
}

private func twFanoutHasLaterRoundRun(
    _ group: TWFanoutMutableGroup,
    summaries: [RemoteThreadSnapshot.RunSummary]
) -> Bool {
    guard let roundId = group.roundId else { return false }
    let laneRunIds = Set(group.canonicalLanes.compactMap { twNonempty($0.row.runId) })
    var runIndexById: [String: Int] = [:]
    for (index, summary) in summaries.enumerated() {
        if let runId = twNonempty(summary.runId) { runIndexById[runId] = index }
    }
    let laneRunIndexes = laneRunIds.compactMap { runIndexById[$0] }
    guard let lastLaneRunIndex = laneRunIndexes.max() else { return false }
    return summaries.enumerated().contains { index, summary in
        index > lastLaneRunIndex && twNonempty(summary.ensembleRoundId) == roundId
            && !laneRunIds.contains(twNonempty(summary.runId) ?? "")
            && twNonempty(summary.startedAt) != nil
    }
}

private func twFanoutAttributions(
    _ lanes: [TWFanoutIndexedLane]
) -> [TWFanoutViewportAttribution] {
    var attributions: [TWFanoutViewportAttribution] = []
    var seen: Set<String> = []
    for lane in lanes {
        let fanout = lane.row.fanoutResult
        let provider = twNonempty(fanout?.provider)
        guard let provider else { continue }
        let attribution = TWFanoutViewportAttribution(
            participantId: twNonempty(fanout?.participantId),
            provider: provider,
            role: twNonempty(fanout?.role),
            model: twNonempty(fanout?.model))
        if seen.insert(attribution.id).inserted {
            attributions.append(attribution)
        }
    }
    return attributions
}

private func twShouldCollapseFanoutGroup(
    _ group: TWFanoutMutableGroup,
    rows: [RemoteThreadSnapshot.Row],
    summaries: [RemoteThreadSnapshot.RunSummary],
    summariesByRunId: [String: RemoteThreadSnapshot.RunSummary]
) -> Bool {
    let lanes = group.canonicalLanes
    guard !lanes.isEmpty else { return false }
    if let expectedLaneCount = group.expectedLaneCount, lanes.count < expectedLaneCount { return false }
    guard lanes.allSatisfy({ twFanoutLaneIsTerminal($0, summariesByRunId: summariesByRunId) })
    else { return false }

    let lastLaneIndex = group.laneRows.map(\.index).max() ?? group.anchorIndex
    let laneRunIds = Set(lanes.compactMap { twNonempty($0.row.runId) })
    let hasLaterTranscriptTurn = rows.dropFirst(lastLaneIndex + 1).contains {
        twStartsLaterFanoutTranscriptTurn($0, laneRunIds: laneRunIds)
    }
    return hasLaterTranscriptTurn || twFanoutHasLaterRoundRun(group, summaries: summaries)
}

/// Recover fan-out waves the iOS transcript may condense into one-line
/// disclosures. The contract is intentionally stricter than mere lane
/// presence: every expected lane must have a terminal summary and a later
/// transcript/run handoff must exist. Active and just-finished waves therefore
/// retain their full lane cards until the conversation has visibly moved on.
func twCollapsedFanoutViewportGroups(
    rows: [RemoteThreadSnapshot.Row],
    runSummaries: [RemoteThreadSnapshot.RunSummary]
) -> [TWFanoutViewportGroup] {
    var summariesByRunId: [String: RemoteThreadSnapshot.RunSummary] = [:]
    for summary in runSummaries {
        if let runId = twNonempty(summary.runId) { summariesByRunId[runId] = summary }
    }

    return twFanoutGroups(rows: rows, summariesByRunId: summariesByRunId)
        .filter {
            twShouldCollapseFanoutGroup(
                $0, rows: rows, summaries: runSummaries, summariesByRunId: summariesByRunId)
        }
        .map { group in
            let lanes = group.canonicalLanes
            let firstLaneId = lanes.first?.row.id ?? "empty"
            let roundKey = group.roundId ?? "legacy"
            return TWFanoutViewportGroup(
                id: "ios-fanout-viewport-\(roundKey)-\(group.anchorRow.id)-\(firstLaneId)",
                roundId: group.roundId,
                anchorRowId: group.anchorRow.id,
                anchorIndex: group.anchorIndex,
                dispatchLabel: group.dispatchLabel,
                stage: group.stage,
                laneRows: group.laneRows.map(\.row),
                laneCount: lanes.count,
                attributions: twFanoutAttributions(lanes),
                lastRow: group.laneRows.last?.row ?? group.anchorRow)
        }
}
