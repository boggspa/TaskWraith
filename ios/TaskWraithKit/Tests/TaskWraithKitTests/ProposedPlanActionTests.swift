// Proposed-plan decision bridge action — the wire contract for the iOS plan
// round-trip (slice 2c). The phone sends BridgeAction.proposedPlanDecision to
// flip metadata.proposedPlan.status on the Mac; this pins the encoded payload
// shape (kind + fields + the replay-defense stamps) the Mac validator expects.

import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Proposed-plan bridge action")
struct ProposedPlanActionTests {
    private func payload(_ params: [String: Any]) throws -> [String: Any] {
        let base64 = try #require(params["payloadBase64"] as? String)
        let data = try #require(Data(base64Encoded: base64))
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // Approve no longer uses proposedPlanDecision (it flips status atomically with
    // the implement run); this action is the Respond/Dismiss path and only ever
    // carries decision "dismissed".
    @Test("proposedPlanDecision stamps a typed dismissed payload with replay metadata")
    func dismissedEncodes() throws {
        let params = BridgeAction.proposedPlanDecision(
            workspaceId: "ws-1", threadId: "t-1", messageId: "m-1", decision: "dismissed")
        let payload = try payload(params)
        #expect(payload["kind"] as? String == "proposedPlanDecision")
        #expect(payload["workspaceId"] as? String == "ws-1")
        #expect(payload["threadId"] as? String == "t-1")
        #expect(payload["messageId"] as? String == "m-1")
        #expect(payload["decision"] as? String == "dismissed")
        #expect(payload["actionId"] as? String != nil)
        let issuedAt = try #require(payload["issuedAt"] as? Int)
        let expiresAt = try #require(payload["expiresAt"] as? Int)
        #expect(expiresAt > issuedAt)
    }
}
