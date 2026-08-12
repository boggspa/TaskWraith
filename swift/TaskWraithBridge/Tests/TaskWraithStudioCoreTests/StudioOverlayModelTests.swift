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
}
