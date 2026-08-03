// Pure presentation model for assistant message thumbs feedback.
//
// Desktop contract mirrored from `src/renderer/src/lib/messageFeedback.ts` and
// `TranscriptMessageContextMenu` / `TranscriptPanel`:
// - Assistant-only (and not channel-inbound relay rows).
// - Toggle: re-applying the same vote with no extra detail clears feedback.
// - Flip: up ↔ down replaces the vote without clearing.
// - Re-applying the same vote WITH reason/note updates rather than clears.
// - Six closed-set poor-rating reason codes + optional free-text note (≤1000).
// - Reason free-text is bounded to 80 chars (desktop MAX_FEEDBACK_REASON_CHARS).
// - No deletion surface here — message delete is a separate candidate.
//
// Callbacks only: the host owns durable ledger writes and bridge mutation.
// This file stays free of RemoteSessionModel / BridgeAction* / Models.swift.

import Foundation

/// Thumbs vote on an assistant message. Mirrors desktop `MessageFeedbackVote`.
public enum AssistantMessageFeedbackVote: String, Equatable, Sendable, CaseIterable {
    case up
    case down
}

/// Closed-set poor-rating reason codes. Order and codes match desktop
/// `MESSAGE_FEEDBACK_REASON_OPTIONS` exactly so Mac receipts stay comparable.
public enum AssistantMessageFeedbackReasonCode: String, Equatable, Sendable, CaseIterable {
    case wrongApproach = "wrong-approach"
    case hallucinatedOrWrong = "hallucinated-or-wrong"
    case brokeSomething = "broke-something"
    case overVerbose = "over-verbose"
    case wrongModelForRole = "wrong-model-for-role"
    case incomplete = "incomplete"

    public var label: String {
        switch self {
        case .wrongApproach: return "Wrong approach"
        case .hallucinatedOrWrong: return "Hallucinated / wrong"
        case .brokeSomething: return "Broke something"
        case .overVerbose: return "Over-verbose"
        case .wrongModelForRole: return "Wrong model for role"
        case .incomplete: return "Incomplete"
        }
    }
}

/// Optional detail attached when voting (typically thumbs-down reasons).
public struct AssistantMessageFeedbackDetails: Equatable, Sendable {
    public var reason: String?
    public var note: String?

    public init(reason: String? = nil, note: String? = nil) {
        self.reason = reason
        self.note = note
    }

    public init(reasonCode: AssistantMessageFeedbackReasonCode, note: String? = nil) {
        self.reason = reasonCode.rawValue
        self.note = note
    }
}

/// Stored feedback snapshot after apply/read. Pure value — not a wire DTO.
public struct AssistantMessageFeedbackState: Equatable, Sendable {
    public var vote: AssistantMessageFeedbackVote
    /// Epoch ms when the vote was last set (caller-supplied for determinism).
    public var at: Int64
    public var reason: String?
    public var note: String?

    public init(
        vote: AssistantMessageFeedbackVote,
        at: Int64,
        reason: String? = nil,
        note: String? = nil
    ) {
        self.vote = vote
        self.at = at
        self.reason = reason
        self.note = note
    }
}

/// Host-facing intent produced by the action chrome. Integrators map this to
/// bridge/store writes; this candidate never mutates chat state itself.
public struct AssistantMessageFeedbackRequest: Equatable, Sendable {
    public var messageId: String
    public var vote: AssistantMessageFeedbackVote
    public var details: AssistantMessageFeedbackDetails?

    public init(
        messageId: String,
        vote: AssistantMessageFeedbackVote,
        details: AssistantMessageFeedbackDetails? = nil
    ) {
        self.messageId = messageId
        self.vote = vote
        self.details = details
    }
}

/// One assistant row's feedback chrome input.
public struct AssistantMessageFeedbackItem: Equatable, Sendable, Identifiable {
    public var messageId: String
    /// Desktop/message role string. Feedback is offered only for `assistant`.
    public var role: String
    /// Desktop `metadata.kind` — `channelInbound` is not rateable.
    public var metadataKind: String?
    public var current: AssistantMessageFeedbackState?

    public var id: String { messageId }

    public init(
        messageId: String,
        role: String,
        metadataKind: String? = nil,
        current: AssistantMessageFeedbackState? = nil
    ) {
        self.messageId = messageId.trimmingCharacters(in: .whitespacesAndNewlines)
        self.role = role.trimmingCharacters(in: .whitespacesAndNewlines)
        if let kind = metadataKind?.trimmingCharacters(in: .whitespacesAndNewlines),
            !kind.isEmpty
        {
            self.metadataKind = kind
        } else {
            self.metadataKind = nil
        }
        self.current = current
    }
}

public enum AssistantMessageFeedbackCopy {
    public static let goodResponse = "Good response"
    public static let removeGoodRating = "Remove good rating"
    public static let poorResponse = "Poor response"
    public static let removePoorRating = "Remove poor rating"
    public static let reasonSectionTitle = "Why was this poor?"
    public static let notePlaceholder = "Optional note (local only)"
    public static let noteCharLimitHint = "Up to 1000 characters"
    public static let notRateableHint = "Only assistant messages can be rated"
}

public enum AssistantMessageFeedbackModel {
    public static let maxReasonChars = 80
    public static let maxNoteChars = 1000

    /// Desktop `canRateMessage`: assistant role and not channel-inbound relay.
    public static func canRate(_ item: AssistantMessageFeedbackItem) -> Bool {
        guard !item.messageId.isEmpty else { return false }
        guard item.role == "assistant" else { return false }
        if item.metadataKind == "channelInbound" { return false }
        return true
    }

    public static func readVote(
        from state: AssistantMessageFeedbackState?
    ) -> AssistantMessageFeedbackVote? {
        state?.vote
    }

    /// Toggle-apply a vote. Same contract as desktop `applyChatMessageFeedback`:
    /// - same vote + no extra → clear
    /// - otherwise set/replace with bounded reason/note
    public static func apply(
        current: AssistantMessageFeedbackState?,
        vote: AssistantMessageFeedbackVote,
        at: Int64,
        extra: AssistantMessageFeedbackDetails? = nil
    ) -> AssistantMessageFeedbackState? {
        let hasExtra =
            boundedText(extra?.reason, max: maxReasonChars) != nil
            || boundedText(extra?.note, max: maxNoteChars) != nil

        if current?.vote == vote, !hasExtra {
            return nil
        }

        let reason = boundedText(extra?.reason, max: maxReasonChars)
        let note = boundedText(extra?.note, max: maxNoteChars)
        return AssistantMessageFeedbackState(
            vote: vote,
            at: at,
            reason: reason,
            note: note
        )
    }

    /// Build a host request for thumbs-up / thumbs-down chrome. Returns nil when
    /// the row is not rateable — host must not invent a fallback message id.
    public static func makeRequest(
        item: AssistantMessageFeedbackItem,
        vote: AssistantMessageFeedbackVote,
        details: AssistantMessageFeedbackDetails? = nil
    ) -> AssistantMessageFeedbackRequest? {
        guard canRate(item) else { return nil }
        return AssistantMessageFeedbackRequest(
            messageId: item.messageId,
            vote: vote,
            details: sanitizeDetails(details)
        )
    }

    public static func makeReasonRequest(
        item: AssistantMessageFeedbackItem,
        reason: AssistantMessageFeedbackReasonCode,
        note: String? = nil
    ) -> AssistantMessageFeedbackRequest? {
        makeRequest(
            item: item,
            vote: .down,
            details: AssistantMessageFeedbackDetails(reasonCode: reason, note: note)
        )
    }

    /// Desktop context-menu labels for the active vote state.
    public static func thumbsUpTitle(current: AssistantMessageFeedbackState?) -> String {
        current?.vote == .up
            ? AssistantMessageFeedbackCopy.removeGoodRating
            : AssistantMessageFeedbackCopy.goodResponse
    }

    public static func thumbsDownTitle(current: AssistantMessageFeedbackState?) -> String {
        current?.vote == .down
            ? AssistantMessageFeedbackCopy.removePoorRating
            : AssistantMessageFeedbackCopy.poorResponse
    }

    public static func accessibilityLabel(
        for vote: AssistantMessageFeedbackVote,
        item: AssistantMessageFeedbackItem
    ) -> String {
        switch vote {
        case .up:
            return thumbsUpTitle(current: item.current)
        case .down:
            return thumbsDownTitle(current: item.current)
        }
    }

    public static func reasonAccessibilityLabel(
        _ reason: AssistantMessageFeedbackReasonCode
    ) -> String {
        "Poor response: \(reason.label)"
    }

    public static func systemImage(for vote: AssistantMessageFeedbackVote, selected: Bool)
        -> String
    {
        switch vote {
        case .up:
            return selected ? "hand.thumbsup.fill" : "hand.thumbsup"
        case .down:
            return selected ? "hand.thumbsdown.fill" : "hand.thumbsdown"
        }
    }

    public static func isSelected(
        _ vote: AssistantMessageFeedbackVote,
        current: AssistantMessageFeedbackState?
    ) -> Bool {
        current?.vote == vote
    }

    /// All six desktop reason options in stable display order.
    public static var reasonOptions: [AssistantMessageFeedbackReasonCode] {
        Array(AssistantMessageFeedbackReasonCode.allCases)
    }

    public static func sanitizeDetails(
        _ details: AssistantMessageFeedbackDetails?
    ) -> AssistantMessageFeedbackDetails? {
        guard let details else { return nil }
        let reason = boundedText(details.reason, max: maxReasonChars)
        let note = boundedText(details.note, max: maxNoteChars)
        if reason == nil, note == nil { return nil }
        return AssistantMessageFeedbackDetails(reason: reason, note: note)
    }

    public static func boundedNote(_ value: String?) -> String? {
        boundedText(value, max: maxNoteChars)
    }

    public static func boundedReason(_ value: String?) -> String? {
        boundedText(value, max: maxReasonChars)
    }

    private static func boundedText(_ value: String?, max: Int) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.count <= max { return trimmed }
        let end = trimmed.index(trimmed.startIndex, offsetBy: max)
        return String(trimmed[..<end])
    }
}
