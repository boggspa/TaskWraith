// Pure policy model for single-message transcript deletion.
//
// Mirrors desktop `deleteMessageFromChat` / `messageAnchorsActivePrompt`
// (`App.tsx` + `transcriptDeleteGuard.ts` + `agentQuestionQueueHasMessage`):
// 1. Block when the row anchors an open ask_user_question or pending plan choice.
// 2. Otherwise require an explicit confirmation that previews the body.
//
// Presentation only — no bridge mutation, no RemoteSessionModel / Models
// imports. Integrators supply pending-anchor ids and execute delete via callback.

import Foundation

/// Desktop confirm title (before the preview body).
public enum TranscriptMessageDeletionCopy {
    public static let confirmTitle = "Delete this message from the transcript?"
    public static let confirmAction = "Delete"
    public static let cancelAction = "Cancel"
    public static let dismissBlockedAction = "OK"
    public static let blockedReason =
        "This message has an open prompt waiting on it. Answer or dismiss the prompt before deleting the message."
    public static let deleteButtonTitle = "Delete message"
    public static let deleteButtonAccessibility = "Delete message from transcript"

    /// Preview truncation matches desktop (`content.length > 80` → 77 + "…").
    public static let previewLimit = 80
    public static let previewKeep = 77
}

/// Inputs the host already knows without decoding wire models in this file.
public struct TranscriptMessageDeletionInput: Equatable, Sendable {
    public var messageId: String
    public var role: String?
    public var content: String?
    /// Message ids currently anchoring queued `ask_user_question` prompts.
    public var pendingAgentQuestionMessageIds: Set<String>
    /// Message id of the in-flight plan-mode choice, if any.
    public var pendingPlanChoiceMessageId: String?

    public init(
        messageId: String,
        role: String? = nil,
        content: String? = nil,
        pendingAgentQuestionMessageIds: Set<String> = [],
        pendingPlanChoiceMessageId: String? = nil
    ) {
        self.messageId = messageId
        self.role = role
        self.content = content
        self.pendingAgentQuestionMessageIds = pendingAgentQuestionMessageIds
        self.pendingPlanChoiceMessageId = pendingPlanChoiceMessageId
    }
}

/// Confirmation payload shown before a deletable (non-anchored) message is removed.
public struct TranscriptMessageDeletionConfirmation: Equatable, Sendable, Identifiable {
    public var messageId: String
    public var title: String
    /// Truncated / role-fallback preview shown under the title.
    public var preview: String
    /// Full confirm body: title + blank line + preview (desktop `window.confirm` text).
    public var confirmText: String
    public var confirmActionLabel: String
    public var cancelActionLabel: String
    public var accessibilityLabel: String

    public var id: String { messageId }

    public init(
        messageId: String,
        title: String,
        preview: String,
        confirmText: String,
        confirmActionLabel: String,
        cancelActionLabel: String,
        accessibilityLabel: String
    ) {
        self.messageId = messageId
        self.title = title
        self.preview = preview
        self.confirmText = confirmText
        self.confirmActionLabel = confirmActionLabel
        self.cancelActionLabel = cancelActionLabel
        self.accessibilityLabel = accessibilityLabel
    }
}

/// Blocked-state chrome when the message still anchors an open prompt/plan.
public struct TranscriptMessageDeletionBlocked: Equatable, Sendable, Identifiable {
    public var messageId: String
    public var reason: String
    public var dismissActionLabel: String
    public var accessibilityLabel: String

    public var id: String { messageId }

    public init(
        messageId: String,
        reason: String,
        dismissActionLabel: String,
        accessibilityLabel: String
    ) {
        self.messageId = messageId
        self.reason = reason
        self.dismissActionLabel = dismissActionLabel
        self.accessibilityLabel = accessibilityLabel
    }
}

/// Policy outcome — never auto-deletes.
public enum TranscriptMessageDeletionDecision: Equatable, Sendable {
    /// Missing / blank message id — host must not invent a fallback.
    case unavailable
    /// Open prompt/plan still references this row.
    case blocked(TranscriptMessageDeletionBlocked)
    /// Destructive action needs an explicit user confirm.
    case requiresConfirmation(TranscriptMessageDeletionConfirmation)
}

/// Intent emitted only after the user confirms (callback seam for Boss wiring).
public struct TranscriptMessageDeletionIntent: Equatable, Sendable {
    public var messageId: String

    public init(messageId: String) {
        self.messageId = messageId
    }
}

public enum TranscriptMessageDeletionPolicyModel {
    /// Pure desktop guard: message is the anchor of a pending agent question
    /// and/or plan choice.
    public static func messageAnchorsActivePrompt(
        messageId: String,
        pendingAgentQuestionMessageId: String?,
        pendingPlanChoiceMessageId: String?
    ) -> Bool {
        let id = normalizedId(messageId)
        guard !id.isEmpty else { return false }
        if let pending = normalizedOptionalId(pendingAgentQuestionMessageId), pending == id {
            return true
        }
        if let pending = normalizedOptionalId(pendingPlanChoiceMessageId), pending == id {
            return true
        }
        return false
    }

    /// Queue form of the agent-question anchor check (`agentQuestionQueueHasMessage`).
    public static func agentQuestionQueueHasMessage(
        pendingMessageIds: Set<String>,
        messageId: String
    ) -> Bool {
        let id = normalizedId(messageId)
        guard !id.isEmpty else { return false }
        return pendingMessageIds.contains { normalizedId($0) == id }
    }

    /// Evaluate whether delete is blocked or needs confirmation.
    public static func evaluate(_ input: TranscriptMessageDeletionInput)
        -> TranscriptMessageDeletionDecision
    {
        let id = normalizedId(input.messageId)
        guard !id.isEmpty else { return .unavailable }

        let anchorsQuestion = agentQuestionQueueHasMessage(
            pendingMessageIds: input.pendingAgentQuestionMessageIds,
            messageId: id
        )
        let anchorsPlan = messageAnchorsActivePrompt(
            messageId: id,
            pendingAgentQuestionMessageId: nil,
            pendingPlanChoiceMessageId: input.pendingPlanChoiceMessageId
        )
        if anchorsQuestion || anchorsPlan {
            let reason = TranscriptMessageDeletionCopy.blockedReason
            return .blocked(
                TranscriptMessageDeletionBlocked(
                    messageId: id,
                    reason: reason,
                    dismissActionLabel: TranscriptMessageDeletionCopy.dismissBlockedAction,
                    accessibilityLabel: "Cannot delete message. \(reason)"
                )
            )
        }

        let preview = makePreview(content: input.content, role: input.role)
        let title = TranscriptMessageDeletionCopy.confirmTitle
        let confirmText = "\(title)\n\n\(preview)"
        return .requiresConfirmation(
            TranscriptMessageDeletionConfirmation(
                messageId: id,
                title: title,
                preview: preview,
                confirmText: confirmText,
                confirmActionLabel: TranscriptMessageDeletionCopy.confirmAction,
                cancelActionLabel: TranscriptMessageDeletionCopy.cancelAction,
                accessibilityLabel: "\(title) \(preview)"
            )
        )
    }

    /// Convenience over discrete pending ids (single question + plan).
    public static func evaluate(
        messageId: String,
        role: String? = nil,
        content: String? = nil,
        pendingAgentQuestionMessageId: String? = nil,
        pendingPlanChoiceMessageId: String? = nil
    ) -> TranscriptMessageDeletionDecision {
        var pendingIds = Set<String>()
        if let pending = normalizedOptionalId(pendingAgentQuestionMessageId) {
            pendingIds.insert(pending)
        }
        return evaluate(
            TranscriptMessageDeletionInput(
                messageId: messageId,
                role: role,
                content: content,
                pendingAgentQuestionMessageIds: pendingIds,
                pendingPlanChoiceMessageId: pendingPlanChoiceMessageId
            )
        )
    }

    /// True when the host may show a Delete affordance for this identity.
    /// Blocked anchors still show Delete so the user gets the blocked explanation.
    public static func showsDeleteAffordance(messageId: String?) -> Bool {
        !normalizedId(messageId ?? "").isEmpty
    }

    public static func deleteAffordanceTitle() -> String {
        TranscriptMessageDeletionCopy.deleteButtonTitle
    }

    public static func deleteAffordanceAccessibilityLabel() -> String {
        TranscriptMessageDeletionCopy.deleteButtonAccessibility
    }

    /// Build a confirmed delete intent only from a confirmation payload the
    /// user already accepted — never from a blocked decision.
    public static func confirmedIntent(
        from confirmation: TranscriptMessageDeletionConfirmation
    ) -> TranscriptMessageDeletionIntent? {
        let id = normalizedId(confirmation.messageId)
        guard !id.isEmpty else { return nil }
        return TranscriptMessageDeletionIntent(messageId: id)
    }

    /// Desktop preview: truncate at 80 with 77 + "…", else `(role message)`.
    public static func makePreview(content: String?, role: String?) -> String {
        if let content, !content.isEmpty {
            if content.count > TranscriptMessageDeletionCopy.previewLimit {
                return String(content.prefix(TranscriptMessageDeletionCopy.previewKeep)) + "…"
            }
            return content
        }
        if let roleLabel = normalizedOptional(role) {
            return "(\(roleLabel) message)"
        }
        return "(message)"
    }

    // MARK: - Normalization

    private static func normalizedId(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func normalizedOptionalId(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = normalizedId(value)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func normalizedOptional(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
