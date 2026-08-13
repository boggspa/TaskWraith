import AVFoundation
import XCTest

@testable import TaskWraithStudioCore

/// Real audio, real hardware, measured sync.
///
/// The pure tests prove the arithmetic; these prove there is actually sound and
/// that the device's own sample counter advances independently of anything this
/// package computes. Without that, "measured A/V sync" would be a simulation of
/// a measurement.
@MainActor
final class StudioAudioPlaybackTests: XCTestCase {
    private let ntsc = StudioTimebase.ntsc2997

    private func makeToneAsset() async throws -> URL {
        let url = StudioTestMedia.makeTemporaryMovieURL()
        try await StudioTestMedia.writeToneMovie(to: url, seconds: 2.0)
        return url
    }

    // MARK: - Decoding the asset's audio

    func testAnAssetsAudioTrackDecodesToPcm() async throws {
        let url = try await makeToneAsset()
        defer { try? FileManager.default.removeItem(at: url) }

        let track = try await StudioAudioTrack.load(url: url)
        XCTAssertEqual(track.sampleRate, 44_100)
        // AAC pads, so this is "about two seconds" rather than exact.
        XCTAssertGreaterThan(track.sampleCount, 44_100)
        XCTAssertLessThan(track.sampleCount, 44_100 * 3)
        XCTAssertEqual(track.format.channelCount, 1)

        // The samples must be actual signal, not silence — a decode that
        // produced zeros would satisfy every structural assertion above.
        let data = try XCTUnwrap(track.buffer.floatChannelData?[0])
        var peak: Float = 0
        for index in 0..<min(Int(track.buffer.frameLength), 44_100) {
            peak = max(peak, abs(data[index]))
        }
        XCTAssertGreaterThan(peak, 0.05, "decoded audio is silent")
    }

    func testAVideoOnlyAssetReportsNoAudioRatherThanSilence() async throws {
        let url = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try await StudioTestMedia.writeFlatMovie(lumaLevels: [32, 96], to: url)

        do {
            _ = try await StudioAudioTrack.load(url: url)
            XCTFail("a video-only asset must report noAudioTrack")
        } catch let error as StudioAudioError {
            // Distinguishable from "audio that happens to be quiet", which is
            // what a zero-filled fallback would have looked like.
            XCTAssertEqual(error, .noAudioTrack)
        }
    }

    func testTheSampleCapIsATypedErrorNotASilentTruncation() async throws {
        let url = try await makeToneAsset()
        defer { try? FileManager.default.removeItem(at: url) }

        do {
            _ = try await StudioAudioTrack.load(url: url, maxSampleCount: 1_000)
            XCTFail("the cap must be enforced")
        } catch let error as StudioAudioError {
            XCTAssertEqual(error, .sampleLimitExceeded(limit: 1_000))
        }
    }

    // MARK: - Real playback on real hardware

    /// THE EVIDENCE THAT MATTERS. Starts AVAudioEngine, plays the asset's own
    /// audio, and asserts the DEVICE's sample counter advances — a quantity this
    /// package does not compute and cannot fake.
    func testTheAudioDeviceAdvancesItsOwnSampleCounterDuringPlayback() async throws {
        let url = try await makeToneAsset()
        defer { try? FileManager.default.removeItem(at: url) }
        let track = try await StudioAudioTrack.load(url: url)

        let player = StudioAudioPlayer()
        defer { player.detach() }
        do {
            try player.attach(track: track, timebase: ntsc)
            guard try player.play(fromTicks: 0) else {
                throw XCTSkip("audio player declined to start")
            }
        } catch let error as StudioAudioError {
            // A machine with no output device is a skip, not a failure.
            throw XCTSkip("no usable audio output: \(error)")
        }

        let start = player.rawSamplePosition()
        try await Task.sleep(nanoseconds: 400_000_000)
        let later = player.rawSamplePosition()

        XCTAssertGreaterThan(later, start, "the audio device counter did not advance")
        // 0.4s at 44.1kHz is ~17,640 samples. Generous bounds: this asserts the
        // counter runs at roughly real time, not that it hit a precise value.
        let advanced = later - start
        XCTAssertGreaterThan(advanced, 4_410, "advanced far too little for 0.4s")
        XCTAssertLessThan(advanced, 44_100, "advanced far too much for 0.4s")
    }

    /// Output latency must be SUBTRACTED, or the measurement flatters the
    /// pipeline by crediting it with audio the listener has not heard yet.
    func testAudiblePositionTrailsTheRawDeviceCounter() async throws {
        let url = try await makeToneAsset()
        defer { try? FileManager.default.removeItem(at: url) }
        let track = try await StudioAudioTrack.load(url: url)

        let player = StudioAudioPlayer()
        defer { player.detach() }
        do {
            try player.attach(track: track, timebase: ntsc)
            guard try player.play(fromTicks: 0) else { throw XCTSkip("player declined to start") }
        } catch let error as StudioAudioError {
            throw XCTSkip("no usable audio output: \(error)")
        }
        try await Task.sleep(nanoseconds: 300_000_000)

        // ONE reading. Sampling the counter twice and comparing the results is
        // what the first version of this test did, and it failed — not because
        // the correction was missing but because the two samples came from
        // different instants and could arrive out of order. The production API
        // now returns a consistent pair, which is the real fix.
        let reading = try XCTUnwrap(player.reading())
        let latency = player.outputLatencySamples
        XCTAssertGreaterThanOrEqual(latency, 0)
        XCTAssertEqual(reading.audibleSamplePosition, reading.samplePosition - latency)
        if latency > 0 {
            XCTAssertLessThan(
                reading.audiblePositionTicks,
                reading.positionTicks,
                "audible position must trail the device counter"
            )
        }
    }

    /// REAL HARDWARE PLUMBING — and deliberately NOT a sync claim any more.
    ///
    /// WHAT THIS PROVES: a real device counter, corrected for output latency,
    /// reaches StudioAvSyncMeter and accumulates. The audio device is the one
    /// part of this pipeline that cannot be exercised offscreen, so that the
    /// plumbing works against real hardware is worth asserting.
    ///
    /// WHAT IT USED TO CLAIM, AND WHY THAT WAS WORTHLESS. It computed the
    /// picture side FROM the audio side — `frameIndex(ofTicks: audible)` then
    /// `ticks(ofFrame:)` — so the "error" was the quantisation remainder of
    /// `audible` onto the frame grid, bounded by one frame period as a matter of
    /// arithmetic. At 29.97 that is 33.4 ms, and it asserted `< 45`. A theorem
    /// dressed as a measurement, over a test containing NO VIDEO AT ALL.
    ///
    /// The sync claim now lives in StudioAvSyncFailureTests, where the picture
    /// is scripted independently of the sound and a stalled picture is PROVEN
    /// to leave tolerance. No tolerance is asserted here, because the picture
    /// side below advances on `Task.sleep` and asserting a bound on an
    /// imprecise timer would be trading a tautology for a flake.
    func testTheSyncMeterAcceptsReadingsFromRealAudioHardware() async throws {
        let url = try await makeToneAsset()
        defer { try? FileManager.default.removeItem(at: url) }
        let track = try await StudioAudioTrack.load(url: url)

        let player = StudioAudioPlayer()
        defer { player.detach() }
        do {
            try player.attach(track: track, timebase: ntsc)
            guard try player.play(fromTicks: 0) else { throw XCTSkip("player declined to start") }
        } catch let error as StudioAudioError {
            throw XCTSkip("no usable audio output: \(error)")
        }

        let clock = StudioPlaybackClock(timebase: ntsc, durationTicks: 30_000 * 2)
        var meter = StudioAvSyncMeter(timebase: ntsc)

        // The picture side advances on its OWN counter — one frame per pass —
        // rather than being derived from `audible`. It is not a real decoder, so
        // the resulting error is not a sync figure; what matters is that the two
        // sides are independent, because a meter fed two views of one number
        // cannot report anything at all.
        var presentedFrame: Int64 = 0
        for _ in 0..<12 {
            try await Task.sleep(nanoseconds: 40_000_000)
            guard let audible = player.audiblePositionTicks() else { continue }
            meter.record(
                presentedFrameTicks: clock.ticks(ofFrame: presentedFrame),
                audiblePositionTicks: audible
            )
            presentedFrame += 1
        }

        guard meter.sampleCount > 0 else {
            throw XCTSkip("audio never produced a position on this machine")
        }
        XCTAssertGreaterThan(meter.sampleCount, 4)
        XCTAssertNotNil(
            meter.meanErrorMilliseconds,
            "the meter must produce a mean once real readings have arrived"
        )
        XCTAssertNotNil(meter.onScreenFrameTicks, "a recorded frame is a picture on screen")
        XCTAssertTrue(
            meter.currentErrorMilliseconds.isFinite,
            "real device readings must convert to a finite error"
        )
    }

    // MARK: - Lifecycle

    func testDetachStopsTheEngineAndClearsTheClock() async throws {
        let url = try await makeToneAsset()
        defer { try? FileManager.default.removeItem(at: url) }
        let track = try await StudioAudioTrack.load(url: url)

        let player = StudioAudioPlayer()
        do {
            try player.attach(track: track, timebase: ntsc)
        } catch let error as StudioAudioError {
            throw XCTSkip("no usable audio output: \(error)")
        }
        XCTAssertTrue(player.hasAudio)
        player.detach()
        XCTAssertFalse(player.hasAudio)
        XCTAssertFalse(player.isPlaying)
        // No audio means NO measurement, never a measured zero.
        XCTAssertNil(player.audiblePositionTicks())
        XCTAssertNil(player.audioHostSeconds())
    }
}
