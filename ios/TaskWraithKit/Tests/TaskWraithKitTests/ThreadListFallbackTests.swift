// Thread-list fallback — iOS consumes `bridge.broadcastThreadList` when the
// richer projection snapshot is empty or delayed (release pairing symptom).

import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Thread list fallback")
struct ThreadListFallbackTests {
    private func summary(
        chatId: String = "chat-1",
        title: String = "Fix the bridge",
        workspaceId: String? = "ws-agbench",
        provider: String = "cursor",
        status: String = "idle",
        parentChatId: String? = nil,
        chatKind: String? = nil
    ) -> ThreadSummary {
        ThreadSummary(
            chatId: chatId,
            title: title,
            workspaceId: workspaceId,
            provider: provider,
            status: status,
            lastMessageAt: "2026-07-05T18:00:00Z",
            parentChatId: parentChatId,
            pinned: false,
            runId: nil,
            runStartedAt: nil,
            chatKind: chatKind)
    }

    @Test("ThreadListMessage decodes Mac broadcast shape")
    func decodeThreadListMessage() throws {
        let json = """
        {"threads":[{"chatId":"c1","title":"Hello","workspaceId":"ws1","provider":"codex","status":"running","lastMessageAt":"2026-07-05T18:00:00Z","pinned":true,"chatKind":"ensemble"}]}
        """
        let message = try JSONDecoder().decode(ThreadListMessage.self, from: Data(json.utf8))
        #expect(message.threads.count == 1)
        #expect(message.threads[0].chatId == "c1")
        #expect(message.threads[0].pinned == true)
        #expect(message.threads[0].chatKind == "ensemble")
    }

    @Test("taskCard maps chatKind for ensemble classification")
    func taskCardMapsChatKind() {
        let ensemble = ThreadListFallback.taskCard(from: summary(chatKind: "ensemble"))
        #expect(ensemble.isEnsemble == true)
        #expect(ensemble.chatKind == "ensemble")
        let solo = ThreadListFallback.taskCard(from: summary(chatKind: nil))
        #expect(solo.isEnsemble == false)
        #expect(solo.chatKind == "single")
    }

    @Test("taskCard maps summary fields for list rendering")
    func taskCardFromSummary() {
        let card = ThreadListFallback.taskCard(from: summary(chatId: "sub-1", parentChatId: "parent-1"))
        #expect(card.id == "sub-1")
        #expect(card.threadId == "sub-1")
        #expect(card.title == "Fix the bridge")
        #expect(card.workspaceId == "ws-agbench")
        #expect(card.provider == "cursor")
        #expect(card.status == "idle")
        #expect(card.parentChatId == "parent-1")
        #expect(card.parentChatRelation == "subThread")
        #expect(card.isDraft == false)
        #expect(card.archived == false)
    }

    @Test("mergeTaskCards uses fallback when no authoritative cards exist")
    func mergeFallbackOnly() {
        let threads = [summary(chatId: "a"), summary(chatId: "b")]
        let merged = ThreadListFallback.mergeTaskCards(
            existing: [],
            fallbackCardIds: [],
            threads: threads)
        #expect(merged.cards.map(\.id) == ["a", "b"])
        #expect(merged.fallbackCardIds == Set(["a", "b"]))
    }

    @Test("mergeTaskCards keeps authoritative projection and adds missing threads")
    func mergeAuthoritativeWins() {
        let authoritative = RemoteTaskCard(
            id: "a",
            title: "Rich card",
            status: "running",
            provider: "claude",
            selectedModelType: nil,
            customModel: nil,
            codexReasoningEffort: nil,
            claudeReasoningEffort: nil,
            pendingProviderChange: nil,
            workspaceId: "ws1",
            threadId: "a",
            parentChatId: nil,
            createdAt: nil,
            updatedAt: nil,
            parentChatRelation: nil,
            pinned: nil,
            agentName: nil,
            agentAccent: nil,
            agentSlug: nil,
            sideChatMode: nil,
            sideChatLifecycleState: nil,
            chatKind: nil,
            isDraft: nil,
            draftVariant: nil,
            isShared: nil,
            sharedMode: nil,
            archived: nil,
            runId: nil,
            preview: "preview text",
            pendingApprovalCount: nil,
            pendingQuestionCount: nil,
            activeGoal: nil,
            todoLanes: nil,
            canvasPreviews: nil,
            capabilities: nil,
            additionalWorkspaces: nil,
            queuedComposerPrompts: nil)
        let merged = ThreadListFallback.mergeTaskCards(
            existing: [authoritative],
            fallbackCardIds: [],
            threads: [summary(chatId: "a", title: "Stale"), summary(chatId: "b")])
        #expect(merged.cards.count == 2)
        #expect(merged.cards[0].title == "Rich card")
        #expect(merged.cards[1].id == "b")
        #expect(merged.fallbackCardIds == Set(["b"]))
    }

    @Test("mergeTaskCards repairs missing chatKind on authoritative cards")
    func mergeRepairsChatKind() {
        let authoritative = RemoteTaskCard(
            id: "a",
            title: "Rich card",
            status: "running",
            provider: "claude",
            selectedModelType: nil,
            customModel: nil,
            codexReasoningEffort: nil,
            claudeReasoningEffort: nil,
            pendingProviderChange: nil,
            workspaceId: "ws1",
            threadId: "a",
            parentChatId: nil,
            createdAt: nil,
            updatedAt: nil,
            parentChatRelation: nil,
            pinned: nil,
            agentName: nil,
            agentAccent: nil,
            agentSlug: nil,
            sideChatMode: nil,
            sideChatLifecycleState: nil,
            chatKind: nil,
            isDraft: nil,
            draftVariant: nil,
            isShared: nil,
            sharedMode: nil,
            archived: nil,
            runId: nil,
            preview: "preview text",
            pendingApprovalCount: nil,
            pendingQuestionCount: nil,
            activeGoal: nil,
            todoLanes: nil,
            canvasPreviews: nil,
            capabilities: nil,
            additionalWorkspaces: nil,
            queuedComposerPrompts: nil)
        let merged = ThreadListFallback.mergeTaskCards(
            existing: [authoritative],
            fallbackCardIds: [],
            threads: [summary(chatId: "a", chatKind: "ensemble")])
        #expect(merged.cards[0].chatKind == "ensemble")
        #expect(merged.cards[0].isEnsemble == true)
    }

    @Test("mergeTaskCards syncs chatKind from aligned thread-list summaries")
    func mergeSyncsChatKindFromThreadList() {
        let authoritative = RemoteTaskCard(
            id: "a",
            title: "Rich card",
            status: "idle",
            provider: "claude",
            selectedModelType: nil,
            customModel: nil,
            codexReasoningEffort: nil,
            claudeReasoningEffort: nil,
            pendingProviderChange: nil,
            workspaceId: "ws1",
            threadId: "a",
            parentChatId: nil,
            createdAt: nil,
            updatedAt: nil,
            parentChatRelation: nil,
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
        let repaired = ThreadListFallback.repairFromThreadListSummary(
            from: summary(chatId: "a", chatKind: "ensemble"), onto: authoritative)
        #expect(repaired.chatKind == "ensemble")
        #expect(repaired.isEnsemble == true)
        #expect(repaired.provider == "claude")
    }

    @Test("mergeTaskCards clears stale running status from thread-list summaries")
    func mergeClearsStaleRunningStatus() {
        let authoritative = RemoteTaskCard(
            id: "a",
            title: "Rich card",
            status: "running",
            provider: "claude",
            selectedModelType: nil,
            customModel: nil,
            codexReasoningEffort: nil,
            claudeReasoningEffort: nil,
            pendingProviderChange: nil,
            workspaceId: "ws1",
            threadId: "a",
            parentChatId: nil,
            createdAt: nil,
            updatedAt: nil,
            parentChatRelation: nil,
            pinned: nil,
            agentName: nil,
            agentAccent: nil,
            agentSlug: nil,
            sideChatMode: nil,
            sideChatLifecycleState: nil,
            chatKind: "ensemble",
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
        let repaired = ThreadListFallback.repairFromThreadListSummary(
            from: summary(chatId: "a", status: "idle", chatKind: "ensemble"), onto: authoritative)
        #expect(repaired.status == "idle")
        #expect(repaired.isEnsemble == true)
    }
}
