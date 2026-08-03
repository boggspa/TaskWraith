import Foundation
import Testing

@testable import TaskWraithKit

@Suite("People contribution draft bridge")
struct PeopleContributionDraftBridgeTests {
    private func payload(_ params: [String: Any]) throws -> [String: Any] {
        let base64 = try #require(params["payloadBase64"] as? String)
        let data = try #require(Data(base64Encoded: base64))
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("promotion sends identity only")
    func sendsIdentityOnly() throws {
        let encoded = BridgeAction.promoteCollaboratorComment(
            workspaceId: "ws-1", threadId: "thread-1", messageId: "people-1")
        let action = try payload(encoded)

        #expect(action["kind"] as? String == "promoteCollaboratorComment")
        #expect(action["workspaceId"] as? String == "ws-1")
        #expect(action["threadId"] as? String == "thread-1")
        #expect(action["messageId"] as? String == "people-1")
        #expect(action["actionId"] as? String != nil)
    }

    @Test("promotion never sends external prose or a run instruction")
    func omitsUntrustedBodyAndRunFlags() throws {
        let action = try payload(
            BridgeAction.promoteCollaboratorComment(
                workspaceId: "ws-1", threadId: "thread-1", messageId: "people-1"))

        #expect(action["body"] == nil)
        #expect(action["text"] == nil)
        #expect(action["prompt"] == nil)
        #expect(action["run"] == nil)
        #expect(action["autoSend"] == nil)
    }
}
