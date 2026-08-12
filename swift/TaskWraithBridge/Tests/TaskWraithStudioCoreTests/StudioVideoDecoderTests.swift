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
        let (formatDescription, samples) = try StudioTestMedia.encodeFlatFrames(lumaLevels: [128])
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
        let (formatDescription, samples) = try StudioTestMedia.encodeFlatFrames(lumaLevels: [32, 224])
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
        let (formatDescription, samples) = try StudioTestMedia.encodeFlatFrames(lumaLevels: levels)
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
        let (formatDescription, samples) = try StudioTestMedia.encodeFlatFrames(lumaLevels: [32, 224])
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
        let (formatDescription, samples) = try StudioTestMedia.encodeFlatFrames(lumaLevels: [128])
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
        let (formatDescription, samples) = try StudioTestMedia.encodeFlatFrames(lumaLevels: [128])
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
        let (formatDescription, samples) = try StudioTestMedia.encodeFlatFrames(lumaLevels: [128])
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
        let (formatDescription, _) = try StudioTestMedia.encodeFlatFrames(lumaLevels: [128])
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
        let (formatDescription, samples) = try StudioTestMedia.encodeFlatFrames(lumaLevels: [32, 224])
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
