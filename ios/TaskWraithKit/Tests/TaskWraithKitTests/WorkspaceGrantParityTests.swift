import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Workspace grant and Full Access parity")
struct WorkspaceGrantParityTests {
    private func payload(_ params: [String: Any]) throws -> [String: Any] {
        let base64 = try #require(params["payloadBase64"] as? String)
        let data = try #require(Data(base64Encoded: base64))
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("workspace consent carries only the registered workspace decision")
    func workspaceConsentPayload() throws {
        let encoded = BridgeAction.setRemoteWorkspaceAccess(
            workspaceId: "ws-1", enabled: true, actionId: "grant-1")
        let payload = try payload(encoded)

        #expect(payload["kind"] as? String == "setRemoteWorkspaceAccess")
        #expect(payload["workspaceId"] as? String == "ws-1")
        #expect(payload["enabled"] as? Bool == true)
        #expect(payload["actionId"] as? String == "grant-1")
        #expect(payload["provider"] == nil)
        #expect(payload["approvalMode"] == nil)
        #expect(payload["capabilities"] == nil)
        #expect(payload["expiresAt"] as? Int != nil)
    }

    @Test("Full Access consent identifies one exact participant lane")
    func trustedSessionPayload() throws {
        let encoded = BridgeAction.setTrustedSession(
            workspaceId: "ws-1",
            threadId: "thread-1",
            provider: "antigravity",
            enabled: true,
            ensembleParticipantId: "participant-1",
            runtimeProfileId: "profile-1",
            actionId: "trusted-1")
        let payload = try payload(encoded)

        #expect(payload["kind"] as? String == "setTrustedSession")
        #expect(payload["workspaceId"] as? String == "ws-1")
        #expect(payload["threadId"] as? String == "thread-1")
        #expect(payload["provider"] as? String == "antigravity")
        #expect(payload["enabled"] as? Bool == true)
        #expect(payload["ensembleParticipantId"] as? String == "participant-1")
        #expect(payload["runtimeProfileId"] as? String == "profile-1")
        #expect(payload["actionId"] as? String == "trusted-1")
    }

    @Test("workspace stubs decode grant state without requiring task content")
    func workspaceGrantProjectionDecodes() throws {
        let summary = try JSONDecoder().decode(
            WorkspaceSummary.self,
            from: Data(
                #"{"workspaceId":"ws-1","displayName":"Repo","path":"/repo","chatCount":0,"runningChatCount":0,"remoteAccessGranted":false}"#.utf8))

        #expect(summary.workspaceId == "ws-1")
        #expect(summary.remoteAccessGranted == false)
        #expect(summary.remoteAccessMode == nil)
        #expect(summary.capabilities == nil)
    }

    @Test("grant and Full Access acknowledgements decode authoritatively")
    func acknowledgementDataDecodes() throws {
        let grant = try JSONDecoder().decode(
            BridgeActionAck.self,
            from: Data(#"{"accepted":true,"data":{"granted":true}}"#.utf8))
        let trusted = try JSONDecoder().decode(
            BridgeActionAck.self,
            from: Data(#"{"accepted":true,"data":{"enabled":true}}"#.utf8))

        #expect(grant.data?.granted == true)
        #expect(trusted.data?.enabled == true)
    }
}
