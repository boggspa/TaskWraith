import XCTest

@testable import TaskWraithStudioCore

/// The overlay's arithmetic, asserted without a GPU.
///
/// StudioViewerWindow has no test target, so every decision the transport
/// surface makes — where the playhead sits, which span the marks describe, where
/// a click lands — lives in StudioOverlayLayout and is asserted here.
final class StudioOverlayModelTests: XCTestCase {
    /// 960x540 at 2x, which is the viewer's actual default window size.
    private let viewport = StudioOverlayViewport(width: 1920, height: 1080, scale: 2)
    /// Ten seconds at 30fps in a 30-tick-per-second timebase.
    private let duration: Int64 = 300

    private func state(
        position: Int64 = 0,
        inPoint: Int64? = nil,
        outPoint: Int64? = nil,
        looping: Bool = false,
        playing: Bool = true,
        entry: StudioTimecodeFieldSnapshot? = nil,
        durationTicks: Int64? = nil
    ) -> StudioOverlayState {
        StudioOverlayState(
            viewport: viewport,
            positionTicks: position,
            durationTicks: durationTicks ?? duration,
            isPlaying: playing,
            inPointTicks: inPoint,
            outPointTicks: outPoint,
            isLoopingRange: looping,
            timecodeText: "00:00:02:00",
            sourceLabel: "clip.mov",
            entry: entry
        )
    }

    // MARK: - The zero-duration trap

    /// THE CASE THAT CRASHES. The viewer's default clock is built with
    /// `durationTicks: 0` because the synthetic pattern is unbounded, so this
    /// runs on every launch before media opens. An unguarded `position /
    /// duration` yields NaN, and NaN reaching `Int64(...)` in the hit test is
    /// not a wrong answer — Swift TRAPS, and the viewer dies the first time
    /// anyone clicks the scrub bar with no media loaded.
    func testZeroDurationProducesAFiniteFractionRatherThanNaN() {
        let fraction = StudioOverlayLayout.playheadFraction(positionTicks: 42, durationTicks: 0)
        XCTAssertTrue(fraction.isFinite, "zero duration must not produce NaN")
        XCTAssertEqual(fraction, 0)
    }

    func testHitTestingWithNoMediaLoadedIsSurvivable() {
        let model = StudioOverlayLayout.build(state(durationTicks: 0))
        // Would trap on Int64(Double.nan) without the guard.
        let ticks = StudioOverlayLayout.ticks(atX: 900, in: model, durationTicks: 0)
        XCTAssertEqual(ticks, 0)
    }

    func testEveryEmittedRectIsFiniteWithNoMediaLoaded() {
        let model = StudioOverlayLayout.build(state(position: 1234, durationTicks: 0))
        XCTAssertTrue(model.isVisible)
        for rect in model.rects {
            XCTAssertTrue(rect.frame.x.isFinite, "non-finite x reaches the vertex buffer")
            XCTAssertTrue(rect.frame.width.isFinite)
            XCTAssertTrue(rect.frame.y.isFinite)
            XCTAssertTrue(rect.frame.height.isFinite)
        }
    }

    // MARK: - Playhead

    func testPlayheadFractionIsProportionalAndClamped() {
        XCTAssertEqual(
            StudioOverlayLayout.playheadFraction(positionTicks: 150, durationTicks: 300),
            0.5
        )
        XCTAssertEqual(
            StudioOverlayLayout.playheadFraction(positionTicks: -10, durationTicks: 300),
            0
        )
        XCTAssertEqual(
            StudioOverlayLayout.playheadFraction(positionTicks: 900, durationTicks: 300),
            1
        )
    }

    func testPlayheadSitsAtTheMiddleOfTheTrackAtTheMiddleOfTheAsset() throws {
        let model = StudioOverlayLayout.build(state(position: 150))
        let playhead = try XCTUnwrap(model.rects.last)
        let expected = model.trackFrame.x + model.trackFrame.width / 2
        XCTAssertEqual(playhead.frame.x + playhead.frame.width / 2, expected, accuracy: 1.0)
    }

    /// A playhead at the very end must stay inside the track rather than
    /// hanging half its width off the right edge.
    func testPlayheadAtTheEndStaysInsideTheTrack() throws {
        let model = StudioOverlayLayout.build(state(position: duration))
        let playhead = try XCTUnwrap(model.rects.last)
        XCTAssertLessThanOrEqual(playhead.frame.maxX, model.trackFrame.maxX + 0.001)
        XCTAssertGreaterThanOrEqual(playhead.frame.x, model.trackFrame.x - 0.001)
    }

    // MARK: - Hit testing

    /// The property that makes scrubbing trustworthy: clicking where the
    /// playhead is drawn seeks to where the playhead already was.
    func testHitTestRoundTripsWithThePlayheadPosition() {
        let model = StudioOverlayLayout.build(state(position: 0))
        for position: Int64 in [0, 1, 75, 150, 299, 300] {
            let fraction = StudioOverlayLayout.playheadFraction(
                positionTicks: position,
                durationTicks: duration
            )
            let x = model.trackFrame.x + model.trackFrame.width * fraction
            let recovered = StudioOverlayLayout.ticks(
                atX: x,
                in: model,
                durationTicks: duration
            )
            XCTAssertEqual(recovered, position, "round trip failed at \(position)")
        }
    }

    func testHitTestClampsBeyondBothEndsOfTheTrack() {
        let model = StudioOverlayLayout.build(state())
        XCTAssertEqual(
            StudioOverlayLayout.ticks(atX: -5000, in: model, durationTicks: duration),
            0
        )
        XCTAssertEqual(
            StudioOverlayLayout.ticks(atX: 99999, in: model, durationTicks: duration),
            duration
        )
    }

    func testHitTestRejectsNonFiniteInput() {
        let model = StudioOverlayLayout.build(state())
        XCTAssertEqual(
            StudioOverlayLayout.ticks(atX: .nan, in: model, durationTicks: duration),
            0
        )
    }

    /// The grab area has to be a real pointer target: a 5pt track is not one.
    func testGrabAreaIsTallerThanTheDrawnTrack() {
        let model = StudioOverlayLayout.build(state())
        XCTAssertGreaterThan(model.grabFrame.height, model.trackFrame.height * 3)
        XCTAssertEqual(model.grabFrame.x, model.trackFrame.x)
        XCTAssertEqual(model.grabFrame.width, model.trackFrame.width)
    }

    // MARK: - Marks

    func testMarkedSpanIsDrawnBetweenTheMarks() throws {
        let model = StudioOverlayLayout.build(state(position: 0, inPoint: 60, outPoint: 240))
        let span = try XCTUnwrap(
            model.rects.first { $0.color == StudioOverlayColor.markedSpan }
        )
        let expectedStart = model.trackFrame.x + model.trackFrame.width * 0.2
        let expectedEnd = model.trackFrame.x + model.trackFrame.width * 0.8
        XCTAssertEqual(span.frame.x, expectedStart, accuracy: 1.0)
        XCTAssertEqual(span.frame.maxX, expectedEnd, accuracy: 1.0)
    }

    /// An inverted pair is not a range; the transport already refuses to build
    /// one, and the overlay must not draw one either.
    func testInvertedMarksDrawNoSpan() {
        let model = StudioOverlayLayout.build(state(inPoint: 240, outPoint: 60))
        XCTAssertNil(model.rects.first { $0.color == StudioOverlayColor.markedSpan })
    }

    /// Out is EXCLUSIVE, so a mark at the very end must still be visible rather
    /// than drawn one pixel past the track.
    func testOutMarkAtTheEndStaysInsideTheTrack() throws {
        let model = StudioOverlayLayout.build(state(inPoint: 0, outPoint: duration))
        let marks = model.rects.filter { $0.color == StudioOverlayColor.mark }
        XCTAssertEqual(marks.count, 2)
        for mark in marks {
            XCTAssertLessThanOrEqual(mark.frame.maxX, model.trackFrame.maxX + 0.001)
        }
    }

    // MARK: - Readout

    func testTimecodeEntryReplacesTheRunningReadout() throws {
        let running = StudioOverlayLayout.build(state())
        XCTAssertEqual(running.texts.first?.string, "00:00:02:00")

        let typing = StudioOverlayLayout.build(
            state(entry: StudioTimecodeFieldSnapshot(displayText: "--:--:_4:12", digits: "412"))
        )
        // A field that keeps showing the running position while you type into
        // it is the fastest way to seek somewhere you did not mean to.
        XCTAssertEqual(typing.texts.first?.string, "--:--:_4:12")
        XCTAssertEqual(typing.texts.first?.color, StudioOverlayColor.activeText)
    }

    func testStatusReportsTransportState() {
        let playing = StudioOverlayLayout.build(state(playing: true))
        XCTAssertTrue(playing.texts.contains { $0.string.hasPrefix("PLAY") })

        let looping = StudioOverlayLayout.build(
            state(inPoint: 30, outPoint: 90, looping: true, playing: false)
        )
        let status = looping.texts.first { $0.string.contains("PAUSE") }
        XCTAssertNotNil(status)
        XCTAssertTrue(status?.string.contains("LOOP") ?? false)
    }

    func testAMessageOutranksTheSourceLabel() {
        var failing = state()
        failing.message = "not a timecode"
        let model = StudioOverlayLayout.build(failing)
        XCTAssertTrue(model.texts.contains { $0.string == "not a timecode" })
        XCTAssertFalse(model.texts.contains { $0.string == "clip.mov" })
    }

    /// Right-aligned text is positioned from a PREDICTED width. If the model's
    /// prediction and the atlas's drawn advance disagree, the line overhangs the
    /// window — so this asserts they agree by construction.
    func testRightAlignedTextStaysInsideTheViewport() {
        var wide = state(inPoint: 30, outPoint: 90, looping: true)
        wide.diagnostics = StudioOverlayDiagnostics(
            presentedFrameCount: 123_456,
            droppedFrameCount: 7,
            retainedFrameCount: 3,
            hardwareDecodeLabel: "hardware"
        )
        let model = StudioOverlayLayout.build(wide)
        for text in model.texts {
            let width = StudioOverlayRenderMetrics.width(
                of: text.string,
                pointSize: text.pointSize
            )
            XCTAssertLessThanOrEqual(
                text.x + width,
                viewport.width + 0.001,
                "\(text.string) overhangs the viewport"
            )
        }
    }

    // MARK: - Ghost proposals

    private func ghostState(
        band: Bool = true,
        version: StudioReviewVersion = .proposed
    ) -> StudioOverlayState {
        var value = state()
        value.reviewVersion = version
        value.ghosts = [
            StudioGhostGeometry(
                proposalId: "p-1",
                startTicks: 60,
                endTicks: band ? 240 : 60,
                isInsertionPoint: !band
            )
        ]
        return value
    }

    func testAGhostBandIsDrawnAcrossTheProposedRange() throws {
        let model = StudioOverlayLayout.build(ghostState())
        let ghost = try XCTUnwrap(model.rects.first { $0.color == StudioOverlayColor.ghost })
        XCTAssertEqual(ghost.frame.x, model.trackFrame.x + model.trackFrame.width * 0.2, accuracy: 1)
        XCTAssertEqual(
            ghost.frame.maxX,
            model.trackFrame.x + model.trackFrame.width * 0.8,
            accuracy: 1
        )
    }

    /// In the CURRENT version the insert has no duration, so it must draw as a
    /// caret. A band would claim the sequence already contains material the host
    /// has not accepted.
    func testAnInsertionPointDrawsAsACaretNotABand() {
        let model = StudioOverlayLayout.build(ghostState(band: false, version: .current))
        XCTAssertNil(model.rects.first { $0.color == StudioOverlayColor.ghost })
        XCTAssertNotNil(model.rects.first { $0.color == StudioOverlayColor.ghostEdge })
    }

    /// A ghost is a SUGGESTION. It must sit underneath the playhead and the
    /// operator's own marks, never over them — draw order is the whole of that
    /// claim, so it is asserted rather than assumed.
    func testGhostsDrawUnderneathThePlayheadAndMarks() throws {
        var value = ghostState()
        value.inPointTicks = 30
        value.outPointTicks = 270
        let model = StudioOverlayLayout.build(value)

        let ghostIndex = try XCTUnwrap(
            model.rects.firstIndex { $0.color == StudioOverlayColor.ghost }
        )
        let playheadIndex = try XCTUnwrap(
            model.rects.lastIndex { $0.color == StudioOverlayColor.playhead }
        )
        let markIndex = try XCTUnwrap(
            model.rects.firstIndex { $0.color == StudioOverlayColor.mark }
        )
        XCTAssertLessThan(ghostIndex, playheadIndex, "ghost drew over the playhead")
        XCTAssertLessThan(ghostIndex, markIndex, "ghost drew over an In/Out mark")
    }

    func testTheReviewVersionLeadsTheStatusLine() {
        let proposed = StudioOverlayLayout.build(ghostState(version: .proposed))
        XCTAssertTrue(proposed.texts.contains { $0.string.hasPrefix("PROPOSED") })

        let current = StudioOverlayLayout.build(ghostState(version: .current))
        XCTAssertTrue(current.texts.contains { $0.string.hasPrefix("CURRENT") })

        // No proposal open: no version label at all. Nil and .current are
        // different claims and the HUD must not conflate them.
        let plain = StudioOverlayLayout.build(state())
        XCTAssertFalse(plain.texts.contains { $0.string.contains("CURRENT") })
    }

    func testAGhostIsDescribedForAssistiveTechnology() throws {
        let model = StudioOverlayLayout.build(ghostState())
        let descriptor = try XCTUnwrap(
            model.accessibilityElements.first { $0.label == "Proposed edit" }
        )
        XCTAssertEqual(descriptor.value, "p-1")
        XCTAssertGreaterThan(descriptor.frame.width, 0)
    }

    func testNoGhostsMeansNoGhostGeometry() {
        let model = StudioOverlayLayout.build(state())
        XCTAssertNil(model.rects.first { $0.color == StudioOverlayColor.ghost })
        XCTAssertNil(model.accessibilityElements.first { $0.label == "Proposed edit" })
    }

    // MARK: - Degenerate viewports

    func testAViewportTooSmallForTheHudDrawsNothing() {
        var tiny = state()
        tiny.viewport = StudioOverlayViewport(width: 40, height: 30, scale: 2)
        let model = StudioOverlayLayout.build(tiny)
        XCTAssertFalse(model.isVisible)
        XCTAssertTrue(model.isEmpty)
        // And hit testing a hidden overlay must not seek anywhere.
        XCTAssertEqual(
            StudioOverlayLayout.ticks(atX: 20, in: model, durationTicks: duration),
            0
        )
    }

    func testZeroSizedViewportIsHandled() {
        var empty = state()
        empty.viewport = StudioOverlayViewport(width: 0, height: 0, scale: 2)
        let model = StudioOverlayLayout.build(empty)
        XCTAssertFalse(model.isVisible)
    }

    // MARK: - Accessibility (outcome 10 groundwork)

    /// Metal-drawn controls carry no accessibility for free. Declaring them as
    /// the overlay is built is what keeps outcome 10 reachable without a
    /// redesign; this asserts the descriptors exist and carry real values, NOT
    /// that VoiceOver has been exercised.
    func testTheScrubBarIsDescribedAsASliderCarryingTheTimecode() throws {
        let model = StudioOverlayLayout.build(state(position: 60))
        let slider = try XCTUnwrap(
            model.accessibilityElements.first { $0.role == .slider }
        )
        XCTAssertEqual(slider.label, "Playhead")
        XCTAssertEqual(slider.value, "00:00:02:00")
        XCTAssertEqual(slider.frame, model.grabFrame)
    }

    /// THE ACCESSIBILITY CHURN BUG, asserted from both sides.
    ///
    /// Descriptors at two playback positions are NOT equal — the playhead and
    /// readout carry the running timecode — so a viewer republishing on plain
    /// inequality reallocates every child on every display-link tick during
    /// playback. They ARE structurally identical, which is what lets the caller
    /// update spoken values in place instead. The first assertion is the bug;
    /// the second is the fix.
    func testDescriptorsAreStructurallyStableAcrossPlaybackButNotEqual() {
        let early = StudioOverlayLayout.build(state(position: 30))
        var laterState = state(position: 90)
        laterState.timecodeText = "00:00:03:00"
        let later = StudioOverlayLayout.build(laterState)

        XCTAssertNotEqual(
            early.accessibilityElements,
            later.accessibilityElements,
            "if these were equal the churn bug could not have existed"
        )
        XCTAssertEqual(early.accessibilityElements.count, later.accessibilityElements.count)
        for (a, b) in zip(early.accessibilityElements, later.accessibilityElements) {
            XCTAssertTrue(
                a.matchesStructure(of: b),
                "\(a.label) changed structurally between frames, forcing a rebuild"
            )
        }
    }

    /// Structural identity must still notice a control genuinely moving or
    /// changing, or the viewer would keep stale frames forever.
    func testStructuralMatchDetectsRealControlChanges() {
        let base = StudioAccessibilityDescriptor(
            role: .slider,
            label: "Playhead",
            value: "00:00:01:00",
            frame: StudioOverlayFrame(x: 0, y: 0, width: 10, height: 10)
        )
        let valueOnly = StudioAccessibilityDescriptor(
            role: .slider,
            label: "Playhead",
            value: "00:00:09:00",
            frame: StudioOverlayFrame(x: 0, y: 0, width: 10, height: 10)
        )
        XCTAssertTrue(base.matchesStructure(of: valueOnly))

        let moved = StudioAccessibilityDescriptor(
            role: .slider,
            label: "Playhead",
            value: "00:00:01:00",
            frame: StudioOverlayFrame(x: 40, y: 0, width: 10, height: 10)
        )
        XCTAssertFalse(base.matchesStructure(of: moved), "a resized control must rebuild")

        let relabelled = StudioAccessibilityDescriptor(
            role: .staticText,
            label: "Playhead",
            value: "00:00:01:00",
            frame: StudioOverlayFrame(x: 0, y: 0, width: 10, height: 10)
        )
        XCTAssertFalse(base.matchesStructure(of: relabelled), "a role change must rebuild")
    }

    /// Marking In/Out ADDS controls, so that genuinely must rebuild.
    func testAddingMarksIsAStructuralChange() {
        let bare = StudioOverlayLayout.build(state())
        let marked = StudioOverlayLayout.build(state(inPoint: 30, outPoint: 90))
        XCTAssertNotEqual(bare.accessibilityElements.count, marked.accessibilityElements.count)
    }

    func testMarksAndLoopStateAreDescribed() {
        let model = StudioOverlayLayout.build(
            state(inPoint: 30, outPoint: 90, looping: true)
        )
        let labels = Set(model.accessibilityElements.map(\.label))
        XCTAssertTrue(labels.contains("In point"))
        XCTAssertTrue(labels.contains("Out point"))
        XCTAssertTrue(labels.contains("Timecode"))
        let loop = model.accessibilityElements.first { $0.label == "Loop marked range" }
        // Static text, not a checkbox: nothing in the HUD can be clicked to
        // toggle looping, and announcing an inoperable control is worse than
        // describing the state.
        XCTAssertEqual(loop?.role, .staticText)
        XCTAssertEqual(loop?.value, "on")
    }

    func testEveryAccessibilityElementHasANonEmptyLabel() {
        let model = StudioOverlayLayout.build(state(inPoint: 30, outPoint: 90))
        XCTAssertFalse(model.accessibilityElements.isEmpty)
        for element in model.accessibilityElements {
            XCTAssertFalse(element.label.isEmpty)
            XCTAssertTrue(element.frame.width > 0)
        }
    }

    /// The packaged endurance run caught this: a long asset label and the full
    /// diagnostics string were both laid out at secondaryY, and once the
    /// diagnostics width clamped to the left margin they rendered on top of
    /// each other, making the a/v meter unreadable.
    func testSourceLabelAndDiagnosticsOccupyDisjointRows() {
        var busy = state()
        busy.sourceLabel = String(repeating: "A", count: 180) + ".mov"
        busy.diagnostics = StudioOverlayDiagnostics(
            presentedFrameCount: 123_456,
            droppedFrameCount: 123_456,
            retainedFrameCount: 123_456,
            hardwareDecodeLabel: "hardware",
            syncLabel: "a/v +123.456ms !",
            memoryLabel: "rss 1234MB",
            cacheHitCount: 123_456,
            boundTextureCount: 123_456,
            playerCount: 123_456
        )
        let model = StudioOverlayLayout.build(busy)

        let label = model.texts.first { $0.string == busy.sourceLabel }
        let diagnostics = model.texts.first { $0.string.contains("a/v +123.456ms") }
        XCTAssertNotNil(label, "the long source label must still be laid out")
        XCTAssertNotNil(diagnostics, "the diagnostics row must still be laid out")
        guard let label, let diagnostics else { return }

        let labelWidth = StudioOverlayRenderMetrics.width(
            of: label.string, pointSize: label.pointSize)
        let labelHeight = StudioOverlayRenderMetrics.cellHeight(forPointSize: label.pointSize)
        let diagnosticsWidth = StudioOverlayRenderMetrics.width(
            of: diagnostics.string, pointSize: diagnostics.pointSize)
        let diagnosticsHeight = StudioOverlayRenderMetrics.cellHeight(forPointSize: diagnostics.pointSize)

        let overlaps =
            label.x < diagnostics.x + diagnosticsWidth
            && diagnostics.x < label.x + labelWidth
            && label.y < diagnostics.y + diagnosticsHeight
            && diagnostics.y < label.y + labelHeight
        XCTAssertFalse(
            overlaps,
            "source label and diagnostics must occupy disjoint frames; "
                + "label \(label) vs diagnostics \(diagnostics)")

        XCTAssertGreaterThanOrEqual(diagnostics.x, -0.001)
        XCTAssertLessThanOrEqual(
            diagnostics.x + diagnosticsWidth, viewport.width + 0.001,
            "the diagnostics row must remain inside the viewport")
    }

    // MARK: - Why the transport moved

    private func mutationRecord(
        kind: StudioTransportMutationKind = .lifecycleOpen,
        beforeSource: StudioTransportHostSource = .audio,
        afterSource: StudioTransportHostSource = .audio,
        host: Double = 4,
        beforeAnchorTicks: Int64 = 0,
        afterAnchorTicks: Int64 = 0,
        beforePosition: Int64 = 2400,
        afterPosition: Int64 = 2400
    ) -> StudioTransportMutationRecord {
        StudioTransportMutationRecord(
            kind: kind, route: .source,
            beforeSource: beforeSource, afterSource: afterSource,
            suppliedHostSeconds: host,
            beforeAnchorTicks: beforeAnchorTicks, beforeAnchorHostSeconds: 0,
            beforePositionTicks: beforePosition, beforeDurationTicks: 6000,
            beforeIsPlaying: true, beforeRate: 1,
            afterAnchorTicks: afterAnchorTicks, afterAnchorHostSeconds: host,
            afterPositionTicks: afterPosition, afterDurationTicks: 6000,
            afterIsPlaying: true, afterRate: 1)
    }

    /// THE FALSE NEGATIVE THIS PREDICATE HAD, AND WHY IT MATTERED MOST.
    ///
    /// A position read at a wrong-domain host ALREADY resolves to duration
    /// before the mutation runs, so pre == post == duration and a position
    /// comparison answers "not caused here" for exactly the case it exists to
    /// catch. The causal transition is the ANCHOR the mutation persists.
    func testAClampIsAttributedFromTheAnchorTransitionNotTheResolvedPosition() {
        // The real wrong-domain shape: both position reads already read 600s.
        XCTAssertTrue(
            mutationRecord(
                beforeAnchorTicks: 0, afterAnchorTicks: 6000,
                beforePosition: 6000, afterPosition: 6000
            ).clampedToDuration,
            "a mutation that persisted the anchor onto the bound must be named "
                + "even though both position reads already showed duration")

        // An anchor already parked at duration is not this mutation's doing.
        XCTAssertFalse(
            mutationRecord(
                beforeAnchorTicks: 6000, afterAnchorTicks: 6000,
                beforePosition: 6000, afterPosition: 6000
            ).clampedToDuration)

        // Ordinary movement well inside the media.
        XCTAssertFalse(
            mutationRecord(beforeAnchorTicks: 0, afterAnchorTicks: 2400).clampedToDuration)
    }

    /// Source IDENTITY, not a magnitude threshold: a machine host is
    /// machine-domain on a freshly booted machine too, where its value is small.
    func testADomainChangeIsIdentifiedBySourceIdentityNotMagnitude() {
        XCTAssertTrue(
            mutationRecord(beforeSource: .audio, afterSource: .machine, host: 12)
                .crossedHostDomain,
            "a small machine host on a fresh boot is still a domain change")
        XCTAssertFalse(
            mutationRecord(beforeSource: .audio, afterSource: .audio, host: 100_000)
                .crossedHostDomain)
    }

    func testTheMutationRecordSerialisesItsOperandsUnderAVersionedSchema() {
        let export = mutationRecord(
            kind: .audioReschedule, beforeSource: .machine, afterSource: .audio,
            host: 4, beforeAnchorTicks: 0, afterAnchorTicks: 6000,
            beforePosition: 6000, afterPosition: 6000
        ).diagnosticsExportText

        XCTAssertTrue(export.hasPrefix("tm1 "), export)
        XCTAssertTrue(export.contains("kind=audioReschedule"), export)
        XCTAssertTrue(export.contains("preSrc=machine postSrc=audio"), export)
        XCTAssertTrue(export.contains("preAnchorT=0"), export)
        XCTAssertTrue(export.contains("postAnchorT=6000"), export)
        XCTAssertTrue(export.contains("crossedDomain=1"), export)
        XCTAssertTrue(export.contains("clamped=1"), export)
        XCTAssertTrue(export.contains("prevHost=-"), export)
    }

    func testTheTransportMutationIsPublishedAsAnAccessibilityOnlyDescriptor() {
        var subject = state()
        subject.diagnostics = StudioOverlayDiagnostics(
            presentedFrameCount: 10, droppedFrameCount: 0, retainedFrameCount: 3,
            hardwareDecodeLabel: "hardware",
            transportMutationDetail: "tm1 kind=lifecycleOpen")
        let model = StudioOverlayLayout.build(subject)

        let descriptor = model.accessibilityElements
            .first { $0.label == "Transport mutation detail" }
        XCTAssertEqual(descriptor?.value, "tm1 kind=lifecycleOpen")
        XCTAssertEqual(descriptor?.role, .staticText)

        // Absent before any mutation, and drawing nothing either way.
        var none = state()
        none.diagnostics = StudioOverlayDiagnostics(
            presentedFrameCount: 10, droppedFrameCount: 0, retainedFrameCount: 3,
            hardwareDecodeLabel: "hardware")
        let bare = StudioOverlayLayout.build(none)
        XCTAssertNil(bare.accessibilityElements.first { $0.label == "Transport mutation detail" })
        XCTAssertEqual(model.texts, bare.texts, "the record must not draw anything")
        XCTAssertEqual(model.rects, bare.rects)
    }

    // MARK: - A playback control something can actually press

    /// Review hydrates PAUSED, and every safe way to start it was inert:
    /// background key events do nothing while the Companion is inactive, and
    /// the only alternative is foreground input, which is exactly the focus
    /// theft the acceptance policy forbids. A pressable accessibility control
    /// is the one route that is both safe and real.

    func testThePlaybackControlIsPublishedAsAPressableAction() {
        var paused = state()
        paused.isPlaying = false
        let pausedModel = StudioOverlayLayout.build(paused)
        let pausedControl = pausedModel.accessibilityElements.first { $0.label == "Playback" }
        XCTAssertEqual(pausedControl?.value, "paused")
        XCTAssertEqual(pausedControl?.action, .togglePlayback)

        var playing = state()
        playing.isPlaying = true
        let playingControl = StudioOverlayLayout.build(playing)
            .accessibilityElements.first { $0.label == "Playback" }
        XCTAssertEqual(playingControl?.value, "playing")
    }

    /// The value moves every time playback starts or stops; the control does
    /// not. Republishing on value alone would reallocate the element and hand
    /// assistive technology a moving target — the same churn the playhead
    /// slider already avoids.
    func testThePlaybackControlKeepsItsStructureWhileItsValueMoves() throws {
        var paused = state()
        paused.isPlaying = false
        var playing = state()
        playing.isPlaying = true

        let pausedControl = try XCTUnwrap(
            StudioOverlayLayout.build(paused).accessibilityElements
                .first { $0.label == "Playback" })
        let playingControl = try XCTUnwrap(
            StudioOverlayLayout.build(playing).accessibilityElements
                .first { $0.label == "Playback" })

        XCTAssertNotEqual(pausedControl.value, playingControl.value)
        XCTAssertTrue(pausedControl.matchesStructure(of: playingControl))
    }

    /// THE REASON ACTION IS PART OF IDENTITY. Role, label and frame can all
    /// coincide while the thing the press DOES differs. If structure matching
    /// ignored the action, an element wired to one behaviour could be reused
    /// in place for another and the press would silently do the wrong thing.
    func testTwoControlsThatDifferOnlyByActionAreNotTheSameControl() {
        let frame = StudioOverlayFrame(x: 1, y: 2, width: 3, height: 4)
        let pressable = StudioAccessibilityDescriptor(
            role: .button, label: "Playback", value: "paused",
            frame: frame, action: .togglePlayback)
        let inert = StudioAccessibilityDescriptor(
            role: .button, label: "Playback", value: "paused", frame: frame)

        XCTAssertFalse(
            pressable.matchesStructure(of: inert),
            "a pressable control must never be reused in place for an inert one")
        XCTAssertFalse(inert.matchesStructure(of: pressable))
    }

    // MARK: - The retained A/V sample leaves the process

    /// Carries the retained worst A/V reading OUT of the process without a
    /// debugger. Reading it from a packaged run previously meant attaching
    /// LLDB and resolving an internal Swift type by name; that failed twice on
    /// type lookup before reaching any data. Accessibility already crosses the
    /// process boundary and is already read by the acceptance driver, so the
    /// sample rides a surface that works.

    private func detailState(_ detail: String?, currentDetail: String? = nil) -> StudioOverlayState {
        var subject = state()
        subject.diagnostics = StudioOverlayDiagnostics(
            presentedFrameCount: 10,
            droppedFrameCount: 0,
            retainedFrameCount: 3,
            hardwareDecodeLabel: "hardware",
            syncLabel: "a/v -15.8ms pk 1088.5",
            syncDetail: detail,
            syncCurrentDetail: currentDetail
        )
        return subject
    }

    func testTheRetainedSampleIsPublishedAsItsOwnAccessibilityDescriptor() {
        let export =
            "av1 pf=60000 ap=90000 err=-30000 errms=-1000.000 win=1000000000 "
            + "winms=1000.000 drawn=1 expl=explained"
        let model = StudioOverlayLayout.build(detailState(export))

        let descriptor = model.accessibilityElements.first { $0.label == "A/V sync detail" }
        XCTAssertEqual(descriptor?.value, export)
        XCTAssertEqual(descriptor?.role, .staticText)
    }

    /// No sample means NO control. An empty or placeholder element would give a
    /// reader something to parse that says nothing, and a driver that finds the
    /// descriptor is entitled to believe a measurement exists behind it.
    func testNoDescriptorIsPublishedBeforeAnySampleExists() {
        let model = StudioOverlayLayout.build(detailState(nil))
        XCTAssertNil(model.accessibilityElements.first { $0.label == "A/V sync detail" })
        XCTAssertNil(model.accessibilityElements.first { $0.label == "A/V sync current detail" })
    }

    func testPeakAndCurrentSamplesArePublishedAsDistinctDescriptorsInOneSnapshot() {
        let peak =
            "av1 pf=0 ap=30000 err=-30000 errms=-1000.000 win=1000000000 "
            + "winms=1000.000 drawn=1 expl=explained"
        let current =
            "avc1 ts=30000 fd=1001 pf=60000 ap=59550 err=450 errms=15.000 "
            + "win=750000 winms=0.750 drawn=1 expl=not_explained"
        let model = StudioOverlayLayout.build(detailState(peak, currentDetail: current))

        let peakDescriptor = model.accessibilityElements
            .first { $0.label == "A/V sync detail" }
        let currentDescriptor = model.accessibilityElements
            .first { $0.label == "A/V sync current detail" }
        XCTAssertEqual(peakDescriptor?.value, peak)
        XCTAssertEqual(currentDescriptor?.value, current)
        XCTAssertEqual(peakDescriptor?.role, .staticText)
        XCTAssertEqual(currentDescriptor?.role, .staticText)
        XCTAssertNotEqual(peakDescriptor?.label, currentDescriptor?.label)
    }

    /// ADDED, NOT SUBSTITUTED. The existing spoken controls are what a human
    /// using VoiceOver relies on; a machine-readable field must not displace
    /// them or renumber the tree they sit in.
    func testExportingTheSampleLeavesTheExistingControlsIntact() {
        let withoutDetail = StudioOverlayLayout.build(detailState(nil))
        let withDetail = StudioOverlayLayout.build(detailState("av1 pf=0 ap=0 err=0"))

        for existing in withoutDetail.accessibilityElements {
            XCTAssertTrue(
                withDetail.accessibilityElements.contains(existing),
                "\(existing.label) was altered or dropped by the export")
        }
        XCTAssertEqual(
            withDetail.accessibilityElements.count,
            withoutDetail.accessibilityElements.count + 1)
    }

    /// THE BEHAVIOUR-NEUTRALITY PROOF. The export must reach accessibility and
    /// nothing else: no new glyph, no shifted row, no changed HUD string. A
    /// drawn difference here would be a visible product change smuggled in as
    /// diagnostics, so the entire drawn output is compared rather than sampled.
    func testExportingTheSampleDrawsAbsolutelyNothing() {
        let withoutDetail = StudioOverlayLayout.build(detailState(nil))
        let withDetail = StudioOverlayLayout.build(detailState("av1 pf=0 ap=0 err=0"))

        XCTAssertEqual(withDetail.texts, withoutDetail.texts)
        XCTAssertEqual(withDetail.rects, withoutDetail.rects)
        XCTAssertEqual(withDetail.trackFrame, withoutDetail.trackFrame)
        XCTAssertEqual(withDetail.grabFrame, withoutDetail.grabFrame)
    }
}
