// TWBannerTemplate — the user-authored description of how a completion banner
// is worded. Edited on the Mac (Settings → Notifications), synced into the
// shared App Group, and read by BOTH render paths: the foreground local banner
// and the Notification Service Extension.
//
// WHY A CLOSED SCHEMA, NOT A MINI-LANGUAGE: this is decoded inside an app
// extension with a ~30s budget and a "never render worse than the generic
// banner" guarantee. A closed struct of allowlisted tokens can't loop, can't
// recurse, and can't fail in a way that costs us the banner. Every decode error,
// unknown token, or missing field degrades to `.default`, which reproduces the
// hard-coded 1.x wording byte-for-byte (pinned by test).
//
// The template NEVER travels in the APNs payload — it lives in the App Group.
// See CompletionPushContent.ts: that JSON contract is frozen at five fields and
// the blob is already clipped hard against the 4KB ceiling.

import Foundation

/// One conditional chunk of the diff line. Rendered only when its field is
/// non-zero, which is how "3 files · +128" collapses to "+128" without the
/// template needing an `if`.
public struct TWDiffSegment: Codable, Sendable, Equatable {
    public enum Field: String, Codable, Sendable {
        case files
        case additions
        case deletions
    }

    public let field: Field
    /// `{value}` → the grouped number. `{s}` → "" when the value is exactly 1,
    /// "s" otherwise, so "file{s}" pluralises without a second field.
    public let format: String

    public init(field: Field, format: String) {
        self.field = field
        self.format = format
    }
}

public struct TWBannerTemplate: Codable, Sendable, Equatable {
    /// Bumped when a field's MEANING changes. A template carrying a version this
    /// build doesn't understand is discarded in favour of `.default` rather than
    /// half-applied — an older phone must never guess at newer semantics.
    public static let currentVersion = 1

    public var version: Int
    /// Tokens: `{statusEmoji}` `{agent}` `{status}`.
    public var titleFormat: String
    /// Each entry is one body line. Tokens: `{summary}` `{diff}` `{agent}`
    /// `{status}` `{statusEmoji}`. Lines that render empty are dropped, so a
    /// template can list `{diff}` unconditionally.
    public var bodyLines: [String]
    /// Keyed by `CompletionBannerStatus.rawKey`. A missing key renders as "".
    public var statusEmoji: [String: String]
    /// Body used when every line rendered empty. Keyed the same way.
    public var statusFallback: [String: String]
    public var diffSegments: [TWDiffSegment]
    public var diffSeparator: String
    public var previewSentences: Int
    public var previewCap: Int

    public init(
        version: Int = TWBannerTemplate.currentVersion,
        titleFormat: String,
        bodyLines: [String],
        statusEmoji: [String: String],
        statusFallback: [String: String],
        diffSegments: [TWDiffSegment],
        diffSeparator: String,
        previewSentences: Int,
        previewCap: Int
    ) {
        self.version = version
        self.titleFormat = titleFormat
        self.bodyLines = bodyLines
        self.statusEmoji = statusEmoji
        self.statusFallback = statusFallback
        self.diffSegments = diffSegments
        self.diffSeparator = diffSeparator
        self.previewSentences = previewSentences
        self.previewCap = previewCap
    }

    /// Reproduces the hard-coded pre-template wording EXACTLY. Pinned by
    /// `TWBannerTemplateTests.defaultTemplateMatchesLegacyWording` — if you change
    /// a string here you are changing what every un-customised user sees.
    public static let `default` = TWBannerTemplate(
        titleFormat: "{statusEmoji} {agent}",
        bodyLines: ["{summary}", "{diff}"],
        statusEmoji: [
            "success": "\u{2705}",
            "warning": "\u{26A0}\u{FE0F}",
            "error": "\u{26A0}\u{FE0F}",
            "quota": "\u{274C}",
            "cancelled": "\u{26A0}\u{FE0F}"
        ],
        statusFallback: [
            "success": "Run finished.",
            "warning": "Run finished with warnings.",
            "error": "Run needs your attention.",
            "quota": "Rate limit or quota wall.",
            "cancelled": "Run cancelled."
        ],
        diffSegments: [
            TWDiffSegment(field: .files, format: "\u{1F4DD} {value} file{s}"),
            TWDiffSegment(field: .additions, format: "\u{1F7E9} +{value}"),
            TWDiffSegment(field: .deletions, format: "\u{1F7E5} -{value}")
        ],
        diffSeparator: " \u{00B7} ",
        previewSentences: 2,
        previewCap: 180
    )

    /// Clamp anything that could produce a pathological banner. Applied on every
    /// load, so a hand-edited or corrupted blob can't emit a 10,000-character
    /// body or a title made of 400 lines.
    public func sanitized() -> TWBannerTemplate {
        var copy = self
        copy.previewSentences = min(max(previewSentences, 1), 6)
        copy.previewCap = min(max(previewCap, 20), 400)
        copy.titleFormat = String(titleFormat.prefix(120))
        copy.bodyLines = bodyLines.prefix(4).map { String($0.prefix(200)) }
        copy.diffSegments = Array(diffSegments.prefix(6))
        copy.diffSeparator = String(diffSeparator.prefix(8))
        return copy
    }

    /// Decode from JSON bytes. Returns `.default` on ANY problem — malformed
    /// JSON, a shape mismatch, or a version this build predates.
    public static func decode(_ data: Data?) -> TWBannerTemplate {
        guard let data,
            let decoded = try? JSONDecoder().decode(TWBannerTemplate.self, from: data),
            decoded.version == currentVersion
        else { return .default }
        return decoded.sanitized()
    }

    public func encoded() -> Data? {
        try? JSONEncoder().encode(self)
    }
}

extension CompletionBannerStatus {
    /// Stable string key for the template dictionaries. Deliberately NOT derived
    /// from the enum case name via reflection — renaming a case must not silently
    /// orphan every user's saved template.
    public var rawKey: String {
        switch self {
        case .success: return "success"
        case .warning: return "warning"
        case .error: return "error"
        case .quota: return "quota"
        case .cancelled: return "cancelled"
        }
    }
}

/// `bridge.broadcastBannerTemplate` params. Mirrors the TS `BannerTemplateMessage`
/// in src/shared/bannerTemplate.ts.
public struct BannerTemplateMessage: Codable, Sendable, Equatable {
    public let template: TWBannerTemplate
    /// Live Activity appearance, riding the same broadcast. Optional in BOTH
    /// directions — an older Mac never sends it, and this build must not treat
    /// its absence as "the user turned everything off".
    public let activity: TWActivityAppearance?

    public init(template: TWBannerTemplate, activity: TWActivityAppearance? = nil) {
        self.template = template
        self.activity = activity
    }
}

/// Mirrors `ActivityAppearance` in src/shared/bannerTemplate.ts.
///
/// EVERY FIELD IS OPTIONAL, on purpose. This decodes inside a fire-and-forget
/// broadcast handler with no retry: one unexpected field type from a newer Mac
/// must not throw away the archetype and colours the user did send.
public struct TWActivityAppearance: Codable, Sendable, Equatable {
    public let enabled: Bool?
    public let archetype: String?
    /// `#RRGGBB`.
    public let successColor: String?
    public let failureColor: String?

    public init(
        enabled: Bool? = nil, archetype: String? = nil,
        successColor: String? = nil, failureColor: String? = nil
    ) {
        self.enabled = enabled
        self.archetype = archetype
        self.successColor = successColor
        self.failureColor = failureColor
    }
}

/// Where the template lives on-device. The app writes it; the NSE reads it.
public enum TWBannerTemplateStore {
    static let defaultsKey = "tw.bannerTemplate.v1"

    public static func load(
        defaults: UserDefaults? = UserDefaults(suiteName: TWPushKeyAccess.appGroup)
    ) -> TWBannerTemplate {
        TWBannerTemplate.decode(defaults?.data(forKey: defaultsKey))
    }

    public static func save(
        _ template: TWBannerTemplate,
        defaults: UserDefaults? = UserDefaults(suiteName: TWPushKeyAccess.appGroup)
    ) {
        guard let data = template.sanitized().encoded() else { return }
        defaults?.set(data, forKey: defaultsKey)
    }

    public static func clear(
        defaults: UserDefaults? = UserDefaults(suiteName: TWPushKeyAccess.appGroup)
    ) {
        defaults?.removeObject(forKey: defaultsKey)
    }
}
