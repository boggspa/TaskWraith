import Combine
import Foundation
import Testing
import TaskWraithKit

@testable import TaskWraithUI

@Suite("Refresh projection deduplication")
@MainActor
struct RefreshProjectionDeduplicationTests {
    @Test func snapshotAckIsSkippedWhenItsBroadcastArrivesFirst() throws {
        let model = makeModel()
        let snapshot = try threadSnapshot(threadId: "thread-1", taskId: "task-1")
        var publications = 0
        let subscription = model.$threadSnapshots.dropFirst().sink { _ in
            publications += 1
        }
        defer { subscription.cancel() }

        model.mergeThreadSnapshotProjectionForTesting(snapshot, key: "thread-1")
        model.mergeThreadSnapshotAckForTesting(snapshot, key: "thread-1")

        #expect(publications == 1)
        #expect(model.threadSnapshotMergeWorkCountForTesting == 1)
        #expect(model.threadSnapshots["thread-1"] == snapshot)
        #expect(model.threadSnapshots["task-1"] == snapshot)
    }

    @Test func snapshotAckRemainsFallbackWhenBroadcastIsMissing() throws {
        let model = makeModel()
        let snapshot = try threadSnapshot(threadId: "thread-2", taskId: "task-2")
        var publications = 0
        let subscription = model.$threadSnapshots.dropFirst().sink { _ in
            publications += 1
        }
        defer { subscription.cancel() }

        model.mergeThreadSnapshotAckForTesting(snapshot, key: "thread-2")

        #expect(publications == 1)
        #expect(model.threadSnapshotMergeWorkCountForTesting == 1)
        #expect(model.threadSnapshots["thread-2"] == snapshot)
    }

    @Test func lateSnapshotBroadcastDoesNotRepublishAckFallback() throws {
        let model = makeModel()
        let snapshot = try threadSnapshot(threadId: "thread-3", taskId: "task-3")
        var publications = 0
        let subscription = model.$threadSnapshots.dropFirst().sink { _ in
            publications += 1
        }
        defer { subscription.cancel() }

        model.mergeThreadSnapshotAckForTesting(snapshot, key: "thread-3")
        model.mergeThreadSnapshotProjectionForTesting(snapshot, key: "thread-3")

        #expect(publications == 1)
        #expect(model.threadSnapshotMergeWorkCountForTesting == 1)
    }

    @Test func nonidenticalOlderPageAckStillMerges() throws {
        let model = makeModel()
        let latest = try threadSnapshot(
            threadId: "thread-4", taskId: "task-4", rowId: "row-new",
            windowStartIndex: 1, totalRows: 2)
        let olderPage = try threadSnapshot(
            threadId: "thread-4", taskId: "task-4", rowId: "row-old",
            windowStartIndex: 0, totalRows: 2)

        model.mergeThreadSnapshotProjectionForTesting(latest, key: "thread-4")
        model.mergeThreadSnapshotAckForTesting(olderPage, key: "thread-4")

        #expect(model.threadSnapshotMergeWorkCountForTesting == 2)
        #expect(model.threadSnapshots["thread-4"]?.rows?.map(\.id) == ["row-old", "row-new"])
    }

    @Test func equalGitSnapshotsPublishOnlyOnce() throws {
        let model = makeModel()
        let main = try gitSnapshot(branch: "main", changed: 2)
        let feature = try gitSnapshot(branch: "feature/perf", changed: 3)
        var publications = 0
        let subscription = model.$gitSnapshots.dropFirst().sink { _ in
            publications += 1
        }
        defer { subscription.cancel() }

        model.cacheGitSnapshotForTesting(main, workspaceId: "ws-1")
        model.cacheGitSnapshotForTesting(main, workspaceId: "ws-1")

        #expect(publications == 1)
        #expect(model.gitSnapshots["ws-1"] == main)

        model.cacheGitSnapshotForTesting(feature, workspaceId: "ws-1")
        #expect(publications == 2)
        #expect(model.gitSnapshots["ws-1"] == feature)
    }

    private func threadSnapshot(
        threadId: String, taskId: String, rowId: String = "row-1",
        windowStartIndex: Int? = nil, totalRows: Int = 1
    ) throws
        -> RemoteThreadSnapshot
    {
        let row = try JSONDecoder().decode(
            RemoteThreadSnapshot.Row.self,
            from: Data(
                """
                {
                  "id":"\(rowId)",
                  "role":"assistant",
                  "kind":"message",
                  "preview":"Ready"
                }
                """.utf8))
        return RemoteThreadSnapshot(
            threadId: threadId,
            taskId: taskId,
            workspaceId: "ws-1",
            provider: "codex",
            rows: [row],
            totalRows: totalRows,
            windowStartIndex: windowStartIndex)
    }

    private func gitSnapshot(branch: String, changed: Int) throws -> GitWorkspaceSnapshot {
        try JSONDecoder().decode(
            GitWorkspaceSnapshot.self,
            from: Data(
                """
                {
                  "branch":"\(branch)",
                  "counts":{"changed":\(changed),"staged":0,"unstaged":\(changed)},
                  "clean":false
                }
                """.utf8))
    }

    private func makeModel() -> RemoteSessionModel {
        let defaults = UserDefaults(
            suiteName: "RefreshProjectionDeduplicationTests.\(UUID().uuidString)")!
        return RemoteSessionModel(
            identityStore: StaticIdentitySeedStore(),
            pairingStore: UserDefaultsPairedHostStore(defaults: defaults))
    }

    private struct StaticIdentitySeedStore: IdentitySeedStore {
        func loadOrCreateSeed() throws -> Data {
            Data(repeating: 7, count: 32)
        }
    }
}
