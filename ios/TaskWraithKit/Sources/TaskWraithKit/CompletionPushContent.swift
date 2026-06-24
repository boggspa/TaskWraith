// CompletionPushContent — the decrypted rich plaintext from a run-complete push
// (decoded by the Notification Service Extension). Twin of the Mac's
// src/main/CompletionPushContent.ts: keys title/preview/filesChanged/additions/
// deletions. Routing IDs + success-vs-failed ride the payload, so they're not in
// the encrypted blob.

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
    public func bannerInput(failed: Bool) -> CompletionBannerInput {
        CompletionBannerInput(
            title: title, failed: failed, preview: preview,
            filesChanged: filesChanged, additions: additions, deletions: deletions)
    }
}
