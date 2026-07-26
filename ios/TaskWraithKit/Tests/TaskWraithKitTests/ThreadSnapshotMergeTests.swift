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

    /// A drained peer inbox must actually clear. Messages are consumed on the
    /// target thread's next turn, and that turn's snapshot is the one carrying the
    /// zero — so a merge that treated a present zero as "no news" would leave the
    /// badge showing its old count for the rest of the session.
    @Test("metadata merge clears the peer inbox on a stated zero")
    func clearsInboxOnStatedZero() throws {
        let existing = try snapshot(
            #"{"threadId":"t-1","threadMessageInbox":{"pendingCount":2,"senders":["Ratchet"]}}"#)
        let incoming = try snapshot(
            #"{"threadId":"t-1","threadMessageInbox":{"pendingCount":0,"senders":[]}}"#)
        let merged = ThreadSnapshotMerge.applyingMetadata(from: incoming, onto: existing)
        #expect(merged.threadMessageInbox?.count == 0)
    }

    /// The other half of the same contract: absence means "this refresh carried no
    /// inbox data", not "empty". Dropping the count there would blank the badge on
    /// every row-window refresh.
    @Test("metadata merge keeps the peer inbox when the refresh omits it")
    func keepsInboxWhenOmitted() throws {
        let existing = try snapshot(
            #"{"threadId":"t-1","threadMessageInbox":{"pendingCount":2,"senders":["Ratchet"]}}"#)
        let incoming = try snapshot(#"{"threadId":"t-1","totalRows":9}"#)
        let merged = ThreadSnapshotMerge.applyingMetadata(from: incoming, onto: existing)
        #expect(merged.threadMessageInbox?.count == 2)
        #expect(merged.threadMessageInbox?.senders == ["Ratchet"])
    }
}
