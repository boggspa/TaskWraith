import AVFoundation
import CoreMedia
import Foundation

/// Lightweight, value-type sample metadata kept for every sample in an asset.
/// The compressed payload itself may live behind a bounded cache.
public struct StudioSampleIndexEntry: Equatable, Sendable {
    public let frameIndex: Int64
    public let isSyncSample: Bool
    public let presentationTime: CMTime

    public init(frameIndex: Int64, isSyncSample: Bool, presentationTime: CMTime) {
        self.frameIndex = frameIndex
        self.isSyncSample = isSyncSample
        self.presentationTime = presentationTime
    }
}

/// Supplies compressed samples to StudioVideoFrameSource.
///
/// The index/metadata pass is always eager: it is small and makes seeks and
/// GOP-walk planning exact. The payload pass may be eager (existing short-asset
/// behavior) or bounded (ten-minute assets), but the two are indistinguishable
/// to the frame source.
public protocol StudioSampleProvider {
    var sampleCount: Int { get }
    var isAllIntra: Bool { get }
    func metadata(atDecodeIndex index: Int) -> StudioSampleIndexEntry
    func sampleBuffer(atDecodeIndex index: Int) throws -> CMSampleBuffer
}

/// Current behavior: every compressed sample is retained in memory.
///
/// Kept as the default for short assets and as the explicit-limit test path.
public struct EagerStudioSampleProvider: StudioSampleProvider {
    public let samples: [StudioCompressedSample]

    public init(samples: [StudioCompressedSample]) {
        self.samples = samples
    }

    public var sampleCount: Int { samples.count }
    public var isAllIntra: Bool { samples.allSatisfy(\.isSyncSample) }

    public func metadata(atDecodeIndex index: Int) -> StudioSampleIndexEntry {
        let sample = samples[index]
        return StudioSampleIndexEntry(
            frameIndex: sample.frameIndex,
            isSyncSample: sample.isSyncSample,
            presentationTime: sample.presentationTime
        )
    }

    public func sampleBuffer(atDecodeIndex index: Int) throws -> CMSampleBuffer {
        samples[index].sampleBuffer
    }
}

/// Bounded payload cache over a real container.
///
/// Metadata is loaded eagerly (small). Payloads are read on demand through a
/// forward AVAssetReader and cached up to `payloadCacheLimit`. A backward seek
/// restarts from the nearest preceding sync sample using a fresh reader scoped
/// to that keyframe's presentation time, so memory stays bounded regardless of
/// asset length.
public final class BoundedStudioSampleProvider: StudioSampleProvider {
    public let sampleCount: Int
    public let isAllIntra: Bool
    private let metadata: [StudioSampleIndexEntry]
    private let formatDescription: CMVideoFormatDescription
    private let makeReader: () throws -> AVAssetReader
    private let makeOutput: (AVAssetReader) throws -> AVAssetReaderTrackOutput
    private let payloadCacheLimit: Int

    private var cache: [Int: CMSampleBuffer] = [:]
    private var cacheOrder: [Int] = []
    private var reader: AVAssetReader?
    private var readerOutput: AVAssetReaderTrackOutput?
    private var readerPosition: Int = 0

    public init(
        metadata: [StudioSampleIndexEntry],
        formatDescription: CMVideoFormatDescription,
        initialReader: AVAssetReader? = nil,
        initialOutput: AVAssetReaderTrackOutput? = nil,
        initialReaderPosition: Int = 0,
        makeReader: @escaping () throws -> AVAssetReader,
        makeOutput: @escaping (AVAssetReader) throws -> AVAssetReaderTrackOutput,
        payloadCacheLimit: Int = 240
    ) {
        self.metadata = metadata
        self.formatDescription = formatDescription
        self.sampleCount = metadata.count
        self.isAllIntra = metadata.allSatisfy(\.isSyncSample)
        self.reader = initialReader
        self.readerOutput = initialOutput
        self.readerPosition = initialReaderPosition
        self.makeReader = makeReader
        self.makeOutput = makeOutput
        self.payloadCacheLimit = max(1, payloadCacheLimit)
    }

    /// Number of compressed payloads currently resident. Test-only diagnostic;
    /// the bound is the contract, not a performance knob.
    var cacheCount: Int { cache.count }

    public func metadata(atDecodeIndex index: Int) -> StudioSampleIndexEntry {
        metadata[index]
    }

    public func sampleBuffer(atDecodeIndex index: Int) throws -> CMSampleBuffer {
        if let cached = cache[index] {
            touch(index)
            return cached
        }

        if reader == nil || index < readerPosition {
            try startReader(at: index)
        }

        while readerPosition <= index {
            guard let buffer = readNext() else {
                throw StudioMediaLoadError.readFailed("unexpected end of samples")
            }
            insert(buffer, at: readerPosition)
            readerPosition += 1
        }

        guard let buffer = cache[index] else {
            throw StudioMediaLoadError.readFailed("sample missing after forward read")
        }
        touch(index)
        return buffer
    }

    static func attachingFormatDescription(
        to buffer: CMSampleBuffer,
        formatDescription: CMVideoFormatDescription
    ) -> CMSampleBuffer {
        guard CMSampleBufferGetFormatDescription(buffer) == nil else {
            return buffer
        }
        var timingInfo = CMSampleTimingInfo()
        CMSampleBufferGetSampleTimingInfo(buffer, at: 0, timingInfoOut: &timingInfo)
        var size = CMSampleBufferGetSampleSize(buffer, at: 0)

        var newBuffer: CMSampleBuffer?
        let status = CMSampleBufferCreate(
            allocator: kCFAllocatorDefault,
            dataBuffer: CMSampleBufferGetDataBuffer(buffer),
            dataReady: true,
            makeDataReadyCallback: nil,
            refcon: nil,
            formatDescription: formatDescription,
            sampleCount: 1,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timingInfo,
            sampleSizeEntryCount: 1,
            sampleSizeArray: &size,
            sampleBufferOut: &newBuffer
        )
        guard status == noErr, let created = newBuffer else { return buffer }

        if
            let sourceAttachments = CMSampleBufferGetSampleAttachmentsArray(
                buffer,
                createIfNecessary: false
            ) as? [[CFString: Any]],
            let destinationAttachments = CMSampleBufferGetSampleAttachmentsArray(
                created,
                createIfNecessary: true
            ) as? [NSMutableDictionary]
        {
            for (index, sourceAttachment) in sourceAttachments.enumerated()
            where index < destinationAttachments.count {
                for (key, value) in sourceAttachment {
                    destinationAttachments[index][key] = value
                }
            }
        }
        return created
    }

    private func startReader(at index: Int) throws {
        // Nearest preceding sync sample is the only legal decode start.
        var keyframeIndex = 0
        var cursor = index
        while cursor >= 0 {
            if metadata[cursor].isSyncSample {
                keyframeIndex = cursor
                break
            }
            cursor -= 1
        }

        let newReader = try makeReader()
        let output = try makeOutput(newReader)
        guard newReader.startReading() else {
            throw StudioMediaLoadError.readFailed(String(describing: newReader.error))
        }

        reader = newReader
        readerOutput = output

        // Skip exactly to the keyframe by count. This is exact regardless of
        // container timebase quirks, and the skip length is bounded by the GOP.
        var currentIndex = 0
        while currentIndex < keyframeIndex {
            guard nextPayloadBuffer(from: output) != nil else {
                throw StudioMediaLoadError.readFailed("unexpected end while skipping to keyframe")
            }
            currentIndex += 1
        }

        guard let finalBuffer = nextPayloadBuffer(from: output) else {
            throw StudioMediaLoadError.readFailed("no valid samples at requested keyframe")
        }

        insert(
            Self.attachingFormatDescription(
                to: finalBuffer,
                formatDescription: formatDescription
            ),
            at: keyframeIndex
        )
        readerPosition = keyframeIndex + 1
    }

    private func readNext() -> CMSampleBuffer? {
        guard let output = readerOutput else { return nil }
        guard let buffer = nextPayloadBuffer(from: output) else { return nil }
        return Self.attachingFormatDescription(
            to: buffer,
            formatDescription: formatDescription
        )
    }

    /// Matches the metadata pass exactly. AVAssetReader may emit stream/event
    /// buffers with a valid timestamp but no compressed payload. Counting one
    /// as a frame shifts every decode index and submitting it to VideoToolbox
    /// produces a bad-data failure.
    private func nextPayloadBuffer(from output: AVAssetReaderTrackOutput) -> CMSampleBuffer? {
        while true {
            guard let buffer = output.copyNextSampleBuffer() else { return nil }
            if CMSampleBufferGetDataBuffer(buffer) != nil,
                CMSampleBufferGetPresentationTimeStamp(buffer).isValid
            {
                return buffer
            }
        }
    }

    private func insert(_ buffer: CMSampleBuffer, at index: Int) {
        if cache[index] == nil {
            cacheOrder.append(index)
        }
        cache[index] = buffer
        while cacheOrder.count > payloadCacheLimit {
            let evicted = cacheOrder.removeFirst()
            cache.removeValue(forKey: evicted)
        }
    }

    private func touch(_ index: Int) {
        if let position = cacheOrder.firstIndex(of: index) {
            cacheOrder.remove(at: position)
            cacheOrder.append(index)
        }
    }
}
