import Foundation

/// Swift mirror of the host's exact transcript segments (mission outcome 6's
/// transcript selection).
///
/// StudioProtocol.ts IS NORMATIVE, and the host made a decision here worth
/// preserving rather than undoing: TaskWraith's product transcription speaks
/// floating-point milliseconds, but Studio's editing clock is exact rational
/// time, so the durable contract stores `{n, d}` and keeps confidence as
/// METADATA ONLY. Nothing in this file may let confidence or a millisecond
/// round-trip influence edit timing — an edit point derived from a float is an
/// edit point that lands on the wrong frame.
public struct StudioTranscriptSegment: Equatable, Sendable {
    public let segmentId: String
    public let text: String
    public let sourceIn: StudioRationalTime
    /// EXCLUSIVE end, matching every other range in this package and the host's
    /// own half-open convention.
    public let sourceOut: StudioRationalTime
    /// Recognizer metadata. Never used for timing.
    public let confidence: Double?

    public init(
        segmentId: String,
        text: String,
        sourceIn: StudioRationalTime,
        sourceOut: StudioRationalTime,
        confidence: Double? = nil
    ) {
        self.segmentId = segmentId
        self.text = text
        self.sourceIn = sourceIn
        self.sourceOut = sourceOut
        self.confidence = confidence
    }

    /// The segment's range in a viewer timebase, or nil when it is degenerate.
    public func range(in timebase: StudioTimebase) -> StudioLoopRange? {
        StudioLoopRange(
            startTicks: sourceIn.ticks(in: timebase),
            endTicks: sourceOut.ticks(in: timebase)
        )
    }
}

public struct StudioTranscript: Equatable, Sendable {
    /// Must match the host's STUDIO_TRANSCRIPT_SCHEMA_VERSION.
    public static let schemaVersion = 1

    public let transcriptId: String
    public let assetId: String
    public let localeIdentifier: String?
    /// Ordered and non-overlapping — the host validates both, so this does not
    /// re-derive that guarantee, it RELIES on it. Re-validating here would
    /// create a second opinion about the same rule that could drift.
    public let segments: [StudioTranscriptSegment]

    public init(
        transcriptId: String,
        assetId: String,
        localeIdentifier: String? = nil,
        segments: [StudioTranscriptSegment]
    ) {
        self.transcriptId = transcriptId
        self.assetId = assetId
        self.localeIdentifier = localeIdentifier
        self.segments = segments
    }

    // MARK: - Selection

    /// The segment containing `ticks`, or nil in a gap between segments.
    ///
    /// Nil is a real answer, not a failure: silence between phrases is not part
    /// of any segment, and snapping the caret into the nearest one would make it
    /// impossible to place a cut in a pause — which is precisely where editors
    /// most often want one.
    public func segment(atTicks ticks: Int64, timebase: StudioTimebase) -> StudioTranscriptSegment? {
        segments.first { segment in
            guard let range = segment.range(in: timebase) else { return false }
            return ticks >= range.startTicks && ticks < range.endTicks
        }
    }

    /// Every segment boundary, in ascending tick order. Both edges of every
    /// segment, because an editor snaps to the START of a word as readily as to
    /// the end of the one before it.
    public func boundaryTicks(in timebase: StudioTimebase) -> [Int64] {
        var ticks: [Int64] = []
        for segment in segments {
            guard let range = segment.range(in: timebase) else { continue }
            ticks.append(range.startTicks)
            ticks.append(range.endTicks)
        }
        return Array(Set(ticks)).sorted()
    }
}

/// Result of a snap attempt.
///
/// `none` is deliberately distinct from "snapped to where you already were".
/// Snapping that ALWAYS snaps makes precise work impossible — an editor must be
/// able to place a cut mid-word on purpose — so a boundary outside tolerance
/// leaves the position untouched and says so.
public enum StudioSnapResult: Equatable, Sendable {
    case none(ticks: Int64)
    case snapped(ticks: Int64, toBoundary: Int64)

    public var ticks: Int64 {
        switch self {
        case .none(let ticks): return ticks
        case .snapped(let ticks, _): return ticks
        }
    }

    public var didSnap: Bool {
        if case .snapped = self { return true }
        return false
    }
}

public enum StudioTranscriptSnapper {
    /// Snaps `ticks` to the nearest boundary within `toleranceTicks`.
    ///
    /// Ties go to the EARLIER boundary, deterministically. An editor dragging a
    /// handle that lands exactly between two boundaries must get the same answer
    /// every time, or the handle appears to flicker between them.
    public static func snap(
        ticks: Int64,
        toBoundaries boundaries: [Int64],
        toleranceTicks: Int64
    ) -> StudioSnapResult {
        guard toleranceTicks > 0, !boundaries.isEmpty else { return .none(ticks: ticks) }
        var best: Int64?
        var bestDistance = Int64.max
        for boundary in boundaries {
            let distance = abs(boundary - ticks)
            if distance < bestDistance || (distance == bestDistance && boundary < (best ?? .max)) {
                bestDistance = distance
                best = boundary
            }
        }
        guard let best, bestDistance <= toleranceTicks else { return .none(ticks: ticks) }
        return .snapped(ticks: best, toBoundary: best)
    }
}

public enum StudioTranscriptDecoder {
    /// Decodes a transcript from a `set_transcript` operation payload.
    public static func transcript(fromSetTranscript payload: [String: Any]) throws
        -> StudioTranscript
    {
        guard let type = payload["type"] as? String else {
            throw StudioProposalDecodeError.missingField("type")
        }
        guard type == "set_transcript" else { throw StudioProposalDecodeError.notAProposal }
        guard let body = payload["transcript"] as? [String: Any] else {
            throw StudioProposalDecodeError.missingField("transcript")
        }
        return try transcript(from: body)
    }

    public static func transcript(from body: [String: Any]) throws -> StudioTranscript {
        guard let schemaVersion = body["schemaVersion"] as? Int else {
            throw StudioProposalDecodeError.missingField("schemaVersion")
        }
        guard schemaVersion == StudioTranscript.schemaVersion else {
            throw StudioProposalDecodeError.unsupportedSchemaVersion(schemaVersion)
        }
        guard let transcriptId = body["transcriptId"] as? String else {
            throw StudioProposalDecodeError.missingField("transcriptId")
        }
        guard let assetId = body["assetId"] as? String else {
            throw StudioProposalDecodeError.missingField("assetId")
        }
        guard let rawSegments = body["segments"] as? [[String: Any]] else {
            throw StudioProposalDecodeError.missingField("segments")
        }
        return StudioTranscript(
            transcriptId: transcriptId,
            assetId: assetId,
            localeIdentifier: body["localeIdentifier"] as? String,
            segments: try rawSegments.map(segment(from:))
        )
    }

    public static func segment(from payload: [String: Any]) throws -> StudioTranscriptSegment {
        guard let segmentId = payload["segmentId"] as? String else {
            throw StudioProposalDecodeError.missingField("segment.segmentId")
        }
        guard let text = payload["text"] as? String else {
            throw StudioProposalDecodeError.missingField("segment.text")
        }
        return StudioTranscriptSegment(
            segmentId: segmentId,
            text: text,
            sourceIn: try StudioProposalDecoder.rational(
                from: payload["sourceIn"],
                field: "segment.sourceIn"
            ),
            sourceOut: try StudioProposalDecoder.rational(
                from: payload["sourceOut"],
                field: "segment.sourceOut"
            ),
            // Metadata only, and optional. A malformed confidence must not cost
            // us the segment's TIMING, which is the part that matters.
            confidence: (payload["confidence"] as? NSNumber)?.doubleValue
        )
    }
}
