import CoreVideo
import Metal
import XCTest

@testable import TaskWraithStudioCore

/// Zero-copy path verification.
///
/// These build REAL IOSurface-backed bi-planar pixel buffers — the same shape a
/// VideoToolbox decoder emits — bind their planes through CVMetalTextureCache,
/// render them through the shader, and assert the resulting RGB. So "zero-copy
/// works on this stack" is a measured claim, not an architectural one.
///
/// NOTE on CVPixelBufferLockBaseAddress below: the banked AVCDAW do-not-repeat
/// note bans CPU-visible pixel access on the PRESENTATION path. Synthesising a
/// source frame in a test fixture is the opposite direction and is unavoidable;
/// nothing in StudioVideoTextureBridge or StudioVideoFrameRenderer locks a base
/// address.
final class StudioVideoTextureBridgeTests: XCTestCase {
    private let width = 64
    private let height = 64

    // MARK: - Fixtures

    private func makeBiPlanarBuffer(
        range: StudioVideoRange = .full,
        cb: UInt8 = 128,
        cr: UInt8 = 128,
        metalCompatible: Bool = true,
        luma: (Int, Int) -> UInt8
    ) throws -> CVPixelBuffer {
        var attributes: [CFString: Any] = [:]
        if metalCompatible {
            attributes[kCVPixelBufferMetalCompatibilityKey] = true
            attributes[kCVPixelBufferIOSurfacePropertiesKey] = [CFString: Any]() as CFDictionary
        }
        let formatType =
            range == .full
            ? kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
            : kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange

        var buffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            width,
            height,
            formatType,
            attributes as CFDictionary,
            &buffer
        )
        let pixelBuffer = try XCTUnwrap(buffer, "CVPixelBufferCreate failed with \(status)")

        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }

        if let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) {
            let stride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
            let pointer = base.assumingMemoryBound(to: UInt8.self)
            for y in 0..<CVPixelBufferGetHeightOfPlane(pixelBuffer, 0) {
                for x in 0..<CVPixelBufferGetWidthOfPlane(pixelBuffer, 0) {
                    pointer[y * stride + x] = luma(x, y)
                }
            }
        }
        // NV12: plane 1 is Cb and Cr interleaved at half resolution.
        if let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 1) {
            let stride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 1)
            let pointer = base.assumingMemoryBound(to: UInt8.self)
            for y in 0..<CVPixelBufferGetHeightOfPlane(pixelBuffer, 1) {
                for x in 0..<CVPixelBufferGetWidthOfPlane(pixelBuffer, 1) {
                    pointer[y * stride + x * 2] = cb
                    pointer[y * stride + x * 2 + 1] = cr
                }
            }
        }
        return pixelBuffer
    }

    private func makeStack() throws -> (StudioVideoTextureBridge, StudioVideoFrameRenderer) {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device available on this machine")
        }
        return (
            try StudioVideoTextureBridge(device: device),
            try StudioVideoFrameRenderer(device: device)
        )
    }

    private func render(
        _ frame: StudioVideoFrameTextures,
        with renderer: StudioVideoFrameRenderer
    ) throws -> MTLTexture {
        let target = try StudioTestPatternRenderer.makeOffscreenTarget(
            device: renderer.device,
            width: width,
            height: height
        )
        try renderer.render(frame: frame, to: target)
        return target
    }

    private func assertPixel(
        _ texture: MTLTexture,
        x: Int,
        y: Int,
        isNear expected: (r: Int, g: Int, b: Int),
        tolerance: Int = 2,
        _ message: String = "",
        line: UInt = #line
    ) throws {
        let pixel = try StudioTestPatternRenderer.readPixel(from: texture, x: x, y: y)
        let actual = (r: Int(pixel.red), g: Int(pixel.green), b: Int(pixel.blue))
        let withinTolerance =
            abs(actual.r - expected.r) <= tolerance
            && abs(actual.g - expected.g) <= tolerance
            && abs(actual.b - expected.b) <= tolerance
        XCTAssertTrue(
            withinTolerance,
            "\(message) at (\(x),\(y)) expected ~\(expected) +/-\(tolerance), got \(actual)",
            line: line
        )
    }

    // MARK: - Binding

    func testBridgeBindsBothPlanesWithExpectedFormatsAndSizes() throws {
        let (bridge, _) = try makeStack()
        let buffer = try makeBiPlanarBuffer { _, _ in 128 }
        let frame = try bridge.makeTextures(from: buffer)

        XCTAssertEqual(frame.luma.pixelFormat, .r8Unorm)
        XCTAssertEqual(frame.luma.width, 64)
        XCTAssertEqual(frame.luma.height, 64)
        // 4:2:0 — chroma is half resolution in both axes.
        XCTAssertEqual(frame.chroma.pixelFormat, .rg8Unorm)
        XCTAssertEqual(frame.chroma.width, 32)
        XCTAssertEqual(frame.chroma.height, 32)
        XCTAssertEqual(frame.displayWidth, 64)
        XCTAssertEqual(frame.displayHeight, 64)
        XCTAssertEqual(frame.range, .full)
        XCTAssertEqual(bridge.boundFrameCount, 1)
        XCTAssertEqual(bridge.failedBindCount, 0)
    }

    func testUnsupportedPixelFormatIsRejected() throws {
        let (bridge, _) = try makeStack()
        var buffer: CVPixelBuffer?
        CVPixelBufferCreate(
            kCFAllocatorDefault,
            16,
            16,
            kCVPixelFormatType_32BGRA,
            [
                kCVPixelBufferMetalCompatibilityKey: true,
                kCVPixelBufferIOSurfacePropertiesKey: [CFString: Any]() as CFDictionary,
            ] as CFDictionary,
            &buffer
        )
        let bgra = try XCTUnwrap(buffer)

        XCTAssertThrowsError(try bridge.makeTextures(from: bgra)) { error in
            guard case StudioVideoBridgeError.unsupportedPixelFormat = error else {
                return XCTFail("expected unsupportedPixelFormat, got \(error)")
            }
        }
        XCTAssertEqual(bridge.failedBindCount, 1)
    }

    // MARK: - Conversion

    func testFullRangeGreyRampConvertsToExpectedRgb() throws {
        let (bridge, renderer) = try makeStack()

        for level in [UInt8(0), UInt8(128), UInt8(255)] {
            let buffer = try makeBiPlanarBuffer { _, _ in level }
            let target = try render(try bridge.makeTextures(from: buffer), with: renderer)
            let expected = Int(level)
            try assertPixel(
                target,
                x: 32,
                y: 32,
                isNear: (expected, expected, expected),
                "full-range Y=\(level) should pass through as neutral grey"
            )
        }
    }

    /// Proves the CHROMA plane is actually bound and used: a neutral-luma frame
    /// with maximum Cr must come out red-shifted, not grey.
    func testChromaPlaneAffectsOutput() throws {
        let (bridge, renderer) = try makeStack()
        let buffer = try makeBiPlanarBuffer(cb: 128, cr: 255) { _, _ in 128 }
        let target = try render(try bridge.makeTextures(from: buffer), with: renderer)

        // BT.709 full-swing: y=0.502, cr=+0.5 -> r saturates, g drops, b holds.
        try assertPixel(
            target,
            x: 32,
            y: 32,
            isNear: (255, 68, 129),
            "maximum Cr must red-shift the frame"
        )
    }

    /// Differential test: the SAME coded value must render differently depending
    /// on the range flag. If the flag were ignored both would match.
    func testVideoRangeIsExpandedToFullSwing() throws {
        let (bridge, renderer) = try makeStack()

        let videoBlack = try makeBiPlanarBuffer(range: .video) { _, _ in 16 }
        let videoBlackTarget = try render(try bridge.makeTextures(from: videoBlack), with: renderer)
        try assertPixel(
            videoBlackTarget,
            x: 32,
            y: 32,
            isNear: (0, 0, 0),
            "video-range Y=16 is black"
        )

        let videoWhite = try makeBiPlanarBuffer(range: .video) { _, _ in 235 }
        let videoWhiteTarget = try render(try bridge.makeTextures(from: videoWhite), with: renderer)
        try assertPixel(
            videoWhiteTarget,
            x: 32,
            y: 32,
            isNear: (255, 255, 255),
            "video-range Y=235 is white"
        )

        // Same coded 16, interpreted as full range, stays dark grey rather than
        // clipping to black.
        let fullDark = try makeBiPlanarBuffer(range: .full) { _, _ in 16 }
        let fullDarkTarget = try render(try bridge.makeTextures(from: fullDark), with: renderer)
        try assertPixel(
            fullDarkTarget,
            x: 32,
            y: 32,
            isNear: (16, 16, 16),
            "full-range Y=16 must NOT be expanded to black"
        )
    }

    /// An inverted uv mapping is the classic upside-down viewer, and a constant
    /// test frame would never catch it.
    func testVerticalOrientationIsNotFlipped() throws {
        let (bridge, renderer) = try makeStack()
        let buffer = try makeBiPlanarBuffer { _, y in y < 32 ? 255 : 0 }
        let target = try render(try bridge.makeTextures(from: buffer), with: renderer)

        try assertPixel(target, x: 32, y: 8, isNear: (255, 255, 255), "top half is white")
        try assertPixel(target, x: 32, y: 56, isNear: (0, 0, 0), "bottom half is black")
    }

    // MARK: - Lifetime

    /// If StudioVideoFrameTextures did not retain its CVMetalTexture wrappers,
    /// releasing the pixel buffer before the draw would produce garbage or a
    /// crash. Rendering correctly here IS the retention evidence.
    func testFrameSurvivesPixelBufferRelease() throws {
        let (bridge, renderer) = try makeStack()

        let frame: StudioVideoFrameTextures
        do {
            let buffer = try makeBiPlanarBuffer { _, _ in 255 }
            frame = try bridge.makeTextures(from: buffer)
            // buffer's last strong reference dies at the end of this scope.
        }
        bridge.flushUnusedTextures()

        let target = try render(frame, with: renderer)
        try assertPixel(
            target,
            x: 32,
            y: 32,
            isNear: (255, 255, 255),
            "frame must stay valid after the pixel buffer is released"
        )
    }

    func testInFlightRetentionRingIsBounded() throws {
        let (bridge, renderer) = try makeStack()
        let buffer = try makeBiPlanarBuffer { _, _ in 128 }

        for _ in 0..<10 {
            renderer.retain(try bridge.makeTextures(from: buffer))
        }
        XCTAssertEqual(
            renderer.retainedFrameCount,
            StudioVideoFrameRenderer.inFlightRetentionDepth,
            "the seed/retain hook must not grow without bound"
        )

        renderer.releaseRetainedFrames()
        XCTAssertEqual(renderer.retainedFrameCount, 0)
    }

    /// Bounded churn. This is NOT an outcome-11 memory claim — there is no RSS
    /// measurement here — but it does prove repeated bind/render/release cycles
    /// stay error-free and that the bridge's counters agree with reality.
    func testRepeatedBindAndRenderStaysErrorFree() throws {
        let (bridge, renderer) = try makeStack()
        let target = try StudioTestPatternRenderer.makeOffscreenTarget(
            device: renderer.device,
            width: width,
            height: height
        )

        for index in 0..<100 {
            let level = UInt8(index % 256)
            let buffer = try makeBiPlanarBuffer { _, _ in level }
            let frame = try bridge.makeTextures(from: buffer)
            try renderer.render(frame: frame, to: target)
            bridge.flushUnusedTextures()
        }

        XCTAssertEqual(bridge.boundFrameCount, 100)
        XCTAssertEqual(bridge.failedBindCount, 0)
        XCTAssertEqual(renderer.retainedFrameCount, 0, "offscreen path must not retain")
    }
}
