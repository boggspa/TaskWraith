import Foundation
import Testing
import TaskWraithKit
@testable import TaskWraithUI

@Suite("Pinned message transcript navigation")
struct PinnedMessageNavigationTests {
    private func row(_ id: String, timestamp: String? = nil) -> RemoteThreadSnapshot.Row {
        var object: [String: Any] = [
            "id": id,
            "role": "assistant",
            "kind": "assistant",
            "preview": id,
        ]
        if let timestamp { object["timestamp"] = timestamp }
        let data = try! JSONSerialization.data(withJSONObject: object)
        return try! JSONDecoder().decode(RemoteThreadSnapshot.Row.self, from: data)
    }

    @Test func loadedSourceIsNotDuplicated() {
        let loaded = [row("a"), row("target"), row("b")]
        #expect(
            PinnedMessageNavigationModel.rowsForJump(
                loadedRows: loaded,
                sourceRow: row("target")
            ).map(\.id) == ["a", "target", "b"]
        )
    }

    @Test func offWindowSourceKeepsChronologicalPlacement() {
        let loaded = [
            row("later-1", timestamp: "2026-08-03T12:00:00.000Z"),
            row("later-2", timestamp: "2026-08-03T13:00:00.000Z"),
        ]
        let source = row("target", timestamp: "2026-08-03T11:00:00.000Z")
        #expect(
            PinnedMessageNavigationModel.rowsForJump(
                loadedRows: loaded,
                sourceRow: source
            ).map(\.id) == ["target", "later-1", "later-2"]
        )
    }

    @Test func missingTimestampFallsBackWithoutReorderingLoadedRows() {
        let loaded = [row("a"), row("b")]
        #expect(
            PinnedMessageNavigationModel.rowsForJump(
                loadedRows: loaded,
                sourceRow: row("target")
            ).map(\.id) == ["target", "a", "b"]
        )
    }

    @Test func sourceResolutionPrefersLoadedCanonicalRow() {
        let loaded = row("target", timestamp: "2026-08-03T13:00:00.000Z")
        let pin = row("target", timestamp: "2026-08-03T12:00:00.000Z")
        #expect(
            PinnedMessageNavigationModel.sourceRow(
                messageId: "target",
                loadedRows: [loaded],
                pinnedRows: [pin]
            )?.timestamp == loaded.timestamp
        )
        #expect(
            PinnedMessageNavigationModel.sourceRow(
                messageId: "target",
                loadedRows: [],
                pinnedRows: [pin]
            )?.timestamp == pin.timestamp
        )
    }
}
