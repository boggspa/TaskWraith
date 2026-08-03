import Foundation
import TaskWraithKit

/// Pure transcript-window adapter for a pinned-message jump.
///
/// Pinned rows are projected from the whole transcript and may sit outside the
/// phone's latest-N window. The pinned row is already the canonical desktop
/// message projection, so a jump can temporarily place that exact source row
/// into the rendered window without inventing identity or mutating host state.
enum PinnedMessageNavigationModel {
    static func rowsForJump(
        loadedRows: [RemoteThreadSnapshot.Row],
        sourceRow: RemoteThreadSnapshot.Row?
    ) -> [RemoteThreadSnapshot.Row] {
        guard let sourceRow else { return loadedRows }
        guard !loadedRows.contains(where: { $0.id == sourceRow.id }) else {
            return loadedRows
        }

        var rows = loadedRows
        guard let sourceTimestamp = normalized(sourceRow.timestamp) else {
            rows.insert(sourceRow, at: 0)
            return rows
        }
        let insertionIndex = rows.firstIndex { row in
            guard let timestamp = normalized(row.timestamp) else { return false }
            return timestamp > sourceTimestamp
        }
        rows.insert(sourceRow, at: insertionIndex ?? rows.endIndex)
        return rows
    }

    static func sourceRow(
        messageId: String,
        loadedRows: [RemoteThreadSnapshot.Row],
        pinnedRows: [RemoteThreadSnapshot.Row]
    ) -> RemoteThreadSnapshot.Row? {
        loadedRows.first(where: { $0.id == messageId })
            ?? pinnedRows.first(where: { $0.id == messageId })
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
