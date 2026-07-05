import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Chat kind bridge helpers")
struct ChatKindBridgeTests {
    private func card(
        provider: String = "claude",
        parentChatRelation: String? = nil,
        parentChatId: String? = nil
    ) -> RemoteTaskCard {
        RemoteTaskCard(
            id: "chat-1",
            title: "Test",
            status: "idle",
            provider: provider,
            selectedModelType: "sonnet",
            customModel: nil,
            codexReasoningEffort: nil,
            claudeReasoningEffort: nil,
            pendingProviderChange: nil,
            workspaceId: "ws-1",
            threadId: "chat-1",
            parentChatId: parentChatId,
            createdAt: nil,
            updatedAt: nil,
            parentChatRelation: parentChatRelation,
            pinned: nil,
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
            queuedComposerPrompts: nil)
    }

    @Test("buildSeedParticipant uses composer provider and card model")
    func seedParticipant() {
        let seed = ChatKindBridge.buildSeedParticipant(from: card(), provider: "codex", model: "gpt-5")
        #expect(seed["provider"] as? String == "codex")
        #expect(seed["model"] as? String == "gpt-5")
        #expect(seed["enabled"] as? Bool == true)
        #expect((seed["id"] as? String)?.hasPrefix("ensemble-seed-codex-") == true)
    }

    @Test("buildSeedParticipant works without a task card")
    func seedParticipantWithoutCard() {
        let seed = ChatKindBridge.buildSeedParticipant(provider: "claude", model: "sonnet")
        #expect(seed["provider"] as? String == "claude")
        #expect(seed["model"] as? String == "sonnet")
    }

    @Test("isLinkedChild detects sub-threads and side chats")
    func linkedChild() {
        #expect(ChatKindBridge.isLinkedChild(card(parentChatRelation: "subThread", parentChatId: "p")) == true)
        #expect(ChatKindBridge.isLinkedChild(card(parentChatRelation: "sideChat")) == true)
        #expect(ChatKindBridge.isLinkedChild(card()) == false)
    }
}
