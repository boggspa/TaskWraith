import XCTest

@testable import TaskWraithStudioCore

/// The owner-approved briefing's two-viewer contract (00-BRIEFING.md:142-155).
///
/// Two requirements ride along with the second window and neither is optional:
/// "Hiding a route releases or hibernates its decoder/player resources; two
/// viewers must never become two clocks."
final class StudioViewerRoutesTests: XCTestCase {
    private let timebase = StudioTimebase(timescale: 600, frameDurationTicks: 20)!

    /// THE PROHIBITION. Two routes reading one authority must never disagree
    /// about time. This is asserted on a SHARED REFERENCE rather than on two
    /// values that happen to match, because value semantics would let them
    /// start together and drift apart — which looks correct for exactly as long
    /// as nobody plays anything.
    func testTwoRoutesReadOneClockRatherThanTwoThatAgree() {
        let authority = StudioPlaybackAuthority(
            clock: StudioPlaybackClock(timebase: timebase, durationTicks: 6000))

        // Two routes, modelled as two readers of the same authority.
        let source = authority
        let review = authority
        XCTAssertTrue(source === review, "the routes must share ONE authority object")

        let host = CACurrentMediaTime()
        source.transport.seek(toTicks: 1200, atHost: host)
        XCTAssertEqual(
            review.transport.clock.snapshot(atHost: host).positionTicks, 1200,
            "a seek in one route was invisible to the other — that is two clocks")

        review.transport.seek(toTicks: 3000, atHost: host)
        XCTAssertEqual(
            source.transport.clock.snapshot(atHost: host).positionTicks, 3000,
            "time must flow both ways or the authority is not shared")

        // And a new asset replaces the clock for BOTH at once.
        authority.adopt(clock: StudioPlaybackClock(timebase: timebase, durationTicks: 900))
        XCTAssertEqual(source.transport.clock.durationTicks, 900)
        XCTAssertEqual(review.transport.clock.durationTicks, 900)
    }

    /// The oscillator domain belongs to the same authority as the clock. A
    /// per-view flag lets Review feed machine uptime into a clock Source already
    /// anchored to audio, recreating the packaged end-of-media teleport.
    func testTwoRoutesShareTheHostDomainAndRetainedMutation() {
        let authority = StudioPlaybackAuthority(
            clock: StudioPlaybackClock(timebase: timebase, durationTicks: 6000))
        let source = authority
        let review = authority

        authority.didReanchorTransport(to: .audio, atHost: 4)
        XCTAssertEqual(source.transportHostSource, .audio)
        XCTAssertEqual(review.transportHostSource, .audio)
        XCTAssertEqual(source.lastAudioHostSeconds, 4)
        XCTAssertEqual(review.lastAudioHostSeconds, 4)

        authority.didObserveAudioHostSeconds(4.25)
        XCTAssertEqual(source.lastAudioHostSeconds, 4.25)
        XCTAssertEqual(review.lastAudioHostSeconds, 4.25)

        authority.didReanchorTransport(to: .machine, atHost: 100)
        XCTAssertEqual(source.transportHostSource, .machine)
        XCTAssertEqual(review.transportHostSource, .machine)
        XCTAssertEqual(source.lastAudioHostSeconds, 4.25)
    }

    /// THE OBLIGATION. Hiding must report that resources are owed, so a caller
    /// cannot silently skip the release the briefing requires.
    func testHidingARouteReportsTheResourceObligation() {
        var routes = StudioRouteVisibility()
        XCTAssertTrue(routes.isVisible(.source))
        XCTAssertFalse(routes.isVisible(.review), "Review costs decoder resources; "
            + "opening it before there is anything to review spends them for nothing")

        XCTAssertEqual(routes.toggle(.review), .shown(.review))
        XCTAssertTrue(routes.isVisible(.review))
        XCTAssertFalse(
            StudioRouteTransition.shown(.review).requiresResourceRelease,
            "showing owes nothing")

        let hidden = routes.toggle(.review)
        XCTAssertEqual(hidden, .hidden(.review))
        XCTAssertTrue(
            hidden.requiresResourceRelease,
            "hiding must oblige the caller to release that route's decoders")
        XCTAssertFalse(routes.isVisible(.review))
    }

    /// Independently toggleable, per the briefing — hiding one must not disturb
    /// the other.
    func testRoutesToggleIndependently() {
        var routes = StudioRouteVisibility(visible: [.source, .review])
        routes.toggle(.source)
        XCTAssertFalse(routes.isVisible(.source))
        XCTAssertTrue(routes.isVisible(.review), "hiding Source closed Review too")
    }

    /// A companion with no window reads as a crash and cannot be recovered
    /// without the host, so the last route refuses to hide.
    func testTheLastVisibleRouteRefusesToHide() {
        var routes = StudioRouteVisibility()
        let refused = routes.toggle(.source)
        XCTAssertEqual(refused, .refused(reason: .lastVisibleRoute))
        XCTAssertTrue(routes.isVisible(.source), "the companion must keep a window")
        XCTAssertFalse(
            refused.requiresResourceRelease,
            "a refused hide owes nothing — releasing here would blank a live window")
    }

    func testEveryRouteHasADistinctTitle() {
        let titles = Set(StudioViewerRoute.allCases.map(\.windowTitle))
        XCTAssertEqual(titles.count, StudioViewerRoute.allCases.count)
        XCTAssertTrue(StudioViewerRoute.review.windowTitle.contains("Review"))
    }
}
