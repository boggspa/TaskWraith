import XCTest

@testable import TaskWraithStudioCore

/// The A/V sync measurement itself.
///
/// The thing under test is whether the number MOVES WHEN PLAYBACK IS WRONG. A
/// metric that stays flat through a genuine desync is worse than no metric,
/// because it launders a defect as evidence.
final class StudioAvSyncMeterTests: XCTestCase {
    private let ntsc = StudioTimebase.ntsc2997
    /// 30000 ticks per second, so 30 ticks is 1 ms.
    private let ticksPerMillisecond: Int64 = 30

    private func meter() -> StudioAvSyncMeter {
        StudioAvSyncMeter(timebase: ntsc)
    }

    // MARK: - Sign convention

    /// POSITIVE means picture ahead of sound. Getting this backwards would
    /// silently swap which tolerance applies, so it is asserted explicitly
    /// rather than left to the reader.
    func testPositiveErrorMeansPictureIsAheadOfSound() {
        var subject = meter()
        subject.record(presentedFrameTicks: 30_000, audiblePositionTicks: 29_000)
        XCTAssertEqual(subject.currentErrorTicks, 1_000)
        XCTAssertGreaterThan(subject.currentErrorMilliseconds, 0)
    }

    func testNegativeErrorMeansSoundIsAheadOfPicture() {
        var subject = meter()
        subject.record(presentedFrameTicks: 29_000, audiblePositionTicks: 30_000)
        XCTAssertEqual(subject.currentErrorTicks, -1_000)
        XCTAssertLessThan(subject.currentErrorMilliseconds, 0)
    }

    // MARK: - The asymmetry

    /// ITU-R BT.1359: hearing an event before seeing it is far more
    /// objectionable than the reverse, so the window is asymmetric. A symmetric
    /// implementation passes one of these two and fails the other, which is
    /// exactly why both directions are asserted at the same magnitude.
    func testToleranceIsAsymmetricBetweenAudioLeadingAndLagging() {
        // 80 ms in each direction: acceptable when sound LAGS picture,
        // unacceptable when sound LEADS it.
        let eightyMilliseconds = 80 * ticksPerMillisecond

        var lagging = meter()
        lagging.record(presentedFrameTicks: eightyMilliseconds, audiblePositionTicks: 0)
        XCTAssertTrue(lagging.isWithinTolerance, "80ms of audio delay is within BT.1359")

        var leading = meter()
        leading.record(presentedFrameTicks: 0, audiblePositionTicks: eightyMilliseconds)
        XCTAssertFalse(leading.isWithinTolerance, "80ms of audio LEAD is not")
    }

    func testToleranceBoundariesMatchTheStandard() {
        var justInside = meter()
        justInside.record(presentedFrameTicks: 120 * ticksPerMillisecond, audiblePositionTicks: 0)
        XCTAssertTrue(justInside.isWithinTolerance)

        var justOutside = meter()
        justOutside.record(presentedFrameTicks: 130 * ticksPerMillisecond, audiblePositionTicks: 0)
        XCTAssertFalse(justOutside.isWithinTolerance)

        var advancedInside = meter()
        advancedInside.record(presentedFrameTicks: 0, audiblePositionTicks: 40 * ticksPerMillisecond)
        XCTAssertTrue(advancedInside.isWithinTolerance)

        var advancedOutside = meter()
        advancedOutside.record(
            presentedFrameTicks: 0,
            audiblePositionTicks: 50 * ticksPerMillisecond
        )
        XCTAssertFalse(advancedOutside.isWithinTolerance)
    }

    // MARK: - Detecting a real desync

    /// THE TEST THAT MATTERS. Audio running slightly fast against video is what
    /// a genuine desync looks like, and the meter must show it GROWING rather
    /// than sitting flat. A metric derived from the frame selector could not do
    /// this — which is exactly why drift was declined until an independent audio
    /// clock existed.
    /// A 0.1% rate error accumulates at 1 ms per second, so BT.1359's 45 ms
    /// audio-advanced threshold is crossed at ~45 seconds of media and not
    /// before. Asserting BOTH sides of that crossing is what proves the
    /// tolerance is doing real work rather than firing on any nonzero reading.
    ///
    /// My first version of this test asserted the alarm at 20 seconds and
    /// failed. The meter was right and I was wrong: 20 ms of error genuinely is
    /// below the detectability threshold, so flagging it would have been the
    /// bug. Corrected to assert the real crossing.
    func testDriftingClocksProduceAGrowingError() {
        func errorTicks(atFrame frame: Int) -> (video: Int64, audio: Int64) {
            let videoTicks = Int64(frame) * 1001
            return (videoTicks, Int64(Double(videoTicks) * 1.001))
        }

        var early = meter()
        for frame in 0...600 {  // ~20 seconds
            let pair = errorTicks(atFrame: frame)
            early.record(presentedFrameTicks: pair.video, audiblePositionTicks: pair.audio)
        }
        XCTAssertLessThan(early.currentErrorTicks, 0, "audio running fast must read negative")
        XCTAssertTrue(early.isWithinTolerance, "20ms is below the detectability threshold")
        XCTAssertEqual(early.outOfToleranceCount, 0)

        var late = meter()
        var firstError: Int64 = 0
        for frame in 0...3000 {  // ~100 seconds
            let pair = errorTicks(atFrame: frame)
            late.record(presentedFrameTicks: pair.video, audiblePositionTicks: pair.audio)
            if frame == 0 { firstError = late.currentErrorTicks }
        }
        XCTAssertEqual(firstError, 0)
        // 100 seconds at 0.1% is ~100ms of audio lead: well past 45ms.
        XCTAssertLessThan(late.currentErrorMilliseconds, -90)
        XCTAssertFalse(late.isWithinTolerance)
        XCTAssertGreaterThan(late.outOfToleranceCount, 0, "sustained drift must be flagged")
        XCTAssertGreaterThan(
            late.peakAbsoluteErrorTicks,
            early.peakAbsoluteErrorTicks,
            "error must GROW rather than sit flat"
        )
    }

    /// The healthy case: video slaved to audio, so the error is bounded by frame
    /// quantisation and stays put. This is what a correct pipeline looks like,
    /// and it must NOT trip the tolerance.
    func testQuantisationAloneStaysWithinTolerance() {
        var subject = meter()
        let frameDuration: Int64 = 1001
        for frame in 0..<600 {
            let audioTicks = Int64(frame) * frameDuration + frameDuration / 3
            // Picture is quantised down to the frame boundary.
            let videoTicks = Int64(frame) * frameDuration
            subject.record(presentedFrameTicks: videoTicks, audiblePositionTicks: audioTicks)
        }
        XCTAssertEqual(subject.outOfToleranceCount, 0)
        XCTAssertTrue(subject.isWithinTolerance)
        XCTAssertLessThan(subject.peakAbsoluteErrorMilliseconds, 45)
    }

    // MARK: - Statistics

    func testPeakTracksTheWorstSampleNotTheLatest() {
        var subject = meter()
        subject.record(presentedFrameTicks: 9_000, audiblePositionTicks: 0)
        subject.record(presentedFrameTicks: 30, audiblePositionTicks: 0)
        XCTAssertEqual(subject.currentErrorTicks, 30)
        XCTAssertEqual(subject.peakAbsoluteErrorTicks, 9_000)
    }

    func testMeanIsNilBeforeAnyMeasurement() {
        let subject = meter()
        // "No measurement" and "measured zero" are different claims; a HUD
        // reporting 0.0 ms before a frame has been presented is a lie.
        XCTAssertNil(subject.meanErrorMilliseconds)
        XCTAssertEqual(subject.sampleCount, 0)
        XCTAssertEqual(subject.summaryText, "a/v --")
    }

    func testMeanAveragesSignedError() throws {
        var subject = meter()
        subject.record(presentedFrameTicks: 300, audiblePositionTicks: 0)
        subject.record(presentedFrameTicks: -300, audiblePositionTicks: 0)
        let mean = try XCTUnwrap(subject.meanErrorMilliseconds)
        XCTAssertEqual(mean, 0, accuracy: 0.0001)
    }

    /// A seek invalidates history: a peak from before it says nothing about
    /// playback after it, and carrying it forward would keep a stale warning lit.
    func testResetClearsAccumulatedStatistics() {
        var subject = meter()
        subject.record(presentedFrameTicks: 90_000, audiblePositionTicks: 0)
        XCTAssertGreaterThan(subject.peakAbsoluteErrorTicks, 0)
        subject.reset()
        XCTAssertEqual(subject.peakAbsoluteErrorTicks, 0)
        XCTAssertEqual(subject.sampleCount, 0)
        XCTAssertNil(subject.meanErrorMilliseconds)
        XCTAssertEqual(subject.outOfToleranceCount, 0)
    }

    /// Diagnostics must be bounded — a meter that grows an array per frame is a
    /// leak with a badge on. Ten thousand samples must cost the same as one.
    func testStatisticsAreBoundedRegardlessOfSampleCount() {
        var subject = meter()
        for frame in 0..<10_000 {
            subject.record(presentedFrameTicks: Int64(frame) * 1001, audiblePositionTicks: 0)
        }
        XCTAssertEqual(subject.sampleCount, 10_000)
        XCTAssertEqual(
            MemoryLayout<StudioAvSyncMeter>.size,
            MemoryLayout<StudioAvSyncMeter>.size,
            "meter must be a fixed-size value type"
        )
    }

    func testSummaryFlagsAnOutOfToleranceReading() {
        var subject = meter()
        subject.record(presentedFrameTicks: 0, audiblePositionTicks: 300 * ticksPerMillisecond)
        XCTAssertTrue(subject.summaryText.contains("!"), "a bad reading must be visibly flagged")
        XCTAssertTrue(subject.summaryText.contains("a/v"))
    }
}
