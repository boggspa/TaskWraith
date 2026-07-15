import Foundation
import Testing
@testable import TaskWraithKit
@testable import TaskWraithUI

/// Phone-side workflow write-actions (pause/resume/run-now) against the
/// landed Mac contract: payload shape, ack decode, optimistic flip semantics,
/// and the verbatim-denial failure surface.
@MainActor
@Suite("Workflow write-actions")
struct WorkflowActionsTests {
    private func makeModel() -> RemoteSessionModel {
        let defaults = UserDefaults(suiteName: "TWWorkflowTests.\(UUID().uuidString)")!
        return RemoteSessionModel(
            identityStore: StaticSeed(),
            pairingStore: UserDefaultsPairedHostStore(defaults: defaults))
    }

    private struct StaticSeed: IdentitySeedStore {
        func loadOrCreateSeed() throws -> Data { Data(repeating: 7, count: 32) }
    }

    private func decodePayload(_ params: [String: Any]) throws -> [String: Any] {
        let base64 = try #require(params["payloadBase64"] as? String)
        let data = try #require(Data(base64Encoded: base64))
        return try #require(
            try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func workflow(_ id: String, enabled: Bool?) -> RemoteWorkflow {
        RemoteWorkflow(
            id: id, name: "Nightly sweep", workspaceId: "ws-1", threadId: "t-\(id)",
            provider: "claude", enabled: enabled, schedule: "Every 60 min",
            status: "idle")
    }

    // ── Wire payloads ─────────────────────────────────────────────────────────

    @Test func setEnabledPayloadMatchesLandedContract() throws {
        let payload = try decodePayload(
            BridgeAction.workflowSetEnabled(workflowId: "wf-1", enabled: false))
        #expect(payload["kind"] as? String == "workflowSetEnabled")
        #expect(payload["workflowId"] as? String == "wf-1")
        #expect(payload["enabled"] as? Bool == false)
        // Replay protection: the Mac REQUIRES actionId + expiresAt on mutations.
        #expect(!((payload["actionId"] as? String) ?? "").isEmpty)
        let issuedAt = try #require(payload["issuedAt"] as? Int)
        let expiresAt = try #require(payload["expiresAt"] as? Int)
        #expect(expiresAt > issuedAt)
        // Authority is Mac-derived: the phone must NOT send workspace/posture.
        #expect(payload["workspaceId"] == nil)
        #expect(payload["approvalMode"] == nil)
    }

    @Test func runNowPayloadMatchesLandedContract() throws {
        let payload = try decodePayload(BridgeAction.workflowRunNow(workflowId: "wf-9"))
        #expect(payload["kind"] as? String == "workflowRunNow")
        #expect(payload["workflowId"] as? String == "wf-9")
        #expect(!((payload["actionId"] as? String) ?? "").isEmpty)
        #expect(payload["workspaceId"] == nil)
    }

    // ── Ack decode ────────────────────────────────────────────────────────────

    @Test func ackDataDecodesWorkflowFields() throws {
        let json = #"""
        {"accepted": true, "executed": true,
         "message": "Workflow \"wf-1\" queued to run now",
         "data": {"workflowId": "wf-1", "enabled": true,
                  "scheduledTaskId": "task-3", "workflowExecutionId": "exec-7"}}
        """#
        let ack = try JSONDecoder().decode(
            BridgeActionAck.self, from: Data(json.utf8))
        #expect(ack.data?.workflowId == "wf-1")
        #expect(ack.data?.enabled == true)
        #expect(ack.data?.scheduledTaskId == "task-3")
        #expect(ack.data?.workflowExecutionId == "exec-7")
    }

    // ── Model semantics ───────────────────────────────────────────────────────

    @MainActor
    @Test func demoPauseFlipsLocallyWithDemoMessage() async {
        let model = makeModel()
        model.enterDemoMode()
        model.seedWorkflowsForTesting([workflow("wf-1", enabled: true)])
        await model.setWorkflowEnabled(workflowId: "wf-1", enabled: false)
        #expect(model.workflows.first?.isPaused == true)
        #expect(model.lastActionMessage == "Workflow paused (demo).")
    }

    @MainActor
    @Test func failedPauseRevertsOptimisticFlip() async {
        // No pairing, not connected: the transport throws hostUnavailable
        // immediately, so the optimistic flip must roll back.
        let model = makeModel()
        model.seedWorkflowsForTesting([workflow("wf-1", enabled: true)])
        await model.setWorkflowEnabled(workflowId: "wf-1", enabled: false)
        #expect(model.workflows.first?.enabled == true)
        #expect(model.lastActionMessage?.isEmpty == false)
    }

    @MainActor
    @Test func runNowFailureLeavesWorkflowUntouched() async {
        let model = makeModel()
        model.seedWorkflowsForTesting([workflow("wf-1", enabled: true)])
        await model.runWorkflowNow(workflowId: "wf-1")
        #expect(model.workflows.first?.enabled == true)
        #expect(model.workflows.first?.isRunning == false)
        #expect(model.lastActionMessage?.isEmpty == false)
    }

    // ── Failure surface ───────────────────────────────────────────────────────

    @Test func macDenialReasonsSurfaceVerbatim() {
        let message = RemoteSessionModel.workflowActionFailureMessage(
            RemoteSessionModel.RemoteFileActionError.denied(
                "Workflow already has an active execution"),
            phase: .idle)
        #expect(message == "Workflow already has an active execution")
    }
}
