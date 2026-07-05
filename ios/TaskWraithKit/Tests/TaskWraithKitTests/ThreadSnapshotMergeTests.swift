import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Thread snapshot metadata merge")
struct ThreadSnapshotMergeTests {
    private func snapshot(_ json: String) throws -> RemoteThreadSnapshot {
        try JSONDecoder().decode(RemoteThreadSnapshot.self, from: Data(json.utf8))
    }

    @Test("metadata merge preserves rows and clears stale running summary")
    func preservesRowsAndClearsRunning() throws {
        let existing = try snapshot(
            """
            {
              "threadId":"thread-1",
              "rows":[{"id":"row-1","runId":"run-1","preview":"Hello"}],
              "totalRows":1,
              "runSummary":{"runId":"run-1","status":"running","startedAt":"2026-07-01T10:00:00Z"},
              "windowStartIndex":0,
              "hasMoreAbove":false,
              "hasMoreBelow":false
            }
            """)
        let incoming = try snapshot(
            """
            {
              "threadId":"thread-1",
              "rows":[],
              "totalRows":1,
              "runSummary":{
                "runId":"run-1",
                "status":"success",
                "startedAt":"2026-07-01T10:00:00Z",
                "endedAt":"2026-07-01T10:05:00Z"
              }
            }
            """)

        let merged = ThreadSnapshotMerge.applyingMetadata(from: incoming, onto: existing)
        #expect(merged.rows?.count == 1)
        #expect(merged.rows?.first?.id == "row-1")
        #expect(merged.runSummary?.status == "success")
        #expect(merged.runSummary?.endedAt == "2026-07-01T10:05:00Z")
    }
}
