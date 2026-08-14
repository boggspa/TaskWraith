import AVFoundation
import CoreMedia
import Foundation
import Metal

/// File-backed ingest: turns a real container into the compressed samples the
/// existing VideoToolbox decode path already consumes.
///
/// This closes the gap where every video test was fed by samples the TESTS
/// synthesised with VTCompressionSession. The decode and zero-copy Metal path
/// were correct and measured but unreachable from a file.
///
/// `load` IS DELIBERATELY EAGER, AND CAPPED. It reads every compressed
/// payload into memory for short assets and fails with a typed error at
/// `maxSampleCount`. The production `makeFrameSource` factory catches only
/// that exact limit and retries through `loadBounded`, whose eager metadata
/// index is small while compressed payload residency stays cache-bounded.
///
/// SAMPLES ARE KEPT IN DECODE ORDER. They are never sorted by presentation
/// time, because StudioVideoFrameSource now walks GOPs and needs the order the
/// container stored. Sorting by PTS is what made the first real .mov render
/// frame 0's picture for frame 1.
///
/// The previous blanket refusal of inter-coded media is LIFTED: decode-order
/// submission and decode-forward-from-keyframe now exist, so ordinary camera
/// and delivery media is supported. `requireAllSyncSamples` remains available
/// for callers that genuinely need all-intra input, and the sync-sample flags
/// travel with each sample so the frame source can find keyframes.
public enum StudioMediaLoadError: Error, Equatable {
    /// The asset contains samples that depend on other samples. Correct
    /// presentation needs GOP-aware decoding, which does not exist yet.
    case interCodedMediaUnsupported(dependentSampleCount: Int)
    case fileNotFound(String)
    case notARegularFile(String)
    case noVideoTrack
    case missingFormatDescription
    case readerCreationFailed(String)
    case readFailed(String)
    case noSamples
    case sampleLimitExceeded(limit: Int)
    case indeterminateFrameDuration
}

/// Everything the playback stack needs to present one asset.
public struct StudioLoadedMedia {
    public let asset: StudioMediaAsset
    public let formatDescription: CMVideoFormatDescription
    public let samples: [StudioCompressedSample]
    /// The provider handed to StudioVideoFrameSource. Eager for short assets,
    /// bounded for ten-minute media; identical semantics either way.
    public let sampleProvider: StudioSampleProvider
    /// Derived from the asset, so the clock and the sample indices agree.
    public let timebase: StudioTimebase
    public let durationTicks: Int64
    public let naturalSize: CGSize
    /// True when every sample carries a not-a-dependent-sample marker, i.e. the
    /// file is all-keyframe and isolated decoding is actually valid.
    public let allSamplesAreSyncSamples: Bool

    public init(
        asset: StudioMediaAsset,
        formatDescription: CMVideoFormatDescription,
        samples: [StudioCompressedSample],
        sampleProvider: StudioSampleProvider? = nil,
        timebase: StudioTimebase,
        durationTicks: Int64,
        naturalSize: CGSize,
        allSamplesAreSyncSamples: Bool
    ) {
        self.asset = asset
        self.formatDescription = formatDescription
        self.samples = samples
        self.sampleProvider = sampleProvider ?? EagerStudioSampleProvider(samples: samples)
        self.timebase = timebase
        self.durationTicks = durationTicks
        self.naturalSize = naturalSize
        self.allSamplesAreSyncSamples = allSamplesAreSyncSamples
    }
}

public enum StudioMediaSourceLoader {
    /// Two minutes at 30fps. Chosen to be obviously finite rather than tuned.
    public static let defaultMaxSampleCount = 3600

    public static func load(
        asset: StudioMediaAsset,
        maxSampleCount: Int = defaultMaxSampleCount,
        requireAllSyncSamples: Bool = false
    ) async throws -> StudioLoadedMedia {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: asset.path, isDirectory: &isDirectory) else {
            throw StudioMediaLoadError.fileNotFound(asset.path)
        }
        guard !isDirectory.boolValue else {
            throw StudioMediaLoadError.notARegularFile(asset.path)
        }

        let urlAsset = AVURLAsset(url: URL(fileURLWithPath: asset.path))
        let tracks = try await urlAsset.loadTracks(withMediaType: .video)
        guard let track = tracks.first else {
            throw StudioMediaLoadError.noVideoTrack
        }

        let formatDescriptions = try await track.load(.formatDescriptions)
        guard let formatDescription = formatDescriptions.first else {
            throw StudioMediaLoadError.missingFormatDescription
        }

        let minFrameDuration = try await track.load(.minFrameDuration)
        let naturalSize = try await track.load(.naturalSize)
        let duration = try await urlAsset.load(.duration)

        let reader: AVAssetReader
        do {
            reader = try AVAssetReader(asset: urlAsset)
        } catch {
            throw StudioMediaLoadError.readerCreationFailed(String(describing: error))
        }

        // outputSettings nil == hand back samples in their STORED, compressed
        // form. Anything else would make AVFoundation decode for us, which is
        // exactly the copy this project exists to avoid.
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else {
            throw StudioMediaLoadError.readerCreationFailed("reader rejected the track output")
        }
        reader.add(output)
        guard reader.startReading() else {
            throw StudioMediaLoadError.readFailed(String(describing: reader.error))
        }

        var presentationTimes: [CMTime] = []
        var buffers: [CMSampleBuffer] = []
        var syncFlags: [Bool] = []
        var dependentSampleCount = 0
        while let sampleBuffer = output.copyNextSampleBuffer() {
            guard CMSampleBufferGetDataBuffer(sampleBuffer) != nil else { continue }
            let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            guard presentationTime.isValid else { continue }
            let isSync = Self.isSyncSample(sampleBuffer)
            if !isSync { dependentSampleCount += 1 }
            syncFlags.append(isSync)
            presentationTimes.append(presentationTime)
            buffers.append(sampleBuffer)
            if buffers.count > maxSampleCount {
                reader.cancelReading()
                throw StudioMediaLoadError.sampleLimitExceeded(limit: maxSampleCount)
            }
        }

        if reader.status == .failed {
            throw StudioMediaLoadError.readFailed(String(describing: reader.error))
        }
        guard !buffers.isEmpty else {
            throw StudioMediaLoadError.noSamples
        }
        if requireAllSyncSamples, dependentSampleCount > 0 {
            throw StudioMediaLoadError.interCodedMediaUnsupported(
                dependentSampleCount: dependentSampleCount
            )
        }

        let frameDuration = try Self.resolveFrameDuration(
            minFrameDuration: minFrameDuration,
            presentationTimes: presentationTimes
        )
        // Containers rewrite timescales: a 30fps movie written through .mov
        // comes back as 20/600, not 1/30. Reducing by gcd yields the canonical
        // rate and the smallest tick counts, and is exact — 1001/30000 has gcd 1
        // so broadcast rates are untouched.
        let reduced = Self.reduce(frameDuration: frameDuration)
        guard
            reduced.ticks > 0,
            let timebase = StudioTimebase(
                timescale: reduced.timescale,
                frameDurationTicks: reduced.ticks
            )
        else {
            throw StudioMediaLoadError.indeterminateFrameDuration
        }

        var samples: [StudioCompressedSample] = []
        samples.reserveCapacity(buffers.count)
        for (index, buffer) in buffers.enumerated() {
            guard
                let frameIndex = Self.frameIndex(
                    of: presentationTimes[index],
                    frameDuration: frameDuration
                )
            else {
                throw StudioMediaLoadError.indeterminateFrameDuration
            }
            samples.append(
                StudioCompressedSample(
                    frameIndex: frameIndex,
                    isSyncSample: syncFlags[index],
                    sampleBuffer: buffer
                )
            )
        }
        // NOT sorted: decode order is preserved deliberately. See the header.

        let durationTicks = CMTimeConvertScale(
            duration,
            timescale: CMTimeScale(timebase.timescale),
            method: .roundHalfAwayFromZero
        )

        return StudioLoadedMedia(
            asset: asset,
            formatDescription: formatDescription,
            samples: samples,
            timebase: timebase,
            durationTicks: durationTicks.isValid ? max(0, durationTicks.value) : 0,
            naturalSize: naturalSize,
            allSamplesAreSyncSamples: dependentSampleCount == 0
        )
    }

    /// Loads a real container into a bounded, content-time-addressable sample
    /// provider. Metadata (frame index, sync flag, presentation time) is eager;
    /// compressed payloads are read on demand and cached up to
    /// `payloadCacheLimit`, so a ten-minute asset does not retain its whole
    /// sample table in memory.
    ///
    /// The returned `StudioLoadedMedia.samples` is intentionally empty: callers
    /// that need frame count or metadata should use `sampleProvider`.
    public static func loadBounded(
        asset: StudioMediaAsset,
        payloadCacheLimit: Int = 240,
        requireAllSyncSamples: Bool = false
    ) async throws -> StudioLoadedMedia {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: asset.path, isDirectory: &isDirectory) else {
            throw StudioMediaLoadError.fileNotFound(asset.path)
        }
        guard !isDirectory.boolValue else {
            throw StudioMediaLoadError.notARegularFile(asset.path)
        }

        let urlAsset = AVURLAsset(url: URL(fileURLWithPath: asset.path))
        let tracks = try await urlAsset.loadTracks(withMediaType: .video)
        guard let track = tracks.first else {
            throw StudioMediaLoadError.noVideoTrack
        }

        let formatDescriptions = try await track.load(.formatDescriptions)
        guard let formatDescription = formatDescriptions.first else {
            throw StudioMediaLoadError.missingFormatDescription
        }

        let minFrameDuration = try await track.load(.minFrameDuration)
        let naturalSize = try await track.load(.naturalSize)
        let duration = try await urlAsset.load(.duration)

        let reader: AVAssetReader
        do {
            reader = try AVAssetReader(asset: urlAsset)
        } catch {
            throw StudioMediaLoadError.readerCreationFailed(String(describing: error))
        }

        let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else {
            throw StudioMediaLoadError.readerCreationFailed("reader rejected the track output")
        }
        reader.add(output)
        guard reader.startReading() else {
            throw StudioMediaLoadError.readFailed(String(describing: reader.error))
        }

        var presentationTimes: [CMTime] = []
        var syncFlags: [Bool] = []
        var dependentSampleCount = 0
        while let sampleBuffer = output.copyNextSampleBuffer() {
            guard CMSampleBufferGetDataBuffer(sampleBuffer) != nil else { continue }
            let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            guard presentationTime.isValid else { continue }
            let isSync = Self.isSyncSample(sampleBuffer)
            if !isSync { dependentSampleCount += 1 }
            syncFlags.append(isSync)
            presentationTimes.append(presentationTime)
        }

        if reader.status == .failed {
            throw StudioMediaLoadError.readFailed(String(describing: reader.error))
        }
        guard !presentationTimes.isEmpty else {
            throw StudioMediaLoadError.noSamples
        }
        if requireAllSyncSamples, dependentSampleCount > 0 {
            throw StudioMediaLoadError.interCodedMediaUnsupported(
                dependentSampleCount: dependentSampleCount
            )
        }

        let frameDuration = try Self.resolveFrameDuration(
            minFrameDuration: minFrameDuration,
            presentationTimes: presentationTimes
        )
        let reduced = Self.reduce(frameDuration: frameDuration)
        guard
            reduced.ticks > 0,
            let timebase = StudioTimebase(
                timescale: reduced.timescale,
                frameDurationTicks: reduced.ticks
            )
        else {
            throw StudioMediaLoadError.indeterminateFrameDuration
        }

        var metadata: [StudioSampleIndexEntry] = []
        metadata.reserveCapacity(presentationTimes.count)
        for (index, pts) in presentationTimes.enumerated() {
            guard let frameIndex = Self.frameIndex(of: pts, frameDuration: frameDuration) else {
                throw StudioMediaLoadError.indeterminateFrameDuration
            }
            metadata.append(
                StudioSampleIndexEntry(
                    frameIndex: frameIndex,
                    isSyncSample: syncFlags[index],
                    presentationTime: pts
                )
            )
        }

        let provider = BoundedStudioSampleProvider(
            metadata: metadata,
            formatDescription: formatDescription,
            makeReader: { try AVAssetReader(asset: urlAsset) },
            makeOutput: { reader in
                let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
                output.alwaysCopiesSampleData = false
                guard reader.canAdd(output) else {
                    throw StudioMediaLoadError.readerCreationFailed("reader rejected the track output")
                }
                reader.add(output)
                return output
            },
            payloadCacheLimit: payloadCacheLimit
        )

        let durationTicks = CMTimeConvertScale(
            duration,
            timescale: CMTimeScale(timebase.timescale),
            method: .roundHalfAwayFromZero
        )

        return StudioLoadedMedia(
            asset: asset,
            formatDescription: formatDescription,
            samples: [],
            sampleProvider: provider,
            timebase: timebase,
            durationTicks: durationTicks.isValid ? max(0, durationTicks.value) : 0,
            naturalSize: naturalSize,
            allSamplesAreSyncSamples: dependentSampleCount == 0
        )
    }

    /// Reduces a frame duration to its canonical rate. Exact by construction:
    /// dividing both terms by their gcd cannot change the ratio.
    static func reduce(frameDuration: CMTime) -> (timescale: Int64, ticks: Int64) {
        let timescale = Int64(frameDuration.timescale)
        let ticks = frameDuration.value
        guard timescale > 0, ticks > 0 else { return (timescale, ticks) }
        let divisor = greatestCommonDivisor(timescale, ticks)
        guard divisor > 1 else { return (timescale, ticks) }
        return (timescale / divisor, ticks / divisor)
    }

    private static func greatestCommonDivisor(_ lhs: Int64, _ rhs: Int64) -> Int64 {
        var a = abs(lhs)
        var b = abs(rhs)
        while b != 0 {
            (a, b) = (b, a % b)
        }
        return a
    }

    /// Convenience: load a file and hand back a ready playback source.
    public static func makeFrameSource(
        asset: StudioMediaAsset,
        device: MTLDevice,
        maxSampleCount: Int = defaultMaxSampleCount,
        requireAllSyncSamples: Bool = false
    ) async throws -> (source: StudioVideoFrameSource, media: StudioLoadedMedia) {
        let media: StudioLoadedMedia
        do {
            media = try await load(
                asset: asset,
                maxSampleCount: maxSampleCount,
                requireAllSyncSamples: requireAllSyncSamples
            )
        } catch StudioMediaLoadError.sampleLimitExceeded(let limit)
            where limit == maxSampleCount
        {
            media = try await loadBounded(
                asset: asset,
                requireAllSyncSamples: requireAllSyncSamples
            )
        }
        let source = try StudioVideoFrameSource(
            formatDescription: media.formatDescription,
            provider: media.sampleProvider,
            device: device
        )
        return (source, media)
    }

    /// Convenience: load a file into a bounded provider and hand back a ready
    /// playback source. Suitable for assets longer than the eager sample cap.
    public static func makeBoundedFrameSource(
        asset: StudioMediaAsset,
        device: MTLDevice,
        payloadCacheLimit: Int = 240,
        requireAllSyncSamples: Bool = false
    ) async throws -> (source: StudioVideoFrameSource, media: StudioLoadedMedia) {
        let media = try await loadBounded(
            asset: asset,
            payloadCacheLimit: payloadCacheLimit,
            requireAllSyncSamples: requireAllSyncSamples
        )
        let source = try StudioVideoFrameSource(
            formatDescription: media.formatDescription,
            provider: media.sampleProvider,
            device: device
        )
        return (source, media)
    }

    // MARK: - Timing

    /// Prefers the track's declared minimum frame duration; falls back to the
    /// MEASURED delta between the first two presentation times, which is exact
    /// for constant-frame-rate content and is often more trustworthy than a
    /// nominal frame rate expressed as a Float.
    static func resolveFrameDuration(
        minFrameDuration: CMTime,
        presentationTimes: [CMTime]
    ) throws -> CMTime {
        if minFrameDuration.isValid, minFrameDuration.value > 0 {
            return minFrameDuration
        }
        guard presentationTimes.count >= 2 else {
            throw StudioMediaLoadError.indeterminateFrameDuration
        }
        let delta = CMTimeSubtract(presentationTimes[1], presentationTimes[0])
        guard delta.isValid, delta.value > 0 else {
            throw StudioMediaLoadError.indeterminateFrameDuration
        }
        return delta
    }

    /// Exact integer frame index: (pts.value * fd.timescale) / (pts.timescale *
    /// fd.value), rounded half away from zero. Deliberately not seconds-based
    /// Double division — the whole time model in this package is integer ticks
    /// so that 30000/1001 lands exactly.
    static func frameIndex(of presentationTime: CMTime, frameDuration: CMTime) -> Int64? {
        guard presentationTime.isValid, frameDuration.isValid, frameDuration.value != 0 else {
            return nil
        }
        let (numerator, numeratorOverflow) = presentationTime.value.multipliedReportingOverflow(
            by: Int64(frameDuration.timescale)
        )
        let (denominator, denominatorOverflow) = Int64(presentationTime.timescale)
            .multipliedReportingOverflow(by: frameDuration.value)
        guard !numeratorOverflow, !denominatorOverflow, denominator != 0 else { return nil }

        let half = denominator / 2
        let adjusted = numerator >= 0 ? numerator + half : numerator - half
        return adjusted / denominator
    }

    private static func isSyncSample(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard
            let attachments = CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer,
                createIfNecessary: false
            ) as? [[CFString: Any]],
            let first = attachments.first
        else {
            // No attachments at all conventionally means "not a dependent
            // sample", i.e. a sync sample.
            return true
        }
        if let dependsOnOthers = first[kCMSampleAttachmentKey_DependsOnOthers] as? Bool {
            return !dependsOnOthers
        }
        return true
    }
}
