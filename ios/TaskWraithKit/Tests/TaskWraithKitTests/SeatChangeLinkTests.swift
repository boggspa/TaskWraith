import Foundation
import Testing

@testable import TaskWraithKit

/// The hrefs below are BYTES the TypeScript encoder actually emitted
/// (`encodeSeatChangeLink` in `src/shared/seatChange.ts`, run over the fixtures
/// this suite names). They are the cross-implementation contract: the escaping
/// rules are the fragile part of this codec, and a Swift-only round-trip would
/// happily agree with itself while disagreeing with the Mac.
@Suite("Seat change link codec (desktop parity)")
struct SeatChangeLinkTests {
    // MARK: - Golden hrefs from the TypeScript encoder

    private static let changedHref =
        "ensemble-seat://p-8?p=claude&m=claude-opus-5&role=GemProWork&n=8&r=max&k=default&g=2"
        + "&bp=grok&bm=grok-4.5-fast&brole=GemProWork&bn=8&br=high&bk=default&bg=2"
    private static let unchangedHref =
        "ensemble-seat://p-8?p=claude&m=claude-opus-5&role=GemProWork&n=8&r=max&k=default&g=2"
    private static let awkwardHref =
        "ensemble-seat://a%20b?p=ollama&m=qwen3-coder%3A30b%2Btools%20%28q4_K_M%29"
        + "&role=R%26D%20%3D%20Lead%27s%2A&n=3"
    private static let thinkingHref =
        "ensemble-seat://p-2?p=kimi&m=kimi-k2.7-code&role=Kimi&n=2&t=1&k=full_access&g=1"
        + "&bp=kimi&bm=kimi-k2.7-code&brole=Kimi&bn=2&bt=0&bk=read_only&bg=0"
    private static let unicodeHref =
        "ensemble-seat://p-%C3%A9?p=mistral&m=devstral-small&role=R%C3%B4le%20%E2%9C%A6&n=1&k=plan"
        + "&bp=mistral&bm=devstral-small&brole=R%C3%B4le%20%E2%9C%A6&bn=1&bk=workspace_write"

    private static let changed = TWSeatChangeLink(
        participantId: "p-8",
        before: TWSeatChangeState(
            provider: "grok", model: "grok-4.5-fast", role: "GemProWork", seatNumber: 8,
            reasoningEffort: "high", permissionPresetId: "default", grantsCount: 2),
        after: TWSeatChangeState(
            provider: "claude", model: "claude-opus-5", role: "GemProWork", seatNumber: 8,
            reasoningEffort: "max", permissionPresetId: "default", grantsCount: 2))

    // MARK: - Decode

    @Test func decodesBothSidesOfAChangedSeat() {
        let link = TWSeatChangeLinkCodec.decode(Self.changedHref)
        #expect(link == Self.changed)
    }

    @Test func anUnchangedSeatDecodesToTwoIdenticalSides() {
        let link = TWSeatChangeLinkCodec.decode(Self.unchangedHref)
        #expect(link?.before == Self.changed.after)
        #expect(link?.after == Self.changed.after)
    }

    /// A bare `)` closes a markdown link destination, so the Mac escapes
    /// `!'()*` on top of `encodeURIComponent`; `+` must survive as a `+` (the
    /// reason neither side may use a form-decoding query parser).
    @Test func survivesParenthesesPlusAndSpacesThatWouldBreakNaiveParsers() {
        let link = TWSeatChangeLinkCodec.decode(Self.awkwardHref)
        #expect(link?.participantId == "a b")
        #expect(link?.after.model == "qwen3-coder:30b+tools (q4_K_M)")
        #expect(link?.after.role == "R&D = Lead's*")
        #expect(link?.after.seatNumber == 3)
    }

    @Test func carriesKimisThinkingFlagIndependentlyOfReasoningEffort() {
        let link = TWSeatChangeLinkCodec.decode(Self.thinkingHref)
        #expect(link?.before.thinkingEnabled == false)
        #expect(link?.after.thinkingEnabled == true)
        #expect(link?.after.reasoningEffort == nil)
        #expect(link?.before.permissionPresetId == "read_only")
        #expect(link?.after.permissionPresetId == "full_access")
        // `g=0` is a real zero, not a missing field.
        #expect(link?.before.grantsCount == 0)
        #expect(link?.after.grantsCount == 1)
    }

    @Test func decodesNonAsciiParticipantIdsAndRoles() {
        let link = TWSeatChangeLinkCodec.decode(Self.unicodeHref)
        #expect(link?.participantId == "p-é")
        #expect(link?.after.role == "Rôle ✦")
        #expect(link?.before.permissionPresetId == "workspace_write")
        #expect(link?.after.permissionPresetId == "plan")
    }

    @Test func rejectsHrefsThatAreNotSeatLinksOrCarryNoResolvableSeat() {
        #expect(TWSeatChangeLinkCodec.decode("ensemble-dm://p-8") == nil)
        #expect(TWSeatChangeLinkCodec.decode("ensemble-seat://p-8") == nil)
        #expect(TWSeatChangeLinkCodec.decode("ensemble-seat://p-8?m=claude-opus-5") == nil)
        #expect(TWSeatChangeLinkCodec.decode("ensemble-seat://?p=claude") == nil)
        #expect(TWSeatChangeLinkCodec.decode("https://example.invalid/?p=claude") == nil)
    }

    /// A malformed escape must cost that FIELD, not the row — the seat still
    /// renders with everything that did decode.
    @Test func aMalformedEscapeDropsOnlyItsOwnField() {
        let link = TWSeatChangeLinkCodec.decode("ensemble-seat://p1?p=claude&m=opus&role=%ZZ&n=4")
        #expect(link?.after.provider == "claude")
        #expect(link?.after.model == "opus")
        #expect(link?.after.role == nil)
        #expect(link?.after.seatNumber == 4)
    }

    // MARK: - Encode (round-trip against the TypeScript bytes)

    @Test func encodesByteIdenticalHrefsToTheTypeScriptEncoder() {
        #expect(TWSeatChangeLinkCodec.encode(Self.changed) == Self.changedHref)
        let unchanged = TWSeatChangeLink(
            participantId: "p-8", before: Self.changed.after, after: Self.changed.after)
        #expect(TWSeatChangeLinkCodec.encode(unchanged) == Self.unchangedHref)
        let awkwardSeat = TWSeatChangeState(
            provider: "ollama", model: "qwen3-coder:30b+tools (q4_K_M)", role: "R&D = Lead's*",
            seatNumber: 3)
        let awkward = TWSeatChangeLink(
            participantId: "a b", before: awkwardSeat, after: awkwardSeat)
        #expect(TWSeatChangeLinkCodec.encode(awkward) == Self.awkwardHref)
    }

    @Test func roundTripsEverySideThroughTheHrefUnchanged() {
        for href in [Self.changedHref, Self.thinkingHref, Self.unicodeHref] {
            let decoded = TWSeatChangeLinkCodec.decode(href)
            #expect(decoded != nil)
            #expect(TWSeatChangeLinkCodec.decode(TWSeatChangeLinkCodec.encode(decoded!)) == decoded)
        }
    }

    // MARK: - Whole-cell link parsing

    @Test func parsesACellThatIsExactlyOneLink() {
        let cell = twParseSoleMarkdownLinkCell(
            "[@Builder · Codex · GPT-5.6-Sol · Ultra · Full WS Access](\(Self.unchangedHref))")
        #expect(cell?.text == "@Builder · Codex · GPT-5.6-Sol · Ultra · Full WS Access")
        #expect(cell?.href == Self.unchangedHref)
    }

    @Test func refusesCellsThatAreNotAWholeSingleLink() {
        #expect(twParseSoleMarkdownLinkCell("**Round Total**") == nil)
        #expect(twParseSoleMarkdownLinkCell("seat: [a](ensemble-seat://p?p=claude&m=x)") == nil)
        #expect(twParseSoleMarkdownLinkCell("[a](ensemble-seat://p?p=claude&m=x) and more") == nil)
        #expect(twParseSoleMarkdownLinkCell("[unterminated](ensemble-seat://p?p=claude") == nil)
        #expect(twParseSoleMarkdownLinkCell("[no destination]()") == nil)
    }

    // MARK: - Projected transcript payload

    @Test func projectedPayloadDecodesAndFallsBackToTheAfterSide() throws {
        let json = """
            {"participantId":"p1","label":"CursorWork","appliedAt":"2026-08-05T12:00:00.000Z",
             "after":{"provider":"claude","model":"claude-opus-5","role":"Lead","seatNumber":1,
                      "reasoningEffort":"max","permissionPresetId":"default","grantsCount":3}}
            """
        let payload = try JSONDecoder().decode(
            TWSeatChangePayload.self, from: Data(json.utf8))
        let link = try #require(payload.renderableLink)
        #expect(link.before == link.after)
        #expect(link.after.grantsCount == 3)
        #expect(payload.label == "CursorWork")
    }

    /// A seat blob missing the fields this build knows must never throw the
    /// whole row's decode away.
    @Test func aPartialSeatDecodesWithEmptyStringsRatherThanThrowing() throws {
        let payload = try JSONDecoder().decode(
            TWSeatChangePayload.self, from: Data(#"{"after":{"role":"Lead"}}"#.utf8))
        #expect(payload.after?.provider == "")
        #expect(payload.after?.model == "")
        #expect(payload.renderableLink == nil)
    }
}
