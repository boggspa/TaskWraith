// Presentation model for the desktop Copy transcript menu
// (`CopyTranscriptButton.tsx`): Copy Messages vs Copy handoff Markdown.
//
// Extracted for Priority-4 so Boss can replace the single-purpose iOS
// "Copy transcript" toolbar button with a two-format menu without growing
// ThreadDetailViews / RemoteSessionModel in this lane.
//
// Callbacks only — this model never serializes transcript bytes, never
// touches the pasteboard, and never invents bridge capabilities. The host
// wires `onCopyMessages` / `onCopyHandoffMarkdown` to Mac exports
// (`buildChatMessageTranscript` / `buildChatMarkdownTranscript`).

import Foundation

/// Clipboard format selected from the copy-transcript menu.
public enum TranscriptCopyFormat: String, Equatable, Sendable, CaseIterable {
    /// Raw conversation message bodies only (`copy-chat-messages`).
    case messages
    /// Safe handoff Markdown (`copy-chat-markdown-transcript`).
    case handoff
}

/// Desktop `CopyTranscriptResult` failure reasons — keep strings wire-stable.
public enum TranscriptCopyFailureReason: String, Equatable, Sendable, CaseIterable {
    case notFound = "not-found"
    case archived
    case empty
    case tooLarge = "too-large"
    case unauthorized
}

/// Successful copy summary — mirrors desktop `{ messageCount, charCount, omissions }`.
public struct TranscriptCopySuccessSummary: Equatable, Sendable {
    public var messageCount: Int
    public var charCount: Int
    /// Handoff scrub notes (paths, secrets, tool details, …). Raw Messages
    /// returns an empty array from the Mac handler today.
    public var omissions: [String]

    public init(messageCount: Int, charCount: Int, omissions: [String] = []) {
        self.messageCount = max(0, messageCount)
        self.charCount = max(0, charCount)
        self.omissions = omissions
    }
}

public enum TranscriptCopyResult: Equatable, Sendable {
    case success(TranscriptCopySuccessSummary)
    case failure(TranscriptCopyFailureReason)
}

/// Static chrome + copy strings matching desktop `CopyTranscriptButton`.
public enum TranscriptCopyMenuCopy {
    public static let dialogTitle = "Copy transcript"
    public static let dialogDescription =
        "Creates safe handoff Markdown, or copies raw conversation messages only."
    public static let copyMessagesLabel = "Copy Messages"
    public static let copyHandoffLabel = "Copy handoff Markdown"
    public static let busyLabel = "Copying..."
    public static let closeLabel = "Close"
    public static let closeAccessibilityLabel = "Close copy transcript"

    public static let triggerAccessibilityIdle = "Copy transcript as Markdown"
    public static let triggerAccessibilityCopiedHandoff = "Copied transcript as Markdown"
    public static let triggerAccessibilityCopiedMessages = "Copied messages"
    public static let dialogAccessibilityLabel = "Copy transcript"

    /// Honest framing of what raw Copy Messages leaves out — mirrors
    /// `buildChatMessageTranscript` / `messageOnlyTranscriptMessages` comments.
    /// Shown under the Messages action so users are not surprised by a quieter
    /// clipboard than the handoff Markdown export.
    public static let rawMessagesOmissionExplanation =
        "Raw Messages copies user and assistant prose only. It omits speaker labels, timestamps, Markdown structure, attachment names, tool summaries, system/tool/error rows, and orchestration metadata (sub-thread returns, delegations, closeouts)."

    /// Handoff export always discloses scrubbing in the Markdown header; this
    /// short UI note keeps the menu honest before the copy runs.
    public static let handoffOmissionExplanation =
        "Handoff Markdown is scrubbed for handoff: absolute paths, home paths, common secrets, raw tool details/outputs, and attachment paths/bytes may be omitted and listed after copy."
}

/// Pure helpers for labels, status text, and a11y — no host I/O.
public enum TranscriptCopyMenuModel {
    public static func actionLabel(for format: TranscriptCopyFormat, busy: Bool) -> String {
        if busy { return TranscriptCopyMenuCopy.busyLabel }
        switch format {
        case .messages:
            return TranscriptCopyMenuCopy.copyMessagesLabel
        case .handoff:
            return TranscriptCopyMenuCopy.copyHandoffLabel
        }
    }

    /// Desktop `failureMessage` — keep wording identical for parity reviews.
    public static func failureMessage(for reason: TranscriptCopyFailureReason) -> String {
        switch reason {
        case .notFound:
            return "This chat could not be loaded."
        case .archived:
            return "Archived chats cannot be copied from here."
        case .tooLarge:
            return "This transcript is too large for clipboard copy."
        case .unauthorized:
            return "This window is not allowed to copy transcripts."
        case .empty:
            return "There is no transcript content to copy yet."
        }
    }

    /// Desktop status: `Copied N message(s).` + optional `; `-joined omissions.
    public static func successStatus(for summary: TranscriptCopySuccessSummary) -> String {
        let noun = summary.messageCount == 1 ? "message" : "messages"
        var text = "Copied \(summary.messageCount) \(noun)."
        let cleaned = summary.omissions
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        if !cleaned.isEmpty {
            text += " \(cleaned.joined(separator: "; "))."
        }
        return text
    }

    public static func triggerAccessibilityLabel(
        copiedFormat: TranscriptCopyFormat?
    ) -> String {
        switch copiedFormat {
        case .messages:
            return TranscriptCopyMenuCopy.triggerAccessibilityCopiedMessages
        case .handoff:
            return TranscriptCopyMenuCopy.triggerAccessibilityCopiedHandoff
        case nil:
            return TranscriptCopyMenuCopy.triggerAccessibilityIdle
        }
    }

    public static func omissionExplanation(for format: TranscriptCopyFormat) -> String {
        switch format {
        case .messages:
            return TranscriptCopyMenuCopy.rawMessagesOmissionExplanation
        case .handoff:
            return TranscriptCopyMenuCopy.handoffOmissionExplanation
        }
    }

    /// Parse a desktop/Mac wire reason string; unknown → `.empty` (safe default).
    public static func failureReason(fromWire reason: String?) -> TranscriptCopyFailureReason {
        let trimmed = reason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return TranscriptCopyFailureReason(rawValue: trimmed) ?? .empty
    }

    public static func makeSuccess(
        messageCount: Int,
        charCount: Int,
        omissions: [String] = []
    ) -> TranscriptCopyResult {
        .success(
            TranscriptCopySuccessSummary(
                messageCount: messageCount,
                charCount: charCount,
                omissions: omissions
            )
        )
    }

    public static func makeFailure(_ reason: TranscriptCopyFailureReason) -> TranscriptCopyResult {
        .failure(reason)
    }
}
