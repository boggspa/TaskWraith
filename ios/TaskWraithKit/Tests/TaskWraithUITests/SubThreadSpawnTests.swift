import Foundation
import TaskWraithKit
import Testing

@testable import TaskWraithUI

@Suite("Sub-thread spawn readiness (host-wired seam)")
struct SubThreadSpawnReadinessTests {
    private func input(
        isDemo: Bool = false,
        hostWired: Bool = true,
        parentIsSubThread: Bool = false,
        workspaceId: String? = "ws-1",
        parentThreadId: String? = "thread-1",
        proposedProvider: String = "claude",
        prompt: String = "Review the diff."
    ) -> SubThreadSpawnReadiness.Input {
        SubThreadSpawnReadiness.Input(
            isDemo: isDemo,
            hostCreateSubThreadWired: hostWired,
            parentIsSubThread: parentIsSubThread,
            workspaceId: workspaceId,
            parentThreadId: parentThreadId,
            proposedProvider: proposedProvider,
            prompt: prompt
        )
    }

    @Test("unwired host disables spawn even with a filled prompt — the notWired seam")
    func unwiredHostDisablesSpawn() {
        let readiness = SubThreadSpawnReadiness.evaluate(input(hostWired: false))
        #expect(readiness.canCreate == false)
        #expect(readiness.reason == SubThreadSpawnReadiness.notWiredReason)
        #expect(SubThreadSpawnProposal.bridgeParams(input(hostWired: false)) == nil)
    }

    @Test("absent host capability is not wired — fail closed, never a payload")
    func missingCapabilityIsNotWired() throws {
        let json = Data(#"{"monitor":true,"deleteMessage":true}"#.utf8)
        let caps = try JSONDecoder().decode(RemoteTaskCapabilities.self, from: json)
        #expect(caps.createSubThread == nil)
        let readiness = SubThreadSpawnReadiness.evaluate(input(hostWired: caps.createSubThread == true))
        #expect(readiness.canCreate == false)
        #expect(SubThreadSpawnProposal.bridgeParams(input(hostWired: caps.createSubThread == true)) == nil)
    }

    @Test("projected createSubThread true is the host-wired signal")
    func projectedTrueIsWired() throws {
        let json = Data(#"{"createSubThread":true}"#.utf8)
        let caps = try JSONDecoder().decode(RemoteTaskCapabilities.self, from: json)
        #expect(caps.createSubThread == true)
        let readiness = SubThreadSpawnReadiness.evaluate(
            input(hostWired: caps.createSubThread == true))
        #expect(readiness.canCreate == true)
        #expect(readiness.reason == nil)
    }

    @Test("a nested parent is refused before the host is asked")
    func nestedParentIsRefused() {
        let readiness = SubThreadSpawnReadiness.evaluate(
            input(hostWired: true, parentIsSubThread: true))
        #expect(readiness.canCreate == false)
        #expect(readiness.reason == SubThreadSpawnReadiness.nestedParentReason)
        #expect(
            SubThreadSpawnProposal.bridgeParams(
                input(hostWired: true, parentIsSubThread: true)) == nil)
    }

    @Test("global and missing workspaces cannot spawn")
    func workspaceRequired() {
        #expect(
            SubThreadSpawnReadiness.evaluate(input(workspaceId: nil)).reason
                == SubThreadSpawnReadiness.missingWorkspaceReason)
        #expect(
            SubThreadSpawnReadiness.evaluate(input(workspaceId: "global")).reason
                == SubThreadSpawnReadiness.missingWorkspaceReason)
        #expect(
            SubThreadSpawnReadiness.evaluate(input(workspaceId: "  ")).reason
                == SubThreadSpawnReadiness.missingWorkspaceReason)
    }

    @Test("missing parent thread cannot spawn")
    func threadRequired() {
        let readiness = SubThreadSpawnReadiness.evaluate(input(parentThreadId: nil))
        #expect(readiness.canCreate == false)
        #expect(readiness.reason == SubThreadSpawnReadiness.missingThreadReason)
    }

    @Test("empty prompt is refused; host bound is 20000")
    func promptBounds() {
        #expect(
            SubThreadSpawnReadiness.evaluate(input(prompt: "   ")).reason
                == SubThreadSpawnReadiness.missingPromptReason)
        let tooLong = String(repeating: "x", count: BridgeAction.createSubThreadPromptMaxChars + 1)
        #expect(
            SubThreadSpawnReadiness.evaluate(input(prompt: tooLong)).reason
                == SubThreadSpawnReadiness.promptTooLongReason)
        let atBound = String(repeating: "x", count: BridgeAction.createSubThreadPromptMaxChars)
        #expect(SubThreadSpawnReadiness.evaluate(input(prompt: atBound)).canCreate == true)
    }

    @Test("provider is a proposal the Mac still has to admit")
    func providerIsProposal() throws {
        #expect(
            SubThreadSpawnReadiness.evaluate(input(proposedProvider: "")).reason
                == SubThreadSpawnReadiness.missingProviderReason)
        #expect(
            SubThreadSpawnReadiness.evaluate(input(proposedProvider: "gemini")).reason
                == SubThreadSpawnReadiness.missingProviderReason)
        #expect(SubThreadSpawnReadiness.isAdmittedProposal("claude") == true)
        #expect(SubThreadSpawnReadiness.isAdmittedProposal("antigravity") == true)
        #expect(SubThreadSpawnReadiness.isAdmittedProposal("gemini") == false)

        let params = try #require(
            SubThreadSpawnProposal.bridgeParams(
                input(proposedProvider: "Claude"), returnResult: false, actionId: "act-1"))
        let payload = try decodePayload(params)
        #expect(payload["kind"] as? String == "createSubThread")
        #expect(payload["workspaceId"] as? String == "ws-1")
        #expect(payload["threadId"] as? String == "thread-1")
        #expect(payload["provider"] as? String == "claude")
        #expect(payload["prompt"] as? String == "Review the diff.")
        #expect(payload["returnResult"] as? Bool == false)
        #expect(payload["subThreadId"] == nil)
        #expect(payload["actionId"] as? String == "act-1")
    }

    @Test("demo mode does not pretend the host executor is wired")
    func demoIsNotASilentNotWiredCall() {
        let readiness = SubThreadSpawnReadiness.evaluate(
            input(isDemo: true, hostWired: true))
        #expect(readiness.canCreate == false)
        #expect(readiness.reason == SubThreadSpawnReadiness.demoReason)
        #expect(SubThreadSpawnProposal.bridgeParams(input(isDemo: true, hostWired: true)) == nil)
    }

    @Test("wired parent with workspace, thread, provider, prompt can create")
    func readyWhenHostWired() {
        let readiness = SubThreadSpawnReadiness.evaluate(input())
        #expect(readiness.canCreate == true)
        #expect(readiness.reason == nil)
        #expect(SubThreadSpawnProposal.bridgeParams(input()) != nil)
    }

    @Test("UTF-16 code-unit boundary matches host JS .length so emoji-heavy prompts are refused locally")
    func utf16BoundaryMatchesHost() {
        let emoji = "👍" // 2 UTF-16 code units in JavaScript
        let atBound = String(repeating: emoji, count: BridgeAction.createSubThreadPromptMaxChars / 2)
        #expect(SubThreadSpawnReadiness.evaluate(input(prompt: atBound)).canCreate == true)
        #expect(atBound.utf16.count == BridgeAction.createSubThreadPromptMaxChars)

        let overBound = atBound + emoji
        #expect(SubThreadSpawnReadiness.evaluate(input(prompt: overBound)).reason
            == SubThreadSpawnReadiness.promptTooLongReason)
        #expect(overBound.utf16.count == BridgeAction.createSubThreadPromptMaxChars + 2)
    }

    private func decodePayload(_ params: [String: Any]) throws -> [String: Any] {
        let payloadBase64 = try #require(params["payloadBase64"] as? String)
        let payloadData = try #require(Data(base64Encoded: payloadBase64))
        let object = try JSONSerialization.jsonObject(with: payloadData)
        return try #require(object as? [String: Any])
    }
}
