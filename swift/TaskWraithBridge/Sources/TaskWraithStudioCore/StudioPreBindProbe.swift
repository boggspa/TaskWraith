import CoreMedia
import CoreVideo
import Foundation
import IOSurface

/// Test-installable probe that fires immediately before a `CVPixelBuffer` is
/// wrapped as Metal textures.
///
/// Production never installs a sink, so the call is a nil-check. Tests install
/// a sink that COPIES plane bytes synchronously; they must not retain the
/// live `CVPixelBuffer` itself, because that would pin the decoder pool and
/// hide the reuse defect this probe exists to see.
public enum StudioPreBindProbe {
    public struct Sample: Sendable {
        public let presentationTime: CMTime
        public let planeBytes: [UInt8]
        public let ioSurfaceID: IOSurfaceID?
        public let width: Int
        public let height: Int

        public init(
            presentationTime: CMTime,
            planeBytes: [UInt8],
            ioSurfaceID: IOSurfaceID?,
            width: Int,
            height: Int
        ) {
            self.presentationTime = presentationTime
            self.planeBytes = planeBytes
            self.ioSurfaceID = ioSurfaceID
            self.width = width
            self.height = height
        }
    }

    /// Optional sink. Not Sendable on purpose: the live display-link path is
    /// main-thread, and a test installs/clears this on the same thread.
    nonisolated(unsafe) public static var sink: ((CVPixelBuffer, CMTime) -> Void)?

    @inline(__always)
    public static func record(_ pixelBuffer: CVPixelBuffer, presentationTime: CMTime) {
        sink?(pixelBuffer, presentationTime)
    }

    /// Tight Y then CbCr copies. Stride padding is stripped so a padded
    /// IOSurface row cannot masquerade as picture disagreement.
    public static func copyTightPlanes(_ pixelBuffer: CVPixelBuffer) throws -> [UInt8] {
        let planeCount = CVPixelBufferGetPlaneCount(pixelBuffer)
        guard planeCount >= 2 else {
            throw StudioVideoDecoderError.decodeProducedNoFrame
        }
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        var bytes: [UInt8] = []
        for plane in 0..<planeCount {
            let width = CVPixelBufferGetWidthOfPlane(pixelBuffer, plane)
            let height = CVPixelBufferGetHeightOfPlane(pixelBuffer, plane)
            let stride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, plane)
            let bytesPerPixel = plane == 0 ? 1 : 2
            let rowBytes = width * bytesPerPixel
            guard let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, plane) else {
                throw StudioVideoDecoderError.decodeProducedNoFrame
            }
            let pointer = base.assumingMemoryBound(to: UInt8.self)
            bytes.reserveCapacity(bytes.count + rowBytes * height)
            for y in 0..<height {
                bytes.append(
                    contentsOf: UnsafeBufferPointer(
                        start: pointer + y * stride,
                        count: rowBytes
                    )
                )
            }
        }
        return bytes
    }

    public static func ioSurfaceID(of pixelBuffer: CVPixelBuffer) -> IOSurfaceID? {
        guard let surface = CVPixelBufferGetIOSurface(pixelBuffer)?.takeUnretainedValue() else {
            return nil
        }
        return IOSurfaceGetID(surface)
    }

    public static func makeSample(
        from pixelBuffer: CVPixelBuffer,
        presentationTime: CMTime
    ) throws -> Sample {
        Sample(
            presentationTime: presentationTime,
            planeBytes: try copyTightPlanes(pixelBuffer),
            ioSurfaceID: ioSurfaceID(of: pixelBuffer),
            width: CVPixelBufferGetWidth(pixelBuffer),
            height: CVPixelBufferGetHeight(pixelBuffer)
        )
    }

    /// Quantified plane disagreement. The warm pre-bind 593/1 was a firstDiff
    /// of 108 vs 109 / 77 vs 72 with no byte-count; packaged trails are
    /// thousands of pixels. Those are different classes and must not share a
    /// boolean.
    public struct PlaneDiff: Sendable, Equatable {
        public let mismatchCount: Int
        public let maxAbsDelta: Int
        public let firstIndex: Int
        public let firstLive: UInt8
        public let firstFresh: UInt8
        public let liveCount: Int
        public let freshCount: Int

        public var isIdentical: Bool {
            mismatchCount == 0 && liveCount == freshCount
        }

        /// Accumulated stripe/checker residue, not a handful of ±1 luma codes
        /// after a warm VideoToolbox session.
        public var isTrailClass: Bool {
            liveCount != freshCount || mismatchCount > 64 || maxAbsDelta > 8
        }

        public var summary: String {
            "mismatchCount=\(mismatchCount) maxAbs=\(maxAbsDelta) firstDiff=\(firstIndex) live=\(firstLive) fresh=\(firstFresh) (\(liveCount) vs \(freshCount) bytes)"
        }
    }

    public static func diffPlanes(live: [UInt8], fresh: [UInt8]) -> PlaneDiff {
        let n = min(live.count, fresh.count)
        var mismatchCount = abs(live.count - fresh.count)
        var maxAbsDelta = live.count == fresh.count ? 0 : 255
        var firstIndex = -1
        var firstLive: UInt8 = 0
        var firstFresh: UInt8 = 0
        if n > 0 {
            for i in 0..<n {
                let delta = abs(Int(live[i]) - Int(fresh[i]))
                if delta == 0 { continue }
                mismatchCount += 1
                if delta > maxAbsDelta { maxAbsDelta = delta }
                if firstIndex < 0 {
                    firstIndex = i
                    firstLive = live[i]
                    firstFresh = fresh[i]
                }
            }
        }
        return PlaneDiff(
            mismatchCount: mismatchCount,
            maxAbsDelta: maxAbsDelta,
            firstIndex: firstIndex,
            firstLive: firstLive,
            firstFresh: firstFresh,
            liveCount: live.count,
            freshCount: fresh.count
        )
    }
}
