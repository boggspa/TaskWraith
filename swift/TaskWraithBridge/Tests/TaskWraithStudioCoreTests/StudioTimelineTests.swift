import XCTest

@testable import TaskWraithStudioCore

/// Outcome 6's visible surface: timeline, transcript selection, ghosts,
/// snapping, trim handles, proposal-first editing.
///
/// Four properties decide whether this is real rather than plausible, and each
/// is a place a working-looking implementation would lie.
final class StudioTimelineTests: XCTestCase {
    private let timebase = StudioTimebase(timescale: 30, frameDurationTicks: 1)!
    private let viewport = StudioOverlayViewport(width: 1000, height: 600, scale: 1)
    private let duration: Int64 = 300

    private func rational(_ n: Int64) -> StudioRationalTime { StudioRationalTime(n: n, d: 30)! }

    /// Two phrases with a gap: 30..90 and 150..210.
    private func transcript() -> StudioTranscript {
        StudioTranscript(
            transcriptId: "t-1",
            assetId: "asset-1",
            segments: [
                StudioTranscriptSegment(
                    segmentId: "s-1",
                    text: "first phrase",
                    sourceIn: rational(30),
                    sourceOut: rational(90)
                ),
                StudioTranscriptSegment(
                    segmentId: "s-2",
                    text: "second",
                    sourceIn: rational(150),
                    sourceOut: rational(210)
                ),
            ]
        )
    }

    private func state(
        position: Int64 = 0,
        selected: String? = nil,
        trim: StudioTrimDrag? = nil,
        ghosts: [StudioGhostGeometry] = []
    ) -> StudioTimelineState {
        StudioTimelineState(
            viewport: viewport,
            positionTicks: position,
            durationTicks: duration,
            timebase: timebase,
            transcript: transcript(),
            selectedSegmentId: selected,
            trim: trim,
            ghosts: ghosts
        )
    }

    // MARK: - Property 1: one authority

    /// The timeline must not be a second opinion about time. Position is an
    /// INPUT; there is nowhere for a clock to live.
    ///
    /// Asserted two ways because neither alone is enough: the layout is a
    /// caseless enum with no storage, and the same input renders identically
    /// every time — a model with its own clock would advance between calls.
    func testTheTimelineHoldsNoClockOfItsOwn() {
        let first = StudioTimelineLayout.build(state(position: 120))
        let second = StudioTimelineLayout.build(state(position: 120))
        XCTAssertEqual(first, second, "identical input rendered differently — something is ticking")

        // And the playhead follows the SUPPLIED position rather than any
        // internal notion of now.
        let moved = StudioTimelineLayout.build(state(position: 240))
        XCTAssertNotEqual(first.rects.last, moved.rects.last)
    }

    func testThePlayheadTracksTheSuppliedPosition() throws {
        let model = StudioTimelineLayout.build(state(position: 150))
        let playhead = try XCTUnwrap(model.rects.last)
        let expected = model.bandFrame.x + model.bandFrame.width * 0.5
        XCTAssertEqual(playhead.frame.x, expected, accuracy: 2)
    }

    // MARK: - Property 2: proposal-first

    /// A HANDLE DRAG PRODUCES A PROPOSAL, NOT A MUTATION. The emitted method
    /// must be studio/proposeEdit; studio/applyEdit would bypass the entire
    /// ghost/approve flow that Work1's host half exists to provide.
    func testATrimDragEmitsProposeEditAndNeverApplyEdit() throws {
        var drag = StudioTrimDrag(
            segmentId: "s-1",
            assetId: "asset-1",
            handle: .end,
            originalStartTicks: 30,
            originalEndTicks: 90
        )
        drag.update(toTicks: 120, boundaries: [], toleranceTicks: 0)
        let intent = try XCTUnwrap(drag.intent)

        let line = StudioProposalRequest.proposeEdit(
            intent: intent,
            baseRevision: 7,
            proposalId: "p-1",
            itemId: "i-1",
            requestId: 100,
            timebase: timebase
        )
        let decoded = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: line) as? [String: Any]
        )
        XCTAssertEqual(decoded["method"] as? String, "studio/proposeEdit")
        XCTAssertNotEqual(
            decoded["method"] as? String,
            "studio/applyEdit",
            "a trim that applies directly bypasses the proposal flow entirely"
        )

        let params = try XCTUnwrap(decoded["params"] as? [String: Any])
        XCTAssertEqual(params["schemaVersion"] as? Int, StudioEditProposal.schemaVersion)
        // baseRevision must be the revision the operator was LOOKING at, so the
        // host can reject a stale base instead of silently rebasing.
        XCTAssertEqual(params["baseRevision"] as? Int, 7)

        let op = try XCTUnwrap(params["op"] as? [String: Any])
        XCTAssertEqual(op["type"] as? String, "insert_range")
        XCTAssertEqual(op["assetId"] as? String, "asset-1")
        XCTAssertEqual((op["sourceOut"] as? [String: Any])?["n"] as? Int64, 120)
    }

    /// And the encoded request must round-trip through the SAME decoder the
    /// companion uses for inbound proposals — if it does not, the host would
    /// reject what we send.
    func testTheEmittedOpDecodesWithTheNormativeDecoder() throws {
        var drag = StudioTrimDrag(
            segmentId: "s-1",
            assetId: "asset-1",
            handle: .start,
            originalStartTicks: 30,
            originalEndTicks: 90
        )
        drag.update(toTicks: 45, boundaries: [], toleranceTicks: 0)
        let intent = try XCTUnwrap(drag.intent)
        let line = StudioProposalRequest.proposeEdit(
            intent: intent,
            baseRevision: 1,
            proposalId: "p",
            itemId: "i",
            requestId: 100,
            timebase: timebase
        )
        let decoded = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: line) as? [String: Any]
        )
        let params = try XCTUnwrap(decoded["params"] as? [String: Any])
        let op = try XCTUnwrap(params["op"] as? [String: Any])
        let parsed = try StudioProposalDecoder.insertRange(from: op)
        XCTAssertEqual(parsed.assetId, "asset-1")
        XCTAssertEqual(parsed.sourceIn.ticks(in: timebase), 45)
        XCTAssertEqual(parsed.sourceOut.ticks(in: timebase), 90)
    }

    /// A collapsed or inverted drag is not an edit and must produce nothing.
    func testACollapsedDragProposesNothing() {
        var drag = StudioTrimDrag(
            segmentId: "s-1",
            assetId: "asset-1",
            handle: .end,
            originalStartTicks: 30,
            originalEndTicks: 90
        )
        drag.update(toTicks: 30, boundaries: [], toleranceTicks: 0)
        XCTAssertNil(drag.intent, "a zero-length range is not an edit")
        drag.update(toTicks: 10, boundaries: [], toleranceTicks: 0)
        XCTAssertNil(drag.intent, "an inverted range is not an edit")
    }

    // MARK: - Property 3: snapping reuses the existing snapper

    /// The drag must produce the SAME answer StudioTranscriptSnapper gives —
    /// not a lookalike. A second snapping implementation inside the drag
    /// handler would diverge silently, and the drag copy would win because it
    /// is the one an operator feels.
    func testTheDragSnapAgreesWithTheSnapperExactly() {
        let boundaries = transcript().boundaryTicks(in: timebase)
        XCTAssertEqual(boundaries, [30, 90, 150, 210])

        for target: Int64 in [28, 45, 88, 148, 205, 260] {
            var drag = StudioTrimDrag(
                segmentId: "s-1",
                assetId: "asset-1",
                handle: .end,
                originalStartTicks: 0,
                originalEndTicks: 300
            )
            drag.update(toTicks: target, boundaries: boundaries, toleranceTicks: 5)
            let expected = StudioTranscriptSnapper.snap(
                ticks: target,
                toBoundaries: boundaries,
                toleranceTicks: 5
            )
            XCTAssertEqual(drag.currentTicks, expected.ticks, "diverged at \(target)")
            XCTAssertEqual(drag.didSnap, expected.didSnap, "snap flag diverged at \(target)")
        }
    }

    /// And it inherits the tolerance bound: a drag far from any boundary must
    /// stay exactly where the operator put it, or precise trims are impossible.
    func testADragOutsideToleranceIsNotMoved() {
        var drag = StudioTrimDrag(
            segmentId: "s-1",
            assetId: "asset-1",
            handle: .end,
            originalStartTicks: 0,
            originalEndTicks: 300
        )
        drag.update(
            toTicks: 120,
            boundaries: transcript().boundaryTicks(in: timebase),
            toleranceTicks: 5
        )
        XCTAssertEqual(drag.currentTicks, 120, "a mid-phrase trim must stay put")
        XCTAssertFalse(drag.didSnap)
    }

    // MARK: - Property 4: hit targets exceed their visuals

    func testHandleGrabAreasAreLargerThanTheDrawnHandles() throws {
        let model = StudioTimelineLayout.build(state(selected: "s-1"))
        XCTAssertEqual(model.handleHits.count, 2, "a selected segment has two handles")
        let drawn = StudioTimelineMetrics.handleWidth
        for hit in model.handleHits {
            XCTAssertGreaterThan(
                hit.frame.width,
                drawn * 3,
                "a \(drawn)pt handle needs a far larger grab target"
            )
        }
    }

    /// The handle sits ON the segment edge, so its grab box overlaps the
    /// segment body. Hit testing must prefer the handle: a drag is the more
    /// specific intent and selection is always reachable elsewhere.
    func testAHandleWinsOverTheSegmentBodyItOverlaps() throws {
        let model = StudioTimelineLayout.build(state(selected: "s-1"))
        let handle = try XCTUnwrap(model.handleHits.first)
        let point = (x: handle.frame.x + handle.frame.width / 2, y: handle.frame.y + 2)
        let hit = try XCTUnwrap(StudioTimelineLayout.hit(atX: point.x, y: point.y, in: model))
        XCTAssertEqual(hit.handle, .start, "the segment body swallowed the handle")
    }

    // MARK: - Selection and drawing

    func testSegmentsAreDrawnAndSelectable() throws {
        let model = StudioTimelineLayout.build(state())
        XCTAssertEqual(model.segmentHits.map(\.segmentId), ["s-1", "s-2"])

        let body = try XCTUnwrap(model.segmentHits.first)
        let hit = try XCTUnwrap(
            StudioTimelineLayout.hit(
                atX: body.frame.x + body.frame.width / 2,
                y: body.frame.y + 2,
                in: model
            )
        )
        XCTAssertEqual(hit.segmentId, "s-1")
        XCTAssertNil(hit.handle, "the body is not a handle")
    }

    /// Handles appear only on the SELECTED segment: a grab target on every
    /// segment would make the band a minefield of accidental trims.
    func testUnselectedSegmentsHaveNoHandles() {
        XCTAssertTrue(StudioTimelineLayout.build(state()).handleHits.isEmpty)
        XCTAssertEqual(StudioTimelineLayout.build(state(selected: "s-2")).handleHits.count, 2)
    }

    func testTheTranscriptTextIsActuallyDrawn() throws {
        let model = StudioTimelineLayout.build(state())
        let labels = model.texts.map(\.string)
        XCTAssertFalse(labels.isEmpty, "the transcript reached no renderer")
        XCTAssertTrue(labels.contains { "first phrase".hasPrefix($0) })
    }

    /// A narrow segment must clip rather than overflow into its neighbour.
    func testSegmentTextIsClippedToTheSegmentWidth() {
        var narrow = state()
        narrow.viewport = StudioOverlayViewport(width: 260, height: 600, scale: 1)
        let model = StudioTimelineLayout.build(narrow)
        for text in model.texts {
            let width = StudioOverlayRenderMetrics.width(
                of: text.string,
                pointSize: text.pointSize
            )
            let segment = model.segmentHits.first { $0.frame.x <= text.x + 1 }
            if let segment {
                XCTAssertLessThanOrEqual(
                    width,
                    segment.frame.width + 2,
                    "\"\(text.string)\" overflows its segment"
                )
            }
        }
    }

    func testGhostsAppearOnTheBandToo() throws {
        let model = StudioTimelineLayout.build(
            state(
                ghosts: [
                    StudioGhostGeometry(
                        proposalId: "p-1",
                        startTicks: 60,
                        endTicks: 120,
                        isInsertionPoint: false
                    )
                ]
            )
        )
        XCTAssertNotNil(model.rects.first { $0.color == StudioOverlayColor.ghost })
    }

    // MARK: - Degenerate cases

    func testATinyViewportDrawsNoBand() {
        var tiny = state()
        tiny.viewport = StudioOverlayViewport(width: 40, height: 30, scale: 1)
        let model = StudioTimelineLayout.build(tiny)
        XCTAssertFalse(model.isVisible)
        XCTAssertTrue(model.rects.isEmpty)
        XCTAssertNil(StudioTimelineLayout.hit(atX: 20, y: 20, in: model))
    }

    /// Zero duration is the state the viewer launches in. It must not divide by
    /// it — the same trap that would have crashed the scrub bar.
    func testZeroDurationIsSurvivable() {
        var empty = state()
        empty.durationTicks = 0
        let model = StudioTimelineLayout.build(empty)
        for rect in model.rects {
            XCTAssertTrue(rect.frame.x.isFinite)
            XCTAssertTrue(rect.frame.width.isFinite)
        }
        XCTAssertEqual(StudioTimelineLayout.ticks(atX: 500, in: model, durationTicks: 0), 0)
    }

    func testNoTranscriptDrawsAnEmptyBandRatherThanNothing() {
        var none = state()
        none.transcript = nil
        let model = StudioTimelineLayout.build(none)
        XCTAssertTrue(model.isVisible, "the band still shows the playhead")
        XCTAssertTrue(model.segmentHits.isEmpty)
    }
}

// MARK: - The band reaches the renderer

/// These cover the hop the probe found missing: a transcript that is hydrated,
/// parsed, validated and snapped, but drawn by nobody.
final class StudioTimelineOverlayReachTests: XCTestCase {
    private static let timebase = StudioTimebase(timescale: 600, frameDurationTicks: 20)!
    private static func time(_ n: Int64) -> StudioRationalTime {
        // Force-unwrapped deliberately: a literal denominator of 600 is valid by
        // construction, and a nil here is a broken test, not a runtime case.
        StudioRationalTime(n: n, d: 600)!
    }

    private func transcript() -> StudioTranscript {
        StudioTranscript(
            transcriptId: "t1",
            assetId: "a1",
            segments: [
                StudioTranscriptSegment(
                    segmentId: "s1",
                    text: "the band is drawn",
                    sourceIn: Self.time(0),
                    sourceOut: Self.time(600)
                ),
                StudioTranscriptSegment(
                    segmentId: "s2",
                    text: "by the overlay",
                    sourceIn: Self.time(1200),
                    sourceOut: Self.time(1800)
                ),
            ]
        )
    }

    private func state(withTimeline: Bool) -> StudioOverlayState {
        let viewport = StudioOverlayViewport(width: 1280, height: 720, scale: 2)
        var state = StudioOverlayState(
            viewport: viewport,
            positionTicks: 1000,
            durationTicks: 6000,
            timecodeText: "00:00:01:16",
            sourceLabel: "a1"
        )
        if withTimeline {
            state.timeline = StudioTimelineState(
                viewport: viewport,
                positionTicks: 1000,
                durationTicks: 6000,
                timebase: Self.timebase,
                transcript: transcript(),
                selectedSegmentId: "s1"
            )
        }
        return state
    }

    func testTheTranscriptReachesTheOverlayDrawList() {
        let withBand = StudioOverlayLayout.build(state(withTimeline: true))
        let withoutBand = StudioOverlayLayout.build(state(withTimeline: false))

        XCTAssertTrue(withBand.isVisible)
        XCTAssertTrue(withoutBand.isVisible)
        XCTAssertGreaterThan(
            withBand.rects.count, withoutBand.rects.count,
            "a transcript must add geometry to the drawn overlay, not just to a model nobody reads"
        )
        XCTAssertTrue(
            withBand.texts.contains { $0.string.hasPrefix("the band") },
            "the words themselves must reach the text list"
        )
        XCTAssertEqual(withBand.timeline.segmentHits.count, 2)
    }

    /// nil transcript and empty transcript are DIFFERENT statements, and the
    /// overlay must not blur them into one.
    func testNoTranscriptDrawsNoBandAtAll() {
        let model = StudioOverlayLayout.build(state(withTimeline: false))
        XCTAssertFalse(model.timeline.isVisible)
        XCTAssertTrue(model.timeline.rects.isEmpty)
        XCTAssertTrue(model.timeline.segmentHits.isEmpty)
    }

    /// One clock, two views of it. If the band ever computed its own mapping,
    /// a segment boundary would drift away from the scrub position for the very
    /// same tick.
    func testTheBandAndTheScrubBarPlaceTheSameTickAtTheSameX() {
        let model = StudioOverlayLayout.build(state(withTimeline: true))
        let band = model.timeline
        guard let first = band.segmentHits.first(where: { $0.segmentId == "s2" }) else {
            return XCTFail("missing segment")
        }
        // s2 starts at 1200/600s == tick 1200 of 6000.
        let fraction = StudioOverlayLayout.playheadFraction(
            positionTicks: 1200, durationTicks: 6000)
        let expected = band.bandFrame.x + band.bandFrame.width * fraction
        XCTAssertEqual(first.frame.x, expected, accuracy: 0.001)

        // And the scrub track spans the same horizontal extent, so "same
        // fraction" really is "same screen column".
        XCTAssertEqual(band.bandFrame.x, model.trackFrame.x, accuracy: 0.001)
        XCTAssertEqual(band.bandFrame.width, model.trackFrame.width, accuracy: 0.001)
    }

    func testSegmentsArePublishedToAssistiveTechnology() {
        let model = StudioOverlayLayout.build(state(withTimeline: true))
        let segments = model.accessibilityElements.filter { $0.role == .button }
        XCTAssertEqual(segments.count, 2)
        XCTAssertEqual(segments.first?.label, "the band is drawn")
        XCTAssertEqual(segments.first?.value, "Selected")
        XCTAssertEqual(segments.last?.value, "Not selected")
    }

    /// Selection changes the spoken VALUE but must not change control identity,
    /// or arrowing through the band reallocates an element per keystroke.
    func testSelectingASegmentDoesNotChurnAccessibilityIdentity() {
        var selected = state(withTimeline: true)
        var other = state(withTimeline: true)
        other.timeline?.selectedSegmentId = "s2"

        let a = StudioOverlayLayout.build(selected).accessibilityElements
            .filter { $0.role == .button }
        let b = StudioOverlayLayout.build(other).accessibilityElements
            .filter { $0.role == .button }
        XCTAssertEqual(a.count, b.count)
        for (lhs, rhs) in zip(a, b) {
            XCTAssertTrue(
                lhs.matchesStructure(of: rhs),
                "selection must be a value change, not a new control")
        }
        XCTAssertNotEqual(a.map(\.value), b.map(\.value), "the spoken value must still move")
        selected.timeline?.selectedSegmentId = nil
    }
}

/// A malformed transcript must be REPORTED, not silently dropped: silence is
/// indistinguishable from acceptance.
final class StudioTranscriptRejectionTests: XCTestCase {
    private func message(_ json: String) -> StudioMessage? {
        StudioNdjsonDecoder().push(chunk: Data((json + "\n").utf8)).compactMap {
            if case .message(let m) = $0 { return m }
            return nil
        }.first
    }

    private let valid = """
        {"jsonrpc":"2.0","method":"studio/editCommitted","params":{"revision":3,"op":\
        {"type":"set_transcript","transcript":{"schemaVersion":1,"transcriptId":"t1",\
        "assetId":"a1","segments":[{"segmentId":"s1","text":"hi",\
        "sourceIn":{"n":0,"d":600},"sourceOut":{"n":600,"d":600}}]}}}}
        """

    private let zeroDenominator = """
        {"jsonrpc":"2.0","method":"studio/editCommitted","params":{"revision":4,"op":\
        {"type":"set_transcript","transcript":{"schemaVersion":1,"transcriptId":"t2",\
        "assetId":"a1","segments":[{"segmentId":"s1","text":"hi",\
        "sourceIn":{"n":0,"d":0},"sourceOut":{"n":600,"d":600}}]}}}}
        """

    func testAValidTranscriptDecodes() throws {
        let m = try XCTUnwrap(message(valid))
        guard case .decoded(let t) = StudioCompanionSession.transcriptOutcome(in: m) else {
            return XCTFail("expected a decode")
        }
        XCTAssertEqual(t.transcriptId, "t1")
    }

    func testAMalformedTranscriptIsRejectedWithAReason() throws {
        let m = try XCTUnwrap(message(zeroDenominator))
        guard case .rejected(let reason) = StudioCompanionSession.transcriptOutcome(in: m) else {
            return XCTFail("a zero denominator must be rejected, not accepted or ignored")
        }
        XCTAssertTrue(
            reason.contains("sourceIn"),
            "the reason must name the offending field, got: \(reason)")
    }

    /// The discriminator is the OP TYPE, not the presence of a transcript field:
    /// open_media and propose_edit must pass through untouched.
    func testOtherOperationsAreNotTranscriptRejections() throws {
        let openMedia = """
            {"jsonrpc":"2.0","method":"studio/editCommitted","params":{"revision":2,"op":\
            {"type":"open_media","asset":{"assetId":"a1","path":"/tmp/a.mov",\
            "mediaKind":"video"}}}}
            """
        let m = try XCTUnwrap(message(openMedia))
        guard case .notATranscript = StudioCompanionSession.transcriptOutcome(in: m) else {
            return XCTFail("open_media must pass through, not register as a transcript failure")
        }
    }

    /// The whole point: a rejection reaches the session's error channel, which
    /// the pump writes to stderr.
    func testTheRejectionReachesTheProtocolErrorChannel() {
        let session = StudioCompanionSession(hydrateOnce: false)
        _ = session.startLines()
        _ = session.consume(chunk: Data("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":1}}\n".utf8))
        _ = session.consume(chunk: Data("{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"revision\":1}}\n".utf8))

        let good = session.consume(chunk: Data((valid + "\n").utf8))
        XCTAssertEqual(good.transcripts.count, 1)
        XCTAssertTrue(good.protocolErrors.isEmpty, "a valid transcript must not report an error")

        let bad = session.consume(chunk: Data((zeroDenominator + "\n").utf8))
        XCTAssertTrue(bad.transcripts.isEmpty)
        XCTAssertEqual(bad.protocolErrors.count, 1)
        XCTAssertTrue(bad.protocolErrors[0].hasPrefix("set_transcript rejected:"))
    }
}

/// The decisions the mouse handler delegates to Core.
final class StudioTimelineGestureTests: XCTestCase {
    private static let timebase = StudioTimebase(timescale: 600, frameDurationTicks: 20)!
    private static func time(_ n: Int64) -> StudioRationalTime {
        StudioRationalTime(n: n, d: 600)!
    }

    private let transcript = StudioTranscript(
        transcriptId: "t1",
        assetId: "a1",
        segments: [
            StudioTranscriptSegment(
                segmentId: "s1", text: "one",
                sourceIn: time(0), sourceOut: time(600)),
            StudioTranscriptSegment(
                segmentId: "s2", text: "two",
                sourceIn: time(900), sourceOut: time(1500)),
            StudioTranscriptSegment(
                segmentId: "s3", text: "three",
                sourceIn: time(1800), sourceOut: time(2400)),
        ]
    )

    /// A handle already sits on its own boundary. Including it would pin the
    /// handle and read as a dead control.
    func testAHandleDoesNotSnapToItsOwnSegmentsEdges() {
        let boundaries = StudioTimelineLayout.snapBoundaries(
            transcript: transcript, excluding: "s2", timebase: Self.timebase)
        XCTAssertEqual(boundaries.sorted(), [0, 600, 1800, 2400])
        XCTAssertFalse(boundaries.contains(900), "own start must not be a target")
        XCTAssertFalse(boundaries.contains(1500), "own end must not be a target")
    }

    func testNoTranscriptOffersNoSnapTargets() {
        XCTAssertTrue(
            StudioTimelineLayout.snapBoundaries(
                transcript: nil, excluding: "s1", timebase: Self.timebase
            ).isEmpty)
    }

    /// Half a frame, and never zero — a zero tolerance would make every
    /// comparison an exact-equality test and snapping would never fire.
    func testToleranceIsHalfAFrameAndNeverZero() {
        XCTAssertEqual(StudioTimelineLayout.snapToleranceTicks(timebase: Self.timebase), 10)
        let fine = StudioTimebase(timescale: 600, frameDurationTicks: 1)!
        XCTAssertEqual(StudioTimelineLayout.snapToleranceTicks(timebase: fine), 1)
    }

    /// The full gesture, in the order the mouse handler performs it.
    func testADragEndingNearANeighbourSnapsAndProposesThatExactTick() throws {
        var drag = StudioTrimDrag(
            segmentId: "s2", assetId: "a1", handle: .end,
            originalStartTicks: 900, originalEndTicks: 1500)
        let boundaries = StudioTimelineLayout.snapBoundaries(
            transcript: transcript, excluding: "s2", timebase: Self.timebase)

        // Released 4 ticks short of s3's start, inside the 10-tick tolerance.
        drag.update(toTicks: 1796, boundaries: boundaries,
                    toleranceTicks: StudioTimelineLayout.snapToleranceTicks(
                        timebase: Self.timebase))
        XCTAssertTrue(drag.didSnap)
        XCTAssertEqual(drag.currentTicks, 1800)

        let intent = try XCTUnwrap(drag.intent)
        XCTAssertTrue(intent.snapped)
        XCTAssertEqual(intent.sourceOutTicks, 1800)

        let line = StudioProposalRequest.proposeEdit(
            intent: intent, baseRevision: 7, proposalId: "p1", itemId: "s2",
            requestId: 100, timebase: Self.timebase)
        let json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: line) as? [String: Any])
        XCTAssertEqual(json["method"] as? String, "studio/proposeEdit")
        let params = try XCTUnwrap(json["params"] as? [String: Any])
        XCTAssertEqual(params["baseRevision"] as? Int, 7)
        let op = try XCTUnwrap(params["op"] as? [String: Any])
        let sourceOut = try XCTUnwrap(op["sourceOut"] as? [String: Any])
        XCTAssertEqual(sourceOut["n"] as? Int64 ?? Int64(sourceOut["n"] as? Int ?? -1), 1800)
    }

    /// Released just outside tolerance: the handle stays where the operator put
    /// it. Snapping that ignored tolerance would take the frame away from them.
    func testADragEndingOutsideToleranceKeepsTheOperatorsExactTick() {
        var drag = StudioTrimDrag(
            segmentId: "s2", assetId: "a1", handle: .end,
            originalStartTicks: 900, originalEndTicks: 1500)
        drag.update(
            toTicks: 1789,
            boundaries: StudioTimelineLayout.snapBoundaries(
                transcript: transcript, excluding: "s2", timebase: Self.timebase),
            toleranceTicks: StudioTimelineLayout.snapToleranceTicks(timebase: Self.timebase))
        XCTAssertFalse(drag.didSnap)
        XCTAssertEqual(drag.currentTicks, 1789)
    }

    /// A collapsed or inverted drag proposes NOTHING. The handler reports it
    /// rather than emitting an unrepresentable range.
    func testAnInvertedDragYieldsNoIntent() {
        var drag = StudioTrimDrag(
            segmentId: "s2", assetId: "a1", handle: .end,
            originalStartTicks: 900, originalEndTicks: 1500)
        drag.update(toTicks: 400, boundaries: [], toleranceTicks: 10)
        XCTAssertNil(drag.intent, "an end before the start must not become a proposal")
        drag.update(toTicks: 900, boundaries: [], toleranceTicks: 10)
        XCTAssertNil(drag.intent, "a zero-length segment must not become a proposal")
    }
}

/// Keyboard selection order. Without a keyboard path the band's accessibility
/// descriptors are focusable by nothing, which makes them a claim, not a
/// control.
final class StudioTimelineKeyboardTests: XCTestCase {
    private static func time(_ n: Int64) -> StudioRationalTime {
        StudioRationalTime(n: n, d: 600)!
    }

    private let transcript = StudioTranscript(
        transcriptId: "t1",
        assetId: "a1",
        segments: [
            StudioTranscriptSegment(
                segmentId: "s1", text: "one", sourceIn: time(0), sourceOut: time(600)),
            StudioTranscriptSegment(
                segmentId: "s2", text: "two", sourceIn: time(900), sourceOut: time(1500)),
            StudioTranscriptSegment(
                segmentId: "s3", text: "three", sourceIn: time(1800), sourceOut: time(2400)),
        ]
    )

    private func step(_ from: String?, _ forward: Bool) -> String? {
        StudioTimelineLayout.segmentId(steppingFrom: from, forward: forward, in: transcript)
    }

    /// Tab and Shift-Tab enter the band from opposite ends.
    func testEnteringTheBandPicksTheEndTheOperatorIsHeadingFor() {
        XCTAssertEqual(step(nil, true), "s1")
        XCTAssertEqual(step(nil, false), "s3")
    }

    func testTabWalksInTimelineOrder() {
        XCTAssertEqual(step("s1", true), "s2")
        XCTAssertEqual(step("s2", true), "s3")
        XCTAssertEqual(step("s3", false), "s2")
    }

    /// Deliberately no wrap: silently returning to the first segment hides that
    /// you reached the end, and this band has no scrollbar to show position.
    func testSelectionStopsAtTheEndsRatherThanWrapping() {
        XCTAssertEqual(step("s3", true), "s3", "past the last segment must hold, not wrap to s1")
        XCTAssertEqual(step("s1", false), "s1", "before the first must hold, not wrap to s3")
    }

    func testAnUnknownOrAbsentSelectionFallsBackToAnEnd() {
        XCTAssertEqual(step("gone", true), "s1", "a stale id must not strand the keyboard")
        XCTAssertNil(
            StudioTimelineLayout.segmentId(steppingFrom: nil, forward: true, in: nil))
        let empty = StudioTranscript(transcriptId: "t0", assetId: "a1", segments: [])
        XCTAssertNil(
            StudioTimelineLayout.segmentId(steppingFrom: nil, forward: true, in: empty))
    }

    /// A keyboard nudge asks for an EXACT frame, so it must not snap: snapping
    /// would discard the precision the operator chose the keyboard for.
    func testAKeyboardNudgeLandsOnTheExactFrameAndDoesNotSnap() throws {
        var drag = StudioTrimDrag(
            segmentId: "s2", assetId: "a1", handle: .end,
            originalStartTicks: 900, originalEndTicks: 1500)
        // One frame at 600/20 == 20 ticks, repeated toward s3's start at 1800.
        for _ in 0..<15 {
            drag.update(toTicks: drag.currentTicks + 20, boundaries: [], toleranceTicks: 0)
        }
        XCTAssertFalse(drag.didSnap)
        XCTAssertEqual(drag.currentTicks, 1800)
        XCTAssertEqual(try XCTUnwrap(drag.intent).sourceOutTicks, 1800)
    }
}
