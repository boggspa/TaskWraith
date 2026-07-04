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
    public let status: CompletionBannerStatus
    public let preview: String?
    public let filesChanged: Int
    public let additions: Int
    public let deletions: Int

    public init(
        title: String?, failed: Bool, preview: String?,
        filesChanged: Int, additions: Int, deletions: Int,
        status: CompletionBannerStatus? = nil
    ) {
        self.title = title
        self.failed = failed
        self.status = status ?? (failed ? .error : .success)
        self.preview = preview
        self.filesChanged = filesChanged
        self.additions = additions
        self.deletions = deletions
    }
}

public enum CompletionBannerStatus: Sendable, Equatable {
    case success
    case warning
    case error
    case quota
    case cancelled
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
        let title = "\(emoji(for: input.status)) \(name)"
        var lines: [String] = []
        if let summary = bannerSentences(input.preview) { lines.append(summary) }
        if input.status == .success,
            let diff = diffBannerLine(
                files: input.filesChanged, additions: input.additions, deletions: input.deletions)
        {
            lines.append(diff)
        }
        if lines.isEmpty { lines.append(defaultBody(for: input.status)) }
        return RenderedBanner(title: title, body: lines.joined(separator: "\n"))
    }

    /// "\u{1F7E9} +23,125 \u{1F7E5} -10,055" — compact plain-text diff stats.
    /// nil when nothing changed.
    public static func diffBannerLine(files: Int, additions: Int, deletions: Int) -> String? {
        guard files > 0 || additions > 0 || deletions > 0 else { return nil }
        var parts: [String] = []
        if additions > 0 { parts.append("\u{1F7E9} +\(grouped(additions))") }
        if deletions > 0 { parts.append("\u{1F7E5} -\(grouped(deletions))") }
        if !parts.isEmpty { return parts.joined(separator: " ") }
        return "\(files) file\(files == 1 ? "" : "s") changed"
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

    private static func emoji(for status: CompletionBannerStatus) -> String {
        switch status {
        case .success:
            return "\u{2705}"
        case .warning:
            return "\u{26A0}\u{FE0F}"
        case .error:
            return "\u{26A0}\u{FE0F}"
        case .quota:
            return "\u{274C}"
        case .cancelled:
            return "\u{26A0}\u{FE0F}"
        }
    }

    private static func defaultBody(for status: CompletionBannerStatus) -> String {
        switch status {
        case .success:
            return "Run finished."
        case .warning:
            return "Run finished with warnings."
        case .error:
            return "Run needs your attention."
        case .quota:
            return "Rate limit or quota wall."
        case .cancelled:
            return "Run cancelled."
        }
    }

    private static func grouped(_ value: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
    }
}
