import Foundation
import Testing
import TaskWraithKit

@testable import TaskWraithUI

@Suite("Existing-child navigation intent")
struct ExistingChildNavigationIntentTests {
    private func card(
        id: String,
        parent: String?,
        relation: String?
    ) -> RemoteTaskCard {
        var object: [String: Any] = [
            "id": id,
            "title": "Child",
            "status": "idle",
            "provider": "codex",
            "workspaceId": "ws",
            "threadId": id,
            "chatKind": "single",
        ]
        if let parent { object["parentChatId"] = parent }
        if let relation { object["parentChatRelation"] = relation }
        let data = try! JSONSerialization.data(withJSONObject: object)
        return try! JSONDecoder().decode(RemoteTaskCard.self, from: data)
    }

    @Test func opensExistingDirectChild() {
        let child = card(id: "sub-1", parent: "parent-1", relation: "subThread")
        let intent = ExistingChildNavigation.resolve(
            subThreadId: "sub-1",
            parentThreadId: "parent-1",
            childCards: [child],
            preferredDestination: .openInSidePanel
        )
        #expect(intent == .openExistingChild(subThreadId: "sub-1", destination: .openInSidePanel))
        #expect(intent.isAvailable)
        #expect(intent.actionLabel == "Open in Side Chat")
        #expect(intent.accessibilityLabel.contains("existing sub-thread"))
    }

    @Test func mainDestinationLabelDoesNotImplyCreate() {
        let child = card(id: "sub-1", parent: "parent-1", relation: "subThread")
        let intent = ExistingChildNavigation.resolve(
            subThreadId: "sub-1",
            parentThreadId: "parent-1",
            childCards: [child],
            preferredDestination: .openInMain
        )
        #expect(intent.actionLabel == "Open sub-thread")
        #expect(!intent.actionLabel.lowercased().contains("new"))
    }

    @Test func missingIdIsUnavailable() {
        let intent = ExistingChildNavigation.resolve(
            subThreadId: "  ",
            parentThreadId: "parent-1",
            childCards: []
        )
        #expect(intent == .unavailable(reason: "missing sub-thread id"))
        #expect(!intent.isAvailable)
    }

    @Test func staleIdIsUnavailable() {
        let intent = ExistingChildNavigation.resolve(
            subThreadId: "gone",
            parentThreadId: "parent-1",
            childCards: [card(id: "other", parent: "parent-1", relation: "subThread")]
        )
        #expect(intent == .unavailable(reason: "child thread not found"))
    }

    @Test func wrongParentIsUnavailable() {
        let child = card(id: "sub-1", parent: "other-parent", relation: "subThread")
        let intent = ExistingChildNavigation.resolve(
            subThreadId: "sub-1",
            parentThreadId: "parent-1",
            childCards: [child]
        )
        #expect(intent == .unavailable(reason: "not a child of this thread"))
    }

    @Test func sideChatTargetIsUnavailable() {
        let side = card(id: "side-1", parent: "parent-1", relation: "sideChat")
        let intent = ExistingChildNavigation.resolve(
            subThreadId: "side-1",
            parentThreadId: "parent-1",
            childCards: [side]
        )
        #expect(intent == .unavailable(reason: "target is a side chat, not a sub-thread"))
    }
}
