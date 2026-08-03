import Foundation
import Testing
import TaskWraithKit

@testable import TaskWraithUI

@Suite("Agent Invocation card model (desktop status parity)")
struct AgentInvocationCardModelTests {
    @Test func liveRunningSetWinsOverIdleCard() {
        let child = AgentInvocationChildSnapshot(
            id: "sub-1",
            status: "idle",
            isInLiveRunningSet: true
        )
        #expect(AgentInvocationStatusResolver.resolve(child) == .running)
    }

    @Test func createdWhenIdleWithNoRuns() {
        let child = AgentInvocationChildSnapshot(
            id: "sub-1",
            status: "idle",
            hasRecordedRun: false
        )
        #expect(AgentInvocationStatusResolver.resolve(child) == .created)
    }

    @Test func queuedCardMapsToRunningWithoutLiveSet() {
        let child = AgentInvocationChildSnapshot(id: "sub-1", status: "queued")
        #expect(AgentInvocationStatusResolver.resolve(child) == .running)
    }

    @Test func awaitingApprovalMapsToRunning() {
        let child = AgentInvocationChildSnapshot(id: "sub-1", status: "awaitingApproval")
        #expect(AgentInvocationStatusResolver.resolve(child) == .running)
    }

    @Test func completedOnSuccess() {
        let child = AgentInvocationChildSnapshot(id: "sub-1", status: "success")
        #expect(AgentInvocationStatusResolver.resolve(child) == .completed)
    }

    @Test func returnedWhenResultTimestampPresent() {
        let child = AgentInvocationChildSnapshot(
            id: "sub-1",
            status: "success",
            resultReturnedAt: 1_700_000_000
        )
        #expect(AgentInvocationStatusResolver.resolve(child) == .returned)
    }

    @Test func failedOnRunFailure() {
        let child = AgentInvocationChildSnapshot(id: "sub-1", status: "failed")
        #expect(AgentInvocationStatusResolver.resolve(child) == .failed(reason: "Run failed"))
    }

    @Test func failedToStartOnDispatchError() {
        let child = AgentInvocationChildSnapshot(
            id: "sub-1",
            status: "idle",
            dispatchErrorMessage: "spawn refused"
        )
        #expect(AgentInvocationStatusResolver.resolve(child) == .failed(reason: "Failed to start"))
    }

    @Test func cancelledMaps() {
        let child = AgentInvocationChildSnapshot(id: "sub-1", status: "cancelled")
        #expect(AgentInvocationStatusResolver.resolve(child) == .cancelled(reason: "Run cancelled"))
    }

    @Test func unknownWithoutChild() {
        #expect(AgentInvocationStatusResolver.resolve(nil) == .unknown)
    }

    @Test func inputDefaultsAndRouteLabels() {
        let input = AgentInvocationCardInput(
            subThreadId: "  sub-1  ",
            parentProvider: "claude",
            targetProvider: "codex",
            title: "  ",
            promptPreview: " Do the thing ",
            returnResultToParent: true,
            status: .returned
        )
        #expect(input.subThreadId == "sub-1")
        #expect(input.title == "Untitled sub-thread")
        #expect(input.promptPreview == "Do the thing")
        #expect(input.showsResultReturnedFooter == true)
        #expect(input.routeNote == "Durable sub-thread")
        #expect(AgentInvocationRoute.providerNative.label == "Provider tool call in this transcript")
        #expect(input.status.glyph == "↩")
        #expect(input.status.label == "Returned")
        #expect(AgentInvocationStatus.running.label == "Active")
    }
}
