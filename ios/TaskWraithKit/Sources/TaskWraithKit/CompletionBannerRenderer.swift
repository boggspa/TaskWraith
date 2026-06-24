// CompletionBannerRenderer — the run-complete banner's title + body from the
// structured fields. The SAME logic renders the FOREGROUND local banner and the
// BACKGROUND Notification Service Extension, so they're identical regardless of
// which path fires.
//
// Pure + NSE-safe: no UIKit, no app singletons, lives in the dependency-free
// TaskWraithKit target so the extension can link just this. Extracted verbatim
// from RemoteSessionModel's db69bf4c banner logic (the foreground path will be
// refactored to call this once it's not concurrently contended).

import Foundation

/// The fields needed to render a completion banner. The encrypted push blob
/// carries `title`/`preview`/`filesChanged`/`additions`/`deletions`; the NSE adds
/// `failed` from the push `reason`.
public struct CompletionBannerInput: Sendable, Equatable {
    public let title: String?
    public let failed: Bool
    public let preview: String?
    public let filesChanged: Int
    public let additions: Int
    public let deletions: Int

    public init(
        title: String?, failed: Bool, preview: String?,
        filesChanged: Int, additions: Int, deletions: Int
    ) {
        self.title = title
        self.failed = failed
        self.preview = preview
        self.filesChanged = filesChanged
        self.additions = additions
        self.deletions = deletions
    }
}

public struct RenderedBanner: Sendable, Equatable {
    public let title: String
    public let body: String
    public init(title: String, body: String) {
        self.title = title
        self.body = body
    }
}

public enum CompletionBannerRenderer {
    public static func render(_ input: CompletionBannerInput) -> RenderedBanner {
        let name = (input.title?.isEmpty == false) ? input.title! : "TaskWraith"
        let title = input.failed ? "\u{26A0}\u{FE0F} \(name)" : name
        var lines: [String] = []
        if let summary = bannerSentences(input.preview) { lines.append(summary) }
        if !input.failed,
            let diff = diffBannerLine(
                files: input.filesChanged, additions: input.additions, deletions: input.deletions)
        {
            lines.append(diff)
        }
        if lines.isEmpty { lines.append(input.failed ? "Run needs your attention." : "Run finished.") }
        return RenderedBanner(title: title, body: lines.joined(separator: "\n"))
    }

    /// "\u{1F4DD} 3 files \u{00B7} \u{1F7E2} +128 \u{00B7} \u{1F534} \u{2212}44" —
    /// emoji is the only way to colour a plain-text banner. nil when nothing changed.
    public static func diffBannerLine(files: Int, additions: Int, deletions: Int) -> String? {
        guard files > 0 || additions > 0 || deletions > 0 else { return nil }
        var parts: [String] = []
        if files > 0 { parts.append("\u{1F4DD} \(files) file\(files == 1 ? "" : "s")") }
        if additions > 0 { parts.append("\u{1F7E2} +\(additions)") }
        if deletions > 0 { parts.append("\u{1F534} \u{2212}\(deletions)") }
        return parts.joined(separator: " \u{00B7} ")
    }

    /// First 1–2 sentences of a card preview, flattened to one line + capped, for
    /// a banner body. nil for empty input.
    public static func bannerSentences(_ text: String?, maxSentences: Int = 2, cap: Int = 180)
        -> String?
    {
        guard let raw = text?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return nil
        }
        let flattened = raw.split(whereSeparator: { $0 == "\n" || $0 == "\r" }).joined(separator: " ")
        var assembled = ""
        var sentences = 0
        var pending = ""
        for ch in flattened {
            pending.append(ch)
            if ch == "." || ch == "!" || ch == "?" {
                assembled += pending
                pending = ""
                sentences += 1
                if sentences >= maxSentences { break }
            }
        }
        if assembled.isEmpty { assembled = pending }
        var trimmed = assembled.trimmingCharacters(in: .whitespaces)
        if trimmed.count > cap {
            let end = trimmed.index(trimmed.startIndex, offsetBy: cap)
            trimmed = String(trimmed[..<end]).trimmingCharacters(in: .whitespaces) + "\u{2026}"
        }
        return trimmed.isEmpty ? nil : trimmed
    }
}
