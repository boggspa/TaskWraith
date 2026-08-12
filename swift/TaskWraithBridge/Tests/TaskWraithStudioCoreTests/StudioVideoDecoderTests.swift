import CoreMedia
import CoreVideo
import Metal
import VideoToolbox
import XCTest

@testable import TaskWraithStudioCore

/// End-to-end video path verification: REAL H.264 in, Metal texture out.
///
/// The fixture encodes actual frames with VTCompressionSession rather than
/// shipping a binary asset, so every test decodes a genuine compressed sample
/// carrying a real CMVideoFormatDescription (real SPS/PPS). That makes
/// "VideoToolbox to Metal works on this stack" a measured claim.
///
/// Absolute luma is asserted loosely and ORDERING strictly, because H.264 is
/// lossy and range tagging can shift levels a little; what must be exact is
/// which frame appears, that the decoded buffer is IOSurface-backed and
/// bi-planar, and that it binds with no copy.
final class StudioVideoDecoderTests: XCTestCase {
    private let width = 128
    private let height = 128

    // MARK: - Fixtures

    private func makeDevice() throws -> MTLDevice {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device available on this machine")
        }
        return device
    }

    /// Flat full-range bi-planar source frame. CPU writes here are fixture
    /// construction, not a presentation path.
    private func makeFlatPixelBuffer(luma: UInt8) throws -> CVPixelBuffer {
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

    /// Encodes one flat frame per level, every frame forced to a keyframe so each
    /// sample is independently decodable (GOP-aware seek is a later slice).
    private func encodeFlatFrames(
        lumaLevels: [UInt8]
    ) throws -> (CMVideoFormatDescription, [StudioCompressedSample]) {
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
            let frame = try makeFlatPixelBuffer(luma: level)
            let presentationTime = CMTime(value: Int64(index), timescale: 30)
            let status = VTCompressionSessionEncodeFrame(
                compression,
                imageBuffer: frame,
                presentationTimeStamp: presentationTime,
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

    private func renderedGreen(
        _ textures: StudioVideoFrameTextures,
        renderer: StudioVideoFrameRenderer
    ) throws -> Int {
        let target = try StudioTestPatternRenderer.makeOffscreenTarget(
            device: renderer.device,
            width: width,
            height: height
        )
        try renderer.render(frame: textures, to: target)
        let pixel = try StudioTestPatternRenderer.readPixel(from: target, x: 64, y: 64)
        return Int(pixel.green)
    }

    // MARK: - Decode

    func testDecodedBuffersAreBiPlanarIoSurfaceBackedAndMetalBindable() throws {
        let device = try makeDevice()
        let (formatDescription, samples) = try encodeFlatFrames(lumaLevels: [128])
        let decoder = try StudioVideoDecoder(formatDescription: formatDescription)
        defer { decoder.invalidate() }

        let pixelBuffer = try decoder.decode(samples[0].sampleBuffer)

        let formatType = CVPixelBufferGetPixelFormatType(pixelBuffer)
        XCTAssertTrue(
            formatType == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
                || formatType == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            "decoder must emit a bi-planar format, got \(formatType)"
        )
        // IOSurface backing is what makes the zero-copy binding possible at all.
        XCTAssertNotNil(
            CVPixelBufferGetIOSurface(pixelBuffer),
            "decoded buffer must be IOSurface-backed or it cannot bind to Metal"
        )
        XCTAssertEqual(CVPixelBufferGetPlaneCount(pixelBuffer), 2)

        let bridge = try StudioVideoTextureBridge(device: device)
        let textures = try bridge.makeTextures(from: pixelBuffer)
        XCTAssertEqual(textures.luma.pixelFormat, .r8Unorm)
        XCTAssertEqual(textures.luma.width, width)
        XCTAssertEqual(textures.chroma.pixelFormat, .rg8Unorm)
        XCTAssertEqual(textures.chroma.width, width / 2)
        XCTAssertEqual(decoder.decodedFrameCount, 1)
        XCTAssertEqual(decoder.failedDecodeCount, 0)
    }

    func testDecodedFrameRendersThroughTheZeroCopyPath() throws {
        let device = try makeDevice()
        let renderer = try StudioVideoFrameRenderer(device: device)
        let (formatDescription, samples) = try encodeFlatFrames(lumaLevels: [32, 224])
        let source = try StudioVideoFrameSource(
            formatDescription: formatDescription,
            samples: samples,
            device: device
        )
        defer { source.invalidate() }

        let dark = try renderedGreen(try source.textures(forFrameIndex: 0), renderer: renderer)
        let bright = try renderedGreen(try source.textures(forFrameIndex: 1), renderer: renderer)

        XCTAssertLessThan(dark, 96, "flat Y=32 must decode and render dark, got \(dark)")
        XCTAssertGreaterThan(bright, 160, "flat Y=224 must render bright, got \(bright)")
    }

    // MARK: - Clock-driven selection

    /// The playback clock alone decides which decoded frame is on screen.
    func testPlaybackClockSelectsTheCorrectDecodedFrame() throws {
        let device = try makeDevice()
        let renderer = try StudioVideoFrameRenderer(device: device)
        let levels: [UInt8] = [32, 96, 160, 224]
        let (formatDescription, samples) = try encodeFlatFrames(lumaLevels: levels)
        let source = try StudioVideoFrameSource(
            formatDescription: formatDescription,
            samples: samples,
            device: device
        )
        defer { source.invalidate() }

        // 30fps integer timebase keeps host seconds and frame indices exact.
        var clock = StudioPlaybackClock(
            timebase: StudioTimebase(timescale: 30, frameDurationTicks: 1)!,
            durationTicks: 4
        )

        var greens: [Int] = []
        for frame in 0..<levels.count {
            clock.seek(toTicks: Int64(frame), atHost: 0)
            let snapshot = clock.snapshot(atHost: 0)
            XCTAssertEqual(snapshot.frameIndex, Int64(frame))
            greens.append(
                try renderedGreen(try source.textures(at: snapshot), renderer: renderer)
            )
        }

        for index in 1..<greens.count {
            XCTAssertGreaterThan(
                greens[index],
                greens[index - 1],
                "frame \(index) must render brighter than \(index - 1): \(greens)"
            )
        }
        XCTAssertEqual(source.decodeCount, levels.count)
    }

    func testSampleSelectionHoldsThePreviousFrame() throws {
        let device = try makeDevice()
        let (formatDescription, samples) = try encodeFlatFrames(lumaLevels: [32, 224])
        let source = try StudioVideoFrameSource(
            formatDescription: formatDescription,
            samples: samples,
            device: device
        )
        defer { source.invalidate() }

        XCTAssertEqual(source.sample(forFrameIndex: 0).frameIndex, 0)
        XCTAssertEqual(source.sample(forFrameIndex: 1).frameIndex, 1)
        // Past the last sample the newest frame stays on screen.
        XCTAssertEqual(source.sample(forFrameIndex: 99).frameIndex, 1)
        // Before the start, the first frame is shown rather than nothing.
        XCTAssertEqual(source.sample(forFrameIndex: -5).frameIndex, 0)
    }

    func testRepeatedRequestsForOneFrameHitTheCache() throws {
        let device = try makeDevice()
        let (formatDescription, samples) = try encodeFlatFrames(lumaLevels: [128])
        let source = try StudioVideoFrameSource(
            formatDescription: formatDescription,
            samples: samples,
            device: device
        )
        defer { source.invalidate() }

        _ = try source.textures(forFrameIndex: 0)
        _ = try source.textures(forFrameIndex: 0)
        _ = try source.textures(forFrameIndex: 0)

        XCTAssertEqual(source.decodeCount, 1, "one decode for three display-link ticks")
        XCTAssertEqual(source.cacheHitCount, 2)
    }

    // MARK: - Teardown

    func testInvalidateTearsDownAndIsIdempotent() throws {
        let device = try makeDevice()
        let (formatDescription, samples) = try encodeFlatFrames(lumaLevels: [128])
        let source = try StudioVideoFrameSource(
            formatDescription: formatDescription,
            samples: samples,
            device: device
        )
        _ = try source.textures(forFrameIndex: 0)
        XCTAssertTrue(source.isValid)

        source.invalidate()
        XCTAssertFalse(source.isValid)
        source.invalidate()  // idempotent
        XCTAssertFalse(source.isValid)

        XCTAssertThrowsError(try source.textures(forFrameIndex: 0)) { error in
            XCTAssertEqual(error as? StudioVideoFrameSourceError, .invalidated)
        }
    }

    func testDecoderRejectsUseAfterInvalidate() throws {
        let (formatDescription, samples) = try encodeFlatFrames(lumaLevels: [128])
        let decoder = try StudioVideoDecoder(formatDescription: formatDescription)
        _ = try decoder.decode(samples[0].sampleBuffer)

        decoder.invalidate()
        XCTAssertFalse(decoder.isValid)
        XCTAssertThrowsError(try decoder.decode(samples[0].sampleBuffer)) { error in
            XCTAssertEqual(error as? StudioVideoDecoderError, .sessionInvalidated)
        }
    }

    func testEmptySampleListIsRejected() throws {
        let device = try makeDevice()
        let (formatDescription, _) = try encodeFlatFrames(lumaLevels: [128])
        XCTAssertThrowsError(
            try StudioVideoFrameSource(
                formatDescription: formatDescription,
                samples: [],
                device: device
            )
        ) { error in
            XCTAssertEqual(error as? StudioVideoFrameSourceError, .noSamples)
        }
    }

    func testDiagnosticsReportDecodeAndBindActivity() throws {
        let device = try makeDevice()
        let (formatDescription, samples) = try encodeFlatFrames(lumaLevels: [32, 224])
        let source = try StudioVideoFrameSource(
            formatDescription: formatDescription,
            samples: samples,
            device: device
        )
        defer { source.invalidate() }

        _ = try source.textures(forFrameIndex: 0)
        _ = try source.textures(forFrameIndex: 1)
        _ = try source.textures(forFrameIndex: 1)

        let diagnostics = source.diagnostics
        XCTAssertEqual(diagnostics.sampleCount, 2)
        XCTAssertEqual(diagnostics.decodeCount, 2)
        XCTAssertEqual(diagnostics.cacheHitCount, 1)
        XCTAssertEqual(diagnostics.decodedFrameCount, 2)
        XCTAssertEqual(diagnostics.boundFrameCount, 2)
        XCTAssertEqual(diagnostics.failedDecodeCount, 0)
        XCTAssertEqual(diagnostics.failedBindCount, 0)
        XCTAssertTrue(diagnostics.isValid)
    }
}
