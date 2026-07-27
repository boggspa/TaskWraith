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
    /// Renders with the user's saved template, falling back to `.default` when
    /// none is stored. The `template:` overload exists so the NSE, the Mac's
    /// live preview, and tests can all render a template without touching
    /// UserDefaults.
    public static func render(_ input: CompletionBannerInput) -> RenderedBanner {
        render(input, template: TWBannerTemplateStore.load())
    }

    public static func render(
        _ input: CompletionBannerInput, template: TWBannerTemplate
    ) -> RenderedBanner {
        let t = template.sanitized()
        let name = (input.title?.isEmpty == false) ? input.title! : "TaskWraith"
        let statusKey = input.status.rawKey
        let statusEmoji = t.statusEmoji[statusKey] ?? ""

        // The diff line is suppressed for every non-success status: a failed or
        // cancelled run's counts describe work that was rolled back or never
        // finished, so showing "+128" next to "Run needs your attention" reads as
        // a success. Pre-template behaviour, deliberately kept.
        let diff =
            input.status == .success
            ? diffBannerLine(
                files: input.filesChanged, additions: input.additions,
                deletions: input.deletions, template: t)
            : nil

        let substitutions: [String: String] = [
            "statusEmoji": statusEmoji,
            "agent": name,
            "status": statusKey,
            "summary": bannerSentences(
                input.preview, maxSentences: t.previewSentences, cap: t.previewCap) ?? "",
            "diff": diff ?? ""
        ]

        let title = substitute(t.titleFormat, substitutions)
        // Empty lines are dropped so a template can list {diff} unconditionally
        // and still produce a tight banner on a run that changed nothing.
        var lines = t.bodyLines
            .map { substitute($0, substitutions) }
            .filter { !$0.isEmpty }
        if lines.isEmpty {
            lines.append(t.statusFallback[statusKey] ?? defaultBody(for: input.status))
        }

        // Last line of defence for the NSE's "never worse than generic" contract:
        // a template that renders an empty TITLE would produce a bodyless-looking
        // notification, so fall back to the agent name rather than ship blank.
        let safeTitle = title.isEmpty ? name : title
        return RenderedBanner(title: safeTitle, body: lines.joined(separator: "\n"))
    }

    /// Token substitution over a CLOSED set. Unknown `{tokens}` are stripped
    /// rather than left literal — the Mac's editor validates and refuses to save
    /// them, so anything reaching a device is a corrupted or downgraded blob and
    /// a stray "{fils}" on a lock screen is worse than a gap. Collapses the
    /// whitespace an emptied token leaves behind.
    static func substitute(_ format: String, _ values: [String: String]) -> String {
        var out = ""
        var token = ""
        var inToken = false
        // Only an EMPTY substitution can strand whitespace, so the collapse below
        // is gated on one happening. Collapsing unconditionally would also squash
        // double spaces inside the user's own preview text, which would make the
        // default template stop reproducing the pre-template wording exactly.
        var didEmptySubstitution = false
        for ch in format {
            if ch == "{" {
                // An unclosed "{" earlier in the string: flush it literally.
                if inToken { out += "{" + token }
                inToken = true
                token = ""
            } else if ch == "}" && inToken {
                let value = values[token] ?? ""
                if value.isEmpty { didEmptySubstitution = true }
                out += value
                inToken = false
                token = ""
            } else if inToken {
                token.append(ch)
            } else {
                out.append(ch)
            }
        }
        if inToken { out += "{" + token }
        guard didEmptySubstitution else {
            return out.trimmingCharacters(in: .whitespaces)
        }
        return
            out
            .split(separator: " ", omittingEmptySubsequences: true)
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespaces)
    }

    /// "\u{1F4DD} 3 files \u{00B7} \u{1F7E9} +23,125 \u{00B7} \u{1F7E5} -10,055" — compact
    /// plain-text diff stats. Emoji is the only way to colour a plain-text banner.
    /// nil when nothing changed.
    ///
    /// The file count leads and is kept ALONGSIDE the +/- counts (it used to be a
    /// fallback shown only when both were zero). That matches what the foreground
    /// banner has always shown, so unifying the two render paths doesn't cost the
    /// foreground its file count.
    public static func diffBannerLine(
        files: Int, additions: Int, deletions: Int,
        template: TWBannerTemplate = .default
    ) -> String? {
        var parts: [String] = []
        for segment in template.diffSegments {
            let value: Int
            switch segment.field {
            case .files: value = files
            case .additions: value = additions
            case .deletions: value = deletions
            }
            guard value > 0 else { continue }
            parts.append(
                substitute(segment.format, ["value": grouped(value), "s": value == 1 ? "" : "s"]))
        }
        guard !parts.isEmpty else { return nil }
        return parts.joined(separator: template.diffSeparator)
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
