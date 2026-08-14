import CoreMedia
import Foundation
import IOSurface
import Metal

/// One compressed sample, its presentation frame, and whether it can be decoded
/// on its own.
///
/// `isSyncSample` is load-bearing, not informational: it is what makes a
/// GOP walk possible at all.
public struct StudioCompressedSample {
    public let frameIndex: Int64
    public let isSyncSample: Bool
    public let sampleBuffer: CMSampleBuffer

    public init(frameIndex: Int64, isSyncSample: Bool = true, sampleBuffer: CMSampleBuffer) {
        self.frameIndex = frameIndex
        self.isSyncSample = isSyncSample
        self.sampleBuffer = sampleBuffer
    }

    public var presentationTime: CMTime {
        CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    }
}

/// Joins the three pieces of the video path: StudioVideoDecoder produces a
/// Metal-bindable pixel buffer, StudioVideoTextureBridge wraps its planes with
/// no copy, and StudioPlaybackClock decides which frame that should be.
///
/// GOP-AWARE, AND THIS IS THE WHOLE POINT OF THE TYPE.
///
/// `samples` is in DECODE ORDER — the order AVAssetReader stored them — and is
/// never sorted by presentation time. That distinction is not pedantry: sorting
/// by PTS and decoding each sample alone is precisely what rendered frame 0's
/// picture for frame 1 on the first real file this project opened. A P-frame
/// has no meaning without its references, and once an encoder reorders, decode
/// order and presentation order genuinely differ.
///
/// To present frame N the source finds the sample that presents at or before N,
/// then decodes FORWARD to it either from the nearest preceding sync sample or
/// from wherever the decoder already is, whichever is fewer decodes. Sequential
/// playback therefore costs one decode per frame, and a seek costs at most the
/// GOP length.
///
/// The decoded picture's presentation time is CHECKED against the sample that
/// was requested. Trusting position alone is how a reordered neighbour gets
/// presented as the wrong frame, which is the failure this type exists to
/// prevent.
public enum StudioVideoFrameSourceError: Error, Equatable {
    case noSamples
    case invalidated
    /// The first sample in decode order is not a sync sample, so there is no
    /// point at which decoding can legally begin.
    case noLeadingKeyframe
    /// The decoder returned a picture for a different instant than requested.
    case frameMismatch(expectedTicks: Int64, decodedTicks: Int64)
}

public final class StudioVideoFrameSource {
    private let decoder: StudioVideoDecoder
    private let bridge: StudioVideoTextureBridge
    /// DECODE-order sample access. The provider may be eager or bounded.
    private let provider: StudioSampleProvider
    /// (presentation frame, decode position), ascending by frame.
    private let presentationOrder: [(frameIndex: Int64, decodeIndex: Int)]
    /// Decode positions of sync samples, ascending.
    private let syncIndices: [Int]

    private var lastDecodedIndex: Int?
    /// Recently decoded pictures keyed by presentation frame, oldest first.
    ///
    /// This is a REORDER BUFFER, not a speed optimisation bolted on. Measured on
    /// real inter-coded media, decode order was [0, 4, 2, 1, 3, 8, 6, 5, 7, 10,
    /// 9, 11] for twelve frames with a single keyframe: playing forward in
    /// PRESENTATION order walks backwards through DECODE order constantly, so a
    /// forward-only decoder restarts at the keyframe again and again. Without
    /// this buffer a twelve-frame pass cost 49 decodes with 6 restarts; a long
    /// GOP would make that quadratic and playback unusable.
    ///
    /// Bounded on purpose. A decode chain produces pictures for several
    /// presentation frames and keeping a few of them makes sequential playback
    /// roughly one decode per frame, but each entry retains an IOSurface, so
    /// depth is a memory decision: at UHD a frame is several megabytes. The
    /// default is small deliberately and is the knob to turn if outcome 11's
    /// RSS work ever shows pressure here.
    private var reorderCache: [(frameIndex: Int64, textures: StudioVideoFrameTextures)] = []
    private let reorderCacheDepth: Int
    private var invalidated = false

    /// Resource/lifecycle diagnostics for outcome 9.
    public private(set) var decodeCount = 0
    public private(set) var cacheHitCount = 0
    /// Times a request could not continue from the current decoder position and
    /// had to restart at a keyframe. High values during playback mean the
    /// sequential fast path is not being taken.
    public private(set) var keyframeRestartCount = 0
    /// Most decodes ever needed to satisfy one request — effectively the worst
    /// observed GOP walk.
    public private(set) var longestDecodeChain = 0

    public var hardwareDecodeStatus: StudioHardwareDecodeStatus { decoder.hardwareDecodeStatus }
    public var isValid: Bool { !invalidated && decoder.isValid }
    public var sampleCount: Int { provider.sampleCount }
    /// True when every sample is independently decodable.
    public var isAllIntra: Bool { provider.isAllIntra }

    /// Frames of decoded pictures held to absorb B-frame reordering.
    public static let defaultReorderCacheDepth = 6

    public var reorderCacheCapacity: Int { reorderCacheDepth }

    /// Exact IOSurface identities currently retained by the bounded reorder cache.
    public var liveIOSurfaceIDs: Set<UInt32> {
        Set(reorderCache.compactMap { $0.textures.luma.iosurface.map(IOSurfaceGetID) })
    }

    public convenience init(
        formatDescription: CMVideoFormatDescription,
        samples: [StudioCompressedSample],
        device: MTLDevice,
        reorderCacheDepth: Int = defaultReorderCacheDepth
    ) throws {
        try self.init(
            formatDescription: formatDescription,
            provider: EagerStudioSampleProvider(samples: samples),
            device: device,
            reorderCacheDepth: reorderCacheDepth
        )
    }

    public init(
        formatDescription: CMVideoFormatDescription,
        provider: StudioSampleProvider,
        device: MTLDevice,
        reorderCacheDepth: Int = defaultReorderCacheDepth
    ) throws {
        self.reorderCacheDepth = max(1, reorderCacheDepth)
        guard provider.sampleCount > 0 else {
            throw StudioVideoFrameSourceError.noSamples
        }
        guard provider.metadata(atDecodeIndex: 0).isSyncSample else {
            throw StudioVideoFrameSourceError.noLeadingKeyframe
        }
        self.decoder = try StudioVideoDecoder(formatDescription: formatDescription)
        self.bridge = try StudioVideoTextureBridge(device: device)
        self.provider = provider
        self.presentationOrder =
            (0..<provider.sampleCount)
            .map { (frameIndex: provider.metadata(atDecodeIndex: $0).frameIndex, decodeIndex: $0) }
            .sorted { $0.frameIndex < $1.frameIndex }
        self.syncIndices = (0..<provider.sampleCount).filter {
            provider.metadata(atDecodeIndex: $0).isSyncSample
        }
    }

    // MARK: - Selection

    /// Decode position of the sample presenting at or before `frameIndex`.
    /// Clamps to the first sample when the playhead sits before the start.
    func decodeIndex(forFrameIndex frameIndex: Int64) -> Int {
        var chosen = presentationOrder[0].decodeIndex
        for entry in presentationOrder where entry.frameIndex <= frameIndex {
            chosen = entry.decodeIndex
        }
        return chosen
    }

    /// Latest sync sample at or before a decode position. Guaranteed to exist
    /// because init rejects a stream whose first sample is not a keyframe.
    func syncIndex(atOrBefore decodeIndex: Int) -> Int {
        var chosen = syncIndices[0]
        for candidate in syncIndices where candidate <= decodeIndex {
            chosen = candidate
        }
        return chosen
    }

    public func sample(forFrameIndex frameIndex: Int64) throws -> StudioCompressedSample {
        let decodeIndex = decodeIndex(forFrameIndex: frameIndex)
        let meta = provider.metadata(atDecodeIndex: decodeIndex)
        return StudioCompressedSample(
            frameIndex: meta.frameIndex,
            isSyncSample: meta.isSyncSample,
            sampleBuffer: try provider.sampleBuffer(atDecodeIndex: decodeIndex)
        )
    }

    // MARK: - Frames

    public func textures(at snapshot: StudioTransportSnapshot) throws -> StudioVideoFrameTextures {
        try textures(forFrameIndex: snapshot.frameIndex)
    }

    public func textures(forFrameIndex frameIndex: Int64) throws -> StudioVideoFrameTextures {
        guard !invalidated else {
            throw StudioVideoFrameSourceError.invalidated
        }

        let target = decodeIndex(forFrameIndex: frameIndex)
        let targetFrame = provider.metadata(atDecodeIndex: target).frameIndex
        if let cached = reorderCache.first(where: { $0.frameIndex == targetFrame }) {
            cacheHitCount += 1
            return cached.textures
        }

        // Continue from where the decoder already is when that is no more work
        // than restarting at the keyframe; otherwise restart. Both are correct,
        // so this is purely a cost choice.
        let keyframe = syncIndex(atOrBefore: target)
        var start = keyframe
        if let last = lastDecodedIndex, target > last, (target - last) <= (target - keyframe) {
            start = last + 1
        }
        if start == keyframe {
            keyframeRestartCount += 1
        }

        var decoded: StudioDecodedFrame?
        for index in start...target {
            let frame: StudioDecodedFrame
            do {
                frame = try decoder.decode(provider.sampleBuffer(atDecodeIndex: index))
            } catch {
                // The decoder's reference state is now unknown, so the next
                // request must not assume it can continue from here.
                lastDecodedIndex = nil
                throw error
            }
            decodeCount += 1
            decoded = frame
            // Every picture produced along the way is a real presentation frame
            // somebody is about to ask for; throwing them away is what made a
            // forward pass quadratic.
            if index != target {
                remember(frame, forDecodeIndex: index)
            }
        }
        longestDecodeChain = max(longestDecodeChain, target - start + 1)
        lastDecodedIndex = target

        guard let decoded else {
            throw StudioVideoFrameSourceError.invalidated
        }

        // Verify rather than assume: confirm the picture is for the instant we
        // asked for.
        let expected = provider.metadata(atDecodeIndex: target).presentationTime
        if expected.isValid, decoded.presentationTime.isValid,
            CMTimeCompare(decoded.presentationTime, expected) != 0
        {
            lastDecodedIndex = nil
            throw StudioVideoFrameSourceError.frameMismatch(
                expectedTicks: expected.value,
                decodedTicks: decoded.presentationTime.value
            )
        }

        let textures = try bridge.makeTextures(from: decoded.pixelBuffer)
        insert(textures, forFrameIndex: targetFrame)
        return textures
    }

    /// Binds and stores a picture decoded on the way to the target.
    ///
    /// Binding failures here are swallowed on purpose: this is opportunistic
    /// caching, and the requested frame's own binding is the one that must
    /// surface an error to the caller.
    private func remember(_ frame: StudioDecodedFrame, forDecodeIndex index: Int) {
        guard let textures = try? bridge.makeTextures(from: frame.pixelBuffer) else { return }
        insert(textures, forFrameIndex: provider.metadata(atDecodeIndex: index).frameIndex)
    }

    private func insert(_ textures: StudioVideoFrameTextures, forFrameIndex frameIndex: Int64) {
        reorderCache.removeAll { $0.frameIndex == frameIndex }
        reorderCache.append((frameIndex: frameIndex, textures: textures))
        if reorderCache.count > reorderCacheDepth {
            reorderCache.removeFirst(reorderCache.count - reorderCacheDepth)
        }
    }

    /// Explicit teardown. Idempotent. Order matters: the cached frame is
    /// released BEFORE the texture cache is flushed, because flushing while a
    /// wrapper is still referenced is the misuse that strands surfaces.
    public func invalidate() {
        reorderCache.removeAll()
        lastDecodedIndex = nil
        bridge.flushUnusedTextures()
        decoder.invalidate()
        invalidated = true
    }

    public var diagnostics: Diagnostics {
        Diagnostics(
            sampleCount: provider.sampleCount,
            syncSampleCount: syncIndices.count,
            decodeCount: decodeCount,
            cacheHitCount: cacheHitCount,
            keyframeRestartCount: keyframeRestartCount,
            longestDecodeChain: longestDecodeChain,
            boundFrameCount: bridge.boundFrameCount,
            failedBindCount: bridge.failedBindCount,
            decodedFrameCount: decoder.decodedFrameCount,
            failedDecodeCount: decoder.failedDecodeCount,
            hardwareDecodeStatus: decoder.hardwareDecodeStatus,
            isValid: isValid
        )
    }

    public struct Diagnostics: Equatable, Sendable {
        public let sampleCount: Int
        public let syncSampleCount: Int
        public let decodeCount: Int
        public let cacheHitCount: Int
        public let keyframeRestartCount: Int
        public let longestDecodeChain: Int
        public let boundFrameCount: Int
        public let failedBindCount: Int
        public let decodedFrameCount: Int
        public let failedDecodeCount: Int
        public let hardwareDecodeStatus: StudioHardwareDecodeStatus
        public let isValid: Bool
    }
}
