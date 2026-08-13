import Foundation

/// One clip on the committed timeline, in the viewer's timebase.
public struct StudioSequenceItem: Equatable, Sendable {
    public let itemId: String
    public let assetId: String
    /// Half-open sequence range: start inclusive, end exclusive.
    public let startTicks: Int64
    public let endTicks: Int64
    /// Where this clip begins inside its own asset.
    public let sourceInTicks: Int64

    public var spanTicks: Int64 { endTicks - startTicks }

    /// Sequence tick -> source tick within this clip's asset. Identity speed,
    /// matching the host's own contract that duration == sourceOut - sourceIn.
    public func sourceTicks(forSequenceTicks ticks: Int64) -> Int64? {
        guard ticks >= startTicks, ticks < endTicks else { return nil }
        return sourceInTicks &+ (ticks - startTicks)
    }
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
    /// Sorted by start, non-overlapping — the host's own guarantee for a track.
    public let items: [StudioSequenceItem]
    /// Clock in which item start/end/source ticks were decoded. It must travel
    /// with the sequence so a resident asset can re-express content time before
    /// its audio buffer is scheduled.
    public let timebase: StudioTimebase?

    public init(items: [StudioSequenceItem], timebase: StudioTimebase? = nil) {
        self.items = items.sorted { $0.startTicks < $1.startTicks }
        self.timebase = timebase
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
}

/// Decodes the host's `tracks` payload.
///
/// The document has carried tracks since insert_range began materialising items
/// on accept; the companion parsed assets, proposals and transcripts and DROPPED
/// tracks. So the committed timeline arrived on the wire and reached nothing —
/// this round's recurring shape, at the one place it prevented an outcome.
public enum StudioTimelineSequenceDecoder {
    /// Video tracks only. An audio track's items are not what a viewer presents,
    /// and silently merging them would put two clips at one tick.
    public static func sequence(
        fromTracks tracks: [[String: Any]],
        timebase: StudioTimebase
    ) -> StudioTimelineSequence {
        var items: [StudioSequenceItem] = []
        for track in tracks {
            guard (track["kind"] as? String) == "video" else { continue }
            for raw in track["items"] as? [[String: Any]] ?? [] {
                guard
                    let itemId = raw["itemId"] as? String,
                    let assetId = raw["assetId"] as? String,
                    let position = rational(raw["position"])?.ticks(in: timebase),
                    let duration = rational(raw["duration"])?.ticks(in: timebase),
                    let sourceIn = rational(raw["sourceIn"])?.ticks(in: timebase),
                    duration > 0
                else {
                    // A malformed or zero-length item is SKIPPED, not guessed at.
                    continue
                }
                items.append(
                    StudioSequenceItem(
                        itemId: itemId,
                        assetId: assetId,
                        startTicks: position,
                        endTicks: position &+ duration,
                        sourceInTicks: sourceIn
                    )
                )
            }
        }
        return StudioTimelineSequence(items: items, timebase: timebase)
    }

    private static func rational(_ value: Any?) -> StudioRationalTime? {
        guard
            let dict = value as? [String: Any],
            let n = dict["n"] as? Int ?? (dict["n"] as? Int64).map(Int.init),
            let d = dict["d"] as? Int ?? (dict["d"] as? Int64).map(Int.init)
        else { return nil }
        return StudioRationalTime(n: Int64(n), d: Int64(d))
    }
}
