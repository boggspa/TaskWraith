import AppKit
import XCTest

@testable import TaskWraithStudioCompanion
@testable import TaskWraithStudioCore

/// Fires REAL NSEvents at the viewer.
///
/// WHY THIS TARGET EXISTS. Every gesture claim in outcome 6 previously rested on
/// Core tests plus an argument about the AppKit glue. Core tests are handed an
/// ALREADY-CONVERTED x coordinate, so they pass identically whether the view's
/// window-to-backing conversion is correct, missing, or off by a Retina factor
/// of two — an instrument whose reading is independent of the defect it claims
/// to detect. These tests convert nothing themselves: they hand the view a
/// window point and assert the tick, so the conversion is the thing under test.
@MainActor
final class StudioViewerEventTests: XCTestCase {
    private func makeEvent(
        _ type: NSEvent.EventType,
        at point: NSPoint,
        in window: NSWindow,
        characters: String = "",
        keyCode: UInt16 = 0,
        modifiers: NSEvent.ModifierFlags = []
    ) -> NSEvent {
        if type == .keyDown {
            return NSEvent.keyEvent(
                with: .keyDown,
                location: point,
                modifierFlags: modifiers,
                timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber,
                context: nil,
                characters: characters,
                charactersIgnoringModifiers: characters,
                isARepeat: false,
                keyCode: keyCode
            )!
        }
        return NSEvent.mouseEvent(
            with: type,
            location: point,
            modifierFlags: modifiers,
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber,
            context: nil,
            eventNumber: 0,
            clickCount: 1,
            pressure: 1
        )!
    }

    /// Builds a real view in a real window with a real Metal layer, then runs
    /// ONE real render pass so `overlayModel` is populated the way production
    /// populates it. Nothing here recomputes layout: the test reads the same
    /// model the mouse handler reads.
    private func makeViewer() throws -> (StudioViewerView, NSWindow) {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device")
        }
        let renderer = try StudioViewerRenderer(device: device)
        let timebase = try XCTUnwrap(
            StudioTimebase(timescale: 600, frameDurationTicks: 20))
        let clock = StudioPlaybackClock(timebase: timebase, durationTicks: 6000)

        let view = StudioViewerView(renderer: renderer, clock: clock)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 540),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.contentView = view
        window.makeFirstResponder(view)
        view.frame = NSRect(x: 0, y: 0, width: 960, height: 540)
        view.layoutSubtreeIfNeeded()
        view.renderCurrentFrame()
        return (view, window)
    }

    /// THE CONVERSION TEST. A window point goes in; the tick comes out. Every
    /// Core timeline test passes whether or not this conversion is right,
    /// because they are handed an already-converted x. The expected tick is
    /// derived from GEOMETRY, not from whatever the code happens to return.
    func testAScrubDragLandsOnTheTickTheGeometryPredicts() throws {
        let (view, window) = try makeViewer()
        let model = try XCTUnwrap(view.overlayModel)
        XCTAssertTrue(model.isVisible)

        let scale = window.backingScaleFactor
        // Aim at the horizontal middle of the drawn track, in BACKING pixels...
        let targetBackingX = model.trackFrame.x + model.trackFrame.width / 2
        // ...then express it as the WINDOW point AppKit would deliver, undoing
        // scale and the y-flip by hand so the view's own conversion is the
        // thing under test rather than a shared helper.
        let windowX = targetBackingX / scale
        let grabCentreBackingY = model.grabFrame.y + model.grabFrame.height / 2
        let windowY = view.bounds.height - grabCentreBackingY / scale

        let down = makeEvent(
            .leftMouseDown, at: NSPoint(x: windowX, y: windowY), in: window)
        view.mouseDown(with: down)

        XCTAssertTrue(
            view.transport.isScrubbing,
            "a press on the track's grab area must begin a scrub — if this fails "
                + "the y-flip or the backing scale is wrong")

        let expected = StudioOverlayLayout.ticks(
            atX: targetBackingX, in: model, durationTicks: 6000)
        // Read the TRANSPORT'S clock, not the one handed to the initialiser:
        // StudioPlaybackClock is a value type, so the transport owns the live
        // copy. That is the one-authority design working as intended — a test
        // holding its own copy is reading a stale snapshot, which is the same
        // mistake any caller could make.
        XCTAssertEqual(
            Double(view.transport.clock.snapshot(atHost: CACurrentMediaTime()).positionTicks),
            Double(expected), accuracy: 1,
            "the scrub landed on a different tick than the geometry predicts")
        // Mid-track on a 6000-tick duration is 3000; asserting the ballpark
        // catches a conversion that is self-consistently wrong.
        XCTAssertEqual(Double(expected), 3000, accuracy: 60)

        view.mouseUp(with: makeEvent(
            .leftMouseUp, at: NSPoint(x: windowX, y: windowY), in: window))
        XCTAssertFalse(view.transport.isScrubbing)
    }

    /// A press well above the HUD is picture, not transport. Without this a
    /// conversion error that mapped everything into the strip would still pass
    /// the test above.
    func testAPressInThePictureDoesNotScrub() throws {
        let (view, window) = try makeViewer()
        view.mouseDown(with: makeEvent(
            .leftMouseDown, at: NSPoint(x: 480, y: 500), in: window))
        XCTAssertFalse(
            view.transport.isScrubbing,
            "clicking the picture must not yank the playhead")
    }

    /// Tab must reach the view and move the transcript selection. This is the
    /// binding that makes the band's accessibility descriptors focusable.
    func testTabMovesTheTranscriptSelection() throws {
        let (view, window) = try makeViewer()
        view.adopt(transcript: Self.transcript)
        view.renderCurrentFrame()
        XCTAssertNil(view.selectedSegmentId)

        view.keyDown(with: makeEvent(
            .keyDown, at: .zero, in: window, characters: "\t", keyCode: 48))
        XCTAssertEqual(view.selectedSegmentId, "s1")

        view.keyDown(with: makeEvent(
            .keyDown, at: .zero, in: window, characters: "\t", keyCode: 48))
        XCTAssertEqual(view.selectedSegmentId, "s2")
    }

    /// Return belongs to timecode entry while entry is open. Argued in code
    /// before this target existed; now fired.
    func testReturnDuringTimecodeEntryDoesNotPropose() throws {
        let (view, window) = try makeViewer()
        view.adopt(transcript: Self.transcript)
        view.keyDown(with: makeEvent(
            .keyDown, at: .zero, in: window, characters: "\t", keyCode: 48))
        // A digit STARTS timecode entry.
        view.keyDown(with: makeEvent(
            .keyDown, at: .zero, in: window, characters: "1", keyCode: 18))
        XCTAssertTrue(
            view.timecodeField.isActive,
            "a digit must open timecode entry")

        view.keyDown(with: makeEvent(
            .keyDown, at: .zero, in: window, characters: "\r", keyCode: 36))
        XCTAssertFalse(
            view.timecodeField.isActive,
            "Return must commit the timecode, not fall through to the band")
    }

    private static let transcript = StudioTranscript(
        transcriptId: "t1",
        assetId: "a1",
        segments: [
            StudioTranscriptSegment(
                segmentId: "s1", text: "one",
                sourceIn: StudioRationalTime(n: 0, d: 600)!,
                sourceOut: StudioRationalTime(n: 600, d: 600)!),
            StudioTranscriptSegment(
                segmentId: "s2", text: "two",
                sourceIn: StudioRationalTime(n: 900, d: 600)!,
                sourceOut: StudioRationalTime(n: 1500, d: 600)!),
        ]
    )
}

/// The conversion arithmetic, exercised at a scale that is NOT 1.
///
/// WHY SEPARATELY. The end-to-end event tests run in a headless window whose
/// backingScaleFactor is MEASURED at 1.0, so multiplying by it is a no-op and
/// those tests pass whether or not the scale is applied — I proved that by
/// deleting the scale and watching all four stay green. That is an instrument
/// blind to the exact defect this target was built for. A view with NO window
/// takes the 2.0 fallback, which restores the discrimination.
@MainActor
final class StudioViewerCoordinateTests: XCTestCase {
    func testWindowPointsBecomeTopLeftBackingPixels() throws {
        guard let device = MTLCreateSystemDefaultDevice() else { throw XCTSkip("no Metal") }
        let renderer = try StudioViewerRenderer(device: device)
        let timebase = try XCTUnwrap(StudioTimebase(timescale: 600, frameDurationTicks: 20))
        let view = StudioViewerView(
            renderer: renderer,
            clock: StudioPlaybackClock(timebase: timebase, durationTicks: 6000))
        view.frame = NSRect(x: 0, y: 0, width: 960, height: 540)
        XCTAssertNil(view.window, "no window, so the 2.0 fallback scale applies")

        // Expectations come from the CONTRACT — backing pixels, top-left origin
        // — with the numbers written out, not from re-running the formula.
        let bottomLeft = NSEvent.mouseEvent(
            with: .leftMouseDown, location: NSPoint(x: 0, y: 0),
            modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil,
            eventNumber: 0, clickCount: 1, pressure: 1)!
        let converted = view.overlayPoint(from: bottomLeft)
        XCTAssertEqual(converted.x, 0, accuracy: 0.001)
        XCTAssertEqual(
            converted.y, 1080, accuracy: 0.001,
            "the window's BOTTOM-left is the overlay's BOTTOM-left: y flips to "
                + "the full backing height, 540 x 2")

        let midPoint = NSEvent.mouseEvent(
            with: .leftMouseDown, location: NSPoint(x: 100, y: 40),
            modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil,
            eventNumber: 0, clickCount: 1, pressure: 1)!
        let mid = view.overlayPoint(from: midPoint)
        XCTAssertEqual(mid.x, 200, accuracy: 0.001, "x must be scaled by 2")
        XCTAssertEqual(mid.y, 1000, accuracy: 0.001, "(540 - 40) x 2")
    }
}

/// The HUD must not claim FX while the picture is untouched.
@MainActor
final class StudioViewerGradeHudTests: XCTestCase {
    private func makeView() throws -> StudioViewerView {
        guard let device = MTLCreateSystemDefaultDevice() else { throw XCTSkip("no Metal") }
        let renderer = try StudioViewerRenderer(device: device)
        let timebase = try XCTUnwrap(StudioTimebase(timescale: 600, frameDurationTicks: 20))
        return StudioViewerView(
            renderer: renderer,
            clock: StudioPlaybackClock(timebase: timebase, durationTicks: 600))
    }

    /// isNeutral was written to prevent exactly this and was never called, so
    /// the product reported "Effect" over an unchanged picture.
    func testTheHudSaysNoOpWhenTheGradeChangesNothing() throws {
        let view = try makeView()
        view.gradeSettings = StudioGradeSettings(mode: .effect)
        view.renderer.grade = view.gradeSettings
        XCTAssertTrue(
            view.gradeLabel.contains("no-op"),
            "claiming Effect over an untouched picture is the same lie as a "
                + "bypass that is not a bypass; got \(view.gradeLabel)")

        view.gradeSettings.displayTransform = .rec709ToSRGB
        view.renderer.grade = view.gradeSettings
        XCTAssertEqual(view.gradeLabel, "Effect")

        view.gradeSettings.mode = .split
        view.renderer.grade = view.gradeSettings
        XCTAssertEqual(view.gradeLabel, "Split compare")

        view.gradeSettings.mode = .original
        XCTAssertEqual(view.gradeLabel, "Original", "Original never claims FX")
    }
}

/// The review loop borrows the transport's ONE loop authority. The operator's
/// own In/Out must survive that — they are different features and overwriting
/// one to serve the other makes it unusable.
@MainActor
final class StudioReviewLoopTests: XCTestCase {
    func testTheReviewLoopParksAndRestoresTheOperatorsOwnMarks() throws {
        guard let device = MTLCreateSystemDefaultDevice() else { throw XCTSkip("no Metal") }
        let renderer = try StudioViewerRenderer(device: device)
        let timebase = try XCTUnwrap(StudioTimebase(timescale: 600, frameDurationTicks: 20))
        let view = StudioViewerView(
            renderer: renderer,
            clock: StudioPlaybackClock(timebase: timebase, durationTicks: 6000))

        // The operator's own marks, set before any review begins.
        let host = CACurrentMediaTime()
        view.transport.setInPoint(ticks: 1000, atHost: host)
        view.transport.setOutPoint(ticks: 2000, atHost: host)

        let op = StudioInsertRangeOp(
            itemId: "i1", assetId: "a1", trackId: nil,
            sourceIn: StudioRationalTime(n: 0, d: 600)!,
            sourceOut: StudioRationalTime(n: 600, d: 600)!,
            at: StudioRationalTime(n: 3000, d: 600)!)
        view.adopt(
            reviewTimeline: try XCTUnwrap(
                StudioProposedTimeline(
                    proposal: StudioEditProposal(
                        proposalId: "p1", createdRevision: 1, op: op),
                    timebase: timebase)))

        view.toggleReviewLoop(atHost: host)
        XCTAssertEqual(view.transport.inPointTicks, 2400, "loop starts one second before")
        XCTAssertEqual(view.transport.outPointTicks, 4200)
        XCTAssertTrue(view.transport.isLoopingRange)

        view.toggleReviewLoop(atHost: host)
        XCTAssertEqual(
            view.transport.inPointTicks, 1000,
            "the operator's In was destroyed by a feature that only borrowed it")
        XCTAssertEqual(view.transport.outPointTicks, 2000)
        XCTAssertFalse(view.transport.isLoopingRange)
    }

    /// A resolved ghost must not leave the transport looping a range that no
    /// longer refers to anything.
    func testResolvingAGhostExitsTheReviewLoop() throws {
        guard let device = MTLCreateSystemDefaultDevice() else { throw XCTSkip("no Metal") }
        let renderer = try StudioViewerRenderer(device: device)
        let timebase = try XCTUnwrap(StudioTimebase(timescale: 600, frameDurationTicks: 20))
        let view = StudioViewerView(
            renderer: renderer,
            clock: StudioPlaybackClock(timebase: timebase, durationTicks: 6000))
        let op = StudioInsertRangeOp(
            itemId: "i1", assetId: "a1", trackId: nil,
            sourceIn: StudioRationalTime(n: 0, d: 600)!,
            sourceOut: StudioRationalTime(n: 600, d: 600)!,
            at: StudioRationalTime(n: 3000, d: 600)!)
        view.adopt(
            reviewTimeline: try XCTUnwrap(
                StudioProposedTimeline(
                    proposal: StudioEditProposal(
                        proposalId: "p1", createdRevision: 1, op: op),
                    timebase: timebase)))
        view.toggleReviewLoop(atHost: CACurrentMediaTime())
        XCTAssertTrue(view.transport.isLoopingRange)

        view.adopt(reviewTimeline: nil)
        XCTAssertFalse(
            view.transport.isLoopingRange,
            "a resolved proposal left the transport looping a dead range")
        XCTAssertNil(view.parkedMarks)
    }
}
