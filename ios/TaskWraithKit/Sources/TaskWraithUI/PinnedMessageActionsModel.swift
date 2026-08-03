// Pure presentation model for pinned-message Copy / Jump / Unpin actions.
//
// Desktop `PinnedMessagesPanel` keys every action on `message.id`. The Mac
// already projects pins as full `RemoteThreadRow`s whose `id` is that same
// desktop message id (`RemoteThreadProjection` row builder), so iOS can reuse
// `pinnedRows[i].id` as the single stable key for copy, jump-to-source, and
// unpin — no extra identity field is required.
//
// This file stays free of RemoteSessionModel / bridge calls so NotesPanel and
// future transcript navigation surfaces share one stable presentation contract.

import Foundation

/// One pinned message’s action surface, keyed by the stable transcript row id.
public struct PinnedMessageActionItem: Equatable, Sendable, Identifiable {
    /// Desktop `message.id` / remote `pinnedRows[i].id`. Jump and unpin must
    /// pass this exact value — never a list index or a regenerated UUID.
    public let messageId: String
    public let speaker: String?
    public let role: String?
    /// Projected pin preview. NotesPanel asks the host for the expanded row
    /// before copying when this preview is marked truncated.
    public let copyText: String
    /// When true, Copy is still offered but accessibility notes the text may
    /// be a truncated preview (parity with projected `row.truncated`).
    public let previewTruncated: Bool

    public var id: String { messageId }

    public init(
        messageId: String,
        speaker: String? = nil,
        role: String? = nil,
        copyText: String,
        previewTruncated: Bool = false
    ) {
        self.messageId = messageId
        self.speaker = Self.normalizedOptional(speaker)
        self.role = Self.normalizedOptional(role)
        self.copyText = copyText
        self.previewTruncated = previewTruncated
    }

    private static func normalizedOptional(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

/// Discrete actions the pin-list chrome exposes. Workspace-board `#` stays
/// desktop-only and is intentionally absent.
public enum PinnedMessageAction: String, Equatable, Sendable, CaseIterable {
    case copy
    case jumpToSource
    case unpin
}

/// Portable jump-to-source intent keyed only by the stable message id.
/// NotesPanel and future transcript navigation surfaces can share this shape.
public struct PinnedMessageJumpRequest: Equatable, Sendable {
    public let messageId: String

    public init(messageId: String) {
        self.messageId = messageId
    }
}

public enum PinnedMessageActionsModel {
    /// Build an action item from pin-list fields. Returns `nil` when the row
    /// identity is missing — callers must not invent a fallback id.
    public static func makeItem(
        messageId: String?,
        speaker: String? = nil,
        role: String? = nil,
        preview: String?,
        truncated: Bool? = nil
    ) -> PinnedMessageActionItem? {
        let id = messageId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !id.isEmpty else { return nil }
        let text = preview ?? ""
        return PinnedMessageActionItem(
            messageId: id,
            speaker: speaker,
            role: role,
            copyText: text,
            previewTruncated: truncated == true
        )
    }

    /// Map a projected pin row’s core fields without importing Models into tests
    /// that prefer string fixtures.
    public static func makeItem(
        id: String,
        speaker: String?,
        role: String?,
        preview: String?,
        truncated: Bool?
    ) -> PinnedMessageActionItem? {
        makeItem(
            messageId: id,
            speaker: speaker,
            role: role,
            preview: preview,
            truncated: truncated
        )
    }

    public static func canPerform(_ action: PinnedMessageAction, on item: PinnedMessageActionItem)
        -> Bool
    {
        switch action {
        case .copy:
            return !item.copyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .jumpToSource, .unpin:
            return !item.messageId.isEmpty
        }
    }

    public static func copyPayload(for item: PinnedMessageActionItem) -> String? {
        guard canPerform(.copy, on: item) else { return nil }
        return item.copyText
    }

    public static func jumpRequest(for item: PinnedMessageActionItem) -> PinnedMessageJumpRequest? {
        guard canPerform(.jumpToSource, on: item) else { return nil }
        return PinnedMessageJumpRequest(messageId: item.messageId)
    }

    /// Desktop aria labels: "Copy pinned message" / "Jump to message" / unpin.
    /// Speaker + short preview are appended so VoiceOver can disambiguate a
    /// dense pin list without reading the whole body.
    public static func accessibilityLabel(
        for action: PinnedMessageAction,
        item: PinnedMessageActionItem
    ) -> String {
        var parts: [String] = [baseAccessibilityVerb(action)]
        if let speaker = item.speaker {
            parts.append("from \(speaker)")
        } else if let role = item.role, !role.isEmpty {
            parts.append("(\(role))")
        }
        if let snippet = previewSnippet(item.copyText) {
            parts.append("\"\(snippet)\"")
        }
        if action == .copy, item.previewTruncated {
            parts.append("preview may be truncated")
        }
        return parts.joined(separator: ", ")
    }

    public static func actionSystemImage(_ action: PinnedMessageAction) -> String {
        switch action {
        case .copy: return "doc.on.doc"
        case .jumpToSource: return "arrow.right.to.line"
        case .unpin: return "pin.slash"
        }
    }

    public static func actionTitle(_ action: PinnedMessageAction) -> String {
        switch action {
        case .copy: return "Copy"
        case .jumpToSource: return "Jump to source"
        case .unpin: return "Unpin"
        }
    }

    private static func baseAccessibilityVerb(_ action: PinnedMessageAction) -> String {
        switch action {
        case .copy: return "Copy pinned message"
        case .jumpToSource: return "Jump to message"
        case .unpin: return "Unpin message"
        }
    }

    private static func previewSnippet(_ text: String, limit: Int = 48) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.count <= limit { return trimmed }
        return String(trimmed.prefix(limit)) + "…"
    }
}
