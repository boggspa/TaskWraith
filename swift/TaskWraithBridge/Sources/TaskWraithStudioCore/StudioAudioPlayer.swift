import AVFoundation
import Foundation

public enum StudioAudioError: Error, Equatable {
    case noAudioTrack
    case unreadableAsset(String)
    case formatUnavailable
    case engineStartFailed(String)
    case bufferAllocationFailed
    case sampleLimitExceeded(limit: Int)
}

/// Decoded audio for an opened asset, plus the device that plays it.
///
/// SCOPE, STATED UP FRONT. This plays an asset's FIRST audio track at rate 1.0
/// so that the audio hardware can act as the playback oscillator and A/V sync
/// becomes measurable. It is not a mixer, it does not vary pitch or rate, and it
/// does not handle multi-track or surround layouts — outcome 5 asks for audio
/// playback and measured sync, and inventing a mixing architecture here would
/// widen the slice past what any of it is tested against.
///
/// WHY THE WHOLE TRACK IS DECODED UP FRONT. Same trade the video loader already
/// makes and for the same reason: a streaming reader is a later slice, and a
/// bounded eager read with an explicit cap fails as a typed error rather than
/// consuming a feature film of RAM. The cap is in SAMPLES, not seconds, because
/// that is what actually bounds the allocation.
public final class StudioAudioTrack {
    /// ~10 minutes at 48 kHz. Deliberately explicit: exceeding it is a typed
    /// error, never a silent truncation that would desync everything after it.
    public static let defaultMaxSampleCount = 48_000 * 600

    public let format: AVAudioFormat
    public let buffer: AVAudioPCMBuffer
    public let sampleRate: Int
    public var sampleCount: Int64 { Int64(buffer.frameLength) }

    init(format: AVAudioFormat, buffer: AVAudioPCMBuffer) {
        self.format = format
        self.buffer = buffer
        self.sampleRate = Int(format.sampleRate.rounded())
    }

    /// Reads the asset's first audio track as float PCM.
    ///
    /// `outputSettings` here REQUESTS decompression, which is the opposite of
    /// the video path's `outputSettings: nil`. That asymmetry is deliberate:
    /// video is decoded on the GPU through VideoToolbox precisely to avoid a CPU
    /// copy, while audio has to reach the CPU to be handed to the audio device
    /// no matter what, so letting AVFoundation decode it costs nothing.
    public static func load(
        url: URL,
        maxSampleCount: Int = defaultMaxSampleCount
    ) async throws -> StudioAudioTrack {
        let asset = AVURLAsset(url: url)
        let tracks: [AVAssetTrack]
        do {
            tracks = try await asset.loadTracks(withMediaType: .audio)
        } catch {
            throw StudioAudioError.unreadableAsset(String(describing: error))
        }
        guard let track = tracks.first else { throw StudioAudioError.noAudioTrack }

        let reader: AVAssetReader
        do {
            reader = try AVAssetReader(asset: asset)
        } catch {
            throw StudioAudioError.unreadableAsset(String(describing: error))
        }

        // Non-interleaved float32 is AVAudioEngine's native currency, so this
        // hands the engine exactly what it wants without a second conversion.
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: true,
            AVLinearPCMIsBigEndianKey: false,
        ]
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw StudioAudioError.formatUnavailable }
        reader.add(output)
        guard reader.startReading() else {
            throw StudioAudioError.unreadableAsset(
                String(describing: reader.error ?? StudioAudioError.formatUnavailable)
            )
        }

        var collected: [AVAudioPCMBuffer] = []
        var totalFrames: Int64 = 0
        var format: AVAudioFormat?

        while let sample = output.copyNextSampleBuffer() {
            guard let description = CMSampleBufferGetFormatDescription(sample),
                let streamDescription = CMAudioFormatDescriptionGetStreamBasicDescription(
                    description
                )
            else {
                continue
            }
            if format == nil {
                format = AVAudioFormat(streamDescription: streamDescription)
            }
            guard let format else { throw StudioAudioError.formatUnavailable }
            let frames = CMSampleBufferGetNumSamples(sample)
            guard frames > 0 else { continue }
            totalFrames += Int64(frames)
            if totalFrames > Int64(maxSampleCount) {
                reader.cancelReading()
                throw StudioAudioError.sampleLimitExceeded(limit: maxSampleCount)
            }
            guard
                let chunk = AVAudioPCMBuffer(
                    pcmFormat: format,
                    frameCapacity: AVAudioFrameCount(frames)
                )
            else {
                throw StudioAudioError.bufferAllocationFailed
            }
            chunk.frameLength = AVAudioFrameCount(frames)
            let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
                sample,
                at: 0,
                frameCount: Int32(frames),
                into: chunk.mutableAudioBufferList
            )
            guard status == noErr else {
                throw StudioAudioError.unreadableAsset("PCM copy failed (\(status))")
            }
            collected.append(chunk)
        }

        guard let format, totalFrames > 0 else { throw StudioAudioError.noAudioTrack }
        guard
            let combined = AVAudioPCMBuffer(
                pcmFormat: format,
                frameCapacity: AVAudioFrameCount(totalFrames)
            )
        else {
            throw StudioAudioError.bufferAllocationFailed
        }
        combined.frameLength = 0
        for chunk in collected {
            Self.append(chunk, to: combined)
        }
        return StudioAudioTrack(format: format, buffer: combined)
    }

    private static func append(_ source: AVAudioPCMBuffer, to destination: AVAudioPCMBuffer) {
        let offset = Int(destination.frameLength)
        let frames = Int(source.frameLength)
        let channels = Int(source.format.channelCount)
        guard let sourceData = source.floatChannelData,
            let destinationData = destination.floatChannelData
        else {
            return
        }
        for channel in 0..<channels {
            destinationData[channel].advanced(by: offset)
                .update(from: sourceData[channel], count: frames)
        }
        destination.frameLength += AVAudioFrameCount(frames)
    }
}

/// AVAudioEngine output whose SAMPLE COUNTER is the playback oscillator.
///
/// The interesting property is `audiblePositionTicks`: the device's own rendered
/// sample position, pulled back by output latency so it describes sound actually
/// in the room rather than samples merely handed to the hardware. That
/// correction is what makes the A/V sync figure meaningful instead of flattering
/// — without it the measurement quietly credits the pipeline with audio the
/// listener has not heard yet.
@MainActor
public final class StudioAudioPlayer {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    /// Whether an audio track is resident. Surfaced for outcome 9's player
    /// count, which must report what is actually attached rather than assume.
    public var isAttached: Bool { track != nil }

    private var track: StudioAudioTrack?
    private var clock: StudioAudioClock?
    private var isEngineRunning = false

    public private(set) var isPlaying = false

    public init() {}

    public var sampleRate: Int { track?.sampleRate ?? 0 }
    public var hasAudio: Bool { track != nil }

    /// Output latency in samples: how far ahead of the listener the device is.
    ///
    /// This is the OUTPUT node's presentation latency — the hardware's own
    /// figure for how long a rendered sample takes to become sound. Upstream
    /// node latency is deliberately not added: those nodes run before the sample
    /// counter this is correcting, so including them would double-count. The
    /// device figure is also the dominant term by an order of magnitude.
    public var outputLatencySamples: Int64 {
        guard let clock else { return 0 }
        let seconds = engine.outputNode.presentationLatency
        guard seconds.isFinite, seconds > 0 else { return 0 }
        return clock.samples(forSeconds: seconds)
    }

    public func attach(track newTrack: StudioAudioTrack, timebase: StudioTimebase) throws {
        stop()
        guard let audioClock = StudioAudioClock(
            timebase: timebase,
            sampleRate: newTrack.sampleRate
        ) else {
            throw StudioAudioError.formatUnavailable
        }
        track = newTrack
        clock = audioClock

        if !isEngineRunning {
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: newTrack.format)
        }
    }

    /// Starts playback from `ticks`, anchoring the audio clock at the device's
    /// current sample position.
    @discardableResult
    public func play(fromTicks ticks: Int64) throws -> Bool {
        guard let track, var audioClock = clock else { return false }
        if !isEngineRunning {
            do {
                try engine.start()
            } catch {
                throw StudioAudioError.engineStartFailed(String(describing: error))
            }
            isEngineRunning = true
        }
        player.stop()
        player.scheduleBuffer(track.buffer, at: nil, options: [])
        player.play()
        isPlaying = true
        // Anchor AFTER play() so the sample position is the one the device is
        // actually about to render from.
        audioClock.anchor(atTicks: ticks, samplePosition: rawSamplePosition())
        clock = audioClock
        return true
    }

    public func stop() {
        guard isEngineRunning else { return }
        player.stop()
        engine.stop()
        isEngineRunning = false
        isPlaying = false
    }

    /// The device's rendered sample position. Zero before the node has started,
    /// which is why callers anchor rather than treating it as absolute.
    public func rawSamplePosition() -> Int64 {
        guard let nodeTime = player.lastRenderTime,
            let playerTime = player.playerTime(forNodeTime: nodeTime)
        else {
            return 0
        }
        return playerTime.sampleTime
    }

    /// One consistent look at the audio device.
    ///
    /// EVERYTHING DERIVES FROM A SINGLE SAMPLE OF THE COUNTER. Calling separate
    /// accessors for the raw position, the audible position and the driving
    /// seconds samples a moving counter three times and returns three readings
    /// that never coexisted — they can even come back out of order. A test
    /// caught exactly that, and the fix belongs here rather than in the test:
    /// a caller comparing raw against audible is asking about ONE instant.
    public struct Reading: Equatable, Sendable {
        /// The device's own rendered sample position.
        public let samplePosition: Int64
        /// Same instant, pulled back by output latency: sound in the room.
        public let audibleSamplePosition: Int64
        public let positionTicks: Int64
        public let audiblePositionTicks: Int64
        /// Seconds on the audio device's timeline, for driving the playback
        /// clock in place of host monotonic time.
        public let hostSeconds: Double
    }

    /// Nil when there is no audio, because "no measurement" and "measured zero"
    /// are different claims and the sync meter must not be fed the latter.
    public func reading() -> Reading? {
        guard let clock, isPlaying else { return nil }
        let sample = rawSamplePosition()
        let audible = sample - outputLatencySamples
        return Reading(
            samplePosition: sample,
            audibleSamplePosition: audible,
            positionTicks: clock.ticks(atSamplePosition: sample),
            audiblePositionTicks: clock.ticks(atSamplePosition: audible),
            hostSeconds: clock.seconds(atSamplePosition: sample)
        )
    }

    /// Media position of the sound ACTUALLY AUDIBLE now.
    public func audiblePositionTicks() -> Int64? { reading()?.audiblePositionTicks }

    /// Seconds on the AUDIO DEVICE's timeline, for driving StudioPlaybackClock
    /// in place of host monotonic time.
    public func audioHostSeconds() -> Double? { reading()?.hostSeconds }

    public func detach() {
        stop()
        track = nil
        clock = nil
    }
}
