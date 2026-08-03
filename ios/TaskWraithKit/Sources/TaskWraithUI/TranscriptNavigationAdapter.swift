import Foundation
import TaskWraithKit

/// Keeps transcript-navigation projection logic out of ThreadDetailView.
///
/// The Mac remains authoritative for durable participant identity. This adapter
/// only maps already-decoded remote state into the extracted filter/scrubber
/// presentation models and applies the user's local, session-only selection.
enum TranscriptNavigationAdapter {
    static func filterItems(
        for state: RemoteEnsembleState?
    ) -> [TranscriptParticipantFilterItem] {
        guard let state, let roster = state.roster, !roster.isEmpty else { return [] }
        let entries = roster.map { entry in
            let isBoss = entry.isBossman == true || state.bossmanParticipantId == entry.id
            let isCaptain =
                !isBoss
                && (entry.isSecondInCommand == true
                    || state.secondInCommandParticipantId == entry.id)
            return TranscriptParticipantFilterRosterEntry(
                id: entry.id,
                provider: entry.provider,
                role: entry.role ?? "",
                order: entry.order ?? 0,
                pooledAgent: false,
                isBossman: isBoss,
                isCaptain: isCaptain
            )
        }
        return TranscriptParticipantFilter.buildItems(roster: entries)
    }

    static func filterRows(
        _ rows: [RemoteThreadSnapshot.Row],
        activeFilterKeys: Set<String>
    ) -> [RemoteThreadSnapshot.Row] {
        guard !activeFilterKeys.isEmpty else { return rows }
        return rows.filter { row in
            TranscriptParticipantFilter.shouldShow(
                row: TranscriptFilterableRow(
                    id: row.id,
                    role: row.role ?? "",
                    ensembleParticipantId: row.ensembleParticipantId
                ),
                activeFilterKeys: activeFilterKeys
            )
        }
    }

    static func scrubberMarkers(
        for rows: [RemoteThreadSnapshot.Row]
    ) -> [UserTurnScrubberMarker] {
        let sources = rows.map { row in
            UserTurnScrubberSourceRow(
                id: row.id,
                role: row.role ?? "",
                content: row.preview ?? ""
            )
        }
        return UserTurnScrubber.buildMarkers(from: sources)
    }

    static func selectedParticipantId(
        activeFilterKeys: Set<String>,
        activeParticipantId: String?
    ) -> Bool {
        guard !activeFilterKeys.isEmpty else { return true }
        let row = TranscriptFilterableRow(
            id: "live-participant",
            role: "assistant",
            ensembleParticipantId: activeParticipantId
        )
        return TranscriptParticipantFilter.shouldShow(
            row: row,
            activeFilterKeys: activeFilterKeys
        )
    }
}
