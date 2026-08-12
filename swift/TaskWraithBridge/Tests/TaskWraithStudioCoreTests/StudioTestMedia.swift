import CoreMedia
import CoreVideo
import VideoToolbox
import XCTest

@testable import TaskWraithStudioCore

/// Shared media fixtures for the Studio video tests.
///
/// Frames are ENCODED with a real VTCompressionSession rather than loaded from a
/// checked-in binary, so every decode test exercises a genuine compressed sample
/// carrying a real CMVideoFormatDescription (real SPS/PPS).
///
/// The CPU writes below are fixture construction — synthesising a source frame —
/// which is the opposite of the banked AVCDAW do-not-repeat note about
/// CPU-visible access on the PRESENTATION path. No production Studio code locks
/// a pixel-buffer base address.
enum StudioTestMedia {
    static let defaultWidth = 128
    static let defaultHeight = 128

    /// A flat full-range bi-planar frame: constant luma, neutral chroma.
    static func flatPixelBuffer(
        luma: UInt8,
        width: Int = defaultWidth,
        height: Int = defaultHeight
    ) throws -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            width,
            height,
            kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
            [
                kCVPixelBufferMetalCompatibilityKey: true,
                kCVPixelBufferIOSurfacePropertiesKey: [CFString: Any]() as CFDictionary,
            ] as CFDictionary,
            &buffer
        )
        let pixelBuffer = try XCTUnwrap(buffer, "CVPixelBufferCreate failed: \(status)")

        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }

        if let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) {
            let stride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
            let pointer = base.assumingMemoryBound(to: UInt8.self)
            for y in 0..<CVPixelBufferGetHeightOfPlane(pixelBuffer, 0) {
                for x in 0..<CVPixelBufferGetWidthOfPlane(pixelBuffer, 0) {
                    pointer[y * stride + x] = luma
                }
            }
        }
        // NV12: plane 1 interleaves Cb and Cr at half resolution.
        if let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 1) {
            let stride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 1)
            let pointer = base.assumingMemoryBound(to: UInt8.self)
            for y in 0..<CVPixelBufferGetHeightOfPlane(pixelBuffer, 1) {
                for x in 0..<CVPixelBufferGetWidthOfPlane(pixelBuffer, 1) {
                    pointer[y * stride + x * 2] = 128
                    pointer[y * stride + x * 2 + 1] = 128
                }
            }
        }
        return pixelBuffer
    }

    private final class EncodeCollector: @unchecked Sendable {
        var encoded: [(pts: CMTime, sample: CMSampleBuffer)] = []
        var failure: OSStatus = noErr
    }

    /// One flat H.264 frame per level, every frame forced to a keyframe so each
    /// sample is independently decodable. GOP-aware seeking does not exist yet,
    /// and these fixtures deliberately sidestep it rather than pretend.
    static func encodeFlatFrames(
        lumaLevels: [UInt8],
        width: Int = defaultWidth,
        height: Int = defaultHeight
    ) throws -> (formatDescription: CMVideoFormatDescription, samples: [StudioCompressedSample]) {
        var session: VTCompressionSession?
        let createStatus = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(width),
            height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &session
        )
        let compression = try XCTUnwrap(
            session,
            "VTCompressionSessionCreate failed: \(createStatus)"
        )
        defer { VTCompressionSessionInvalidate(compression) }

        VTSessionSetProperty(
            compression,
            key: kVTCompressionPropertyKey_RealTime,
            value: kCFBooleanTrue
        )
        // No B-frames, so encoded order matches presentation order.
        VTSessionSetProperty(
            compression,
            key: kVTCompressionPropertyKey_AllowFrameReordering,
            value: kCFBooleanFalse
        )
        VTSessionSetProperty(
            compression,
            key: kVTCompressionPropertyKey_ProfileLevel,
            value: kVTProfileLevel_H264_Baseline_AutoLevel
        )

        let collector = EncodeCollector()
        for (index, level) in lumaLevels.enumerated() {
            let frame = try flatPixelBuffer(luma: level, width: width, height: height)
            let status = VTCompressionSessionEncodeFrame(
                compression,
                imageBuffer: frame,
                presentationTimeStamp: CMTime(value: Int64(index), timescale: 30),
                duration: CMTime(value: 1, timescale: 30),
                frameProperties: [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary,
                infoFlagsOut: nil
            ) { status, _, sampleBuffer in
                if status != noErr {
                    collector.failure = status
                    return
                }
                if let sampleBuffer {
                    collector.encoded.append(
                        (CMSampleBufferGetPresentationTimeStamp(sampleBuffer), sampleBuffer)
                    )
                }
            }
            XCTAssertEqual(status, noErr, "encode submission failed for level \(level)")
        }
        // Barrier: every output handler has run once this returns.
        VTCompressionSessionCompleteFrames(compression, untilPresentationTimeStamp: .invalid)

        XCTAssertEqual(collector.failure, noErr, "encoder reported a failure")
        guard collector.encoded.count == lumaLevels.count else {
            throw XCTSkip(
                "encoder produced \(collector.encoded.count) of \(lumaLevels.count) frames"
            )
        }

        let ordered = collector.encoded.sorted { $0.pts.value < $1.pts.value }
        let formatDescription = try XCTUnwrap(
            CMSampleBufferGetFormatDescription(ordered[0].sample),
            "encoded sample carried no format description"
        )
        let samples = ordered.map {
            StudioCompressedSample(frameIndex: $0.pts.value, sampleBuffer: $0.sample)
        }
        return (formatDescription, samples)
    }

    /// A ready-to-use decoded source over flat frames.
    static func makeFrameSource(
        lumaLevels: [UInt8],
        device: MTLDevice
    ) throws -> StudioVideoFrameSource {
        let encoded = try encodeFlatFrames(lumaLevels: lumaLevels)
        return try StudioVideoFrameSource(
            formatDescription: encoded.formatDescription,
            samples: encoded.samples,
            device: device
        )
    }
}
