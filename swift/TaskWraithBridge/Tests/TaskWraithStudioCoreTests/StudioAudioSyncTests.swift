import AVFoundation
import XCTest

@testable import TaskWraithStudioCore

/// Sound addressed by time.
///
/// EVERY TEST HERE RUNS WITHOUT AN AUDIO DEVICE, and that is deliberate. The old
/// behaviour survived because the only audio tests that existed needed a device,
/// skipped without one, and all called `play(fromTicks: 0)` — the single
/// argument for which "start the buffer at sample zero" happens to be correct.
/// The conversions and the decision are pure, so they get tested as pure things.
final class StudioAudioSyncTests: XCTestCase {

    // MARK: - Ticks address samples

    func testTickToSampleConversionIsTheInverseOfSampleToTick() {
        for (rate, timebase) in [
            (48_000, StudioTimebase.ntsc2997),
            (44_100, StudioTimebase.pal25),
            (32_000, StudioTimebase.fps60),
        ] {
            guard let clock = StudioAudioClock(timebase: timebase, sampleRate: rate) else {
                return XCTFail("no clock for \(rate) against \(timebase.timescale)")
            }
            // One second expressed in each currency must agree.
            let oneSecondInTicks = timebase.timescale
            XCTAssertEqual(
                clock.samples(forTicks: oneSecondInTicks),
                Int64(rate),
                "one second at \(rate) Hz should be \(rate) samples, "
                    + "got \(clock.samples(forTicks: oneSecondInTicks))"
            )
            XCTAssertEqual(clock.ticks(forSamples: Int64(rate)), oneSecondInTicks)
        }
    }

    func testStartFrameLandsOnTheSampleThatHoldsThePosition() {
        guard let clock = StudioAudioClock(timebase: .ntsc2997, sampleRate: 48_000) else {
            return XCTFail("no clock")
        }
        // Two seconds into a ten-second track.
        let frame = StudioAudioPlayer.startFrame(
            forTicks: 60_000,
            clock: clock,
            frameLength: 480_000
        )
        XCTAssertEqual(frame, 96_000, "two seconds at 48 kHz is sample 96000, got \(frame as Any)")
    }

    /// Past the end of the sound there is NO frame — not frame zero. Returning a
    /// frame here is how a viewer whose video outlasts its audio would restart
    /// the head of the track under the tail of the picture.
    func testStartFramePastTheEndOfTheSoundIsRefusedRatherThanClamped() {
        guard let clock = StudioAudioClock(timebase: .ntsc2997, sampleRate: 48_000) else {
            return XCTFail("no clock")
        }
        XCTAssertNil(
            StudioAudioPlayer.startFrame(forTicks: 60_000, clock: clock, frameLength: 48_000),
            "two seconds into a one-second track must be nil, not a clamped frame"
        )
    }

    // MARK: - The segment view

    func testASegmentBeginsAtTheRequestedSampleAndSharesTheSourcesMemory() throws {
        let buffer = try Self.rampBuffer(frames: 1_000, channels: 2)
        guard let segment = StudioAudioPlayer.segment(of: buffer, from: 250) else {
            return XCTFail("no segment produced for a non-interleaved float32 buffer")
        }
        XCTAssertEqual(
            segment.frameLength,
            750,
            "a view from frame 250 of 1000 should hold 750 frames, got \(segment.frameLength)"
        )
        guard let data = segment.floatChannelData else { return XCTFail("no channel data") }
        // The ramp stores each sample's own index, so the first sample of the
        // view names the frame it actually started at.
        XCTAssertEqual(
            data[0][0],
            250,
            "the view's first sample should be source sample 250, read \(data[0][0]) — "
                + "a whole-buffer schedule reads 0 here"
        )
        XCTAssertEqual(data[1][0], 250, "every channel must be offset, not just the first")
        XCTAssertEqual(data[0][10], 260)

        // Aliased, not copied: writing through the source is visible in the view.
        buffer.floatChannelData?[0][300] = -1
        XCTAssertEqual(data[0][50], -1, "the view must share the source's samples, not copy them")
    }

    func testASegmentFromZeroIsTheSourceBufferItself() throws {
        let buffer = try Self.rampBuffer(frames: 16, channels: 1)
        XCTAssertTrue(StudioAudioPlayer.segment(of: buffer, from: 0) === buffer)
    }

    func testASegmentPastTheEndIsRefused() throws {
        let buffer = try Self.rampBuffer(frames: 16, channels: 1)
        XCTAssertNil(StudioAudioPlayer.segment(of: buffer, from: 16))
        XCTAssertNil(StudioAudioPlayer.segment(of: buffer, from: 99))
    }

    // MARK: - The decision

    private let tolerance = StudioAudioSyncPolicy.toleranceTicks(for: .ntsc2997)

    func testAStoppedTransportSilencesPlayingSound() {
        XCTAssertEqual(
            StudioAudioSyncPolicy.decide(
                transportIsPlaying: false,
                intendedTicks: 5_000,
                audioEndTicks: 300_000,
                audioIsPlaying: true,
                audioPositionTicks: 5_000,
                toleranceTicks: tolerance
            ),
            .pause,
            "a paused picture with running sound is the defect this whole slice exists for"
        )
    }

    func testAStoppedTransportWithSilentSoundIsLeftAlone() {
        XCTAssertEqual(
            StudioAudioSyncPolicy.decide(
                transportIsPlaying: false,
                intendedTicks: 5_000,
                audioEndTicks: 300_000,
                audioIsPlaying: false,
                audioPositionTicks: nil,
                toleranceTicks: tolerance
            ),
            .leave
        )
    }

    func testARunningTransportWithSilentSoundStartsItAtThePicturesPosition() {
        XCTAssertEqual(
            StudioAudioSyncPolicy.decide(
                transportIsPlaying: true,
                intendedTicks: 90_000,
                audioEndTicks: 300_000,
                audioIsPlaying: false,
                audioPositionTicks: nil,
                toleranceTicks: tolerance
            ),
            .reschedule(ticks: 90_000),
            "resuming must start the sound where the picture is, not where it left off"
        )
    }

    /// The load-bearing negative. A re-schedule is audible, so agreement inside
    /// the tolerance must not touch the player at all.
    func testSoundAlreadyWithinToleranceIsLeftAlone() {
        XCTAssertEqual(
            StudioAudioSyncPolicy.decide(
                transportIsPlaying: true,
                intendedTicks: 90_000,
                audioEndTicks: 300_000,
                audioIsPlaying: true,
                audioPositionTicks: 90_000 + tolerance,
                toleranceTicks: tolerance
            ),
            .leave,
            "divergence of exactly the tolerance is agreement, not drift"
        )
    }

    func testASeekAwayFromTheSoundReschedulesIt() {
        XCTAssertEqual(
            StudioAudioSyncPolicy.decide(
                transportIsPlaying: true,
                intendedTicks: 300,
                audioEndTicks: 300_000,
                audioIsPlaying: true,
                audioPositionTicks: 90_000,
                toleranceTicks: tolerance
            ),
            .reschedule(ticks: 300),
            "a seek backwards past the tolerance must re-address the sound"
        )
    }

    /// Past the end of the sound the answer is `.pause`, NOT `.reschedule`.
    /// `.reschedule` there would fail to start on every frame forever, and a
    /// player that did start would put the head of the track under the tail of
    /// the picture — the audio twin of substituting a clip for a timeline gap.
    func testAPositionPastTheEndOfTheSoundFallsSilentRatherThanRestartingIt() {
        // Far from where the sound is, so dropping the end check yields the
        // dangerous answer — .reschedule — rather than a benign .leave.
        XCTAssertEqual(
            StudioAudioSyncPolicy.decide(
                transportIsPlaying: true,
                intendedTicks: 300_000,
                audioEndTicks: 300_000,
                audioIsPlaying: true,
                audioPositionTicks: 10_000,
                toleranceTicks: tolerance
            ),
            .pause,
            "video outlasting audio must fall silent, never restart the track"
        )
        // And close to it, so "just keep running" is refused too.
        XCTAssertEqual(
            StudioAudioSyncPolicy.decide(
                transportIsPlaying: true,
                intendedTicks: 300_001,
                audioEndTicks: 300_000,
                audioIsPlaying: true,
                audioPositionTicks: 299_500,
                toleranceTicks: tolerance
            ),
            .pause,
            "one tick past the last sample is still past it"
        )
    }

    // MARK: - Sound that belongs to a different picture

    /// PAST THE FIRST CUT THE SOUND IS THE WRONG CLIP'S. Sequence audio is not
    /// switched at cuts, so the attached track belongs to whichever asset was
    /// opened. Continuing to play it puts one clip's dialogue under another
    /// clip's picture — and unlike a frozen picture, it does not look broken.
    func testSoundThatBelongsToAnotherClipIsSilencedRatherThanPlayed() {
        XCTAssertEqual(
            StudioAudioSyncPolicy.decide(
                transportIsPlaying: true,
                intendedTicks: 90_000,
                audioEndTicks: 300_000,
                audioIsPlaying: true,
                audioPositionTicks: 90_000,
                toleranceTicks: tolerance,
                soundMatchesPicture: false
            ),
            .pause,
            "the wrong clip's sound must stop, not keep playing in perfect sync with nothing"
        )
    }

    /// The control that gives the test above meaning: identical inputs, sound
    /// that DOES belong to the picture, left alone.
    func testSoundThatBelongsToThePictureIsNotSilenced() {
        XCTAssertEqual(
            StudioAudioSyncPolicy.decide(
                transportIsPlaying: true,
                intendedTicks: 90_000,
                audioEndTicks: 300_000,
                audioIsPlaying: true,
                audioPositionTicks: 90_000,
                toleranceTicks: tolerance,
                soundMatchesPicture: true
            ),
            .leave
        )
    }

    /// A mismatch must not be answered with `.reschedule` — restarting the wrong
    /// track at the right timecode is still the wrong track.
    func testAMismatchNeverReschedulesTheWrongTrack() {
        XCTAssertEqual(
            StudioAudioSyncPolicy.decide(
                transportIsPlaying: true,
                intendedTicks: 300,
                audioEndTicks: 300_000,
                audioIsPlaying: true,
                audioPositionTicks: 90_000,
                toleranceTicks: tolerance,
                soundMatchesPicture: false
            ),
            .pause,
            "a seek while the wrong clip is attached must silence, never re-address it"
        )
    }

    /// The tolerance is derived from the timebase, so it means the same thing at
    /// every rate rather than being a millisecond figure that is two frames at
    /// one rate and half a frame at another.
    func testToleranceIsTwoFramesOfWhateverRateIsPlaying() {
        XCTAssertEqual(StudioAudioSyncPolicy.toleranceTicks(for: .ntsc2997), 2002)
        XCTAssertEqual(StudioAudioSyncPolicy.toleranceTicks(for: .pal25), 2)
        XCTAssertEqual(StudioAudioSyncPolicy.toleranceTicks(for: .fps60), 2)
    }

    // MARK: - Helpers

    /// A buffer whose every sample equals its own frame index, so any offset is
    /// readable straight off the data rather than inferred.
    private static func rampBuffer(frames: AVAudioFrameCount, channels: UInt32) throws
        -> AVAudioPCMBuffer
    {
        guard
            let format = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: 48_000,
                channels: AVAudioChannelCount(channels),
                interleaved: false
            ),
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames),
            let data = buffer.floatChannelData
        else {
            throw XCTSkip("float32 buffers unavailable on this host")
        }
        buffer.frameLength = frames
        for channel in 0..<Int(channels) {
            for frame in 0..<Int(frames) {
                data[channel][frame] = Float(frame)
            }
        }
        return buffer
    }
}
