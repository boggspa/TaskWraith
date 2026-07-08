import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Composer schedule bridge action")
struct ComposerScheduleActionTests {
    private func payload(_ params: [String: Any]) throws -> [String: Any] {
        let base64 = try #require(params["payloadBase64"] as? String)
        let data = try #require(Data(base64Encoded: base64))
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("composerSchedulePrompt encodes a fail-closed scheduled prompt")
    func schedulePromptEncodes() throws {
        let params = BridgeAction.composerSchedulePrompt(
            workspaceId: "ws-1",
            threadId: "t-1",
            provider: "codex",
            text: "Run later",
            scheduledRunAt: "2026-07-08T21:15:00.000Z",
            approvalMode: "plan",
            workflowMode: "plan",
            model: "gpt-5.5",
            reasoningEffort: "high"
        )
        let payload = try payload(params)

        #expect(payload["kind"] as? String == "composerSchedulePrompt")
        #expect(payload["workspaceId"] as? String == "ws-1")
        #expect(payload["threadId"] as? String == "t-1")
        #expect(payload["provider"] as? String == "codex")
        #expect(payload["text"] as? String == "Run later")
        #expect(payload["scheduledRunAt"] as? String == "2026-07-08T21:15:00.000Z")
        #expect(payload["approvalMode"] as? String == "plan")
        #expect(payload["workflowMode"] as? String == "plan")
        #expect(payload["model"] as? String == "gpt-5.5")
        #expect(payload["reasoningEffort"] as? String == "high")
        #expect(payload["actionId"] as? String != nil)
        let issuedAt = try #require(payload["issuedAt"] as? Int)
        let expiresAt = try #require(payload["expiresAt"] as? Int)
        #expect(expiresAt > issuedAt)
    }
}
