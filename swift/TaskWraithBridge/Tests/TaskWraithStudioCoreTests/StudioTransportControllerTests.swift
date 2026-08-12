import XCTest

@testable import TaskWraithStudioCore

/// Source/Audition transport behaviour (mission outcome 2).
///
/// Everything here ends in a StudioPlaybackClock mutation, so these also assert
/// that the editorial layer never grows a second playhead.
final class StudioTransportControllerTests: XCTestCase {
    /// 30fps integer timebase so ticks and frames read identically.
    private func makeController(durationTicks: Int64 = 600) -> StudioTransportController {
        StudioTransportController(
            clock: StudioPlaybackClock(
                timebase: StudioTimebase(timescale: 30, frameDurationTicks: 1)!,
                durationTicks: durationTicks
            )
        )
    }

    // MARK: - Marks

    func testMarkingInAndOutProducesAHalfOpenRange() {
        var transport = makeController()
        transport.seek(toFrame: 10, atHost: 0)
        transport.markIn(atHost: 0)
        transport.seek(toFrame: 25, atHost: 0)
        transport.markOut(atHost: 0)

        XCTAssertEqual(transport.inPointTicks, 10)
        XCTAssertEqual(transport.outPointTicks, 25)
        XCTAssertTrue(transport.hasCompleteRange)
        XCTAssertEqual(transport.markedRange?.startTicks, 10)
        XCTAssertEqual(
            transport.markedRange?.endTicks,
            25,
            "Out is the exclusive end, matching the host's half-open insert_range"
        )
    }

    /// An inverted or empty range is a mis-click, not a range to repair.
    func testInvertedOrEmptyMarksProduceNoRange() {
        var transport = makeController()
        transport.seek(toFrame: 30, atHost: 0)
        transport.markIn(atHost: 0)
        transport.seek(toFrame: 12, atHost: 0)
        transport.markOut(atHost: 0)
        XCTAssertNil(transport.markedRange)
        XCTAssertFalse(transport.hasCompleteRange)

        transport.seek(toFrame: 30, atHost: 0)
        transport.markOut(atHost: 0)
        XCTAssertNil(transport.markedRange, "a zero-length range is not a range")
    }

    func testMarksSnapToFrameBoundaries() {
        var transport = StudioTransportController(
            clock: StudioPlaybackClock(timebase: .ntsc2997, durationTicks: 1_800_000)
        )
        // 30000 ticks sits inside frame 29 (29 * 1001 = 29029).
        transport.seek(toTicks: 30_000, atHost: 0)
        transport.markIn(atHost: 0)
        XCTAssertEqual(transport.inPointTicks, 29_029, "marks must land exactly on a frame")
    }

    func testClearingMarksAlsoClearsTheClockLoop() {
        var transport = makeController()
        transport.seek(toFrame: 5, atHost: 0)
        transport.markIn(atHost: 0)
        transport.seek(toFrame: 15, atHost: 0)
        transport.markOut(atHost: 0)
        XCTAssertTrue(transport.setLoopingRange(true, atHost: 0))

        transport.clearMarks(atHost: 0)
        XCTAssertNil(transport.markedRange)
        XCTAssertFalse(transport.isLoopingRange)
        XCTAssertNil(transport.clock.loopRange, "the clock must not keep looping a cleared range")
    }

    // MARK: - Range playback

    func testLoopingWithoutACompleteRangeIsRefusedRatherThanLoopingEverything() {
        var transport = makeController()
        XCTAssertFalse(
            transport.setLoopingRange(true, atHost: 0),
            "with no marks there is nothing to loop"
        )
        XCTAssertFalse(transport.isLoopingRange)
        XCTAssertNil(transport.clock.loopRange)
    }

    func testPlayRangeJumpsToInAndPlays() {
        var transport = makeController()
        transport.seek(toFrame: 100, atHost: 0)
        transport.markIn(atHost: 0)
        transport.seek(toFrame: 130, atHost: 0)
        transport.markOut(atHost: 0)
        transport.seek(toFrame: 400, atHost: 0)

        XCTAssertTrue(transport.playRange(atHost: 0))
        let snapshot = transport.clock.snapshot(atHost: 0)
        XCTAssertEqual(snapshot.positionTicks, 100, "play-range starts at In")
        XCTAssertTrue(snapshot.isPlaying)
        XCTAssertNil(transport.clock.loopRange, "looping is off, so this plays through")
    }

    func testPlayRangeLoopsWhenLoopingIsEngaged() {
        var transport = makeController()
        transport.seek(toFrame: 10, atHost: 0)
        transport.markIn(atHost: 0)
        transport.seek(toFrame: 40, atHost: 0)
        transport.markOut(atHost: 0)
        XCTAssertTrue(transport.setLoopingRange(true, atHost: 0))
        XCTAssertTrue(transport.playRange(atHost: 0))

        XCTAssertEqual(transport.clock.loopRange?.startTicks, 10)
        XCTAssertEqual(transport.clock.loopRange?.endTicks, 40)
        // One second at 30fps from frame 10 wraps the 30-frame range back to 10.
        XCTAssertEqual(transport.clock.positionTicks(atHost: 1.0), 10)
    }

    /// Re-marking mid-loop must move the loop, not leave the clock cycling the
    /// range the marks no longer describe.
    func testRemarkingWhileLoopingUpdatesTheClockLoop() {
        var transport = makeController()
        transport.seek(toFrame: 0, atHost: 0)
        transport.markIn(atHost: 0)
        transport.seek(toFrame: 30, atHost: 0)
        transport.markOut(atHost: 0)
        XCTAssertTrue(transport.setLoopingRange(true, atHost: 0))
        XCTAssertEqual(transport.clock.loopRange?.endTicks, 30)

        transport.seek(toFrame: 60, atHost: 0)
        transport.markOut(atHost: 0)
        XCTAssertEqual(
            transport.clock.loopRange?.endTicks,
            60,
            "the live loop must follow the new Out point"
        )
    }

    func testInvalidatingTheRangeWhileLoopingDisengagesLooping() {
        var transport = makeController()
        transport.seek(toFrame: 10, atHost: 0)
        transport.markIn(atHost: 0)
        transport.seek(toFrame: 40, atHost: 0)
        transport.markOut(atHost: 0)
        XCTAssertTrue(transport.setLoopingRange(true, atHost: 0))

        // Move In past Out; the range is no longer valid.
        transport.setInPoint(ticks: 50, atHost: 0)
        XCTAssertNil(transport.markedRange)
        XCTAssertFalse(transport.isLoopingRange)
        XCTAssertNil(transport.clock.loopRange)
    }

    // MARK: - Scrub

    /// Scrubbing while playing must pause, follow, then RESTORE playback.
    func testScrubbingWhilePlayingPausesAndResumes() {
        var transport = makeController()
        transport.play(atHost: 0)
        XCTAssertTrue(transport.clock.snapshot(atHost: 0.5).isPlaying)

        transport.beginScrub(atHost: 0.5)
        XCTAssertTrue(transport.isScrubbing)
        XCTAssertFalse(
            transport.clock.snapshot(atHost: 0.5).isPlaying,
            "the playhead must follow the gesture, not race it"
        )

        transport.updateScrub(toFrame: 200, atHost: 0.6)
        XCTAssertEqual(transport.clock.snapshot(atHost: 0.6).positionTicks, 200)

        transport.endScrub(atHost: 0.7)
        XCTAssertFalse(transport.isScrubbing)
        XCTAssertTrue(
            transport.clock.snapshot(atHost: 0.7).isPlaying,
            "playback was running before the scrub, so it must resume"
        )
    }

    /// And scrubbing while paused must leave it paused.
    func testScrubbingWhilePausedDoesNotStartPlayback() {
        var transport = makeController()
        transport.pause(atHost: 0)

        transport.beginScrub(atHost: 0)
        transport.updateScrub(toFrame: 90, atHost: 0.1)
        transport.endScrub(atHost: 0.2)

        let snapshot = transport.clock.snapshot(atHost: 0.2)
        XCTAssertFalse(snapshot.isPlaying, "a scrub must not start playback that was not running")
        XCTAssertEqual(snapshot.positionTicks, 90)
    }

    func testScrubUpdatesAreIgnoredOutsideAGesture() {
        var transport = makeController()
        transport.seek(toFrame: 10, atHost: 0)
        transport.updateScrub(toFrame: 500, atHost: 0)
        XCTAssertEqual(
            transport.clock.snapshot(atHost: 0).positionTicks,
            10,
            "an update without a begin is not a seek"
        )
        transport.endScrub(atHost: 0)  // idempotent, must not resume anything
        XCTAssertFalse(transport.clock.snapshot(atHost: 0).isPlaying)
    }

    // MARK: - Timecode

    func testTimecodeEntrySeeksToTheExactFrame() throws {
        var transport = StudioTransportController(
            clock: StudioPlaybackClock(timebase: .ntsc2997, durationTicks: 108_000 * 1001)
        )
        try transport.seek(toTimecodeText: "00:00:10:00", atHost: 0)
        XCTAssertEqual(transport.clock.snapshot(atHost: 0).frameIndex, 300)

        // Drop-frame entry lands on the frame that label denotes.
        try transport.seek(toTimecodeText: "00:01:00;02", atHost: 0)
        XCTAssertEqual(transport.clock.snapshot(atHost: 0).frameIndex, 1800)
    }

    func testCurrentTimecodeReflectsThePlayhead() throws {
        // Duration must cover frame 1800 exactly (1800 * 1001 ticks), or the
        // clock clamps and the timecode reads the last representable frame —
        // which is correct behaviour and caught this fixture being too short.
        var transport = StudioTransportController(
            clock: StudioPlaybackClock(timebase: .ntsc2997, durationTicks: 1800 * 1001)
        )
        transport.seek(toFrame: 1800, atHost: 0)
        XCTAssertEqual(try transport.currentTimecode(atHost: 0).text, "00:01:00:00")
        XCTAssertEqual(
            try transport.currentTimecode(atHost: 0, dropFrame: true).text,
            "00:01:00;02"
        )
    }

    /// A bad entry must not move the playhead somewhere approximate.
    func testRejectedTimecodeEntryLeavesThePlayheadAlone() {
        var transport = makeController()
        transport.seek(toFrame: 42, atHost: 0)
        XCTAssertThrowsError(try transport.seek(toTimecodeText: "not a timecode", atHost: 0))
        XCTAssertEqual(transport.clock.snapshot(atHost: 0).positionTicks, 42)
    }
}
