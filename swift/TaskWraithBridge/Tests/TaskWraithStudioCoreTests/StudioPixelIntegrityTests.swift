import CoreMedia
import CoreVideo
import XCTest

@testable import TaskWraithStudioCore

/// The pre-bind discriminator for the packaged trails defect.
///
/// Work1's packaged storm reproduced accumulated macroblock/stripe/checker
/// corruption after 523 backward seconds over a 600s VFR asset. Two in-process
/// controls already eliminated the short-asset eager path (decode storm) and
/// the compositing path (reused target), but neither drove the LONG-ASSET
/// path: BoundedStudioSampleProvider payloads plus StudioVideoDecoder through
/// far jumps and backward restarts on a VFR stream with real IDRs.
///
/// This walks that exact pair and copies the DECODED Y/CbCr planes from the
/// CVPixelBuffer BEFORE any CVMetalTexture bind. Comparing those bytes against
/// a fresh sequential decode is the layer split the packaged probe cannot do:
///
/// RED  => corruption exists before Metal: discontinuity handling, session
///         state, or the bounded provider.
/// GREEN => the decoded stream is correct after the storm; the surviving
///          hypothesis is presented-path texture lifetime.
///
/// Kimi/Work2 authored the VFR fixture and the storm shape; this seat kept
/// both and moved the comparison off `source.textures()` so a zero-copy bind
/// cannot hide a post-decode texture-lease defect as a decode failure.
final class StudioPixelIntegrityTests: XCTestCase {
    /// 22 seconds across 24/30/60fps sections: 720 frames, IDR every 16.
    private let vfrSections: [(frameRate: Int32, frameCount: Int)] = [
        (24, 240), (30, 240), (60, 240),
    ]

    private func makeVFRMovie(at url: URL) async throws {
        try await StudioTestMedia.writeMovingVFRMovie(
            sections: vfrSections,
            to: url,
            maxKeyFrameInterval: 16
        )
    }

    func testBoundedVFRRestartStormDoesNotChangeDecodedBytes() async throws {
        let url = StudioTestMedia.makeTemporaryMovieURL()
        try await makeVFRMovie(at: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let asset = StudioMediaAsset(assetId: "vfr", path: url.path, mediaKind: .video)

        // REFERENCE: a fresh bounded provider + decoder on a plain sequential
        // pass. If the storm session disagrees with this, the disagreement IS
        // the defect, and it exists before Metal.
        let referenceMedia = try await StudioMediaSourceLoader.loadBounded(asset: asset)
        XCTAssertTrue(
            referenceMedia.sampleProvider is BoundedStudioSampleProvider,
            "this control is vacuous unless it drives the long-asset provider"
        )
        let count = referenceMedia.sampleProvider.sampleCount
        XCTAssertEqual(count, 720, "fixture shape changed; update the storm below")
        XCTAssertFalse(
            referenceMedia.allSamplesAreSyncSamples,
            "the fixture must be inter-coded or this control proves nothing"
        )

        let referenceWalker = try PreBindDecodeWalker(media: referenceMedia)
        defer { referenceWalker.invalidate() }
        let checkpoints = [12, 100, 300, 500, 719]
        var referenceBytes: [Int: [UInt8]] = [:]
        for decodeIndex in 0..<count {
            let frame = try referenceWalker.decode(decodeIndex: decodeIndex)
            if checkpoints.contains(decodeIndex) {
                referenceBytes[decodeIndex] = try planeBytes(frame.pixelBuffer)
            }
        }
        XCTAssertNotEqual(
            referenceBytes[100], referenceBytes[300],
            "the fixture must actually move or byte-equality is vacuous"
        )

        // STORM: the packaged probe's shape — far jumps forward, then hundreds
        // of single-frame backward steps, each one feeding an IDR into the
        // EXISTING decompression session. No texture bridge is constructed.
        let stormMedia = try await StudioMediaSourceLoader.loadBounded(asset: asset)
        XCTAssertTrue(
            stormMedia.sampleProvider is BoundedStudioSampleProvider,
            "storm path must also use the bounded provider"
        )
        let stormWalker = try PreBindDecodeWalker(media: stormMedia)
        defer { stormWalker.invalidate() }
        for decodeIndex in stride(from: 719, through: 479, by: -1) {
            _ = try stormWalker.decode(decodeIndex: decodeIndex)
        }
        for decodeIndex in stride(from: 350, through: 170, by: -1) {
            _ = try stormWalker.decode(decodeIndex: decodeIndex)
        }
        for decodeIndex in stride(from: 120, through: 17, by: -1) {
            _ = try stormWalker.decode(decodeIndex: decodeIndex)
        }

        for decodeIndex in checkpoints {
            let after = try planeBytes(
                stormWalker.decode(decodeIndex: decodeIndex).pixelBuffer
            )
            let before = try XCTUnwrap(referenceBytes[decodeIndex])
            XCTAssertEqual(
                after, before,
                "decode index \(decodeIndex) changed after the far-jump/backward storm"
            )
        }
    }
}

/// FrameSource's restart walk without the texture bridge.
///
/// Backward hops restart at the nearest preceding IDR and re-submit that IDR
/// into the same VTDecompressionSession — the transition the packaged storm
/// performs hundreds of times. Sequential hops continue from the last decoded
/// index when that is cheaper than a keyframe restart.
private final class PreBindDecodeWalker {
    private let media: StudioLoadedMedia
    private let decoder: StudioVideoDecoder
    private let syncIndices: [Int]
    private var lastDecodedIndex: Int?

    init(media: StudioLoadedMedia) throws {
        self.media = media
        self.decoder = try StudioVideoDecoder(formatDescription: media.formatDescription)
        self.syncIndices = (0..<media.sampleProvider.sampleCount).filter {
            media.sampleProvider.metadata(atDecodeIndex: $0).isSyncSample
        }
        guard syncIndices.first == 0 else {
            throw StudioVideoFrameSourceError.noLeadingKeyframe
        }
    }

    func decode(decodeIndex: Int) throws -> StudioDecodedFrame {
        let keyframe = syncIndex(atOrBefore: decodeIndex)
        var start = keyframe
        if let last = lastDecodedIndex, decodeIndex > last,
            (decodeIndex - last) <= (decodeIndex - keyframe)
        {
            start = last + 1
        }

        var decoded: StudioDecodedFrame?
        for index in start...decodeIndex {
            do {
                decoded = try decoder.decode(
                    media.sampleProvider.sampleBuffer(atDecodeIndex: index)
                )
            } catch {
                lastDecodedIndex = nil
                throw error
            }
        }
        lastDecodedIndex = decodeIndex

        let frame = try XCTUnwrap(decoded)
        let expected = media.sampleProvider.metadata(atDecodeIndex: decodeIndex).presentationTime
        if expected.isValid, frame.presentationTime.isValid,
            CMTimeCompare(frame.presentationTime, expected) != 0
        {
            lastDecodedIndex = nil
            throw StudioVideoFrameSourceError.frameMismatch(
                expectedTicks: expected.value,
                decodedTicks: frame.presentationTime.value
            )
        }
        return frame
    }

    func invalidate() {
        lastDecodedIndex = nil
        decoder.invalidate()
    }

    private func syncIndex(atOrBefore decodeIndex: Int) -> Int {
        var chosen = syncIndices[0]
        for candidate in syncIndices where candidate <= decodeIndex {
            chosen = candidate
        }
        return chosen
    }
}

/// Tight Y then CbCr copies. Stride padding is stripped so a padded IOSurface
/// row cannot masquerade as picture disagreement.
private func planeBytes(_ pixelBuffer: CVPixelBuffer) throws -> [UInt8] {
    let planeCount = CVPixelBufferGetPlaneCount(pixelBuffer)
    XCTAssertGreaterThanOrEqual(planeCount, 2, "expected bi-planar Y/CbCr output")
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
