import Foundation

/// `bridge.broadcastThreadList` params — minimal chat summaries the Mac already
/// emits alongside the richer projection snapshot. iOS uses these as a fallback
/// when `taskCard` envelopes are missing or delayed (common on release builds).
public struct ThreadListMessage: Codable, Sendable {
    public let threads: [ThreadSummary]
}

/// Minimal projection of `ChatRecord` for iOS rendering. Mirrors
/// `ThreadSummary` in `src/main/BridgeBroadcaster.ts`.
public struct ThreadSummary: Codable, Sendable, Identifiable, Hashable {
    public let chatId: String
    public let title: String
    /// Null for global (non-workspace) chats.
    public let workspaceId: String?
    public let provider: String
    public let status: String
    public let lastMessageAt: String?
    public let parentChatId: String?
    public let pinned: Bool?
    public let runId: String?
    public let runStartedAt: String?
    /// Solo vs ensemble classification — mirrors desktop `chatKind`.
    public let chatKind: String?

    public var id: String { chatId }
}

public enum ThreadListFallback {
    /// Build a list-row card from a thread summary. Richer projection cards
    /// replace these when `bridge.broadcastRemoteProjectionSnapshot` arrives.
    public static func taskCard(from summary: ThreadSummary) -> RemoteTaskCard {
        RemoteTaskCard(fromThreadSummary: summary)
    }

    /// Merge thread-list fallbacks with any authoritative projection cards.
    /// Returns the merged card list and the ids that remain fallback-only.
    /// When a summary carries `chatKind` and an authoritative card for the same
    /// chat still has nil/empty `chatKind`, patch classification in place.
    public static func mergeTaskCards(
        existing: [RemoteTaskCard],
        fallbackCardIds: Set<String>,
        threads: [ThreadSummary]
    ) -> (cards: [RemoteTaskCard], fallbackCardIds: Set<String>) {
        let summaryById = Dictionary(uniqueKeysWithValues: threads.map { ($0.chatId, $0) })
        let fallbackCards = threads.map(taskCard(from:))
        let authoritative = existing
            .filter { !fallbackCardIds.contains($0.id) }
            .map { repairFromThreadListSummary(from: summaryById[$0.id], onto: $0) }

        if authoritative.isEmpty {
            let ids = Set(fallbackCards.map(\.id))
            return (fallbackCards, ids)
        }

        let authoritativeIds = Set(authoritative.map(\.id))
        let supplemental = fallbackCards.filter { !authoritativeIds.contains($0.id) }
        return (authoritative + supplemental, Set(supplemental.map(\.id)))
    }

    /// Sync authoritative task-card classification + status from a thread-list
    /// summary. Mac now derives both fields from the same projection helpers as
    /// full task cards, so thread-list broadcasts can repair stale cards.
    public static func repairFromThreadListSummary(
        from summary: ThreadSummary?, onto card: RemoteTaskCard
    ) -> RemoteTaskCard {
        guard let summary else { return card }
        var repaired = card

        if let summaryKind = normalized(summary.chatKind) {
            let existingKind = normalized(card.chatKind) ?? "single"
            if existingKind != summaryKind {
                repaired = repaired.withChatKind(summaryKind)
            }
        }

        let summaryStatus = summary.status
        let existingStatus = card.status ?? "idle"
        if existingStatus != summaryStatus {
            repaired = repaired.withStatus(summaryStatus)
        }

        return repaired
    }

    /// Back-compat alias for older call sites/tests.
    public static func repairChatKind(
        from summary: ThreadSummary?, onto card: RemoteTaskCard
    ) -> RemoteTaskCard {
        repairFromThreadListSummary(from: summary, onto: card)
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

extension RemoteTaskCard {
    /// Minimal card synthesized from `bridge.broadcastThreadList`.
    public init(fromThreadSummary summary: ThreadSummary) {
        self.init(
            id: summary.chatId,
            title: summary.title,
            status: summary.status,
            provider: summary.provider,
            selectedModelType: nil,
            customModel: nil,
            codexReasoningEffort: nil,
            claudeReasoningEffort: nil,
            pendingProviderChange: nil,
            workspaceId: summary.workspaceId,
            threadId: summary.chatId,
            parentChatId: summary.parentChatId,
            createdAt: summary.lastMessageAt,
            updatedAt: summary.lastMessageAt ?? summary.runStartedAt,
            parentChatRelation: summary.parentChatId == nil ? nil : "subThread",
            pinned: summary.pinned,
            agentName: nil,
            agentAccent: nil,
            agentSlug: nil,
            sideChatMode: nil,
            sideChatLifecycleState: nil,
            chatKind: summary.chatKind ?? "single",
            isDraft: false,
            draftVariant: nil,
            isShared: nil,
            sharedMode: nil,
            archived: false,
            runId: summary.runId,
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

    /// Returns a copy with an updated `chatKind` (used by thread-list merge repair).
    func withChatKind(_ chatKind: String) -> RemoteTaskCard {
        RemoteTaskCard(
            id: id,
            title: title,
            status: status,
            provider: provider,
            selectedModelType: selectedModelType,
            customModel: customModel,
            codexReasoningEffort: codexReasoningEffort,
            claudeReasoningEffort: claudeReasoningEffort,
            pendingProviderChange: pendingProviderChange,
            workspaceId: workspaceId,
            threadId: threadId,
            parentChatId: parentChatId,
            createdAt: createdAt,
            updatedAt: updatedAt,
            parentChatRelation: parentChatRelation,
            pinned: pinned,
            agentName: agentName,
            agentAccent: agentAccent,
            agentSlug: agentSlug,
            sideChatMode: sideChatMode,
            sideChatLifecycleState: sideChatLifecycleState,
            chatKind: chatKind,
            isDraft: isDraft,
            draftVariant: draftVariant,
            isShared: isShared,
            sharedMode: sharedMode,
            archived: archived,
            runId: runId,
            preview: preview,
            pendingApprovalCount: pendingApprovalCount,
            pendingQuestionCount: pendingQuestionCount,
            activeGoal: activeGoal,
            todoLanes: todoLanes,
            canvasPreviews: canvasPreviews,
            capabilities: capabilities,
            additionalWorkspaces: additionalWorkspaces,
            queuedComposerPrompts: queuedComposerPrompts)
    }

    func withStatus(_ status: String) -> RemoteTaskCard {
        RemoteTaskCard(
            id: id,
            title: title,
            status: status,
            provider: provider,
            selectedModelType: selectedModelType,
            customModel: customModel,
            codexReasoningEffort: codexReasoningEffort,
            claudeReasoningEffort: claudeReasoningEffort,
            pendingProviderChange: pendingProviderChange,
            workspaceId: workspaceId,
            threadId: threadId,
            parentChatId: parentChatId,
            createdAt: createdAt,
            updatedAt: updatedAt,
            parentChatRelation: parentChatRelation,
            pinned: pinned,
            agentName: agentName,
            agentAccent: agentAccent,
            agentSlug: agentSlug,
            sideChatMode: sideChatMode,
            sideChatLifecycleState: sideChatLifecycleState,
            chatKind: chatKind,
            isDraft: isDraft,
            draftVariant: draftVariant,
            isShared: isShared,
            sharedMode: sharedMode,
            archived: archived,
            runId: runId,
            preview: preview,
            pendingApprovalCount: pendingApprovalCount,
            pendingQuestionCount: pendingQuestionCount,
            activeGoal: activeGoal,
            todoLanes: todoLanes,
            canvasPreviews: canvasPreviews,
            capabilities: capabilities,
            additionalWorkspaces: additionalWorkspaces,
            queuedComposerPrompts: queuedComposerPrompts)
    }
}
