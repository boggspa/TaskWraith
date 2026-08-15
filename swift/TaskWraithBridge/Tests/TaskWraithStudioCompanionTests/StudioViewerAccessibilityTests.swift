import AppKit
import XCTest

@testable import TaskWraithStudioCompanion
@testable import TaskWraithStudioCore

/// Reads the viewer THROUGH THE ACCESSIBILITY API, as a client would.
///
/// WHY THIS EXISTS. Descriptors were published and Tab moved selection, but
/// nothing had ever read them back through NSAccessibility. That is the same
/// "published but never consumed" shape as the transcript reaching no renderer:
/// an array can be perfectly correct while the element tree an assistive client
/// actually queries is empty, or carries the wrong roles, or is never attached.
///
/// CREDIT BOUNDARY, stated here so it cannot drift: AN AX-API READ IS NOT
/// VOICEOVER. Real assistive technology drives focus, announcement, the rotor
/// and interaction from a separate process. This proves the tree is present,
/// correctly shaped, and correctly maintained. It does not prove anything is
/// speakable.
@MainActor
final class StudioViewerAccessibilityTests: XCTestCase {
    private func makeViewer() throws -> (StudioViewerView, NSWindow) {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device")
        }
        let renderer = try StudioViewerRenderer(device: device)
        let timebase = try XCTUnwrap(StudioTimebase(timescale: 600, frameDurationTicks: 20))
        let view = StudioViewerView(
            renderer: renderer,
            authority: StudioPlaybackAuthority(clock: StudioPlaybackClock(timebase: timebase, durationTicks: 6000)))
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 540),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = view
        view.frame = NSRect(x: 0, y: 0, width: 960, height: 540)
        view.layoutSubtreeIfNeeded()
        view.renderCurrentFrame()
        return (view, window)
    }

    private func makeSharedViewerPair() throws -> (
        source: StudioViewerView,
        review: StudioViewerView,
        sourceWindow: NSWindow,
        reviewWindow: NSWindow,
        scheduling: StudioAudioSchedulingAuthority
    ) {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device")
        }
        let timebase = try XCTUnwrap(
            StudioTimebase(timescale: 600, frameDurationTicks: 20))
        let authority = StudioPlaybackAuthority(
            clock: StudioPlaybackClock(timebase: timebase, durationTicks: 6000))
        let player = StudioAudioPlayer()
        let scheduling = StudioAudioSchedulingAuthority(owner: .source)
        let source = StudioViewerView(
            renderer: try StudioViewerRenderer(device: device),
            authority: authority, route: .source,
            audioPlayer: player, audioSchedulingAuthority: scheduling)
        let review = StudioViewerView(
            renderer: try StudioViewerRenderer(device: device),
            authority: authority, route: .review,
            audioPlayer: player, audioSchedulingAuthority: scheduling)
        let sourceWindow = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 540),
            styleMask: [.titled], backing: .buffered, defer: false)
        let reviewWindow = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 540),
            styleMask: [.titled], backing: .buffered, defer: false)
        sourceWindow.contentView = source
        reviewWindow.contentView = review
        source.frame = NSRect(x: 0, y: 0, width: 960, height: 540)
        review.frame = source.frame
        source.layoutSubtreeIfNeeded()
        review.layoutSubtreeIfNeeded()
        return (source, review, sourceWindow, reviewWindow, scheduling)
    }

    private func renderWithoutOwningAudio(
        _ view: StudioViewerView,
        scheduling: StudioAudioSchedulingAuthority
    ) {
        scheduling.activate(view.route == .source ? .review : .source)
        view.renderCurrentFrame()
    }

    private func makeKeyEvent(
        in window: NSWindow,
        characters: String,
        keyCode: UInt16,
        modifiers: NSEvent.ModifierFlags = []
    ) -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
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

    private func labeledChildren(
        of view: StudioViewerView
    ) throws -> [NSAccessibilityElement] {
        try XCTUnwrap(view.accessibilityChildren() as? [NSAccessibilityElement])
    }

    private func child(
        _ children: [NSAccessibilityElement],
        labeled label: String
    ) throws -> NSAccessibilityElement {
        try XCTUnwrap(
            children.first { $0.accessibilityLabel() == label },
            "AX tree labels: \(children.compactMap { $0.accessibilityLabel() })")
    }

    /// A PRESS THAT ACTUALLY MOVES THE TRANSPORT.
    ///
    /// Review hydrates paused, and every safe way to start it was inert:
    /// background key events do nothing while the Companion is inactive, and
    /// foreground input is the focus theft the acceptance policy forbids. This
    /// presses the real element and reads the transport back through the same
    /// AX tree a client sees — no synthesised events anywhere.
    func testPressingThePlaybackControlTogglesTheRealTransport() throws {
        let (view, window) = try makeViewer()

        func playbackValue() throws -> String? {
            try child(labeledChildren(of: view), labeled: "Playback")
                .accessibilityValue() as? String
        }

        // Read the state rather than assume it: this harness's default clock
        // hydrates PLAYING, so asserting a fixed starting value would test the
        // fixture instead of the control.
        let initial = try XCTUnwrap(playbackValue())
        XCTAssertTrue(["playing", "paused"].contains(initial))
        let opposite = initial == "playing" ? "paused" : "playing"

        let control = try XCTUnwrap(
            child(labeledChildren(of: view), labeled: "Playback")
                as? StudioActionAccessibilityElement,
            "the Playback control must be a pressable element, not an announcement")

        XCTAssertTrue(control.accessibilityPerformPress())
        view.renderCurrentFrame()
        XCTAssertEqual(try playbackValue(), opposite, "AXPress did not move the transport")
        // PER-TICK STABILITY, which is the requirement that matters: a display
        // refresh that changes nothing must not reallocate the control.
        //
        // Identity across a play/pause TRANSITION is deliberately not asserted.
        // Measured: the status line text carries PLAY/PAUSE, the "Loop marked
        // range" frame is sized from that line, and frame is part of structure
        // — so a transition rebuilds the whole tree. That is pre-existing and
        // independent of this control; claiming it here would be asserting a
        // property the product does not have.
        let steady = try child(labeledChildren(of: view), labeled: "Playback")
        view.renderCurrentFrame()
        XCTAssertTrue(
            try child(labeledChildren(of: view), labeled: "Playback") === steady,
            "an idle display tick reallocated the Playback control")

        XCTAssertTrue(control.accessibilityPerformPress())
        view.renderCurrentFrame()
        XCTAssertEqual(try playbackValue(), initial, "AXPress did not move the transport back")

        // The keyboard must reach the SAME behaviour. A key path and an
        // assistive path that disagree about what "play" means is a defect
        // only the people relying on the second one would ever hit.
        view.keyDown(with: makeKeyEvent(in: window, characters: " ", keyCode: 49))
        view.renderCurrentFrame()
        XCTAssertEqual(try playbackValue(), opposite, "Space and AXPress have drifted apart")
    }

    /// The retained tm1 descriptor must identify both AX mutation paths and
    /// remain the same AppKit element across render-only ticks and value-only
    /// record updates. Otherwise the next packaged teleport is either
    /// unattributed or paid for with per-frame AX allocation.
    func testTransportMutationDetailTracksAXPathsWithoutRenderChurn() throws {
        let (view, _) = try makeViewer()

        let playback = try XCTUnwrap(
            try child(labeledChildren(of: view), labeled: "Playback")
                as? StudioActionAccessibilityElement)
        XCTAssertTrue(playback.accessibilityPerformPress())
        XCTAssertEqual(view.lastTransportMutation?.kind, .playbackToggleAccessibility)
        view.renderCurrentFrame()

        let detail = try child(
            labeledChildren(of: view), labeled: "Transport mutation detail")
        let detailIdentity = ObjectIdentifier(detail)
        let playbackValue = try XCTUnwrap(detail.accessibilityValue() as? String)
        XCTAssertTrue(playbackValue.contains("kind=playbackToggleAccessibility"))

        let retained = try XCTUnwrap(view.lastTransportMutation)
        view.renderCurrentFrame()
        let idleDetail = try child(
            labeledChildren(of: view), labeled: "Transport mutation detail")
        XCTAssertEqual(ObjectIdentifier(idleDetail), detailIdentity)
        XCTAssertEqual(idleDetail.accessibilityValue() as? String, playbackValue)
        XCTAssertEqual(view.lastTransportMutation, retained)

        let playhead = try XCTUnwrap(
            try labeledChildren(of: view)
                .first { $0 is StudioPlayheadAccessibilityElement }
                as? StudioPlayheadAccessibilityElement)
        XCTAssertTrue(playhead.apply(NSNumber(value: 3000)))
        XCTAssertEqual(view.lastTransportMutation?.kind, .playheadAccessibilitySet)
        view.renderCurrentFrame()
        let setDetail = try child(
            labeledChildren(of: view), labeled: "Transport mutation detail")
        XCTAssertEqual(ObjectIdentifier(setDetail), detailIdentity)
        XCTAssertTrue(
            try XCTUnwrap(setDetail.accessibilityValue() as? String)
                .contains("kind=playheadAccessibilitySet"))

        playhead.accessibilityPerformAction(.increment)
        XCTAssertEqual(view.lastTransportMutation?.kind, .playheadAccessibilityStep)

        let lastAccepted = try XCTUnwrap(view.lastTransportMutation)
        view.playheadAccessibilityBinding = StudioPlayheadAccessibilityBinding(isBound: false)
        XCTAssertFalse(playhead.apply(NSNumber(value: 4000)))
        XCTAssertEqual(view.lastTransportMutation, lastAccepted)
    }

    /// Both route trees expose the same global tm1 record. A record emitted by
    /// Review must be visible from Source, and value updates must preserve each
    /// route's AX element identity through render-only ticks.
    func testBothRouteTreesExposeOneMutationRecordWithoutRenderChurn() throws {
        let pair = try makeSharedViewerPair()
        renderWithoutOwningAudio(pair.source, scheduling: pair.scheduling)
        renderWithoutOwningAudio(pair.review, scheduling: pair.scheduling)

        func detail(_ view: StudioViewerView) throws -> NSAccessibilityElement {
            try child(
                labeledChildren(of: view), labeled: "Transport mutation detail")
        }

        let sourceDetail = try detail(pair.source)
        let reviewDetail = try detail(pair.review)
        XCTAssertEqual(
            sourceDetail.accessibilityValue() as? String,
            reviewDetail.accessibilityValue() as? String)
        XCTAssertTrue(
            try XCTUnwrap(sourceDetail.accessibilityValue() as? String)
                .contains("route=review"))
        renderWithoutOwningAudio(pair.source, scheduling: pair.scheduling)
        renderWithoutOwningAudio(pair.review, scheduling: pair.scheduling)
        XCTAssertTrue(try detail(pair.source) === sourceDetail)
        XCTAssertTrue(try detail(pair.review) === reviewDetail)

        let sourcePlayback = try XCTUnwrap(
            try child(labeledChildren(of: pair.source), labeled: "Playback")
                as? StudioActionAccessibilityElement)
        XCTAssertTrue(sourcePlayback.accessibilityPerformPress())
        XCTAssertEqual(pair.source.lastTransportMutation?.route, .source)
        XCTAssertEqual(pair.source.lastTransportMutation, pair.review.lastTransportMutation)
        renderWithoutOwningAudio(pair.source, scheduling: pair.scheduling)
        renderWithoutOwningAudio(pair.review, scheduling: pair.scheduling)
        let sourceAfterSource = try detail(pair.source)
        let reviewAfterSource = try detail(pair.review)
        XCTAssertTrue(
            try XCTUnwrap(reviewAfterSource.accessibilityValue() as? String)
                .contains("route=source"))
        renderWithoutOwningAudio(pair.source, scheduling: pair.scheduling)
        renderWithoutOwningAudio(pair.review, scheduling: pair.scheduling)
        XCTAssertTrue(try detail(pair.source) === sourceAfterSource)
        XCTAssertTrue(try detail(pair.review) === reviewAfterSource)

        let reviewPlayback = try XCTUnwrap(
            try child(labeledChildren(of: pair.review), labeled: "Playback")
                as? StudioActionAccessibilityElement)
        XCTAssertTrue(reviewPlayback.accessibilityPerformPress())
        XCTAssertEqual(pair.source.lastTransportMutation?.route, .review)
        XCTAssertEqual(pair.source.lastTransportMutation, pair.review.lastTransportMutation)
        renderWithoutOwningAudio(pair.source, scheduling: pair.scheduling)
        renderWithoutOwningAudio(pair.review, scheduling: pair.scheduling)
        let sourceAfterReview = try detail(pair.source)
        let reviewAfterReview = try detail(pair.review)
        XCTAssertEqual(
            sourceAfterReview.accessibilityValue() as? String,
            reviewAfterReview.accessibilityValue() as? String)
        renderWithoutOwningAudio(pair.source, scheduling: pair.scheduling)
        renderWithoutOwningAudio(pair.review, scheduling: pair.scheduling)
        XCTAssertTrue(try detail(pair.source) === sourceAfterReview)
        XCTAssertTrue(try detail(pair.review) === reviewAfterReview)
    }

    /// Only a descriptor that NAMES an action may become pressable. Everything
    /// else stays an announcement: advertising a press that reaches nothing is
    /// worse than advertising none.
    func testAControlWithoutAnActionIsNotPressable() throws {
        let (view, _) = try makeViewer()
        let children = try labeledChildren(of: view)

        XCTAssertFalse(
            try child(children, labeled: "Timecode") is StudioActionAccessibilityElement)
        XCTAssertFalse(
            try child(children, labeled: "Loop marked range")
                is StudioActionAccessibilityElement)
    }

    /// ASSERTION 1 — the tree a client sees.
    func testTheViewerExposesAnAccessibilityTreeToAClient() throws {
        let (view, _) = try makeViewer()

        XCTAssertTrue(view.isAccessibilityElement())
        XCTAssertEqual(view.accessibilityRole(), .group)
        XCTAssertEqual(view.accessibilityLabel(), "Studio viewer")

        let children = try labeledChildren(of: view)
        XCTAssertFalse(
            children.isEmpty,
            "an empty tree is what an assistive client sees regardless of what "
                + "the descriptor array holds")

        // Read every child the way a client does, not by peeking at descriptors.
        for child in children {
            let role = child.accessibilityRole()
            XCTAssertNotNil(role, "a child with no role is unreachable")
            XCTAssertTrue(
                [.slider, .staticText, .button].contains(role),
                "unexpected role \(String(describing: role))")
            let label = try XCTUnwrap(child.accessibilityLabel())
            XCTAssertFalse(label.isEmpty, "an unlabelled control cannot be announced")
            XCTAssertNotNil(child.accessibilityValue())
            XCTAssertTrue(
                child.accessibilityParent() as? StudioViewerView === view,
                "an unparented element is not in the tree")
        }

        // The controls the transport actually has, read through the API.
        let labels = children.compactMap { $0.accessibilityLabel() }
        XCTAssertTrue(labels.contains("Playhead"), "labels seen by a client: \(labels)")
        XCTAssertEqual(
            children.filter { $0.accessibilityRole() == .slider }.count, 1,
            "exactly one slider: the playhead")
    }

    /// ASSERTION 2 — identity is stable while the timecode runs.
    ///
    /// This is @Challenge2's Finding 1 fix (64ed303e6) checked AT THE LAYER THAT
    /// MATTERS. The original defect rebuilt children at frame rate because the
    /// descriptor value carried the running timecode; the fix has only ever been
    /// verified beneath the AX surface, never through it.
    func testElementIdentityIsStableWhileTheTimecodeRuns() throws {
        let (view, _) = try makeViewer()
        let before = try labeledChildren(of: view)
        let identitiesBefore = before.map(ObjectIdentifier.init)

        // Drive real frames with a moving position.
        let host = CACurrentMediaTime()
        view.transport.play(atHost: host)
        for step in 1...30 {
            view.transport.seek(toTicks: Int64(step) * 100, atHost: host + Double(step) / 60)
            view.renderCurrentFrame()
        }

        let after = try labeledChildren(of: view)
        XCTAssertEqual(after.count, before.count)
        XCTAssertEqual(
            after.map(ObjectIdentifier.init), identitiesBefore,
            "children were reallocated during playback — an assistive client is "
                + "handed a moving target and the churn lands exactly where it "
                + "costs most")
    }

    /// ASSERTION 3 — THE CONTROL, and it is not optional.
    ///
    /// A frozen descriptor, or a tree that never rebuilds because it never
    /// populates, passes assertion 2 trivially. Stability is indistinguishable
    /// from deadness unless the value is also shown to move. Both, or neither
    /// means anything.
    func testTheSpokenValueStillMovesWhileIdentityHolds() throws {
        let (view, _) = try makeViewer()
        let children = try labeledChildren(of: view)
        let playhead = try child(children, labeled: "Playhead")
        let identityBefore = ObjectIdentifier(playhead)
        let spokenBefore = try XCTUnwrap(playhead.accessibilityValueDescription())
        let ticksBefore = try XCTUnwrap(playhead.accessibilityValue() as? NSNumber)

        let host = CACurrentMediaTime()
        view.transport.seek(toTicks: 3000, atHost: host)
        view.renderCurrentFrame()

        let after = try labeledChildren(of: view)
        let playheadAfter = try child(after, labeled: "Playhead")
        XCTAssertEqual(
            ObjectIdentifier(playheadAfter), identityBefore,
            "the value must be updated IN PLACE, not by replacing the element")
        let spokenAfter = try XCTUnwrap(playheadAfter.accessibilityValueDescription())
        let ticksAfter = try XCTUnwrap(playheadAfter.accessibilityValue() as? NSNumber)
        XCTAssertNotEqual(
            spokenAfter, spokenBefore,
            "the spoken value never changed after a 3000-tick seek — a stable "
                + "tree that reports nothing is dead, not efficient")
        XCTAssertNotEqual(ticksAfter, ticksBefore)
        XCTAssertGreaterThan(ticksAfter.int64Value, 0)
    }

    /// VoiceOver must be able to scrub. Setting the Playhead value seeks the
    /// existing transport; it must not grow a second clock.
    func testSettingThePlayheadValueMovesTheOneTransport() throws {
        let (view, _) = try makeViewer()
        let host = CACurrentMediaTime()
        view.transport.pause(atHost: host)
        view.transport.seek(toTicks: 0, atHost: host)
        view.renderCurrentFrame()

        let children = try labeledChildren(of: view)
        let playhead = try XCTUnwrap(
            children.first { $0 is StudioPlayheadAccessibilityElement }
                as? StudioPlayheadAccessibilityElement)

        XCTAssertTrue(playhead.apply(NSNumber(value: 3000)))
        playhead.accessibilitySetValue(NSNumber(value: 3000), forAttribute: .value)

        XCTAssertEqual(
            view.transport.clock.snapshot(atHost: CACurrentMediaTime()).positionTicks,
            3000,
            "an AX value-set must seek the existing StudioTransportController")
        playhead.accessibilityPerformAction(.decrement)
        XCTAssertEqual(
            view.transport.clock.snapshot(atHost: CACurrentMediaTime()).frameIndex,
            149,
            "VoiceOver decrement is a one-frame step on the same transport")
    }

    /// THE CONTROL. Reverting the binding must make the same AX value-set a
    /// no-op. If this still seeks, the slider is a backdoor, not a binding.
    func testRevertingThePlayheadBindingLeavesTheTransport() throws {
        let (view, _) = try makeViewer()
        let host = CACurrentMediaTime()
        view.transport.pause(atHost: host)
        view.transport.seek(toTicks: 1200, atHost: host)
        view.playheadAccessibilityBinding = StudioPlayheadAccessibilityBinding(isBound: false)
        view.renderCurrentFrame()

        let children = try labeledChildren(of: view)
        let playhead = try XCTUnwrap(
            children.first { $0 is StudioPlayheadAccessibilityElement }
                as? StudioPlayheadAccessibilityElement)
        XCTAssertFalse(playhead.apply(NSNumber(value: 4000)))
        playhead.accessibilitySetValue(NSNumber(value: 4000), forAttribute: .value)
        playhead.accessibilityPerformAction(.increment)
        XCTAssertEqual(
            view.transport.clock.snapshot(atHost: CACurrentMediaTime()).positionTicks,
            1200,
            "reverting the binding must fail this control")
    }

    /// Selecting a transcript segment must reach the tree too: the band's
    /// descriptors were the reason the button role exists.
    func testTranscriptSegmentsReachTheAccessibilityTree() throws {
        let (view, _) = try makeViewer()
        view.adopt(transcript: Self.transcript)
        view.renderCurrentFrame()

        // Transcript segments are announcement buttons; the pressable
        // transport control is also a button and is not a segment.
        func segmentButtons(
            _ elements: [NSAccessibilityElement]
        ) -> [NSAccessibilityElement] {
            elements.filter {
                $0.accessibilityRole() == .button && !($0 is StudioActionAccessibilityElement)
            }
        }

        let children = try labeledChildren(of: view)
        let buttons = segmentButtons(children)
        XCTAssertEqual(buttons.count, 2, "both segments must be reachable")
        XCTAssertEqual(buttons.first?.accessibilityLabel(), "one")
        XCTAssertEqual(buttons.first?.accessibilityValue() as? String, "Not selected")

        view.selectedSegmentId = "s1"
        view.renderCurrentFrame()
        let updated = try labeledChildren(of: view)
        let selected = segmentButtons(updated)
        XCTAssertEqual(
            selected.first?.accessibilityValue() as? String, "Selected",
            "selection must be readable by a client, not only drawn")
    }

    /// @Challenge2's F-A: everything above reads the VIEW's own override. This
    /// walks DOWN from the window, the way a client enters the process, and
    /// proves the view is actually reachable — the "published but not consumed
    /// at the next layer up" shape, one layer up.
    func testAClientReachesTheViewFromTheWindow() throws {
        let (view, window) = try makeViewer()
        let windowChildren = NSAccessibility.unignoredChildren(
            from: window.accessibilityChildren() ?? [])
        XCTAssertFalse(
            windowChildren.isEmpty,
            "a client entering at the window must find something")

        // Walk down to the viewer group rather than assuming its depth.
        var frontier: [Any] = windowChildren
        var reached = false
        var depth = 0
        while !frontier.isEmpty, depth < 6, !reached {
            var next: [Any] = []
            for node in frontier {
                if let element = node as? StudioViewerView, element === view {
                    reached = true
                    break
                }
                if let kids = (node as AnyObject).accessibilityChildren?() {
                    next.append(contentsOf: kids)
                }
            }
            frontier = next
            depth += 1
        }
        XCTAssertTrue(
            reached,
            "the viewer is not reachable from the window: its accessibility tree "
                + "is correct and nothing can get to it")
    }

    /// HUD / transport descriptors already exist in Core. This is the same
    /// published-but-consumed control the Playhead already had: a client must
    /// see the named HUD controls, not merely "some static text".
    ///
    /// NOT claimed: the drawn source-label / PLAY-PAUSE status line, which the
    /// overlay still does not publish. Inventing those descriptors here would
    /// be padding the 05:00 slice.
    func testNamedHudControlsReachTheClientWithTheirRoles() throws {
        let (view, _) = try makeViewer()
        let children = try labeledChildren(of: view)
        let labels = children.compactMap { $0.accessibilityLabel() }

        let timecode = try child(children, labeled: "Timecode")
        XCTAssertEqual(timecode.accessibilityRole(), .staticText)
        XCTAssertFalse(
            (timecode.accessibilityValue() as? String ?? "").isEmpty,
            "Timecode must speak a value, not only exist")

        let loop = try child(children, labeled: "Loop marked range")
        XCTAssertEqual(
            loop.accessibilityRole(),
            .staticText,
            "looping is a status token, not an operable checkbox")
        XCTAssertEqual(loop.accessibilityValue() as? String, "off")

        let playhead = try child(children, labeled: "Playhead")
        XCTAssertEqual(playhead.accessibilityRole(), .slider)

        XCTAssertFalse(
            labels.contains("Source") || labels.contains("Transport"),
            "do not invent unpublished HUD labels in this slice: \(labels)")
    }

    /// Document order is the only HUD focus order the product has specified.
    /// Tab walks the transcript band, not these readouts. If Timecode/Loop/
    /// Playhead reorder, VoiceOver rotor order changes with them.
    func testHudDocumentOrderIsTimecodeThenLoopThenPlayhead() throws {
        let (view, _) = try makeViewer()
        let labels = try labeledChildren(of: view).compactMap { $0.accessibilityLabel() }
        let timecode = try XCTUnwrap(labels.firstIndex(of: "Timecode"), "\(labels)")
        let loop = try XCTUnwrap(labels.firstIndex(of: "Loop marked range"), "\(labels)")
        let playhead = try XCTUnwrap(labels.firstIndex(of: "Playhead"), "\(labels)")
        XCTAssertLessThan(timecode, loop)
        XCTAssertLessThan(loop, playhead)
    }

    func testInAndOutMarksReachTheClientWhenSet() throws {
        let (view, _) = try makeViewer()
        let host = CACurrentMediaTime()
        view.transport.seek(toTicks: 1200, atHost: host)
        view.transport.markIn(atHost: host)
        view.transport.seek(toTicks: 3600, atHost: host)
        view.transport.markOut(atHost: host)
        XCTAssertTrue(view.transport.setLoopingRange(true, atHost: host))
        view.renderCurrentFrame()

        let children = try labeledChildren(of: view)
        let inPoint = try child(children, labeled: "In point")
        let outPoint = try child(children, labeled: "Out point")
        XCTAssertEqual(inPoint.accessibilityRole(), .staticText)
        XCTAssertEqual(outPoint.accessibilityRole(), .staticText)
        XCTAssertEqual(inPoint.accessibilityValue() as? String, "1200")
        XCTAssertEqual(outPoint.accessibilityValue() as? String, "3600")

        let loop = try child(children, labeled: "Loop marked range")
        XCTAssertEqual(loop.accessibilityValue() as? String, "on")

        let labels = children.compactMap { $0.accessibilityLabel() }
        let inIndex = try XCTUnwrap(labels.firstIndex(of: "In point"))
        let outIndex = try XCTUnwrap(labels.firstIndex(of: "Out point"))
        let timecode = try XCTUnwrap(labels.firstIndex(of: "Timecode"))
        XCTAssertLessThan(inIndex, outIndex)
        XCTAssertLessThan(outIndex, timecode)
    }

    /// Tab is the specified keyboard focus order: timeline order, no wrap.
    /// Reading Selected/Not selected through AX is what makes that order a
    /// client-visible focus walk rather than a private selectedSegmentId.
    func testTabWalksTranscriptButtonsInTimelineOrderThroughTheTree() throws {
        let (view, window) = try makeViewer()
        view.adopt(transcript: Self.transcript)
        view.renderCurrentFrame()

        // Transcript segments are announcement buttons. The pressable
        // transport control is also a button and is deliberately excluded:
        // this walk is about focus order through the band, not every button
        // in the tree.
        func buttonValues() throws -> [String] {
            try labeledChildren(of: view)
                .filter {
                    $0.accessibilityRole() == .button
                        && !($0 is StudioActionAccessibilityElement)
                }
                .map { try XCTUnwrap($0.accessibilityValue() as? String) }
        }

        XCTAssertEqual(try buttonValues(), ["Not selected", "Not selected"])

        view.keyDown(with: makeKeyEvent(in: window, characters: "\t", keyCode: 48))
        view.renderCurrentFrame()
        XCTAssertEqual(try buttonValues(), ["Selected", "Not selected"])

        view.keyDown(with: makeKeyEvent(in: window, characters: "\t", keyCode: 48))
        view.renderCurrentFrame()
        XCTAssertEqual(try buttonValues(), ["Not selected", "Selected"])

        // No wrap: another Tab must stay on the last segment.
        view.keyDown(with: makeKeyEvent(in: window, characters: "\t", keyCode: 48))
        view.renderCurrentFrame()
        XCTAssertEqual(try buttonValues(), ["Not selected", "Selected"])

        view.keyDown(
            with: makeKeyEvent(
                in: window, characters: "\t", keyCode: 48, modifiers: .shift))
        view.renderCurrentFrame()
        XCTAssertEqual(try buttonValues(), ["Selected", "Not selected"])
    }

    /// Route window titles are the in-process identity we can honestly assert.
    /// Bundle/Dock/Cmd-Tab identity lives on the packaged .app and is in
    /// tension with permanent `.accessory` — see the Work2 report, do not
    /// flip the policy from a unit test.
    func testWindowTitleExposesRouteIdentity() throws {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device")
        }
        let timebase = try XCTUnwrap(StudioTimebase(timescale: 600, frameDurationTicks: 20))
        let authority = StudioPlaybackAuthority(
            clock: StudioPlaybackClock(timebase: timebase, durationTicks: 0))
        let source = StudioViewerWindowController(
            renderer: try StudioViewerRenderer(device: device),
            authority: authority,
            route: .source)
        let review = StudioViewerWindowController(
            renderer: try StudioViewerRenderer(device: device),
            authority: authority,
            route: .review)

        XCTAssertEqual(source.window.title, "TaskWraith Studio — Source")
        XCTAssertEqual(review.window.title, "TaskWraith Studio — Review")
        XCTAssertEqual(source.window.title, StudioViewerRoute.source.windowTitle)
        XCTAssertEqual(review.window.title, StudioViewerRoute.review.windowTitle)
        XCTAssertTrue(source.window.title.hasPrefix("TaskWraith Studio"))
        XCTAssertTrue(review.window.title.hasPrefix("TaskWraith Studio"))
        XCTAssertNotEqual(source.window.title, review.window.title)
    }

    private static let transcript = StudioTranscript(
        transcriptId: "t1", assetId: "a1",
        segments: [
            StudioTranscriptSegment(
                segmentId: "s1", text: "one",
                sourceIn: StudioRationalTime(n: 0, d: 600)!,
                sourceOut: StudioRationalTime(n: 600, d: 600)!),
            StudioTranscriptSegment(
                segmentId: "s2", text: "two",
                sourceIn: StudioRationalTime(n: 900, d: 600)!,
                sourceOut: StudioRationalTime(n: 1500, d: 600)!),
        ])
}
