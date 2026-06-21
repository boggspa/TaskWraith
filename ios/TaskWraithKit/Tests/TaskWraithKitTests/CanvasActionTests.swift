// Canvas write-action bridge payload — the wire contract for the iOS phone→Mac
// close/reload round-trip (P3 slice 2b). The phone sends BridgeAction.canvasAction
// to close or reload an open Canvas preview; this pins the encoded payload shape
// (kind + fields + replay-defense stamps) the Mac validator (isCanvasAction) expects.

import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Canvas bridge action")
struct CanvasActionTests {
    private func payload(_ params: [String: Any]) throws -> [String: Any] {
        let base64 = try #require(params["payloadBase64"] as? String)
        let data = try #require(Data(base64Encoded: base64))
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test(
        "canvasAction stamps a typed close/reload payload with replay metadata",
        arguments: ["close", "reload"])
    func encodes(_ action: String) throws {
        let params = BridgeAction.canvasAction(
            workspaceId: "ws-1", threadId: "t-1", canvasId: "cv1", action: action)
        let payload = try payload(params)
        #expect(payload["kind"] as? String == "canvasAction")
        #expect(payload["workspaceId"] as? String == "ws-1")
        #expect(payload["threadId"] as? String == "t-1")
        #expect(payload["canvasId"] as? String == "cv1")
        #expect(payload["action"] as? String == action)
        #expect(payload["actionId"] as? String != nil)
        let issuedAt = try #require(payload["issuedAt"] as? Int)
        let expiresAt = try #require(payload["expiresAt"] as? Int)
        #expect(expiresAt > issuedAt)
    }
}
