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
        RemoteTaskCard(
            id: id,
            title: "Child",
            status: "idle",
            provider: "codex",
            selectedModelType: nil,
            customModel: nil,
            codexReasoningEffort: nil,
            claudeReasoningEffort: nil,
            pendingProviderChange: nil,
            workspaceId: "ws",
            threadId: id,
            parentChatId: parent,
            createdAt: nil,
            updatedAt: nil,
            parentChatRelation: relation,
            pinned: nil,
            watchingPr: nil,
            agentName: nil,
            agentAccent: nil,
            agentSlug: nil,
            sideChatMode: nil,
            sideChatLifecycleState: nil,
            chatKind: "single",
            isDraft: nil,
            draftVariant: nil,
            isShared: nil,
            sharedMode: nil,
            archived: nil,
            runId: nil,
            preview: nil,
            pendingApprovalCount: nil,
            pendingQuestionCount: nil,
            activeGoal: nil,
            todoLanes: nil,
            canvasPreviews: nil,
            capabilities: nil,
            additionalWorkspaces: nil,
            queuedComposerPrompts: nil
        )
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
