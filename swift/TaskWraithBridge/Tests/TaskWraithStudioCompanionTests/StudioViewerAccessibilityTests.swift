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
            clock: StudioPlaybackClock(timebase: timebase, durationTicks: 6000))
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 540),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = view
        view.frame = NSRect(x: 0, y: 0, width: 960, height: 540)
        view.layoutSubtreeIfNeeded()
        view.renderCurrentFrame()
        return (view, window)
    }

    /// ASSERTION 1 — the tree a client sees.
    func testTheViewerExposesAnAccessibilityTreeToAClient() throws {
        let (view, _) = try makeViewer()

        XCTAssertTrue(view.isAccessibilityElement())
        XCTAssertEqual(view.accessibilityRole(), .group)
        XCTAssertEqual(view.accessibilityLabel(), "Studio viewer")

        let children = try XCTUnwrap(view.accessibilityChildren() as? [NSAccessibilityElement])
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
        let before = try XCTUnwrap(view.accessibilityChildren() as? [NSAccessibilityElement])
        let identitiesBefore = before.map(ObjectIdentifier.init)

        // Drive real frames with a moving position.
        let host = CACurrentMediaTime()
        view.transport.play(atHost: host)
        for step in 1...30 {
            view.transport.seek(toTicks: Int64(step) * 100, atHost: host + Double(step) / 60)
            view.renderCurrentFrame()
        }

        let after = try XCTUnwrap(view.accessibilityChildren() as? [NSAccessibilityElement])
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
        let children = try XCTUnwrap(view.accessibilityChildren() as? [NSAccessibilityElement])
        let playhead = try XCTUnwrap(
            children.first { $0.accessibilityLabel() == "Playhead" })
        let identityBefore = ObjectIdentifier(playhead)
        let valueBefore = try XCTUnwrap(playhead.accessibilityValue() as? String)

        let host = CACurrentMediaTime()
        view.transport.seek(toTicks: 3000, atHost: host)
        view.renderCurrentFrame()

        let after = try XCTUnwrap(view.accessibilityChildren() as? [NSAccessibilityElement])
        let playheadAfter = try XCTUnwrap(
            after.first { $0.accessibilityLabel() == "Playhead" })
        XCTAssertEqual(
            ObjectIdentifier(playheadAfter), identityBefore,
            "the value must be updated IN PLACE, not by replacing the element")
        let valueAfter = try XCTUnwrap(playheadAfter.accessibilityValue() as? String)
        XCTAssertNotEqual(
            valueAfter, valueBefore,
            "the spoken value never changed after a 3000-tick seek — a stable "
                + "tree that reports nothing is dead, not efficient")
    }

    /// Selecting a transcript segment must reach the tree too: the band's
    /// descriptors were the reason the button role exists.
    func testTranscriptSegmentsReachTheAccessibilityTree() throws {
        let (view, _) = try makeViewer()
        view.adopt(transcript: Self.transcript)
        view.renderCurrentFrame()

        let children = try XCTUnwrap(view.accessibilityChildren() as? [NSAccessibilityElement])
        let buttons = children.filter { $0.accessibilityRole() == .button }
        XCTAssertEqual(buttons.count, 2, "both segments must be reachable")
        XCTAssertEqual(buttons.first?.accessibilityLabel(), "one")
        XCTAssertEqual(buttons.first?.accessibilityValue() as? String, "Not selected")

        view.selectedSegmentId = "s1"
        view.renderCurrentFrame()
        let updated = try XCTUnwrap(view.accessibilityChildren() as? [NSAccessibilityElement])
        let selected = updated.filter { $0.accessibilityRole() == .button }
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