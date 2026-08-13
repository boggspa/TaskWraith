import XCTest

@testable import TaskWraithStudioCore

/// Can this meter go red?
///
/// The suite it replaces could not, and the reason is worth stating exactly.
/// `testMeasuredSyncAgainstRealAudioStaysWithinTolerance` computed the picture
/// side FROM the audio side — `frameIndex(ofTicks: audible)` then
/// `ticks(ofFrame:)` — so the error it "measured" was the quantisation remainder
/// of `audible` onto the frame grid, which is bounded by one frame period as a
/// matter of arithmetic. At 29.97 that is 33.4 ms and the assertion was `< 45`.
/// A theorem, asserted as a measurement, with no video anywhere in the test.
///
/// EVERY TEST HERE SCRIPTS THE PICTURE INDEPENDENTLY OF THE SOUND. That is the
/// whole point: if the two sides cannot disagree, no assertion over them means
/// anything, and no amount of real hardware fixes it.
final class StudioAvSyncFailureTests: XCTestCase {

    private let ntsc = StudioTimebase.ntsc2997
    /// One 29.97 frame is 1001 ticks in a 30000 timescale.
    private let frame: Int64 = 1001

    // MARK: - The meter reports desync when there is desync

    /// The condition the old meter could not see: the picture freezes while
    /// sound continues. Under the previous call site this produced ZERO
    /// readings, so a totally desynced viewer reported "a/v --".
    func testAFrozenPictureAgainstRunningSoundLeavesTolerance() {
        var meter = StudioAvSyncMeter(timebase: ntsc)
        // One good frame, so there is a picture on screen at all.
        meter.record(presentedFrameTicks: 0, audiblePositionTicks: 0)

        // Now the decoder stalls for half a second of audio. Nothing new is
        // drawn; the same picture stays up.
        var audible: Int64 = 0
        for _ in 0..<15 {
            audible += frame
            meter.recordDroppedFrame(audiblePositionTicks: audible)
        }

        XCTAssertEqual(meter.sampleCount, 16, "a frozen picture must still produce readings")
        XCTAssertGreaterThan(
            meter.outOfToleranceCount,
            0,
            "half a second of frozen picture is a desync; meter said \(meter.summaryText)"
        )
        // Sound ahead of picture is the tighter direction, so the error is
        // negative and must exceed the 45 ms audio-advanced tolerance.
        XCTAssertLessThan(
            meter.currentErrorMilliseconds,
            -45,
            "15 frames of stall is ~500ms of sound past the picture, "
                + "measured \(meter.currentErrorMilliseconds) ms"
        )
    }

    /// The control that makes the test above mean something: the SAME number of
    /// ticks, with the picture keeping up, must stay green. Without this, the
    /// assertion above would also pass for a meter that simply always fails.
    func testAPictureThatKeepsUpStaysWithinTolerance() {
        var meter = StudioAvSyncMeter(timebase: ntsc)
        var audible: Int64 = 0
        for _ in 0..<16 {
            meter.record(presentedFrameTicks: audible, audiblePositionTicks: audible)
            audible += frame
        }
        XCTAssertEqual(meter.sampleCount, 16)
        XCTAssertEqual(
            meter.outOfToleranceCount,
            0,
            "a picture tracking the sound must not report desync: \(meter.summaryText)"
        )
    }

    /// Drift in the OTHER direction — picture running ahead of sound — must also
    /// register, against the looser 125 ms tolerance. A meter that only caught
    /// one sign would be half an instrument.
    func testAPictureRunningAheadOfSoundAlsoLeavesTolerance() {
        var meter = StudioAvSyncMeter(timebase: ntsc)
        // 5000 ticks is ~167 ms of picture ahead: inside 125 ms? No — past it.
        meter.record(presentedFrameTicks: 5_000, audiblePositionTicks: 0)
        XCTAssertGreaterThan(meter.currentErrorMilliseconds, 125)
        XCTAssertEqual(meter.outOfToleranceCount, 1, meter.summaryText)
    }

    // MARK: - Honest absence

    /// Before anything is drawn there is no picture, so a dropped frame is not
    /// evidence of desync — it is evidence of nothing. Recording zero here would
    /// invent a measurement, which is the failure mode this meter's own
    /// `meanErrorMilliseconds` already refuses.
    func testDroppedFramesBeforeAnyPictureRecordNothing() {
        var meter = StudioAvSyncMeter(timebase: ntsc)
        for tick in 1...10 {
            meter.recordDroppedFrame(audiblePositionTicks: Int64(tick) * frame)
        }
        XCTAssertEqual(meter.sampleCount, 0, "no picture means no sync measurement")
        XCTAssertNil(meter.meanErrorMilliseconds)
        XCTAssertEqual(meter.summaryText, "a/v --")
    }

    /// A seek changes which picture is on screen, so the frame from before it
    /// must not be measured against sound from after it.
    func testResetForgetsThePictureThatWasOnScreen() {
        var meter = StudioAvSyncMeter(timebase: ntsc)
        meter.record(presentedFrameTicks: 0, audiblePositionTicks: 0)
        XCTAssertEqual(meter.onScreenFrameTicks, 0)

        meter.reset()
        XCTAssertNil(meter.onScreenFrameTicks, "a seek invalidates the on-screen picture")

        meter.recordDroppedFrame(audiblePositionTicks: 300_000)
        XCTAssertEqual(
            meter.sampleCount,
            0,
            "a frame from before the seek must not be measured against sound after it"
        )
    }

    /// The stale picture is measured — not the frame that failed to arrive.
    func testAStalledMeterMeasuresTheFrameStillOnScreen() {
        var meter = StudioAvSyncMeter(timebase: ntsc)
        meter.record(presentedFrameTicks: 10_000, audiblePositionTicks: 10_000)
        meter.recordDroppedFrame(audiblePositionTicks: 11_000)
        XCTAssertEqual(
            meter.currentErrorTicks,
            -1_000,
            "error must be measured from the picture on screen (10000), not the "
                + "frame the clock wanted"
        )
        XCTAssertEqual(meter.onScreenFrameTicks, 10_000, "a dropped frame changes no picture")
    }
}
