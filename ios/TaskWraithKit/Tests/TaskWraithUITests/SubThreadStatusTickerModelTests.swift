import Foundation
import Testing
import TaskWraithKit

@testable import TaskWraithUI

@Suite("Sub-thread status ticker model (direct children only)")
struct SubThreadStatusTickerModelTests {
    private func card(
        id: String,
        parent: String?,
        relation: String?,
        provider: String = "codex",
        status: String = "idle",
        title: String = "Child",
        agentName: String? = nil
    ) -> RemoteTaskCard {
        var object: [String: Any] = [
            "id": id,
            "title": title,
            "status": status,
            "provider": provider,
            "workspaceId": "ws",
            "threadId": id,
            "chatKind": "single",
        ]
        if let parent { object["parentChatId"] = parent }
        if let relation { object["parentChatRelation"] = relation }
        if let agentName { object["agentName"] = agentName }
        let data = try! JSONSerialization.data(withJSONObject: object)
        return try! JSONDecoder().decode(RemoteTaskCard.self, from: data)
    }

    @Test func emptyWhenNoRunningDirectChildren() {
        let parent = "parent-1"
        let idle = card(id: "leaf-1", parent: parent, relation: "subThread", status: "idle")
        let model = SubThreadStatusTicker.build(
            parentThreadId: parent,
            parentProvider: "claude",
            taskCards: [idle],
            runningChatIds: []
        )
        #expect(model.isEmpty)
    }

    @Test func emptyWhenViewingTheChildItself() {
        let parent = "parent-1"
        let child = card(id: "child-1", parent: parent, relation: "subThread", status: "running")
        let model = SubThreadStatusTicker.build(
            parentThreadId: child.id,
            parentProvider: "codex",
            taskCards: [child],
            runningChatIds: [child.id]
        )
        #expect(model.isEmpty)
    }

    @Test func showsActiveDirectChildFromRunningSet() {
        let parent = "parent-1"
        let child = card(
            id: "child-1",
            parent: parent,
            relation: "subThread",
            provider: "codex",
            status: "idle",
            title: "Build agent",
            agentName: "Dexterman"
        )
        let model = SubThreadStatusTicker.build(
            parentThreadId: parent,
            parentProvider: "claude",
            taskCards: [child],
            runningChatIds: [child.id]
        )
        #expect(model.items.map(\.id) == ["child-1"])
        #expect(model.items.first?.title == "Build agent")
        #expect(model.items.first?.providerLabel == "Codex")
        #expect(model.parentProviderLabel == "Claude")
        #expect(model.accessibilityLabel.contains("orchestrating"))
        #expect(model.items.first?.accessibilityLabel.contains("Dexterman") == true)
    }

    @Test func excludesSideChatsEvenWhenRunning() {
        let parent = "parent-1"
        let side = card(
            id: "side-1",
            parent: parent,
            relation: "sideChat",
            provider: "grok",
            status: "running"
        )
        let model = SubThreadStatusTicker.build(
            parentThreadId: parent,
            parentProvider: "claude",
            taskCards: [side],
            runningChatIds: [side.id]
        )
        #expect(model.isEmpty)
    }

    @Test func statusFallbackIncludesQueuedWithoutRunningSet() {
        let parent = "parent-1"
        let queued = card(
            id: "child-q",
            parent: parent,
            relation: "subThread",
            status: "queued"
        )
        let model = SubThreadStatusTicker.build(
            parentThreadId: parent,
            parentProvider: "claude",
            taskCards: [queued],
            runningChatIds: nil
        )
        #expect(model.items.map(\.id) == ["child-q"])
    }

    @Test func nilRelationStillCountsAsDirectSubThread() {
        let parent = "parent-1"
        let legacy = card(id: "legacy-1", parent: parent, relation: nil, status: "running")
        #expect(SubThreadStatusTicker.isDirectSubThread(legacy))
        let model = SubThreadStatusTicker.build(
            parentThreadId: parent,
            parentProvider: "kimi",
            taskCards: [legacy],
            runningChatIds: nil
        )
        #expect(model.items.map(\.id) == ["legacy-1"])
    }
}
