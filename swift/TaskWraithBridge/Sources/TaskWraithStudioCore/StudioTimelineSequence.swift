import CoreFoundation
import Foundation

/// One clip on the committed timeline, in the viewer's timebase.
public struct StudioSequenceItem: Equatable, Sendable {
    public let itemId: String
    public let assetId: String
    public let trackId: String
    /// Half-open sequence range: start inclusive, end exclusive.
    public let startTicks: Int64
    public let endTicks: Int64
    /// Where this clip begins inside its own asset.
    public let sourceInTicks: Int64

    public init(
        itemId: String,
        assetId: String,
        trackId: String = "V1",
        startTicks: Int64,
        endTicks: Int64,
        sourceInTicks: Int64
    ) {
        self.itemId = itemId
        self.assetId = assetId
        self.trackId = trackId
        self.startTicks = startTicks
        self.endTicks = endTicks
        self.sourceInTicks = sourceInTicks
    }

    public var spanTicks: Int64 { endTicks - startTicks }

    /// Sequence tick -> source tick within this clip's asset. Identity speed,
    /// matching the host's own contract that duration == sourceOut - sourceIn.
    public func sourceTicks(forSequenceTicks ticks: Int64) -> Int64? {
        guard ticks >= startTicks, ticks < endTicks else { return nil }
        return sourceInTicks &+ (ticks - startTicks)
    }
}

public enum StudioSequenceTrackKind: Equatable, Sendable {
    case video
    case audio
}

/// What the Review route is looking at when it asks "what is at this tick".
public enum StudioSequenceSample: Equatable, Sendable {
    case item(itemId: String, assetId: String, sourceTicks: Int64)
    /// A hole in the sequence, or past its end. DRAWS NOTHING.
    ///
    /// The same refusal the review router already makes: substituting a
    /// neighbouring frame would show an operator material that is not there at
    /// that time, which is worse than black.
    case gap
}

/// The audio counterpart of StudioSequenceSample. This is deliberately only
/// an identity plus source time: selecting PCM and touching the one device
/// player remain presentation-layer responsibilities.
public enum StudioSequenceAudioSelection: Equatable, Sendable {
    case play(assetId: String, sourceTicks: Int64)
    case silence
}

/// Timeline audio is content-addressed. A gap is not permission to reuse the
/// prior clip: it is a positive instruction to remain silent.
public enum StudioSequenceAudioPolicy {
    public static func selection(
        in sequence: StudioTimelineSequence,
        atTicks ticks: Int64
    ) -> StudioSequenceAudioSelection {
        switch sequence.sample(atTicks: ticks) {
        case .gap:
            return .silence
        case .item(_, let assetId, let sourceTicks):
            return .play(assetId: assetId, sourceTicks: sourceTicks)
        }
    }

    /// Re-expresses a document content tick in the selected resident asset's
    /// clock. The source time is a rational instant; integer ticks are merely
    /// its representation in each clock, so reusing the document value for an
    /// asset clock is wrong whenever their timescales differ.
    public static func reexpress(
        sourceTicks: Int64,
        from documentTimebase: StudioTimebase,
        into assetTimebase: StudioTimebase
    ) -> Int64 {
        StudioRationalTime(n: sourceTicks, d: documentTimebase.timescale)!
            .ticks(in: assetTimebase)
    }
}

/// THE COMMITTED TIMELINE AS A PLAYBACK SUBJECT.
///
/// WHY THIS TYPE EXISTS, and it is the distinction the owner-approved briefing
/// draws in one paragraph: Source/Audition "previews the selected ASSET
/// independently of the timeline"; Review "plays the committed TIMELINE or the
/// open ghost proposal". Those are two different subjects. Before this, both
/// routes played the open asset and Review merely decorated it — which is
/// playing the asset with timeline-coloured paint on top.
///
/// StudioTimelineModel is NOT this. That is a drawing model: every consumer is
/// the overlay layout and its other entry points take geometry. Nothing in Core
/// could play a timeline until now.
public struct StudioTimelineSequence: Equatable, Sendable {
    /// Sorted by start, non-overlapping — the host's guarantee inside a track.
    /// Multiple video tracks retain their identities rather than being guessed
    /// from visible items during an accepted full-track projection.
    public let items: [StudioSequenceItem]
    /// Clock in which item start/end/source ticks were decoded. It must travel
    /// with the sequence so a resident asset can re-express content time before
    /// its audio buffer is scheduled.
    public let timebase: StudioTimebase?
    /// Includes empty and audio tracks so track identity is never inferred from
    /// visible items alone.
    public let trackKinds: [String: StudioSequenceTrackKind]

    public init(
        items: [StudioSequenceItem],
        timebase: StudioTimebase? = nil,
        trackKinds: [String: StudioSequenceTrackKind]? = nil
    ) {
        self.items = items.sorted { $0.startTicks < $1.startTicks }
        self.timebase = timebase
        self.trackKinds = trackKinds ?? items.reduce(into: [:]) { kinds, item in
            kinds[item.trackId] = .video
        }
    }

    public var isEmpty: Bool { items.isEmpty }
    /// Total sequence length: the end of the last item, not the sum of spans.
    /// A gap between clips is still time you can sit on.
    public var durationTicks: Int64 { items.map(\.endTicks).max() ?? 0 }

    public func sample(atTicks ticks: Int64) -> StudioSequenceSample {
        guard ticks >= 0 else { return .gap }
        // Linear scan is honest here: a timeline with enough clips to need a
        // binary search is not a timeline this viewer has ever been handed, and
        // a wrong binary search on half-open ranges is a classic off-by-one.
        for item in items {
            if let source = item.sourceTicks(forSequenceTicks: ticks) {
                return .item(itemId: item.itemId, assetId: item.assetId, sourceTicks: source)
            }
        }
        return .gap
    }

    /// Every asset the sequence needs resident to play through.
    public var referencedAssetIds: Set<String> { Set(items.map(\.assetId)) }

    /// Pure adoption of the host's already-materialised result. The companion
    /// performs no edit arithmetic; accepted state and restart hydration are
    /// decoded through the same path.
    public func replacingCommittedSequence(
        with materialized: StudioTimelineSequence
    ) throws -> StudioTimelineSequence {
        guard timebase == materialized.timebase else {
            throw StudioSequenceProjectionError.timebaseMismatch
        }
        return materialized
    }
}

public enum StudioSequenceProjectionError: Error, Equatable {
    case invalidTrack(String)
    case invalidItem(String)
    case timebaseMismatch
}

/// Decodes the host's `tracks` payload.
///
/// The document has carried tracks since insert_range began materialising items
/// on accept; the companion parsed assets, proposals and transcripts and DROPPED
/// tracks. So the committed timeline arrived on the wire and reached nothing —
/// this round's recurring shape, at the one place it prevented an outcome.
public enum StudioTimelineSequenceDecoder {
    /// Hydration is tolerant of malformed legacy entries. Only video items are
    /// projected as picture, while every valid track kind is retained so an
    /// empty or audio track identity is never inferred incorrectly later.
    public static func sequence(
        fromTracks tracks: [[String: Any]],
        timebase: StudioTimebase
    ) -> StudioTimelineSequence {
        (try? decode(tracks: tracks, timebase: timebase, strict: false))
            ?? StudioTimelineSequence(items: [], timebase: timebase)
    }

    /// Live accepted materialisation is strict: malformed or contradictory
    /// tracks reject the whole resolution instead of partially mutating Current.
    public static func strictSequence(
        fromTracks tracks: [[String: Any]],
        timebase: StudioTimebase
    ) throws -> StudioTimelineSequence {
        try decode(tracks: tracks, timebase: timebase, strict: true)
    }

    private static func decode(
        tracks: [[String: Any]],
        timebase: StudioTimebase,
        strict: Bool
    ) throws -> StudioTimelineSequence {
        var items: [StudioSequenceItem] = []
        var trackKinds: [String: StudioSequenceTrackKind] = [:]
        var itemIds: Set<String> = []
        for track in tracks {
            guard exactKeys(track, allowed: ["trackId", "kind", "items"], strict: strict),
                let trackId = track["trackId"] as? String, !trackId.isEmpty,
                let kind = track["kind"] as? String, kind == "video" || kind == "audio",
                let rawItems = track["items"] as? [[String: Any]]
            else {
                // Hydration skips a malformed legacy track rather than guessing;
                // strict live delivery turns the same condition into refusal.
                if strict { throw StudioSequenceProjectionError.invalidTrack("track") }
                continue
            }
            guard trackKinds[trackId] == nil else {
                if strict { throw StudioSequenceProjectionError.invalidTrack(trackId) }
                continue
            }
            trackKinds[trackId] = kind == "video" ? .video : .audio
            for raw in rawItems {
                guard exactKeys(
                    raw,
                    allowed: ["itemId", "assetId", "position", "duration", "sourceIn", "sourceOut"],
                    strict: strict),
                    let itemId = raw["itemId"] as? String, !itemId.isEmpty,
                    let assetId = raw["assetId"] as? String, !assetId.isEmpty,
                    let positionTime = rational(raw["position"]),
                    let durationTime = rational(raw["duration"]),
                    let sourceInTime = rational(raw["sourceIn"]),
                    let sourceOutTime = rational(raw["sourceOut"]),
                    positionTime.n >= 0, durationTime.n > 0, sourceInTime.n >= 0,
                    compare(sourceOutTime, sourceInTime) > 0,
                    exactDurationMatches(
                        durationTime, sourceIn: sourceInTime, sourceOut: sourceOutTime)
                else {
                    // A malformed or zero-length item is SKIPPED, not guessed at,
                    // during hydration; strict delivery rejects it observably.
                    if strict { throw StudioSequenceProjectionError.invalidItem(trackId) }
                    continue
                }
                guard itemIds.insert(itemId).inserted else {
                    if strict { throw StudioSequenceProjectionError.invalidItem(itemId) }
                    continue
                }
                guard kind == "video" else { continue }
                let position = positionTime.ticks(in: timebase)
                let duration = durationTime.ticks(in: timebase)
                let sourceIn = sourceInTime.ticks(in: timebase)
                // Positive exact sub-tick items are absent from the integer
                // projection on both live acceptance and later hydration.
                guard duration > 0 else { continue }
                let end = position.addingReportingOverflow(duration)
                guard !end.overflow else {
                    if strict { throw StudioSequenceProjectionError.invalidItem(itemId) }
                    continue
                }
                items.append(StudioSequenceItem(
                    itemId: itemId,
                    assetId: assetId,
                    trackId: trackId,
                    startTicks: position,
                    endTicks: end.partialValue,
                    sourceInTicks: sourceIn
                ))
            }
        }
        return StudioTimelineSequence(
            items: items, timebase: timebase, trackKinds: trackKinds)
    }

    private static func rational(_ value: Any?) -> StudioRationalTime? {
        guard let dict = value as? [String: Any], Set(dict.keys) == Set(["n", "d"]),
            let n = exactInteger(dict["n"]), let d = exactInteger(dict["d"])
        else { return nil }
        return StudioRationalTime(n: n, d: d)
    }

    private static func exactInteger(_ value: Any?) -> Int64? {
        guard let number = value as? NSNumber,
            CFGetTypeID(number) != CFBooleanGetTypeID(),
            let integer = Int64(number.stringValue),
            integer >= -9_007_199_254_740_991,
            integer <= 9_007_199_254_740_991
        else { return nil }
        return integer
    }

    private static func compare(_ lhs: StudioRationalTime, _ rhs: StudioRationalTime) -> Int {
        let left = Decimal(lhs.n) * Decimal(rhs.d)
        let right = Decimal(rhs.n) * Decimal(lhs.d)
        return left < right ? -1 : (left > right ? 1 : 0)
    }

    /// Exact safe-integer proof of duration == sourceOut - sourceIn. Three
    /// 53-bit factors fit in 192 bits, so this mirrors the host's BigInt
    /// invariant without bringing edit arithmetic into the companion.
    private static func exactDurationMatches(
        _ duration: StudioRationalTime,
        sourceIn: StudioRationalTime,
        sourceOut: StudioRationalTime
    ) -> Bool {
        guard duration.n > 0, sourceIn.n >= 0, sourceOut.n >= 0 else { return false }
        let leftBase = multiply(UInt64(duration.n), UInt64(sourceOut.d))
        guard let left = multiply(leftBase, UInt64(sourceIn.d)) else { return false }
        let outBase = multiply(UInt64(sourceOut.n), UInt64(sourceIn.d))
        let inBase = multiply(UInt64(sourceIn.n), UInt64(sourceOut.d))
        guard let difference = subtract(outBase, inBase),
            let right = multiply(difference, UInt64(duration.d))
        else { return false }
        return left == right
    }

    private struct Wide128 {
        let high: UInt64
        let low: UInt64
    }

    private struct Wide192: Equatable {
        let high: UInt64
        let middle: UInt64
        let low: UInt64
    }

    private static func multiply(_ lhs: UInt64, _ rhs: UInt64) -> Wide128 {
        let product = lhs.multipliedFullWidth(by: rhs)
        return Wide128(high: product.high, low: product.low)
    }

    private static func multiply(_ value: Wide128, _ factor: UInt64) -> Wide192? {
        let lowProduct = value.low.multipliedFullWidth(by: factor)
        let highProduct = value.high.multipliedFullWidth(by: factor)
        let middle = lowProduct.high.addingReportingOverflow(highProduct.low)
        let high = highProduct.high.addingReportingOverflow(middle.overflow ? 1 : 0)
        guard !high.overflow else { return nil }
        return Wide192(
            high: high.partialValue,
            middle: middle.partialValue,
            low: lowProduct.low)
    }

    private static func subtract(_ lhs: Wide128, _ rhs: Wide128) -> Wide128? {
        let low = lhs.low.subtractingReportingOverflow(rhs.low)
        let highWithoutBorrow = lhs.high.subtractingReportingOverflow(rhs.high)
        guard !highWithoutBorrow.overflow else { return nil }
        let high = highWithoutBorrow.partialValue.subtractingReportingOverflow(
            low.overflow ? 1 : 0)
        guard !high.overflow else { return nil }
        return Wide128(high: high.partialValue, low: low.partialValue)
    }

    private static func exactKeys(
        _ value: [String: Any],
        allowed: Set<String>,
        strict: Bool
    ) -> Bool {
        !strict || Set(value.keys) == allowed
    }
}
