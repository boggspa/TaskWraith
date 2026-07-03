// Ensemble settings bridge action — iOS phone -> Mac orchestration controls.
// Pins the exact wire keys used by BridgeActionPayload.isEnsembleSettingsUpdate.

import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Ensemble settings bridge action")
struct EnsembleSettingsActionTests {
    private func payload(_ params: [String: Any]) throws -> [String: Any] {
        let base64 = try #require(params["payloadBase64"] as? String)
        let data = try #require(Data(base64Encoded: base64))
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("ensembleSettingsUpdate stamps mode and hop-limit wire keys")
    func encodesModeAndHopLimit() throws {
        let params = BridgeAction.ensembleSettingsUpdate(
            workspaceId: "ws-1",
            threadId: "t-1",
            orchestrationMode: "continuous",
            maxContinuationHops: 12)
        let payload = try payload(params)
        #expect(payload["kind"] as? String == "ensembleSettingsUpdate")
        #expect(payload["workspaceId"] as? String == "ws-1")
        #expect(payload["threadId"] as? String == "t-1")
        #expect(payload["orchestrationMode"] as? String == "continuous")
        #expect(payload["maxContinuationHops"] as? Int == 12)
        #expect(payload["actionId"] as? String != nil)
        let issuedAt = try #require(payload["issuedAt"] as? Int)
        let expiresAt = try #require(payload["expiresAt"] as? Int)
        #expect(expiresAt > issuedAt)
    }

    @Test("ensembleSettingsUpdate clamps hop limits before encoding")
    func clampsHopLimit() throws {
        let lowPayload = try payload(
            BridgeAction.ensembleSettingsUpdate(
                workspaceId: "ws-1", threadId: "t-1", maxContinuationHops: -4))
        let highPayload = try payload(
            BridgeAction.ensembleSettingsUpdate(
                workspaceId: "ws-1", threadId: "t-1", maxContinuationHops: 900))
        #expect(lowPayload["maxContinuationHops"] as? Int == 1)
        #expect(highPayload["maxContinuationHops"] as? Int == 500)
    }
}
