// Transcript participant / System filter — pure models + selection logic.
//
// Desktop mirror of `src/renderer/src/lib/transcriptParticipantFilter.ts` plus
// the additive multi-select / stale-key pruning owned by TranscriptPanel.
//
// Extracted for Priority-2 so Boss can wire ThreadDetailViews later without
// growing composition-root monoliths in this lane. Honest component inputs only
// — no Models.swift decode dependency, no RemoteSessionModel mutation.
//
// Contract:
// - Empty selection means SHOW ALL (not "hide everything").
// - Selection is additive multi-select across participant keys + System.
// - Stale keys (removed seats) prune on roster rebuild; empty after prune =
//   show-all again.
// - Stable keys use durable participant ids (`participant:<id>`), never ordinals.
// - System bucket catches user prompts and rows with no ensembleParticipantId.
// - Roster ceiling matches Mac MAX_ENSEMBLE_PARTICIPANTS (50).

import Foundation

/// Keep in step with the Mac's shared MAX_ENSEMBLE_PARTICIPANTS.
public let transcriptParticipantFilterMaxRoster = 50

/// Desktop `TRANSCRIPT_SYSTEM_FILTER_KEY`.
public let transcriptSystemFilterKey = "system"

public enum TranscriptParticipantFilterKind: String, Equatable, Sendable {
    case participant
    case system
}

/// Honest roster row for building the filter rail — integrator maps
/// `RemoteEnsembleState.RosterEntry` / live participants into this shape.
public struct TranscriptParticipantFilterRosterEntry: Equatable, Sendable, Identifiable {
    public var id: String
    public var provider: String
    public var role: String
    public var order: Int
    public var pooledAgent: Bool
    public var isBossman: Bool
    public var isCaptain: Bool

    public init(
        id: String,
        provider: String,
        role: String = "",
        order: Int = 0,
        pooledAgent: Bool = false,
        isBossman: Bool = false,
        isCaptain: Bool = false
    ) {
        self.id = id
        self.provider = provider
        self.role = role
        self.order = order
        self.pooledAgent = pooledAgent
        self.isBossman = isBossman
        self.isCaptain = isCaptain
    }
}

/// One chip on the participant / System filter rail.
public struct TranscriptParticipantFilterItem: Equatable, Sendable, Identifiable {
    public var key: String
    public var kind: TranscriptParticipantFilterKind
    public var participantId: String?
    public var ordinal: Int?
    public var provider: String?
    public var role: String
    public var title: String
    public var pooledAgent: Bool
    public var isBossman: Bool
    public var isCaptain: Bool

    public var id: String { key }

    public init(
        key: String,
        kind: TranscriptParticipantFilterKind,
        participantId: String? = nil,
        ordinal: Int? = nil,
        provider: String? = nil,
        role: String,
        title: String,
        pooledAgent: Bool = false,
        isBossman: Bool = false,
        isCaptain: Bool = false
    ) {
        self.key = key
        self.kind = kind
        self.participantId = participantId
        self.ordinal = ordinal
        self.provider = provider
        self.role = role
        self.title = title
        self.pooledAgent = pooledAgent
        self.isBossman = isBossman
        self.isCaptain = isCaptain
    }
}

/// Minimal row identity for filtering without depending on RemoteThreadSnapshot.Row.
public struct TranscriptFilterableRow: Equatable, Sendable, Identifiable {
    public var id: String
    /// Wire role (`user` / `assistant` / `system` / `tool` / …).
    public var role: String
    /// When present, the durable ensemble seat that authored the row.
    public var ensembleParticipantId: String?

    public init(id: String, role: String, ensembleParticipantId: String? = nil) {
        self.id = id
        self.role = role
        self.ensembleParticipantId = ensembleParticipantId
    }
}

public enum TranscriptParticipantFilter {
    /// Desktop `transcriptParticipantFilterKey`.
    public static func key(forParticipantId participantId: String) -> String {
        "participant:\(participantId)"
    }

    /// Desktop `transcriptFilterKeyForMessage` — no participant id → System.
    public static func filterKey(for row: TranscriptFilterableRow) -> String {
        let trimmed = (row.ensembleParticipantId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            return key(forParticipantId: trimmed)
        }
        return transcriptSystemFilterKey
    }

    /// Empty selection means show all (desktop contract).
    public static func shouldShow(
        row: TranscriptFilterableRow,
        activeFilterKeys: Set<String>
    ) -> Bool {
        if activeFilterKeys.isEmpty { return true }
        return activeFilterKeys.contains(filterKey(for: row))
    }

    public static func filterRows(
        _ rows: [TranscriptFilterableRow],
        activeFilterKeys: Set<String>
    ) -> [TranscriptFilterableRow] {
        if activeFilterKeys.isEmpty { return rows }
        return rows.filter { shouldShow(row: $0, activeFilterKeys: activeFilterKeys) }
    }

    /// Build ordered filter chips from a roster. Caps at 50 seats + System.
    /// Non-ensemble / empty roster → no rail items (desktop hides the rail).
    public static func buildItems(
        roster: [TranscriptParticipantFilterRosterEntry],
        maxParticipants: Int = transcriptParticipantFilterMaxRoster
    ) -> [TranscriptParticipantFilterItem] {
        guard !roster.isEmpty else { return [] }

        let sorted = roster.sorted { lhs, rhs in
            if lhs.order != rhs.order { return lhs.order < rhs.order }
            let roleCmp = lhs.role.localizedStandardCompare(rhs.role)
            if roleCmp != .orderedSame { return roleCmp == .orderedAscending }
            return lhs.id.localizedStandardCompare(rhs.id) == .orderedAscending
        }
        let capped = Array(sorted.prefix(max(0, maxParticipants)))

        var items: [TranscriptParticipantFilterItem] = capped.enumerated().map { index, entry in
            let isBoss = entry.isBossman
            let isCaptain = !isBoss && entry.isCaptain
            let authority = isBoss ? "Boss - " : (isCaptain ? "Captain - " : "")
            let roleLabel = entry.role.trimmingCharacters(in: .whitespacesAndNewlines)
            let displayRole = roleLabel.isEmpty ? "Participant \(index + 1)" : roleLabel
            let titleRole = roleLabel.isEmpty ? entry.provider : roleLabel
            return TranscriptParticipantFilterItem(
                key: key(forParticipantId: entry.id),
                kind: .participant,
                participantId: entry.id,
                ordinal: index + 1,
                provider: entry.provider,
                role: displayRole,
                title: "\(authority)\(index + 1) \(titleRole)",
                pooledAgent: entry.pooledAgent,
                isBossman: isBoss,
                isCaptain: isCaptain
            )
        }

        items.append(
            TranscriptParticipantFilterItem(
                key: transcriptSystemFilterKey,
                kind: .system,
                role: "System",
                title: "System messages",
                pooledAgent: false,
                isBossman: false,
                isCaptain: false
            )
        )
        return items
    }

    /// Additive toggle — selecting a chip adds it; selecting again removes it.
    public static func toggle(
        key: String,
        in activeFilterKeys: Set<String>
    ) -> Set<String> {
        var next = activeFilterKeys
        if next.contains(key) {
            next.remove(key)
        } else {
            next.insert(key)
        }
        return next
    }

    /// Drop selection keys that no longer exist on the current rail (removed seats).
    public static func pruneStaleKeys(
        activeFilterKeys: Set<String>,
        validItems: [TranscriptParticipantFilterItem]
    ) -> Set<String> {
        if activeFilterKeys.isEmpty { return activeFilterKeys }
        let valid = Set(validItems.map(\.key))
        let pruned = activeFilterKeys.intersection(valid)
        return pruned.count == activeFilterKeys.count ? activeFilterKeys : pruned
    }

    public static func isFilterActive(_ activeFilterKeys: Set<String>) -> Bool {
        !activeFilterKeys.isEmpty
    }
}
