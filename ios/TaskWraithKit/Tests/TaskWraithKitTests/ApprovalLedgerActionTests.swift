import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Approval ledger read action")
struct ApprovalLedgerActionTests {
    private func payload(_ params: [String: Any]) throws -> [String: Any] {
        // BridgeAction.encode wraps the payload as base64 (transport shape);
        // unwrap exactly as the schedule-action tests do.
        let base64 = try #require(params["payloadBase64"] as? String)
        let data = try #require(Data(base64Encoded: base64))
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test func actionCarriesTheReadContract() throws {
        let full = try payload(
            BridgeAction.approvalLedgerList(workspaceId: "ws-1", threadId: "t-1", limit: 25))
        #expect(full["kind"] as? String == "approvalLedgerList")
        #expect(full["workspaceId"] as? String == "ws-1")
        #expect(full["threadId"] as? String == "t-1")
        #expect(full["limit"] as? Int == 25)
        let minimal = try payload(BridgeAction.approvalLedgerList(workspaceId: "ws-1"))
        #expect(minimal["threadId"] == nil)
        #expect(minimal["limit"] == nil)
    }

    @Test func entriesDecodeBoundedAndTolerant() throws {
        let json = """
            {"ok":true,"data":{"approvalLedgerEntries":[
              {"id":"l1","provider":"claude","method":"shell","title":"Run npm test",
               "status":"resolved","requestedAt":"2026-08-11T02:14:00.000Z",
               "respondedAt":"2026-08-11T02:14:05.000Z","decision":"autoDeny",
               "decisionSource":"policy","threadId":"t-1"},
              {"title":"A future Mac's row","decision":"hibernate"}]}}
            """
        let ack = try JSONDecoder().decode(BridgeActionAck.self, from: Data(json.utf8))
        let entries = ack.data?.approvalLedgerEntries ?? []
        #expect(entries.count == 2)
        #expect(entries.first?.decision == "autoDeny")
        #expect(entries.first?.decisionSource == "policy")
        // Unknown decisions decode as-is; the sheet renders them verbatim.
        #expect(entries.last?.decision == "hibernate")
        #expect(entries.last?.id == nil)
    }
}
