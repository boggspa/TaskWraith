// RemoteShellAppearance.swift — Codable mirror of the Mac's `shellAppearance`
// projection payload (src/main/RemoteTaskProjection.ts → RemoteShellAppearance).
// Decodes only the subset iOS needs; forward-compatible (extra fields ignored,
// missing fields tolerated). Pure (Foundation only); lives in TaskWraithKit and
// is unit-tested. The decode is wired into RemoteSessionModel (TaskWraithUI).

import Foundation

public struct TWRemoteShellAppearance: Codable, Sendable, Equatable {
    /// The desktop composer-style literal (e.g. "default", "codex"). Falls back
    /// to "default" if a malformed payload omits it.
    public let composerStyle: String
    /// ISO8601 stamp from the Mac; used to ignore stale re-broadcasts.
    public let generatedAt: String?
    public let appearanceMode: String?
    public let preferredColorScheme: String?
    public let reduceMotion: Bool?
    public let reduceTransparency: Bool?
    public let compactDensity: Bool?

    public init(
        composerStyle: String,
        generatedAt: String? = nil,
        appearanceMode: String? = nil,
        preferredColorScheme: String? = nil,
        reduceMotion: Bool? = nil,
        reduceTransparency: Bool? = nil,
        compactDensity: Bool? = nil
    ) {
        self.composerStyle = composerStyle
        self.generatedAt = generatedAt
        self.appearanceMode = appearanceMode
        self.preferredColorScheme = preferredColorScheme
        self.reduceMotion = reduceMotion
        self.reduceTransparency = reduceTransparency
        self.compactDensity = compactDensity
    }

    private enum CodingKeys: String, CodingKey {
        case composerStyle, generatedAt, appearanceMode, preferredColorScheme
        case reduceMotion, reduceTransparency, compactDensity
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        composerStyle = (try? c.decode(String.self, forKey: .composerStyle)) ?? "default"
        generatedAt = try? c.decode(String.self, forKey: .generatedAt)
        appearanceMode = try? c.decode(String.self, forKey: .appearanceMode)
        preferredColorScheme = try? c.decode(String.self, forKey: .preferredColorScheme)
        reduceMotion = try? c.decode(Bool.self, forKey: .reduceMotion)
        reduceTransparency = try? c.decode(Bool.self, forKey: .reduceTransparency)
        compactDensity = try? c.decode(Bool.self, forKey: .compactDensity)
    }

    /// Parsed composer style (preserves unknown raw values for diagnostics).
    public var style: TWComposerStyle { TWComposerStyle(raw: composerStyle) }
}

/// Whether an incoming shellAppearance should replace the last-applied one:
/// true only if its `generatedAt` is strictly newer (so the same snapshot
/// re-broadcast — identical envelopeId, fresh-stamp only on real change —
/// doesn't churn published state). Missing timestamps are accepted (the
/// payload is authoritative; the desktop always stamps, so this only covers
/// old/malformed Macs). ISO8601 is compared by parsed Date where possible,
/// falling back to lexicographic compare (UTC "Z" strings sort correctly).
public func twShouldApplyShellAppearance(incoming: String?, last: String?) -> Bool {
    guard let last = last, !last.isEmpty else { return true }
    guard let incoming = incoming, !incoming.isEmpty else { return true }
    if let incomingDate = twParseISO8601(incoming), let lastDate = twParseISO8601(last) {
        return incomingDate > lastDate
    }
    return incoming > last
}

private func twParseISO8601(_ value: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: value) { return date }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return plain.date(from: value)
}
