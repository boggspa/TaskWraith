import Foundation
import Testing
import TaskWraithKit

@testable import TaskWraithUI

@Suite("Delegation transcript row adapter")
struct DelegationTranscriptRowAdapterTests {
    private func row(
        resultReturned: Bool = false
    ) -> RemoteThreadSnapshot.Row {
        let object: [String: Any] = [
            "id": "delegation-row",
            "role": "system",
            "kind": "system",
            "preview": "Delegated",
            "truncated": false,
            "subThreadDelegation": [
                "subThreadId": "sub-1",
                "parentProvider": "claude",
                "targetProvider": "codex",
                "title": "Build check",
                "promptPreview": "Run the focused checks",
                "returnResultToParent": true,
                "resultReturned": resultReturned,
            ],
        ]
        let data = try! JSONSerialization.data(withJSONObject: object)
        return try! JSONDecoder().decode(RemoteThreadSnapshot.Row.self, from: data)
    }

    private func child(
        id: String = "sub-1",
        status: String = "running",
        relation: String = "subThread"
    ) -> RemoteTaskCard {
        let object: [String: Any] = [
            "id": id,
            "title": "Build check",
            "status": status,
            "provider": "codex",
            "workspaceId": "ws",
            "threadId": id,
            "parentChatId": "parent-1",
            "parentChatRelation": relation,
            "chatKind": "single",
            "agentName": "Scout",
            "agentAccent": "#336699",
        ]
        let data = try! JSONSerialization.data(withJSONObject: object)
        return try! JSONDecoder().decode(RemoteTaskCard.self, from: data)
    }

    @Test func joinsWireMetadataToLiveChildState() {
        let input = DelegationTranscriptRowAdapter.input(
            for: row(),
            childCards: [child()]
        )

        #expect(input?.subThreadId == "sub-1")
        #expect(input?.parentProvider == "claude")
        #expect(input?.targetProvider == "codex")
        #expect(input?.title == "Build check")
        #expect(input?.promptPreview == "Run the focused checks")
        #expect(input?.returnResultToParent == true)
        #expect(input?.status == .running)
        #expect(input?.agentName == "Scout")
        #expect(input?.agentAccent == "#336699")
    }

    @Test func siblingReturnWinsOverTerminalChildStatus() {
        let input = DelegationTranscriptRowAdapter.input(
            for: row(resultReturned: true),
            childCards: [child(status: "success")]
        )
        #expect(input?.status == .returned)
        #expect(input?.showsResultReturnedFooter == true)
    }

    @Test func navigationOpensOnlyTheExistingDirectChild() {
        let intent = DelegationTranscriptRowAdapter.navigation(
            for: row(),
            parentThreadId: "parent-1",
            childCards: [child()]
        )
        #expect(intent == .openExistingChild(subThreadId: "sub-1", destination: .openInMain))

        let sideChatIntent = DelegationTranscriptRowAdapter.navigation(
            for: row(),
            parentThreadId: "parent-1",
            childCards: [child(relation: "sideChat")]
        )
        #expect(!sideChatIntent.isAvailable)
    }

    @Test func absentStructuredFieldDoesNotCreateACard() {
        let data = Data(#"{"id":"plain","role":"system","kind":"system"}"#.utf8)
        let plain = try! JSONDecoder().decode(RemoteThreadSnapshot.Row.self, from: data)
        #expect(DelegationTranscriptRowAdapter.input(for: plain, childCards: []) == nil)
    }
}
