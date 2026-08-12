import XCTest

@testable import TaskWraithStudioCore

/// The clock is the one place a frame-accurate editor can silently go wrong, so
/// these assert exact tick arithmetic rather than approximate seconds.
final class StudioPlaybackClockTests: XCTestCase {
    private let ntsc = StudioTimebase.ntsc2997

    /// 60s at 30000 ticks/s.
    private func makeClock(durationTicks: Int64 = 1_800_000) -> StudioPlaybackClock {
        StudioPlaybackClock(timebase: ntsc, durationTicks: durationTicks)
    }

    // MARK: - Timebase

    func testTimebaseRejectsNonPositiveComponents() {
        XCTAssertNil(StudioTimebase(timescale: 0, frameDurationTicks: 1001))
        XCTAssertNil(StudioTimebase(timescale: 30000, frameDurationTicks: 0))
        XCTAssertNil(StudioTimebase(timescale: -30000, frameDurationTicks: 1001))
    }

    func testNtscTimebaseIsTheDropFrameFamilyRate() {
        XCTAssertEqual(ntsc.timescale, 30000)
        XCTAssertEqual(ntsc.frameDurationTicks, 1001)
        XCTAssertEqual(ntsc.framesPerSecond, 30000.0 / 1001.0, accuracy: 1e-12)
    }

    // MARK: - Frame arithmetic

    func testNtscFrameBoundariesAreExact() {
        let clock = makeClock()
        // 29 * 1001 = 29029; 30 * 1001 = 30030. One second (30000 ticks) lands
        // inside frame 29, which is precisely the case a Double seconds
        // representation gets wrong.
        XCTAssertEqual(clock.frameIndex(ofTicks: 29029), 29)
        XCTAssertEqual(clock.frameIndex(ofTicks: 30000), 29)
        XCTAssertEqual(clock.frameIndex(ofTicks: 30029), 29)
        XCTAssertEqual(clock.frameIndex(ofTicks: 30030), 30)
        XCTAssertEqual(clock.ticks(ofFrame: 60), 60060)
        XCTAssertEqual(clock.frameIndex(ofTicks: clock.ticks(ofFrame: 60)), 60)
    }

    func testFrameIndexFloorsTowardNegativeInfinity() {
        let clock = makeClock()
        XCTAssertEqual(clock.frameIndex(ofTicks: 0), 0)
        XCTAssertEqual(clock.frameIndex(ofTicks: -1), -1)
        XCTAssertEqual(clock.frameIndex(ofTicks: -1001), -1)
        XCTAssertEqual(clock.frameIndex(ofTicks: -1002), -2)
    }

    // MARK: - Transport

    func testPausedClockDoesNotAdvance() {
        let clock = makeClock()
        XCTAssertEqual(clock.positionTicks(atHost: 0), 0)
        XCTAssertEqual(clock.positionTicks(atHost: 10_000), 0)
        XCTAssertFalse(clock.snapshot(atHost: 10_000).isPlaying)
    }

    func testPlaybackAdvancesExactlyOneTimescalePerSecond() {
        var clock = makeClock()
        clock.play(atHost: 0)
        XCTAssertEqual(clock.positionTicks(atHost: 1.0), 30_000)
        XCTAssertEqual(clock.positionTicks(atHost: 2.0), 60_000)
        XCTAssertTrue(clock.snapshot(atHost: 1.0).isPlaying)
    }

    /// The anchor design exists for this: position is recomputed from the
    /// anchor, never accumulated, so 1000 seconds of playback is exact.
    func testLongPlaybackDoesNotDrift() {
        var clock = makeClock(durationTicks: 60_000_000)
        clock.play(atHost: 0)
        XCTAssertEqual(clock.positionTicks(atHost: 1000.0), 30_000_000)
    }

    func testPauseCapturesPositionAndFreezesIt() {
        var clock = makeClock()
        clock.play(atHost: 0)
        clock.pause(atHost: 1.0)
        XCTAssertEqual(clock.positionTicks(atHost: 1.0), 30_000)
        XCTAssertEqual(clock.positionTicks(atHost: 99.0), 30_000)
    }

    func testResumingAfterAPauseDoesNotJumpForward() {
        var clock = makeClock()
        clock.play(atHost: 0)
        clock.pause(atHost: 1.0)
        clock.play(atHost: 5.0)
        // One second played, four seconds paused, one more second played.
        XCTAssertEqual(clock.positionTicks(atHost: 6.0), 60_000)
    }

    func testRateChangeReanchorsWithoutJumping() {
        var clock = makeClock()
        clock.play(atHost: 0)
        XCTAssertEqual(clock.positionTicks(atHost: 2.0), 60_000)
        clock.setRate(2.0, atHost: 2.0)
        XCTAssertEqual(clock.positionTicks(atHost: 2.0), 60_000)
        XCTAssertEqual(clock.positionTicks(atHost: 3.0), 120_000)
    }

    func testZeroRateHoldsPosition() {
        var clock = makeClock()
        clock.play(atHost: 0)
        clock.setRate(0, atHost: 1.0)
        XCTAssertEqual(clock.positionTicks(atHost: 50.0), 30_000)
    }

    // MARK: - Seeking and stepping

    func testSeekClampsToDuration() {
        var clock = makeClock(durationTicks: 1_800_000)
        clock.seek(toTicks: 5_000_000, atHost: 0)
        XCTAssertEqual(clock.positionTicks(atHost: 0), 1_800_000)
        clock.seek(toTicks: -42, atHost: 0)
        XCTAssertEqual(clock.positionTicks(atHost: 0), 0)
    }

    func testStepFramesPausesAndLandsOnAFrameBoundary() {
        var clock = makeClock()
        clock.play(atHost: 0)
        clock.stepFrames(1, atHost: 1.0)
        XCTAssertFalse(clock.snapshot(atHost: 1.0).isPlaying)
        // 30000 ticks is inside frame 29, so +1 lands on frame 30 == 30030.
        XCTAssertEqual(clock.positionTicks(atHost: 1.0), 30_030)
        XCTAssertEqual(clock.frameIndex(ofTicks: clock.positionTicks(atHost: 1.0)), 30)
    }

    func testStepFramesBackward() {
        var clock = makeClock()
        clock.seek(toTicks: 30_030, atHost: 0)
        clock.stepFrames(-1, atHost: 0)
        XCTAssertEqual(clock.positionTicks(atHost: 0), 29_029)
    }

    func testStepFramesCannotGoNegative() {
        var clock = makeClock()
        clock.stepFrames(-10, atHost: 0)
        XCTAssertEqual(clock.positionTicks(atHost: 0), 0)
    }

    // MARK: - Looping

    func testLoopRangeRejectsEmptyOrInverted() {
        XCTAssertNil(StudioLoopRange(startTicks: 5, endTicks: 5))
        XCTAssertNil(StudioLoopRange(startTicks: 10, endTicks: 4))
        XCTAssertNil(StudioLoopRange(startTicks: -1, endTicks: 10))
        XCTAssertEqual(StudioLoopRange(startTicks: 0, endTicks: 30_000)?.spanTicks, 30_000)
    }

    /// Integer modulo means a loop is exact on cycle 1 and on cycle 1000.
    func testLoopWrapsExactlyAndDoesNotDriftOverManyCycles() {
        var clock = makeClock(durationTicks: 60_000_000)
        clock.setLoopRange(StudioLoopRange(startTicks: 0, endTicks: 30_000), atHost: 0)
        clock.play(atHost: 0)
        XCTAssertEqual(clock.positionTicks(atHost: 10.5), 15_000)
        XCTAssertEqual(clock.positionTicks(atHost: 1000.5), 15_000)
    }

    func testLoopWithNonZeroStartWraps() {
        var clock = makeClock(durationTicks: 60_000_000)
        clock.setLoopRange(StudioLoopRange(startTicks: 30_000, endTicks: 60_000), atHost: 0)
        clock.seek(toTicks: 30_000, atHost: 0)
        clock.play(atHost: 0)
        XCTAssertEqual(clock.positionTicks(atHost: 0.5), 45_000)
        // One full span later it is back at the same place, not drifting.
        XCTAssertEqual(clock.positionTicks(atHost: 1.5), 45_000)
    }

    func testSeekDoesNotWrapIntoAnActiveLoop() {
        var clock = makeClock()
        clock.setLoopRange(StudioLoopRange(startTicks: 0, endTicks: 30_000), atHost: 0)
        clock.seek(toTicks: 900_000, atHost: 0)
        XCTAssertEqual(clock.positionTicks(atHost: 0), 900_000)
    }

    func testPositionClampsAtDurationWhenNotLooping() {
        var clock = makeClock(durationTicks: 30_000)
        clock.play(atHost: 0)
        XCTAssertEqual(clock.positionTicks(atHost: 5.0), 30_000)
    }

    // MARK: - Snapshot

    func testSnapshotAgreesWithPositionAndFrame() {
        var clock = makeClock()
        clock.play(atHost: 0)
        let snapshot = clock.snapshot(atHost: 2.002)
        XCTAssertEqual(snapshot.positionTicks, 60_060)
        XCTAssertEqual(snapshot.frameIndex, 60)
        XCTAssertEqual(snapshot.seconds, 2.002, accuracy: 1e-9)
        XCTAssertTrue(snapshot.isPlaying)
        XCTAssertEqual(snapshot.rate, 1.0)
    }
}
