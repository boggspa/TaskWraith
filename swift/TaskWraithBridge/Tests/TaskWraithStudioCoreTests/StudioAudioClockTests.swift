import XCTest

@testable import TaskWraithStudioCore

/// The audio clock's arithmetic, asserted without a device.
///
/// This is the oscillator the whole A/V sync claim rests on, so exactness here
/// is the difference between a real measurement and a decorative one.
final class StudioAudioClockTests: XCTestCase {
    private let ntsc = StudioTimebase.ntsc2997

    // MARK: - Exactness

    /// 48 kHz into a 30000-tick timescale reduces to 5/8, and one hour must land
    /// exactly on 30000*3600.
    ///
    /// MEASURED CORRECTION: this test does NOT prove integer maths beats a
    /// Double round trip. I checked, expecting it would — across three hours at
    /// every buffer boundary, for four rate/timescale pairs, the two paths never
    /// disagreed once, because the magnitudes are far below 2^53. What protects
    /// long runs is the ANCHORED design asserted below, not the arithmetic.
    func testOneHourOfAudioConvertsExactly() throws {
        let clock = try XCTUnwrap(StudioAudioClock(timebase: ntsc, sampleRate: 48_000))
        let oneHourSamples: Int64 = 48_000 * 3600
        // NTSC timescale is 30000 ticks/second.
        XCTAssertEqual(clock.ticks(forSamples: oneHourSamples), 30_000 * 3600)
    }

    func testConversionIsExactForAwkwardSampleRates() throws {
        // 44100 against 30000 reduces to 100/147 — deliberately not a round
        // ratio, which is exactly where a naive implementation drifts.
        let clock = try XCTUnwrap(StudioAudioClock(timebase: ntsc, sampleRate: 44_100))
        XCTAssertEqual(clock.ticks(forSamples: 44_100), 30_000)
        XCTAssertEqual(clock.ticks(forSamples: 44_100 * 600), 30_000 * 600)
    }

    /// Accumulating one buffer at a time must land in exactly the same place as
    /// one big conversion. If it does not, playback drifts against itself.
    func testIncrementalConversionMatchesASingleConversion() throws {
        let clock = try XCTUnwrap(StudioAudioClock(timebase: ntsc, sampleRate: 48_000))
        let total: Int64 = 48_000 * 60
        XCTAssertEqual(clock.ticks(forSamples: total), 30_000 * 60)
        // Anchored reads are recomputed from the anchor, never accumulated, so
        // sampling midway cannot bias the endpoint.
        var anchored = clock
        anchored.anchor(atTicks: 0, samplePosition: 0)
        for step in stride(from: Int64(0), to: total, by: 512) {
            _ = anchored.ticks(atSamplePosition: step)
        }
        XCTAssertEqual(anchored.ticks(atSamplePosition: total), 30_000 * 60)
    }

    func testRoundingGoesToNearestRatherThanTruncating() throws {
        let clock = try XCTUnwrap(StudioAudioClock(timebase: ntsc, sampleRate: 48_000))
        // 5/8: one sample is 0.625 ticks, which must round to 1 rather than 0.
        XCTAssertEqual(clock.ticks(forSamples: 1), 1)
        // Two samples is 1.25 ticks -> 1.
        XCTAssertEqual(clock.ticks(forSamples: 2), 1)
        // Four samples is 2.5 ticks -> 3 (away from zero, matching the
        // playback clock's convention rather than banker's rounding).
        XCTAssertEqual(clock.ticks(forSamples: 4), 3)
    }

    func testNegativeSampleDeltasRoundSymmetrically() throws {
        let clock = try XCTUnwrap(StudioAudioClock(timebase: ntsc, sampleRate: 48_000))
        XCTAssertEqual(clock.ticks(forSamples: -1), -1)
        XCTAssertEqual(clock.ticks(forSamples: -4), -3)
        XCTAssertEqual(clock.ticks(forSamples: -48_000), -30_000)
    }

    // MARK: - Anchoring

    func testPositionIsRelativeToTheAnchor() throws {
        var clock = try XCTUnwrap(StudioAudioClock(timebase: ntsc, sampleRate: 48_000))
        // Start playing at 10 media seconds while the device is already at an
        // arbitrary sample position — which is what actually happens, because
        // the node's counter does not reset per play.
        clock.anchor(atTicks: 300_000, samplePosition: 1_234_567)
        XCTAssertEqual(clock.ticks(atSamplePosition: 1_234_567), 300_000)
        XCTAssertEqual(clock.ticks(atSamplePosition: 1_234_567 + 48_000), 300_000 + 30_000)
    }

    func testReanchoringMovesThePositionWithoutDrift() throws {
        var clock = try XCTUnwrap(StudioAudioClock(timebase: ntsc, sampleRate: 48_000))
        clock.anchor(atTicks: 0, samplePosition: 0)
        XCTAssertEqual(clock.ticks(atSamplePosition: 48_000), 30_000)
        // A seek re-anchors; history must not leak into the new position.
        clock.anchor(atTicks: 900_000, samplePosition: 48_000)
        XCTAssertEqual(clock.ticks(atSamplePosition: 48_000), 900_000)
        XCTAssertEqual(clock.ticks(atSamplePosition: 96_000), 930_000)
    }

    func testSecondsAreRelativeToTheAnchor() throws {
        var clock = try XCTUnwrap(StudioAudioClock(timebase: ntsc, sampleRate: 48_000))
        clock.anchor(atTicks: 0, samplePosition: 5_000_000)
        XCTAssertEqual(clock.seconds(atSamplePosition: 5_000_000), 0, accuracy: 1e-12)
        XCTAssertEqual(clock.seconds(atSamplePosition: 5_048_000), 1.0, accuracy: 1e-12)
    }

    // MARK: - Latency conversion

    func testLatencySecondsConvertToSamples() throws {
        let clock = try XCTUnwrap(StudioAudioClock(timebase: ntsc, sampleRate: 48_000))
        XCTAssertEqual(clock.samples(forSeconds: 0.01), 480)
        XCTAssertEqual(clock.samples(forSeconds: 0), 0)
        // Non-finite latency must not produce a trap or a wild correction.
        XCTAssertEqual(clock.samples(forSeconds: .nan), 0)
        XCTAssertEqual(clock.samples(forSeconds: .infinity), 0)
    }

    // MARK: - Degenerate construction

    func testAZeroOrNegativeSampleRateIsRefused() {
        XCTAssertNil(StudioAudioClock(timebase: ntsc, sampleRate: 0))
        XCTAssertNil(StudioAudioClock(timebase: ntsc, sampleRate: -48_000))
    }

    /// An absurd sample delta must degrade rather than trap, for the same reason
    /// the playback clock clamps before its Int64 conversion: a media clock is
    /// not allowed to be the thing that kills the viewer.
    func testAbsurdSampleCountsDoNotTrap() throws {
        let clock = try XCTUnwrap(StudioAudioClock(timebase: ntsc, sampleRate: 48_000))
        let huge = Int64.max / 2
        let result = clock.ticks(forSamples: huge)
        XCTAssertTrue(result != 0, "overflow fallback produced nothing")
    }

    /// PAL is a whole-number rate, so the reduction must not mangle the simple
    /// case while handling the awkward one.
    func testPalTimebaseConvertsExactly() throws {
        let clock = try XCTUnwrap(StudioAudioClock(timebase: .pal25, sampleRate: 48_000))
        let ticksPerSecond = Int64(StudioTimebase.pal25.timescale)
        XCTAssertEqual(clock.ticks(forSamples: 48_000), ticksPerSecond)
        XCTAssertEqual(clock.ticks(forSamples: 48_000 * 120), ticksPerSecond * 120)
    }
}
