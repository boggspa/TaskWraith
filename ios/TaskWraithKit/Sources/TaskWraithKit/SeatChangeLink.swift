import Foundation

/*
 * SeatChangeLink.swift — the Swift twin of `src/shared/seatChange.ts`'s
 * close-out link codec, plus the seat value type both the close-out cell and
 * the projected transcript row render from.
 *
 * Pure Foundation on purpose (no SwiftUI): the escaping rules are the fragile
 * part, and they have to be unit-testable against hrefs the TypeScript encoder
 * actually emitted. `SeatChangeLinkTests` pins those bytes.
 *
 * Why the Mac escapes more than `encodeURIComponent` does — and why this side
 * must decode it: the seat travels inside a MARKDOWN link destination, where a
 * bare `)` closes the link, so `!'()*` are percent-encoded too (an Ollama tag
 * like `qwen3-coder:30b (q4_K_M)` was enough to truncate an href mid-query).
 * Decoding is plain percent-decoding, so nothing extra is needed here beyond
 * NOT treating `+` as a space — which is exactly why the Mac hand-parses
 * instead of using URLSearchParams, and why this side hand-parses instead of
 * using URLComponents.queryItems (which does decode `+` as a space).
 */

/// One side of a seat change — the fields the seat strip renders. Mirrors
/// `SeatChangeSeatState` in `src/shared/seatChange.ts` field-for-field, and is
/// also the wire shape of the projected `row.seatChange.before` / `.after`.
///
/// `provider` / `model` are non-optional with an empty-string default rather
/// than optionals: every consumer needs a string, and a decode that cannot fail
/// keeps one malformed seat from failing the whole row (the strip checks
/// `provider.isEmpty` and stands down instead).
public struct TWSeatChangeState: Codable, Sendable, Equatable {
    public var provider: String
    public var model: String
    /// Participant role at this side of the change — rendered right-aligned in
    /// the provider accent so same-model seats stay tellable apart.
    public var role: String?
    /// 1-based roster position, rendered as the "#N" prefix on the role.
    public var seatNumber: Int?
    public var reasoningEffort: String?
    /// Kimi's thinking toggle — a separate input from `reasoningEffort` that
    /// produces the same chip suffix.
    public var thinkingEnabled: Bool?
    public var permissionPresetId: String?
    /// Chat-level workspace grant count at emit time (the permission chip's
    /// "N grants" suffix).
    public var grantsCount: Int?

    public init(
        provider: String,
        model: String = "",
        role: String? = nil,
        seatNumber: Int? = nil,
        reasoningEffort: String? = nil,
        thinkingEnabled: Bool? = nil,
        permissionPresetId: String? = nil,
        grantsCount: Int? = nil
    ) {
        self.provider = provider
        self.model = model
        self.role = role
        self.seatNumber = seatNumber
        self.reasoningEffort = reasoningEffort
        self.thinkingEnabled = thinkingEnabled
        self.permissionPresetId = permissionPresetId
        self.grantsCount = grantsCount
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        func string(_ key: CodingKeys) -> String? {
            (try? container.decodeIfPresent(String.self, forKey: key)) ?? nil
        }
        provider = string(.provider) ?? ""
        model = string(.model) ?? ""
        role = string(.role)
        seatNumber = (try? container.decodeIfPresent(Int.self, forKey: .seatNumber)) ?? nil
        reasoningEffort = string(.reasoningEffort)
        thinkingEnabled = (try? container.decodeIfPresent(Bool.self, forKey: .thinkingEnabled)) ?? nil
        permissionPresetId = string(.permissionPresetId)
        grantsCount = (try? container.decodeIfPresent(Int.self, forKey: .grantsCount)) ?? nil
    }
}

/// A decoded `ensemble-seat://` link: the seat as it ENTERED and LEFT the
/// round. An unchanged seat omits the before side on the wire and decodes to
/// two identical sides, so the strip has nothing to roll.
public struct TWSeatChangeLink: Sendable, Equatable {
    public let participantId: String
    public let before: TWSeatChangeState
    public let after: TWSeatChangeState

    public init(participantId: String, before: TWSeatChangeState, after: TWSeatChangeState) {
        self.participantId = participantId
        self.before = before
        self.after = after
    }
}

/// The authoritative seat-change payload projected onto a transcript row
/// (`metadata.seatChange` on the Mac). Every field optional + plain String, so
/// a value a newer Mac invents degrades instead of failing the row decode.
public struct TWSeatChangePayload: Codable, Sendable, Equatable {
    public let participantId: String?
    /// Human seat label at emit time (role or provider).
    public let label: String?
    public let before: TWSeatChangeState?
    public let after: TWSeatChangeState?
    /// ISO timestamp of the LATEST coalesced adjustment.
    public let appliedAt: String?

    public init(
        participantId: String?,
        label: String?,
        before: TWSeatChangeState?,
        after: TWSeatChangeState?,
        appliedAt: String?
    ) {
        self.participantId = participantId
        self.label = label
        self.before = before
        self.after = after
        self.appliedAt = appliedAt
    }

    /// The two sides as a renderable link, or nil when the payload carries no
    /// seat worth drawing. Absent `before` falls back to `after` — the same
    /// "nothing to roll" degradation the link codec applies.
    public var renderableLink: TWSeatChangeLink? {
        guard let after, !after.provider.isEmpty else { return nil }
        let resolvedBefore = (before?.provider.isEmpty == false) ? before : nil
        return TWSeatChangeLink(
            participantId: participantId ?? "",
            before: resolvedBefore ?? after,
            after: after)
    }
}

public enum TWSeatChangeLinkCodec {
    public static let prefix = "ensemble-seat://"

    /// After-side keys, mirrored with a `b` prefix for the before side. Short
    /// because every close-out row carries one of these.
    private enum Key {
        static let provider = "p"
        static let model = "m"
        static let role = "role"
        static let seatNumber = "n"
        static let reasoningEffort = "r"
        static let thinkingEnabled = "t"
        static let permissionPresetId = "k"
        static let grantsCount = "g"
    }

    /// `encodeURIComponent`'s unreserved set MINUS `!'()*`, which the Mac
    /// percent-encodes on top of it. Everything else escapes.
    private static let unreserved = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~")

    // MARK: - Decode

    /// `ensemble-seat://<participantId>?<after fields>&<b-prefixed before
    /// fields>` → the two sides. Returns nil for anything that is not a seat
    /// link or carries no resolvable after-seat, so the caller can fall back to
    /// the link TEXT rather than render an empty cell.
    public static func decode(_ href: String) -> TWSeatChangeLink? {
        guard href.hasPrefix(prefix) else { return nil }
        let rest = href.dropFirst(prefix.count)
        guard let queryStart = rest.firstIndex(of: "?") else { return nil }
        guard let participantId = String(rest[rest.startIndex..<queryStart]).removingPercentEncoding,
            !participantId.isEmpty
        else { return nil }
        let params = decodeParams(String(rest[rest.index(after: queryStart)...]))
        guard let after = readSeat(params, prefix: "") else { return nil }
        return TWSeatChangeLink(
            participantId: participantId,
            before: readSeat(params, prefix: "b") ?? after,
            after: after)
    }

    private static func decodeParams(_ query: String) -> [String: String] {
        var out: [String: String] = [:]
        for pair in query.split(separator: "&", omittingEmptySubsequences: true) {
            guard let eq = pair.firstIndex(of: "=") else { continue }
            // A malformed escape drops that FIELD rather than the whole row —
            // mirrors the Mac's per-pair try/catch.
            guard let key = String(pair[pair.startIndex..<eq]).removingPercentEncoding,
                let value = String(pair[pair.index(after: eq)...]).removingPercentEncoding
            else { continue }
            out[key] = value
        }
        return out
    }

    private static func readSeat(_ params: [String: String], prefix: String) -> TWSeatChangeState? {
        guard let provider = params[prefix + Key.provider], !provider.isEmpty else { return nil }
        let role = params[prefix + Key.role]
        let reasoningEffort = params[prefix + Key.reasoningEffort]
        let permissionPresetId = params[prefix + Key.permissionPresetId]
        let thinking = params[prefix + Key.thinkingEnabled]
        return TWSeatChangeState(
            provider: provider,
            model: params[prefix + Key.model] ?? "",
            role: (role?.isEmpty == false) ? role : nil,
            seatNumber: boundedInt(params[prefix + Key.seatNumber], atLeast: 1),
            reasoningEffort: (reasoningEffort?.isEmpty == false) ? reasoningEffort : nil,
            thinkingEnabled: thinking.map { $0 == "1" },
            permissionPresetId: (permissionPresetId?.isEmpty == false) ? permissionPresetId : nil,
            grantsCount: boundedInt(params[prefix + Key.grantsCount], atLeast: 0))
    }

    /// The Mac reads these through `Number(...)` and keeps the field only when
    /// the result is finite and within range. Absent ⇒ NaN ⇒ dropped; an
    /// unparseable token ⇒ NaN ⇒ dropped; `Number('')` is 0, so an EMPTY value
    /// is a zero, not a missing field.
    private static func boundedInt(_ raw: String?, atLeast minimum: Int) -> Int? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let value: Double
        if trimmed.isEmpty {
            value = 0
        } else if let parsed = Double(trimmed), parsed.isFinite {
            value = parsed
        } else {
            return nil
        }
        guard value >= Double(minimum), value <= Double(Int32.max) else { return nil }
        return Int(value)
    }

    // MARK: - Encode

    /// The encoding twin. Not used by the app (the Mac is the only writer) —
    /// it exists so the round-trip is testable from this side and so a drift in
    /// the escaping rules fails a Swift test rather than a phone.
    ///
    /// The Mac decides "changed" with `JSON.stringify` inequality over two
    /// objects it builds identically; structural inequality is the same
    /// predicate expressed in a language with real value types.
    public static func encode(_ link: TWSeatChangeLink) -> String {
        var params = seatParams(link.after, prefix: "")
        if link.before != link.after {
            params.append(contentsOf: seatParams(link.before, prefix: "b"))
        }
        let query = params
            .map { "\(encodeComponent($0.0))=\(encodeComponent($0.1))" }
            .joined(separator: "&")
        return "\(prefix)\(encodeComponent(link.participantId))?\(query)"
    }

    private static func seatParams(_ state: TWSeatChangeState, prefix: String) -> [(String, String)] {
        var params: [(String, String)] = [
            (prefix + Key.provider, state.provider),
            (prefix + Key.model, state.model)
        ]
        if let role = state.role, !role.isEmpty { params.append((prefix + Key.role, role)) }
        if let seatNumber = state.seatNumber, seatNumber != 0 {
            params.append((prefix + Key.seatNumber, String(seatNumber)))
        }
        if let effort = state.reasoningEffort, !effort.isEmpty {
            params.append((prefix + Key.reasoningEffort, effort))
        }
        if let thinking = state.thinkingEnabled {
            params.append((prefix + Key.thinkingEnabled, thinking ? "1" : "0"))
        }
        if let preset = state.permissionPresetId, !preset.isEmpty {
            params.append((prefix + Key.permissionPresetId, preset))
        }
        if let grants = state.grantsCount {
            params.append((prefix + Key.grantsCount, String(grants)))
        }
        return params
    }

    private static func encodeComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }
}

/// A markdown table cell whose ENTIRE content is one link — the shape the round
/// close-out emits for its Seat column (`[<plain-text seat>](ensemble-seat://…)`).
public struct TWMarkdownLinkCell: Sendable, Equatable {
    /// The link text: the full plain-text seat description, and the mandatory
    /// fallback when the href does not decode. Never render a dead link.
    public let text: String
    public let href: String

    public init(text: String, href: String) {
        self.text = text
        self.href = href
    }
}

/// Parse a cell that is EXACTLY one markdown link, nothing else. Anything with
/// surrounding text, a second link, or an unterminated destination returns nil
/// so the cell keeps its ordinary inline-markdown rendering.
///
/// Requiring the destination to end at the cell's last character is safe here
/// precisely because the encoder percent-encodes `)`: a seat href can never
/// contain one.
public func twParseSoleMarkdownLinkCell(_ raw: String) -> TWMarkdownLinkCell? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    let characters = Array(trimmed)
    guard characters.count >= 4, characters[0] == "[", characters[characters.count - 1] == ")"
    else { return nil }

    var depth = 0
    var closingBracket: Int?
    var index = 0
    while index < characters.count {
        let character = characters[index]
        if character == "\\" {
            index += 2
            continue
        }
        if character == "[" { depth += 1 }
        if character == "]" {
            depth -= 1
            if depth == 0 {
                closingBracket = index
                break
            }
        }
        index += 1
    }
    guard let closingBracket, closingBracket + 1 < characters.count,
        characters[closingBracket + 1] == "("
    else { return nil }

    let text = String(characters[1..<closingBracket])
    let href = String(characters[(closingBracket + 2)..<(characters.count - 1)])
    // A `(` or `)` loose in the destination means this is not a single tidy
    // link — leave it to the ordinary markdown renderer.
    guard !href.isEmpty, !href.contains("("), !href.contains(")") else { return nil }
    return TWMarkdownLinkCell(text: text, href: href)
}
