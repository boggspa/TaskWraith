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

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }
}
