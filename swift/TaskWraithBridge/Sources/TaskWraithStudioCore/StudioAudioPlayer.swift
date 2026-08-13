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
    private var isPlayerAttachedToEngine = false

    public private(set) var isPlaying = false
    /// Exact identity of the resident asset attached to the one device player.
    /// A caller must name this again when scheduling; a stale route may not
    /// repurpose the last track after a timeline cut.
    public private(set) var attachedAssetId: String?
    public private(set) var scheduledAssetId: String?
    public private(set) var hasQueuedOutput = false
    public private(set) var switchCount = 0
    public private(set) var dropCount = 0
    public private(set) var correctionCount = 0
    private var lastScheduledAssetId: String?

    public struct Diagnostics: Equatable, Sendable {
        public let attachedAssetId: String?
        public let scheduledAssetId: String?
        public let hasQueuedOutput: Bool
        public let switchCount: Int
        public let dropCount: Int
        public let correctionCount: Int
    }

    public init() {}

    public var sampleRate: Int { track?.sampleRate ?? 0 }
    public var hasAudio: Bool { track != nil }
    public var diagnostics: Diagnostics {
        Diagnostics(
            attachedAssetId: attachedAssetId,
            scheduledAssetId: scheduledAssetId,
            hasQueuedOutput: hasQueuedOutput,
            switchCount: switchCount,
            dropCount: dropCount,
            correctionCount: correctionCount
        )
    }

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

    public func attach(
        track newTrack: StudioAudioTrack,
        timebase: StudioTimebase,
        assetId: String? = nil
    ) throws {
        stop()
        guard let audioClock = StudioAudioClock(
            timebase: timebase,
            sampleRate: newTrack.sampleRate
        ) else {
            throw StudioAudioError.formatUnavailable
        }
        track = newTrack
        clock = audioClock
        attachedAssetId = assetId
        scheduledAssetId = nil
        hasQueuedOutput = false

        if !isPlayerAttachedToEngine {
            engine.attach(player)
            isPlayerAttachedToEngine = true
        } else {
            engine.disconnectNodeOutput(player)
        }
        engine.connect(player, to: engine.mainMixerNode, format: newTrack.format)
    }

    /// Media position one tick past the last sample of the attached sound.
    /// Zero when nothing is attached, which the sync policy reads as "there is
    /// nothing to play" rather than "play from the start".
    public var endTicks: Int64 {
        guard let track, let clock else { return 0 }
        return clock.ticks(forSamples: track.sampleCount)
    }

    /// The buffer frame holding media position `ticks`, or nil when the position
    /// lies past the end of the sound.
    ///
    /// Static and pure so the mapping is verifiable WITHOUT an audio device. The
    /// device-dependent half of playback must not be the reason a conversion
    /// goes untested — that is how the old behaviour survived: every audio test
    /// called `play(fromTicks: 0)`, the one argument for which starting the
    /// buffer at sample zero happens to be correct.
    public nonisolated static func startFrame(
        forTicks ticks: Int64,
        clock: StudioAudioClock,
        frameLength: AVAudioFrameCount
    ) -> AVAudioFrameCount? {
        let sample = clock.samples(forTicks: ticks)
        guard sample < Int64(frameLength) else { return nil }
        return AVAudioFrameCount(max(sample, 0))
    }

    /// A view over `buffer` beginning at `startFrame`, SHARING its samples.
    ///
    /// Copying would move up to a few hundred megabytes per seek, which is not a
    /// scrub. The view aliases the source's per-channel pointers, so the source
    /// must outlive it — the player retains `track` for as long as anything it
    /// scheduled can still be rendering, and the allocated buffer list is freed
    /// by the deallocator rather than leaked.
    ///
    /// Non-interleaved float32 only, which is exactly what `StudioAudioTrack`
    /// produces. Anything else returns nil rather than reinterpreting memory
    /// under a format it was not written in.
    nonisolated static func segment(
        of buffer: AVAudioPCMBuffer,
        from startFrame: AVAudioFrameCount
    ) -> AVAudioPCMBuffer? {
        let format = buffer.format
        guard !format.isInterleaved,
            format.commonFormat == .pcmFormatFloat32,
            format.channelCount > 0,
            startFrame < buffer.frameLength,
            let channelData = buffer.floatChannelData
        else {
            return nil
        }
        if startFrame == 0 { return buffer }

        let channels = Int(format.channelCount)
        let frames = buffer.frameLength - startFrame
        let byteCount = UInt32(frames) * UInt32(MemoryLayout<Float>.size)
        let listSize =
            MemoryLayout<AudioBufferList>.size
            + (channels - 1) * MemoryLayout<AudioBuffer>.stride
        let storage = UnsafeMutableRawPointer.allocate(
            byteCount: listSize,
            alignment: MemoryLayout<AudioBufferList>.alignment
        )
        let list = storage.bindMemory(to: AudioBufferList.self, capacity: 1)
        list.pointee.mNumberBuffers = UInt32(channels)
        let audioBuffers = UnsafeMutableAudioBufferListPointer(list)
        for channel in 0..<channels {
            audioBuffers[channel] = AudioBuffer(
                mNumberChannels: 1,
                mDataByteSize: byteCount,
                mData: UnsafeMutableRawPointer(
                    channelData[channel].advanced(by: Int(startFrame))
                )
            )
        }
        return AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: list) { _ in
            storage.deallocate()
        }
    }

    /// Starts the sound AT `ticks`, anchoring the audio clock at the device's
    /// current sample position.
    ///
    /// `ticks` now addresses CONTENT as well as the anchor. It did not always:
    /// this method used to schedule the whole buffer from sample zero and carry
    /// `ticks` into the anchor alone, so after any pause, seek, scrub, step or
    /// loop wrap the picture moved and the sound did not — and the position it
    /// REPORTED stayed right by construction the whole time.
    ///
    /// Returns false when the position lies past the end of the sound. Silence
    /// is the honest answer there; the head of the track is not.
    @discardableResult
    public func play(
        fromTicks ticks: Int64,
        expectedAssetId: String? = nil
    ) throws -> Bool {
        if let expectedAssetId, expectedAssetId != attachedAssetId {
            dropCount += 1
            silence()
            return false
        }
        guard let track, var audioClock = clock else { return false }
        guard
            let startFrame = Self.startFrame(
                forTicks: ticks,
                clock: audioClock,
                frameLength: track.buffer.frameLength
            ),
            let scheduled = Self.segment(of: track.buffer, from: startFrame)
        else {
            silence()
            return false
        }
        if !isEngineRunning {
            do {
                try engine.start()
            } catch {
                throw StudioAudioError.engineStartFailed(String(describing: error))
            }
            isEngineRunning = true
        }
        let changedAsset = lastScheduledAssetId != attachedAssetId
        let wasQueued = hasQueuedOutput
        // AVAudioPlayerNode.stop() explicitly flushes every scheduled buffer.
        // pause() does not, so it is never the gap/missing-asset silence path.
        player.stop()
        hasQueuedOutput = false
        player.scheduleBuffer(scheduled, at: nil, options: [])
        player.play()
        isPlaying = true
        hasQueuedOutput = true
        scheduledAssetId = attachedAssetId
        lastScheduledAssetId = attachedAssetId
        if changedAsset {
            switchCount += 1
        } else if wasQueued {
            correctionCount += 1
        }
        // Anchor AFTER play() so the sample position is the one the device is
        // actually about to render from.
        audioClock.anchor(atTicks: ticks, samplePosition: rawSamplePosition())
        clock = audioClock
        return true
    }

    /// Holds the sound where it is without tearing the engine down.
    ///
    /// `isPlaying` goes false so `reading()` stops answering: a paused node's
    /// sample counter is not a position, and the viewer's oscillator machinery
    /// already knows how to fall back to host monotonic time the moment audio
    /// stops reporting.
    public func pause() {
        guard isPlaying else { return }
        player.pause()
        isPlaying = false
    }

    /// Positive output silence. AVAudioPlayerNode.pause() leaves scheduled
    /// buffers queued; stop() flushes them so a gap, missing asset, or identity
    /// refusal cannot resume the last audible clip later.
    public func silence() {
        player.stop()
        scheduledAssetId = nil
        hasQueuedOutput = false
        isPlaying = false
    }

    public func stop() {
        silence()
        guard isEngineRunning else { return }
        engine.stop()
        isEngineRunning = false
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
        attachedAssetId = nil
        lastScheduledAssetId = nil
    }
}
