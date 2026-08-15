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

        let view = StudioViewerView(
            renderer: renderer,
            authority: StudioPlaybackAuthority(clock: clock))
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

    // MARK: - One clock domain for every transport mutation

    /// THE MECHANISM, IN ARITHMETIC.
    ///
    /// While audio drives playback the clock is anchored AUDIO-RELATIVE, near
    /// zero. `CACurrentMediaTime()` is machine uptime, on the order of 1e5
    /// seconds. A mutation carrying the second into a clock anchored in the
    /// first computes an elapsed of roughly the machine's whole uptime, and the
    /// duration clamp turns that into an instant jump to end-of-media — the
    /// packaged 4.133s -> 600s teleport.
    func testAMutationFromTheWrongClockDomainTeleportsToEndOfMedia() throws {
        let timebase = try XCTUnwrap(StudioTimebase(timescale: 600, frameDurationTicks: 20))
        // Ten seconds of media.
        var audioAnchored = StudioPlaybackClock(timebase: timebase, durationTicks: 6000)
        audioAnchored.play(atHost: 0)
        XCTAssertEqual(
            audioAnchored.positionTicks(atHost: 4), 2400,
            "four audio-relative seconds is four seconds in")

        var sameDomain = audioAnchored
        sameDomain.play(atHost: 4)
        XCTAssertEqual(
            sameDomain.positionTicks(atHost: 4), 2400,
            "a mutation in the clock's own domain must not move the playhead")

        var crossDomain = audioAnchored
        crossDomain.play(atHost: 100_000)
        XCTAssertEqual(
            crossDomain.positionTicks(atHost: 100_000), 6000,
            "machine uptime against an audio anchor must clamp to end-of-media; "
                + "if this stops clamping, the guard below proves nothing")
    }

    /// THE GUARD. Every transport mutation in the viewer must read the same
    /// host source the renderer reads. A single site reverting to
    /// `CACurrentMediaTime()` reintroduces the teleport, and it would only show
    /// up in a packaged run.
    ///
    /// Source-pinned deliberately: reproducing an audio-anchored live session
    /// offscreen would require attaching a real audio track, which this harness
    /// cannot do — the same limit already recorded for the sync meter.
    func testNoTransportMutationReadsTheMachineClockDirectly() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
                .appendingPathComponent(
                    "Sources/TaskWraithStudioCompanion/StudioViewerWindow.swift"),
            encoding: .utf8)

        XCTAssertFalse(
            source.contains("atHost: CACurrentMediaTime()"),
            "a transport mutation is using machine uptime directly")
        XCTAssertFalse(
            source.contains("let host = CACurrentMediaTime()"),
            "an event handler is deriving its mutation host from machine uptime")
        XCTAssertTrue(source.contains("var transportMutationHostSeconds: Double"))

        // The three legitimate uses: the domain fallback itself, the oscillator
        // swap that reads the OLD source before re-establishing under the new
        // one, and the once-a-second memory sampling throttle.
        let remaining = source.components(separatedBy: "CACurrentMediaTime()").count - 1
        let inComments = source.components(separatedBy: "\n")
            .filter { $0.contains("CACurrentMediaTime()") && $0.contains("///") }
            .count
        XCTAssertEqual(
            remaining - inComments, 4,
            "the only non-comment machine-clock reads are the domain fallback, "
                + "the two oscillator-swap operands, and the memory throttle")
    }

    // MARK: - Who owns the grade mode

    /// A LUT arriving previews itself; the operator can always take it back.
    ///
    /// The automatic mode exists because a Load that changes no pixel is
    /// indistinguishable from a Load that failed. It must not become a viewer
    /// that keeps overruling the person using it.
    func testALoadedPreviewGradesItselfThenYieldsToTheOperator() throws {
        let (view, window) = try makeViewer()
        XCTAssertEqual(view.gradeSettings.mode, .original)

        view.applyEffectPreviewGradeMode(active: true, isFirstActivation: true)
        XCTAssertEqual(view.gradeSettings.mode, .effect, "Load must preview without a keystroke")
        XCTAssertEqual(view.renderer.grade.mode, .effect, "the renderer must see the same mode")
        XCTAssertTrue(view.gradeModeAutoEnabledByEffectPreview)

        // The operator presses g and returns to Original. That is now THEIR mode.
        view.keyDown(with: makeEvent(.keyDown, at: .zero, in: window, characters: "g"))
        XCTAssertEqual(view.gradeSettings.mode, .original)
        XCTAssertFalse(view.gradeModeAutoEnabledByEffectPreview, "the operator took the grade")

        // Replacing the resident LUT must not drag them back into Effect.
        view.applyEffectPreviewGradeMode(active: true, isFirstActivation: false)
        XCTAssertEqual(
            view.gradeSettings.mode, .original,
            "a replacement overruled an operator who had chosen Original")

        // Nor may clearing move a mode the operator owns.
        view.applyEffectPreviewGradeMode(active: false, isFirstActivation: false)
        XCTAssertEqual(view.gradeSettings.mode, .original)
    }

    func testClearingAnAutomaticPreviewReturnsThePicture() throws {
        let (view, _) = try makeViewer()
        view.applyEffectPreviewGradeMode(active: true, isFirstActivation: true)
        XCTAssertEqual(view.gradeSettings.mode, .effect)

        view.applyEffectPreviewGradeMode(active: false, isFirstActivation: false)
        XCTAssertEqual(view.gradeSettings.mode, .original, "Clear must undo what Load did")
        XCTAssertEqual(view.renderer.grade.mode, .original)
        XCTAssertFalse(view.gradeModeAutoEnabledByEffectPreview)
    }

    /// The mirror case, and the one that would be easy to get wrong: an Effect
    /// the operator switched on themselves is not the LUT path's to undo.
    func testAnOperatorChosenEffectSurvivesAClear() throws {
        let (view, window) = try makeViewer()
        view.keyDown(with: makeEvent(.keyDown, at: .zero, in: window, characters: "g"))
        XCTAssertEqual(view.gradeSettings.mode, .effect)
        XCTAssertFalse(view.gradeModeAutoEnabledByEffectPreview)

        view.applyEffectPreviewGradeMode(active: false, isFirstActivation: false)
        XCTAssertEqual(
            view.gradeSettings.mode, .effect,
            "clearing a LUT must not steal a mode the operator chose")
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

/// Process startup must not be mistaken for an operator asking to see Studio.
/// The host's open_media notification is the presentation boundary.
@MainActor
final class StudioViewerPresentationTests: XCTestCase {
    func testSourcePresentationWaitsForAnOpenMediaRequest() async throws {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device")
        }
        let renderer = try StudioViewerRenderer(device: device)
        let timebase = try XCTUnwrap(
            StudioTimebase(timescale: 600, frameDurationTicks: 20))
        let controller = StudioViewerWindowController(
            renderer: renderer,
            authority: StudioPlaybackAuthority(
                clock: StudioPlaybackClock(timebase: timebase, durationTicks: 0)))
        var presentationCount = 0
        let state = StudioViewerAppState(
            controller: controller,
            renderer: renderer,
            presentSource: { presentationCount += 1 })

        XCTAssertEqual(
            presentationCount, 0,
            "constructing the supervised viewer must not present it at app startup")
        XCTAssertFalse(
            controller.isPresentationAttached,
            "the hidden startup viewer must not run its Metal display link off-screen")

        await state.open(assets: [
            StudioMediaAsset(
                assetId: "requested",
                path: "/path/that/does/not/exist.mov")
        ])

        XCTAssertEqual(
            presentationCount, 1,
            "an explicit open_media request must present Studio, including its load error")
    }

    /// Source open must not steal the operator's key window or promote the
    /// accessory companion to a regular activating app. Capture already works
    /// while this process stays inactive.
    func testShowOrdersTheWindowFrontWithoutTakingKeyOrActivating() throws {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device")
        }
        let renderer = try StudioViewerRenderer(device: device)
        let timebase = try XCTUnwrap(
            StudioTimebase(timescale: 600, frameDurationTicks: 20))
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let wasActive = application.isActive

        let controller = StudioViewerWindowController(
            renderer: renderer,
            authority: StudioPlaybackAuthority(
                clock: StudioPlaybackClock(timebase: timebase, durationTicks: 0)))

        controller.show()

        XCTAssertTrue(controller.isPresentationAttached)
        XCTAssertTrue(controller.window.isVisible)
        XCTAssertFalse(
            controller.window.isKeyWindow,
            "show() must not steal key-window status from the operator")
        XCTAssertEqual(
            application.activationPolicy(),
            .accessory,
            "presentation must not promote the companion to a regular app")
        XCTAssertEqual(
            application.isActive, wasActive,
            "presentation must not change process activation")
    }

    func testDefaultOpenMediaPresentationDoesNotActivate() async throws {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device")
        }
        let renderer = try StudioViewerRenderer(device: device)
        let timebase = try XCTUnwrap(
            StudioTimebase(timescale: 600, frameDurationTicks: 20))
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let wasActive = application.isActive
        let controller = StudioViewerWindowController(
            renderer: renderer,
            authority: StudioPlaybackAuthority(
                clock: StudioPlaybackClock(timebase: timebase, durationTicks: 0)))
        let state = StudioViewerAppState(
            controller: controller,
            renderer: renderer)

        await state.open(assets: [
            StudioMediaAsset(
                assetId: "requested",
                path: "/path/that/does/not/exist.mov")
        ])

        XCTAssertTrue(controller.window.isVisible)
        XCTAssertFalse(controller.window.isKeyWindow)
        XCTAssertEqual(application.activationPolicy(), .accessory)
        XCTAssertEqual(application.isActive, wasActive)
    }
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
            authority: StudioPlaybackAuthority(clock: StudioPlaybackClock(timebase: timebase, durationTicks: 6000)))
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
            authority: StudioPlaybackAuthority(clock: StudioPlaybackClock(timebase: timebase, durationTicks: 600)))
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
            authority: StudioPlaybackAuthority(clock: StudioPlaybackClock(timebase: timebase, durationTicks: 6000)))

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
            authority: StudioPlaybackAuthority(clock: StudioPlaybackClock(timebase: timebase, durationTicks: 6000)))
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

/// The routes must SHOW different things, or they are one window twice.
@MainActor
final class StudioRouteContentTests: XCTestCase {
    private func makeView(_ route: StudioViewerRoute, _ authority: StudioPlaybackAuthority)
        throws -> StudioViewerView
    {
        guard let device = MTLCreateSystemDefaultDevice() else { throw XCTSkip("no Metal") }
        let renderer = try StudioViewerRenderer(device: device)
        let view = StudioViewerView(renderer: renderer, authority: authority, route: route)
        view.frame = NSRect(x: 0, y: 0, width: 960, height: 540)
        return view
    }

    private var ghost: StudioProposedTimeline {
        get throws {
            let op = StudioInsertRangeOp(
                itemId: "i1", assetId: "a1", trackId: nil,
                sourceIn: StudioRationalTime(n: 0, d: 600)!,
                sourceOut: StudioRationalTime(n: 600, d: 600)!,
                at: StudioRationalTime(n: 3000, d: 600)!)
            return try XCTUnwrap(
                StudioProposedTimeline(
                    proposal: StudioEditProposal(
                        proposalId: "p1", createdRevision: 1, op: op),
                    timebase: StudioTimebase(timescale: 600, frameDurationTicks: 20)!))
        }
    }

    /// The briefing says Source previews the asset "independently of the
    /// timeline". A ghost drawn over the audition viewer would make the two
    /// routes the same window twice.
    func testAGhostReachesReviewAndNotSource() throws {
        let timebase = try XCTUnwrap(StudioTimebase(timescale: 600, frameDurationTicks: 20))
        let authority = StudioPlaybackAuthority(
            clock: StudioPlaybackClock(timebase: timebase, durationTicks: 6000))
        let source = try makeView(.source, authority)
        let review = try makeView(.review, authority)
        let open = try ghost

        source.adopt(reviewTimeline: open)
        review.adopt(reviewTimeline: open)
        source.renderCurrentFrame()
        review.renderCurrentFrame()

        // Asserted on the DRAWN rects rather than on state, because "the route
        // shows it" is the claim and a state field nothing renders would be the
        // very shape this round keeps catching.
        func ghostRects(_ view: StudioViewerView) -> Int {
            (view.overlayModel?.rects ?? []).filter {
                $0.color == .ghost || $0.color == .ghostEdge
            }.count
        }
        XCTAssertEqual(
            ghostRects(source), 0,
            "the Source route drew a proposal's ghost — the routes are the same window twice")
        XCTAssertGreaterThan(
            ghostRects(review), 0,
            "the Review route drew no ghost, so Review shows nothing Source does not")
    }

    /// And the two routes still agree about time, because that is the one thing
    /// the briefing says they must never disagree about.
    func testRoutesDifferInContentButNotInTime() throws {
        let timebase = try XCTUnwrap(StudioTimebase(timescale: 600, frameDurationTicks: 20))
        let authority = StudioPlaybackAuthority(
            clock: StudioPlaybackClock(timebase: timebase, durationTicks: 6000))
        let source = try makeView(.source, authority)
        let review = try makeView(.review, authority)

        source.transport.seek(toTicks: 2400, atHost: CACurrentMediaTime())
        XCTAssertEqual(
            review.transport.clock.snapshot(atHost: CACurrentMediaTime()).positionTicks,
            2400,
            "content may differ between routes; TIME may not")
    }
}

/// The HUD timecode must be one frame's transport snapshot, not a second clock sample.
@MainActor
final class StudioViewerHudTimecodeTests: XCTestCase {
    private func makeViewer(durationTicks: Int64 = 6000) throws -> StudioViewerView {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device")
        }
        let renderer = try StudioViewerRenderer(device: device)
        let timebase = try XCTUnwrap(
            StudioTimebase(timescale: 600, frameDurationTicks: 20))
        let clock = StudioPlaybackClock(timebase: timebase, durationTicks: durationTicks)
        let view = StudioViewerView(
            renderer: renderer,
            authority: StudioPlaybackAuthority(clock: clock))
        view.frame = NSRect(x: 0, y: 0, width: 960, height: 540)
        view.layoutSubtreeIfNeeded()
        return view
    }

    private func makeTexture(for view: StudioViewerView) throws -> MTLTexture {
        let descriptor = MTLTextureDescriptor()
        descriptor.width = 960
        descriptor.height = 540
        descriptor.pixelFormat = .bgra8Unorm
        descriptor.textureType = .type2D
        descriptor.usage = [.renderTarget, .shaderRead]
        return try XCTUnwrap(view.renderer.device.makeTexture(descriptor: descriptor))
    }

    /// Reproduces the VFR/HUD blocker: a per-frame snapshot taken ~5 seconds
    /// into playback must not be replaced by an absolute-host read that clamps
    /// to the 10-minute duration. Deleting the overlay/snapshot join must fail
    /// this control.
    func testOverlayTimecodeUsesTheSameTransportSnapshot() throws {
        let view = try makeViewer(durationTicks: 360_000) // 10 minutes, matching the endurance fixture.
        let timebase = view.transport.clock.timebase
        view.transport.play(atHost: 0)

        // A per-frame transport snapshot taken ~5 seconds into playback.
        let fiveSecondSnapshot = view.transport.clock.snapshot(atHost: 5.0)
        XCTAssertEqual(fiveSecondSnapshot.frameIndex, 150,
            "the test snapshot must land near five seconds, not at the end")

        // An absolute-host read at a huge host time would clamp to the duration.
        let absoluteHost = Double(view.transport.clock.durationTicks) / Double(timebase.timescale) + 1000.0
        let absoluteTimecode = try view.transport.currentTimecode(atHost: absoluteHost)
        XCTAssertEqual(absoluteTimecode.text, "00:10:00:00",
            "absolute-host read must clamp to duration for this red control to mean anything")

        let texture = try makeTexture(for: view)
        let overlay = view.overlayState(snapshot: fiveSecondSnapshot, drawable: texture)

        XCTAssertEqual(overlay.timecodeText, "00:00:05:00",
            "HUD timecode must be derived from the per-frame snapshot, not from a fresh absolute-host sample")
    }
}
