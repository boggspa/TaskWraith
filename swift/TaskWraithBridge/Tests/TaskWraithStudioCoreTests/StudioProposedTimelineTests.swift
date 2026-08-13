import XCTest

@testable import TaskWraithStudioCore

/// Current/Proposed as arithmetic (mission outcomes 3 and 6).
///
/// An insert_range RIPPLES rather than overlaying, so the same review position
/// addresses different material in the two versions. Getting that mapping wrong
/// produces an A/B that compares a frame with itself and looks perfect.
final class StudioProposedTimelineTests: XCTestCase {
    /// Whole-number timebase: 30 ticks per second, one tick per frame, so every
    /// number in these assertions is readable by hand.
    private let timebase = StudioTimebase(timescale: 30, frameDurationTicks: 1)!

    private func rational(_ n: Int64) -> StudioRationalTime {
        // n/30 seconds against a 30-tick timescale is n ticks exactly.
        StudioRationalTime(n: n, d: 30)!
    }

    /// Inserts 40 ticks of source (starting at source tick 100) at sequence 200.
    private func makeTimeline(
        at insertion: Int64 = 200,
        sourceIn: Int64 = 100,
        sourceOut: Int64 = 140,
        assetId: String = "insert-asset"
    ) -> StudioProposedTimeline {
        let proposal = StudioEditProposal(
            proposalId: "p1",
            createdRevision: 7,
            op: StudioInsertRangeOp(
                itemId: "item-1",
                assetId: assetId,
                sourceIn: rational(sourceIn),
                sourceOut: rational(sourceOut),
                at: rational(insertion)
            )
        )
        return StudioProposedTimeline(proposal: proposal, timebase: timebase)!
    }

    // MARK: - Where the picture comes from

    /// THE ASSERTION THAT MATTERS. Before the insert, proposed and current agree.
    /// Inside it, the picture comes from the SOURCE ASSET at a source offset.
    /// After it, the existing timeline shifted back by the span.
    func testProposedPositionsResolveToTheRightMaterial() {
        let timeline = makeTimeline()

        XCTAssertEqual(timeline.sample(atProposedTicks: 0), .existing(ticks: 0))
        XCTAssertEqual(timeline.sample(atProposedTicks: 199), .existing(ticks: 199))

        // First frame of the insert: source tick 100, not sequence tick 200.
        XCTAssertEqual(
            timeline.sample(atProposedTicks: 200),
            .inserted(assetId: "insert-asset", ticks: 100)
        )
        XCTAssertEqual(
            timeline.sample(atProposedTicks: 220),
            .inserted(assetId: "insert-asset", ticks: 120)
        )
        // Last frame of the insert: sourceOut is EXCLUSIVE, so 239 -> 139.
        XCTAssertEqual(
            timeline.sample(atProposedTicks: 239),
            .inserted(assetId: "insert-asset", ticks: 139)
        )
        // One past it: back to the existing timeline at the insertion point.
        XCTAssertEqual(timeline.sample(atProposedTicks: 240), .existing(ticks: 200))
        XCTAssertEqual(timeline.sample(atProposedTicks: 340), .existing(ticks: 300))
    }

    /// The boundary is where an off-by-one hides: material AT the insertion point
    /// ripples right, matching the half-open convention used by the marks, the
    /// loop range and the host's own insert_range.
    func testMaterialAtTheInsertionPointRipplesRight() {
        let timeline = makeTimeline()
        XCTAssertEqual(timeline.proposedTicks(forCurrentTicks: 199), 199)
        XCTAssertEqual(timeline.proposedTicks(forCurrentTicks: 200), 240)
        XCTAssertEqual(timeline.proposedTicks(forCurrentTicks: 201), 241)
    }

    /// Round trip: current -> proposed -> current must be the identity for every
    /// position, because that material exists in both versions.
    func testCurrentToProposedRoundTripsForEveryExistingPosition() {
        let timeline = makeTimeline()
        for current: Int64 in [0, 1, 100, 199, 200, 201, 500, 1_000] {
            let proposed = timeline.proposedTicks(forCurrentTicks: current)
            XCTAssertEqual(
                timeline.currentTicks(forProposedTicks: proposed),
                current,
                "round trip failed at \(current)"
            )
        }
    }

    /// Inside the insert there IS no current-timeline equivalent. Returning a
    /// nearby frame would be a quiet lie about what the comparison shows.
    func testInsertedMaterialHasNoCurrentEquivalent() {
        let timeline = makeTimeline()
        XCTAssertNil(timeline.currentTicks(forProposedTicks: 200))
        XCTAssertNil(timeline.currentTicks(forProposedTicks: 239))
        // The boundaries either side DO map.
        XCTAssertEqual(timeline.currentTicks(forProposedTicks: 199), 199)
        XCTAssertEqual(timeline.currentTicks(forProposedTicks: 240), 200)
    }

    func testProposedDurationGrowsByTheInsertedSpan() {
        let timeline = makeTimeline()
        XCTAssertEqual(timeline.durationTicks(currentDuration: 1_000), 1_040)
        XCTAssertEqual(timeline.durationTicks(currentDuration: 0), 40)
    }

    // MARK: - Review ranges

    func testAffectedRangeIsExactlyTheInsertedMaterial() throws {
        let range = try XCTUnwrap(makeTimeline().affectedRange)
        XCTAssertEqual(range.startTicks, 200)
        XCTAssertEqual(range.endTicks, 240)
        XCTAssertEqual(range.spanTicks, 40)
    }

    /// Roll exists so a reviewer sees the CUT, not the clip: looping the insert
    /// alone shows the new material perfectly and says nothing about the join.
    func testReviewRangeAddsPreAndPostRoll() throws {
        let range = try XCTUnwrap(
            makeTimeline().reviewRange(preRollTicks: 60, postRollTicks: 30)
        )
        XCTAssertEqual(range.startTicks, 140)
        XCTAssertEqual(range.endTicks, 270)
    }

    /// An insert near the head of the sequence cannot pre-roll into negative
    /// time. Without the clamp the range is invalid and looping silently stops
    /// working — which reads as "the loop button is broken".
    func testPreRollClampsAtTheStartOfTheSequence() throws {
        let timeline = makeTimeline(at: 10)
        let range = try XCTUnwrap(timeline.reviewRange(preRollTicks: 600, postRollTicks: 0))
        XCTAssertEqual(range.startTicks, 0)
        XCTAssertGreaterThan(range.endTicks, 0)
    }

    func testPostRollClampsToTheProposedDuration() throws {
        let timeline = makeTimeline()
        let range = try XCTUnwrap(
            timeline.reviewRange(
                preRollTicks: 0,
                postRollTicks: 10_000,
                currentDurationTicks: 300
            )
        )
        // Proposed duration is 300 + 40; roll cannot run past the end.
        XCTAssertEqual(range.endTicks, 340)
    }

    func testNegativeRollIsTreatedAsZeroRatherThanShrinkingTheRange() throws {
        let range = try XCTUnwrap(
            makeTimeline().reviewRange(preRollTicks: -100, postRollTicks: -100)
        )
        XCTAssertEqual(range.startTicks, 200)
        XCTAssertEqual(range.endTicks, 240)
    }

    // MARK: - Ghost geometry

    /// In CURRENT the insert has no width — it is a point where material will
    /// arrive. Drawing a band there would claim the sequence already contains
    /// material it does not.
    func testGhostIsACaretInCurrentAndABandInProposed() {
        let timeline = makeTimeline()

        let current = timeline.ghost(in: .current)
        XCTAssertTrue(current.isInsertionPoint)
        XCTAssertEqual(current.startTicks, current.endTicks)
        XCTAssertEqual(current.startTicks, 200)

        let proposed = timeline.ghost(in: .proposed)
        XCTAssertFalse(proposed.isInsertionPoint)
        XCTAssertEqual(proposed.startTicks, 200)
        XCTAssertEqual(proposed.endTicks, 240)
        XCTAssertEqual(proposed.proposalId, "p1")
    }

    func testReviewVersionTogglesAndLabels() {
        XCTAssertEqual(StudioReviewVersion.current.toggled, .proposed)
        XCTAssertEqual(StudioReviewVersion.proposed.toggled, .current)
        XCTAssertEqual(StudioReviewVersion.current.label, "CURRENT")
        XCTAssertEqual(StudioReviewVersion.proposed.label, "PROPOSED")
    }

    // MARK: - Malformed proposals

    /// A zero-length or inverted range is not a proposal to render; it is a
    /// malformed one, and a zero-width ghost would hide that.
    func testZeroLengthAndInvertedRangesAreRefused() {
        let zero = StudioEditProposal(
            proposalId: "z",
            createdRevision: 1,
            op: StudioInsertRangeOp(
                itemId: "i",
                assetId: "a",
                sourceIn: rational(100),
                sourceOut: rational(100),
                at: rational(0)
            )
        )
        XCTAssertNil(StudioProposedTimeline(proposal: zero, timebase: timebase))

        let inverted = StudioEditProposal(
            proposalId: "v",
            createdRevision: 1,
            op: StudioInsertRangeOp(
                itemId: "i",
                assetId: "a",
                sourceIn: rational(140),
                sourceOut: rational(100),
                at: rational(0)
            )
        )
        XCTAssertNil(StudioProposedTimeline(proposal: inverted, timebase: timebase))
    }

    // MARK: - Rational time conversion

    /// The host speaks rational time; the viewer speaks ticks. NTSC is where a
    /// careless conversion lands a ghost on the wrong frame.
    func testRationalTimeConvertsIntoTheViewersTimebase() throws {
        let ntsc = StudioTimebase.ntsc2997
        // One second expressed as 30000/30000 and as 1/1 must agree.
        XCTAssertEqual(StudioRationalTime(n: 1, d: 1)!.ticks(in: ntsc), 30_000)
        XCTAssertEqual(StudioRationalTime(n: 30_000, d: 30_000)!.ticks(in: ntsc), 30_000)
        // One NTSC frame is 1001 ticks.
        XCTAssertEqual(StudioRationalTime(n: 1001, d: 30_000)!.ticks(in: ntsc), 1001)
        // Ten seconds at an awkward denominator.
        XCTAssertEqual(StudioRationalTime(n: 441_000, d: 44_100)!.ticks(in: ntsc), 300_000)
    }

    func testRationalTimeRejectsAZeroOrNegativeTimescale() {
        XCTAssertNil(StudioRationalTime(n: 1, d: 0))
        XCTAssertNil(StudioRationalTime(n: 1, d: -30))
    }
}
