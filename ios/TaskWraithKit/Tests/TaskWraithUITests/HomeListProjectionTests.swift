import Foundation
import Testing

@testable import TaskWraithKit
@testable import TaskWraithUI

@Suite("Home list projection")
struct HomeListProjectionTests {
    @Test func buildsCardGroupsAndAttentionIndexInOneProjection() throws {
        let cards = try decode(
            [RemoteTaskCard].self,
            """
            [
              {"id":"top","threadId":"wire-top","workspaceId":"ws-1"},
              {"id":"child","parentChatId":"top","workspaceId":"ws-1"},
              {"id":"archived-child","parentChatId":"top","workspaceId":"ws-1","archived":true},
              {"id":"draft","workspaceId":"ws-1","isDraft":true},
              {"id":"archived","workspaceId":"ws-1","archived":true},
              {"id":"workflow-thread","workspaceId":"ws-1"},
              {"id":"orphan","workspaceId":"missing"}
            ]
            """)
        let approvals = try decode(
            [MobileApprovalCard].self,
            """
            [
              {"toolCallId":"a1","threadId":"top"},
              {"toolCallId":"a2","threadId":"wire-top"},
              {"toolCallId":"a3","threadId":"unrelated"}
            ]
            """)
        let questions = try decode(
            [MobileQuestionCard].self,
            """
            [
              {"promptId":"q1","threadId":"wire-top"},
              {"promptId":"q2","threadId":"child"}
            ]
            """)

        let projection = HomeListProjection(
            taskCards: cards,
            workflowThreadIds: ["workflow-thread"],
            knownWorkspaceIds: ["ws-1"],
            approvals: approvals,
            questions: questions)

        #expect(projection.listedCards.map(\.id) == ["top", "child", "orphan"])
        #expect(projection.cardsByWorkspace["ws-1"]?.map(\.id) == ["top"])
        #expect(projection.childrenByParent["top"]?.map(\.id) == ["child"])
        #expect(projection.orphanCards.map(\.id) == ["orphan"])
        #expect(projection.pendingAttentionCount(for: cards[0]) == 3)
        #expect(projection.pendingAttentionCount(for: cards[1]) == 1)
    }

    @Test func identicalCardAndWireIdsDoNotDoubleCountAttention() throws {
        let card = try decode(RemoteTaskCard.self, #"{"id":"same","threadId":"same"}"#)
        let approvals = try decode(
            [MobileApprovalCard].self,
            #"[{"toolCallId":"a1","threadId":"same"}]"#)

        let projection = HomeListProjection(
            taskCards: [card],
            workflowThreadIds: [],
            knownWorkspaceIds: [],
            approvals: approvals,
            questions: [])

        #expect(projection.pendingAttentionCount(for: card) == 1)
    }

    @Test func terminalSnapshotRetiresOnlyItsMatchingStaleRunningCard() throws {
        let cards = try decode(
            [RemoteTaskCard].self,
            """
            [
              {"id":"failed","threadId":"failed","status":"running","runId":"run-failed"},
              {"id":"cancelled","threadId":"cancelled","status":"running","runId":"run-cancelled"},
              {"id":"newer","threadId":"newer","status":"running","runId":"run-new"},
              {"id":"unsnapped","threadId":"unsnapped","status":"running"},
              {"id":"archived","threadId":"archived","status":"running","archived":true}
            ]
            """)
        let failed = try decode(
            RemoteThreadSnapshot.self,
            """
            {"threadId":"failed","runSummary":{"runId":"run-failed","status":"failed"}}
            """)
        let cancelled = try decode(
            RemoteThreadSnapshot.self,
            """
            {"threadId":"cancelled","runSummary":{"runId":"run-cancelled","status":"cancelled"}}
            """)
        let older = try decode(
            RemoteThreadSnapshot.self,
            """
            {"threadId":"newer","runSummary":{"runId":"run-old","status":"failed"}}
            """)

        let active = HomeActiveRunProjection.cards(
            taskCards: cards,
            threadSnapshots: [
                "failed": failed,
                "cancelled": cancelled,
                "newer": older,
            ])

        #expect(active.map(\.id) == ["newer", "unsnapped"])
    }

    @Test func legacyTerminalSummaryWithoutRunIdRetiresStaleRunningCard() throws {
        let card = try decode(
            RemoteTaskCard.self,
            #"{"id":"stale","threadId":"wire-stale","status":"running"}"#)
        let snapshot = try decode(
            RemoteThreadSnapshot.self,
            """
            {"threadId":"wire-stale","runSummary":{"endedAt":"2026-08-28T18:34:00Z"}}
            """)

        #expect(
            HomeActiveRunProjection.cards(
                taskCards: [card],
                threadSnapshots: ["wire-stale": snapshot]
            ).isEmpty)
    }

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }
}
