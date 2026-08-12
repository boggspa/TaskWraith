import CoreMedia
import Foundation
import Metal

/// One compressed sample and the frame it presents.
public struct StudioCompressedSample {
    public let frameIndex: Int64
    public let sampleBuffer: CMSampleBuffer

    public init(frameIndex: Int64, sampleBuffer: CMSampleBuffer) {
        self.frameIndex = frameIndex
        self.sampleBuffer = sampleBuffer
    }
}

/// Joins the three pieces of the video path: StudioVideoDecoder produces a
/// Metal-bindable pixel buffer, StudioVideoTextureBridge wraps its planes with
/// no copy, and StudioPlaybackClock decides which frame that should be.
///
/// This is the seam a viewer talks to. It exists so the viewer never owns a
/// decoder, a texture cache or a playhead of its own — it asks for the textures
/// for the current transport snapshot and draws them.
///
/// CACHING IS DELIBERATELY ONE FRAME DEEP. Holding the most recent decode makes
/// the common case (display link ticking several times within one frame's
/// duration) free, without pretending to be the seek cache outcome 9 will need.
/// A real cache has an eviction policy and a measured memory ceiling; inventing
/// one here would be unmeasured, and outcome 11 explicitly tests for exactly the
/// growth a careless cache causes.
///
/// SEEKING IS NOT GOP-AWARE YET. Frame selection picks the last sample at or
/// before the requested frame and decodes it in isolation, which is correct only
/// while samples are independently decodable. Decoding forward from the nearest
/// keyframe is a later slice; until then a source built from an inter-coded
/// stream will decode reference-less frames and must not be presented as seek
/// support.
public enum StudioVideoFrameSourceError: Error, Equatable {
    case noSamples
    case invalidated
}

public final class StudioVideoFrameSource {
    private let decoder: StudioVideoDecoder
    private let bridge: StudioVideoTextureBridge
    /// Sorted ascending by frameIndex at init so selection is a simple scan.
    private let samples: [StudioCompressedSample]

    private var cachedFrameIndex: Int64?
    private var cachedTextures: StudioVideoFrameTextures?
    private var invalidated = false

    /// Resource/lifecycle diagnostics for outcome 9.
    public private(set) var decodeCount = 0
    public private(set) var cacheHitCount = 0

    public var usedHardwareDecoder: Bool { decoder.usedHardwareDecoder }
    public var isValid: Bool { !invalidated && decoder.isValid }
    public var sampleCount: Int { samples.count }

    public init(
        formatDescription: CMVideoFormatDescription,
        samples: [StudioCompressedSample],
        device: MTLDevice
    ) throws {
        guard !samples.isEmpty else {
            throw StudioVideoFrameSourceError.noSamples
        }
        self.decoder = try StudioVideoDecoder(formatDescription: formatDescription)
        self.bridge = try StudioVideoTextureBridge(device: device)
        self.samples = samples.sorted { $0.frameIndex < $1.frameIndex }
    }

    /// The sample that should be on screen at `frameIndex`: the last one at or
    /// before it, or the first sample when the playhead sits before the start.
    public func sample(forFrameIndex frameIndex: Int64) -> StudioCompressedSample {
        var chosen = samples[0]
        for candidate in samples where candidate.frameIndex <= frameIndex {
            chosen = candidate
        }
        return chosen
    }

    /// Textures for the frame the clock is currently showing. This is the call a
    /// viewer makes on every display-link tick.
    public func textures(at snapshot: StudioTransportSnapshot) throws -> StudioVideoFrameTextures {
        try textures(forFrameIndex: snapshot.frameIndex)
    }

    public func textures(forFrameIndex frameIndex: Int64) throws -> StudioVideoFrameTextures {
        guard !invalidated else {
            throw StudioVideoFrameSourceError.invalidated
        }

        let selected = sample(forFrameIndex: frameIndex)
        if cachedFrameIndex == selected.frameIndex, let cachedTextures {
            cacheHitCount += 1
            return cachedTextures
        }

        let pixelBuffer = try decoder.decode(selected.sampleBuffer)
        let textures = try bridge.makeTextures(from: pixelBuffer)
        decodeCount += 1
        cachedFrameIndex = selected.frameIndex
        cachedTextures = textures
        return textures
    }

    /// Explicit teardown: drops the cached frame, flushes the texture cache and
    /// invalidates the decompression session. Idempotent.
    ///
    /// Order matters. The cached textures are released BEFORE the texture cache
    /// is flushed, because flushing while a wrapper is still referenced is
    /// exactly the misuse that leaves surfaces alive.
    public func invalidate() {
        cachedTextures = nil
        cachedFrameIndex = nil
        bridge.flushUnusedTextures()
        decoder.invalidate()
        invalidated = true
    }

    /// Bounded diagnostics snapshot for outcome 9 reporting.
    public var diagnostics: Diagnostics {
        Diagnostics(
            sampleCount: samples.count,
            decodeCount: decodeCount,
            cacheHitCount: cacheHitCount,
            boundFrameCount: bridge.boundFrameCount,
            failedBindCount: bridge.failedBindCount,
            decodedFrameCount: decoder.decodedFrameCount,
            failedDecodeCount: decoder.failedDecodeCount,
            usedHardwareDecoder: decoder.usedHardwareDecoder,
            isValid: isValid
        )
    }

    public struct Diagnostics: Equatable, Sendable {
        public let sampleCount: Int
        public let decodeCount: Int
        public let cacheHitCount: Int
        public let boundFrameCount: Int
        public let failedBindCount: Int
        public let decodedFrameCount: Int
        public let failedDecodeCount: Int
        public let usedHardwareDecoder: Bool
        public let isValid: Bool
    }
}
