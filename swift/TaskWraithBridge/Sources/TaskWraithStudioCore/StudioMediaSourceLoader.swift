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
/// DELIBERATELY EAGER, AND CAPPED. `load` reads every sample into memory up
/// front. That is honest for the short assets this slice covers and it is
/// bounded by `maxSampleCount` so it fails as a typed error rather than
/// consuming a feature film's worth of RAM. A streaming/lazy reader (or
/// AVAssetReaderSampleReferenceOutput, which yields offsets instead of bytes)
/// is a later slice. Do not present this as a general media loader.
///
/// INTER-CODED MEDIA IS REFUSED, AND THAT IS MEASURED RATHER THAN CAUTIOUS.
/// StudioVideoFrameSource decodes the selected sample in isolation, which is
/// only valid when every sample is independently decodable. The first real .mov
/// written through AVAssetWriter proved what that costs: with a normal GOP the
/// rendered frames came out [32, 32, 160, 224] for source levels
/// [32, 96, 160, 224] — frame 1 silently showed frame 0's picture. Presentation
/// order is not decode order once an encoder reorders, and a lone P-frame has no
/// reference.
///
/// So `load` REFUSES an asset containing dependent samples instead of quietly
/// presenting wrong pictures. Showing the wrong frame is worse than showing
/// none: it looks like working playback. Lifting this needs decode-order
/// submission plus decode-forward-from-keyframe seeking — a later slice — and
/// until then the refusal is the honest behaviour, not a placeholder.
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
    /// Derived from the asset, so the clock and the sample indices agree.
    public let timebase: StudioTimebase
    public let durationTicks: Int64
    public let naturalSize: CGSize
    /// True when every sample carries a not-a-dependent-sample marker, i.e. the
    /// file is all-keyframe and isolated decoding is actually valid.
    public let allSamplesAreSyncSamples: Bool
}

public enum StudioMediaSourceLoader {
    /// Two minutes at 30fps. Chosen to be obviously finite rather than tuned.
    public static let defaultMaxSampleCount = 3600

    public static func load(
        asset: StudioMediaAsset,
        maxSampleCount: Int = defaultMaxSampleCount,
        requireAllSyncSamples: Bool = true
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
        var dependentSampleCount = 0
        while let sampleBuffer = output.copyNextSampleBuffer() {
            guard CMSampleBufferGetDataBuffer(sampleBuffer) != nil else { continue }
            let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            guard presentationTime.isValid else { continue }
            if !Self.isSyncSample(sampleBuffer) { dependentSampleCount += 1 }
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
            samples.append(StudioCompressedSample(frameIndex: frameIndex, sampleBuffer: buffer))
        }
        samples.sort { $0.frameIndex < $1.frameIndex }

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
        requireAllSyncSamples: Bool = true
    ) async throws -> (source: StudioVideoFrameSource, media: StudioLoadedMedia) {
        let media = try await load(
            asset: asset,
            maxSampleCount: maxSampleCount,
            requireAllSyncSamples: requireAllSyncSamples
        )
        let source = try StudioVideoFrameSource(
            formatDescription: media.formatDescription,
            samples: media.samples,
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
