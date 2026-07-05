import Foundation
import Testing

@testable import TaskWraithKit

@Suite("setChatKind bridge action")
struct SetChatKindActionTests {
    private func payload(_ params: [String: Any]) throws -> [String: Any] {
        let base64 = try #require(params["payloadBase64"] as? String)
        let data = try #require(Data(base64Encoded: base64))
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("setChatKind encodes solo to ensemble seed participant")
    func encodesEnsembleToggle() throws {
        let seed: [String: Any] = [
            "id": "ensemble-seed-claude-1",
            "provider": "claude",
            "enabled": true,
            "role": "Claude",
            "order": 1,
            "model": "cli-default",
        ]
        let params = BridgeAction.setChatKind(
            workspaceId: "ws-1",
            threadId: "t-1",
            targetKind: "ensemble",
            seedParticipant: seed)
        let payload = try payload(params)
        #expect(payload["kind"] as? String == "setChatKind")
        #expect(payload["targetKind"] as? String == "ensemble")
        #expect(payload["threadId"] as? String == "t-1")
        let encodedSeed = try #require(payload["seedParticipant"] as? [String: Any])
        #expect(encodedSeed["provider"] as? String == "claude")
    }

    @Test("setChatKind encodes ensemble to solo canonical provider")
    func encodesSoloToggle() throws {
        let params = BridgeAction.setChatKind(
            workspaceId: "ws-1",
            threadId: "t-1",
            targetKind: "single",
            canonicalProvider: "codex")
        let payload = try payload(params)
        #expect(payload["targetKind"] as? String == "single")
        #expect(payload["canonicalProvider"] as? String == "codex")
        #expect(payload["seedParticipant"] == nil)
    }
}
