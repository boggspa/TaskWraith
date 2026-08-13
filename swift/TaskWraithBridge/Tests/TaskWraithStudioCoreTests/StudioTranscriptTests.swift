import XCTest

@testable import TaskWraithStudioCore

/// Transcript selection and snapping (mission outcome 6).
final class StudioTranscriptTests: XCTestCase {
    private let timebase = StudioTimebase(timescale: 30, frameDurationTicks: 1)!

    private func rational(_ n: Int64) -> StudioRationalTime { StudioRationalTime(n: n, d: 30)! }

    /// Two phrases with a deliberate GAP between them: 0..30, then 60..90.
    /// The gap is the interesting part — that is where an editor cuts.
    private func transcript() -> StudioTranscript {
        StudioTranscript(
            transcriptId: "t-1",
            assetId: "asset-1",
            segments: [
                StudioTranscriptSegment(
                    segmentId: "s-1",
                    text: "first",
                    sourceIn: rational(0),
                    sourceOut: rational(30),
                    confidence: 0.9
                ),
                StudioTranscriptSegment(
                    segmentId: "s-2",
                    text: "second",
                    sourceIn: rational(60),
                    sourceOut: rational(90)
                ),
            ]
        )
    }

    // MARK: - Selection

    func testSelectionFindsTheContainingSegment() {
        let subject = transcript()
        XCTAssertEqual(subject.segment(atTicks: 0, timebase: timebase)?.segmentId, "s-1")
        XCTAssertEqual(subject.segment(atTicks: 29, timebase: timebase)?.segmentId, "s-1")
        XCTAssertEqual(subject.segment(atTicks: 60, timebase: timebase)?.segmentId, "s-2")
        XCTAssertEqual(subject.segment(atTicks: 89, timebase: timebase)?.segmentId, "s-2")
    }

    /// sourceOut is EXCLUSIVE, so the boundary tick belongs to whatever comes
    /// next — never to both. An inclusive end would make two segments claim the
    /// same instant and selection would depend on iteration order.
    func testTheSegmentEndIsExclusive() {
        let subject = transcript()
        XCTAssertNil(subject.segment(atTicks: 30, timebase: timebase))
        XCTAssertNil(subject.segment(atTicks: 90, timebase: timebase))
    }

    /// Nil in a gap is a REAL answer. Silence between phrases belongs to no
    /// segment, and snapping the caret into the nearest one would make it
    /// impossible to place a cut in a pause — which is where editors most often
    /// want one.
    func testAGapBetweenSegmentsSelectsNothing() {
        let subject = transcript()
        XCTAssertNil(subject.segment(atTicks: 45, timebase: timebase))
    }

    func testASegmentReportsItsRange() throws {
        let range = try XCTUnwrap(transcript().segments[1].range(in: timebase))
        XCTAssertEqual(range.startTicks, 60)
        XCTAssertEqual(range.endTicks, 90)
    }

    // MARK: - Boundaries and snapping

    func testBoundariesAreSortedAndDeduplicated() {
        // Adjacent segments share a boundary; it must appear once.
        let adjacent = StudioTranscript(
            transcriptId: "t",
            assetId: "a",
            segments: [
                StudioTranscriptSegment(
                    segmentId: "1",
                    text: "a",
                    sourceIn: rational(0),
                    sourceOut: rational(30)
                ),
                StudioTranscriptSegment(
                    segmentId: "2",
                    text: "b",
                    sourceIn: rational(30),
                    sourceOut: rational(60)
                ),
            ]
        )
        XCTAssertEqual(adjacent.boundaryTicks(in: timebase), [0, 30, 60])
        XCTAssertEqual(transcript().boundaryTicks(in: timebase), [0, 30, 60, 90])
    }

    func testSnappingPullsToTheNearestBoundaryWithinTolerance() {
        let boundaries = transcript().boundaryTicks(in: timebase)
        let result = StudioTranscriptSnapper.snap(
            ticks: 58,
            toBoundaries: boundaries,
            toleranceTicks: 5
        )
        XCTAssertEqual(result, .snapped(ticks: 60, toBoundary: 60))
        XCTAssertTrue(result.didSnap)
    }

    /// THE PROPERTY THAT MAKES SNAPPING USABLE. Snapping that always snaps makes
    /// precise work impossible — an editor must be able to place a cut mid-word
    /// on purpose — so a boundary outside tolerance leaves the position alone
    /// and says so.
    func testABoundaryOutsideToleranceDoesNotSnap() {
        let result = StudioTranscriptSnapper.snap(
            ticks: 45,
            toBoundaries: transcript().boundaryTicks(in: timebase),
            toleranceTicks: 5
        )
        XCTAssertEqual(result, .none(ticks: 45))
        XCTAssertFalse(result.didSnap)
        XCTAssertEqual(result.ticks, 45, "an unsnapped position must be preserved exactly")
    }

    /// A handle dragged exactly between two boundaries must resolve the same way
    /// every time, or it appears to flicker between them.
    func testTiesResolveDeterministicallyToTheEarlierBoundary() {
        let result = StudioTranscriptSnapper.snap(
            ticks: 45,
            toBoundaries: [30, 60],
            toleranceTicks: 100
        )
        XCTAssertEqual(result, .snapped(ticks: 30, toBoundary: 30))
        // Repeatable.
        for _ in 0..<5 {
            XCTAssertEqual(
                StudioTranscriptSnapper.snap(ticks: 45, toBoundaries: [60, 30], toleranceTicks: 100),
                .snapped(ticks: 30, toBoundary: 30)
            )
        }
    }

    func testZeroToleranceAndNoBoundariesNeverSnap() {
        XCTAssertEqual(
            StudioTranscriptSnapper.snap(ticks: 30, toBoundaries: [30], toleranceTicks: 0),
            .none(ticks: 30)
        )
        XCTAssertEqual(
            StudioTranscriptSnapper.snap(ticks: 30, toBoundaries: [], toleranceTicks: 100),
            .none(ticks: 30)
        )
    }

    // MARK: - Decoding

    func testATranscriptDecodesFromASetTranscriptOperation() throws {
        let payload: [String: Any] = [
            "type": "set_transcript",
            "transcript": [
                "schemaVersion": 1,
                "transcriptId": "t-1",
                "assetId": "asset-1",
                "localeIdentifier": "en-GB",
                "segments": [
                    [
                        "segmentId": "s-1",
                        "text": "hello",
                        "sourceIn": ["n": 0, "d": 30],
                        "sourceOut": ["n": 30, "d": 30],
                        "confidence": 0.75,
                    ]
                ],
            ],
        ]
        let decoded = try StudioTranscriptDecoder.transcript(fromSetTranscript: payload)
        XCTAssertEqual(decoded.transcriptId, "t-1")
        XCTAssertEqual(decoded.localeIdentifier, "en-GB")
        XCTAssertEqual(decoded.segments.count, 1)
        XCTAssertEqual(decoded.segments[0].text, "hello")
        XCTAssertEqual(decoded.segments[0].confidence ?? 0, 0.75, accuracy: 0.0001)
    }

    func testAnUnknownTranscriptSchemaVersionIsRefused() {
        XCTAssertThrowsError(
            try StudioTranscriptDecoder.transcript(
                from: ["schemaVersion": 2, "transcriptId": "t", "assetId": "a", "segments": []]
            )
        ) { error in
            XCTAssertEqual(
                error as? StudioProposalDecodeError,
                .unsupportedSchemaVersion(2)
            )
        }
    }

    /// Confidence is METADATA. A malformed one must not cost us the segment's
    /// TIMING, which is the part edits depend on.
    func testAMalformedConfidenceDoesNotDiscardTheSegmentsTiming() throws {
        let segment = try StudioTranscriptDecoder.segment(
            from: [
                "segmentId": "s-1",
                "text": "hello",
                "sourceIn": ["n": 0, "d": 30],
                "sourceOut": ["n": 30, "d": 30],
                "confidence": "very sure",
            ]
        )
        XCTAssertNil(segment.confidence)
        XCTAssertEqual(segment.sourceOut.n, 30, "timing survived a bad confidence")
    }

    func testMissingTimingFieldsAreRefused() {
        for field in ["segmentId", "text", "sourceIn", "sourceOut"] {
            var payload: [String: Any] = [
                "segmentId": "s-1",
                "text": "hello",
                "sourceIn": ["n": 0, "d": 30],
                "sourceOut": ["n": 30, "d": 30],
            ]
            payload.removeValue(forKey: field)
            XCTAssertThrowsError(
                try StudioTranscriptDecoder.segment(from: payload),
                "missing \(field) was accepted"
            )
        }
    }
}
