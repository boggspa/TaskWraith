// Push content decoded by the Notification Service Extension. Completion blobs
// mirror the Mac's src/main/CompletionPushContent.ts; question blobs mirror
// src/main/QuestionPushContent.ts. Routing IDs + status ride the APNs payload,
// so only private banner text/counts are encrypted here.

import Foundation

public struct CompletionPushContent: Decodable, Sendable, Equatable {
    public let title: String
    public let preview: String
    public let filesChanged: Int
    public let additions: Int
    public let deletions: Int

    public init(
        title: String, preview: String, filesChanged: Int, additions: Int, deletions: Int
    ) {
        self.title = title
        self.preview = preview
        self.filesChanged = filesChanged
        self.additions = additions
        self.deletions = deletions
    }

    /// Decode from decrypted UTF-8 JSON bytes; nil on any shape mismatch (→ the
    /// NSE shows the generic fallback).
    public static func decode(_ data: Data) -> CompletionPushContent? {
        try? JSONDecoder().decode(CompletionPushContent.self, from: data)
    }

    /// Combine with the push `reason` (failed?) into the shared renderer's input.
    public func bannerInput(failed: Bool, status: CompletionBannerStatus? = nil) -> CompletionBannerInput {
        CompletionBannerInput(
            title: title, failed: failed, preview: preview,
            filesChanged: filesChanged, additions: additions, deletions: deletions,
            status: status)
    }
}

public struct QuestionPushContent: Decodable, Sendable, Equatable {
    public let question: String

    public init(question: String) {
        self.question = question
    }

    /// Decode from decrypted UTF-8 JSON bytes; nil on any shape mismatch (→ the
    /// NSE shows the generic fallback).
    public static func decode(_ data: Data) -> QuestionPushContent? {
        try? JSONDecoder().decode(QuestionPushContent.self, from: data)
    }

    public var bannerBody: String {
        let firstLine =
            question
            .split(whereSeparator: { $0 == "\n" || $0 == "\r" })
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty } ?? "Open TaskWraith to answer."
        return "\u{2753} \(firstLine)"
    }
}
