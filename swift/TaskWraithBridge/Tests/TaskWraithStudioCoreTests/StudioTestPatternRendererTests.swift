import Metal
import XCTest

@testable import TaskWraithStudioCore

/// Render-to-texture verification. The point of these is that the Metal path is
/// provable WITHOUT a window on screen: they assert actual rendered pixel
/// values, so "a frame was produced and it is the frame the clock asked for" is
/// evidence rather than a screenshot.
final class StudioTestPatternRendererTests: XCTestCase {
    private let width = 256
    private let height = 256

    /// Bars are 32px wide at 256; these are their centres.
    private let barCentres = [16, 48, 80, 112, 144, 176, 208, 240]
    private let barBandY = 64
    private let sweepBandY = 192

    private func makeRenderer() throws -> StudioTestPatternRenderer {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device available on this machine")
        }
        return try StudioTestPatternRenderer(device: device)
    }

    private func renderFrame(
        _ renderer: StudioTestPatternRenderer,
        frameIndex: Int64
    ) throws -> MTLTexture {
        let texture = try StudioTestPatternRenderer.makeOffscreenTarget(
            device: renderer.device,
            width: width,
            height: height
        )
        try renderer.render(to: texture, frameIndex: frameIndex)
        return texture
    }

    // MARK: - Pure helpers (run even with no GPU)

    func testSweepPositionIsPeriodicAndNonNegative() {
        XCTAssertEqual(StudioTestPatternRenderer.sweepPosition(forFrame: 0), 0.0)
        XCTAssertEqual(StudioTestPatternRenderer.sweepPosition(forFrame: 60), 0.5)
        XCTAssertEqual(StudioTestPatternRenderer.sweepPosition(forFrame: 120), 0.0)
        XCTAssertEqual(StudioTestPatternRenderer.sweepPosition(forFrame: 180), 0.5)
        // Negative frames must not produce a negative sweep coordinate.
        XCTAssertEqual(StudioTestPatternRenderer.sweepPosition(forFrame: -60), 0.5)
        XCTAssertGreaterThanOrEqual(StudioTestPatternRenderer.sweepPosition(forFrame: -1), 0.0)
    }

    func testBarIndexCoversTheFullWidthWithoutOverflowing() {
        XCTAssertEqual(StudioTestPatternRenderer.barIndex(atU: 0.0), 0)
        XCTAssertEqual(StudioTestPatternRenderer.barIndex(atU: 0.99), 7)
        XCTAssertEqual(StudioTestPatternRenderer.barIndex(atU: 1.0), 7)
        XCTAssertEqual(StudioTestPatternRenderer.barIndex(atU: 2.0), 7)
        XCTAssertEqual(StudioTestPatternRenderer.barIndex(atU: -1.0), 0)
    }

    // MARK: - GPU

    /// Constructing the renderer compiles the shader from source at runtime and
    /// builds the pipeline state; if MSL or the pipeline were wrong this throws.
    func testShaderCompilesAndPipelineBuilds() throws {
        let renderer = try makeRenderer()
        XCTAssertEqual(StudioTestPatternRenderer.pixelFormat, .bgra8Unorm)
        XCTAssertFalse(renderer.device.name.isEmpty)
    }

    func testColorBarsRenderExpectedPixelValues() throws {
        let renderer = try makeRenderer()
        let texture = try renderFrame(renderer, frameIndex: 0)

        for (index, x) in barCentres.enumerated() {
            let pixel = try StudioTestPatternRenderer.readPixel(from: texture, x: x, y: barBandY)
            XCTAssertEqual(
                pixel,
                StudioTestPatternRenderer.barColor(index: index),
                "bar \(index) at x=\(x) rendered \(pixel)"
            )
        }
    }

    /// The sweep bar's position is a pure function of the frame index, so this
    /// is the evidence that rendered output actually follows the frame the
    /// clock supplies rather than being a static image.
    func testSweepPositionTracksFrameIndex() throws {
        let renderer = try makeRenderer()

        let frameZero = try renderFrame(renderer, frameIndex: 0)
        XCTAssertEqual(
            try StudioTestPatternRenderer.readPixel(from: frameZero, x: 2, y: sweepBandY),
            .white
        )
        XCTAssertEqual(
            try StudioTestPatternRenderer.readPixel(from: frameZero, x: 128, y: sweepBandY),
            .black
        )

        let frameSixty = try renderFrame(renderer, frameIndex: 60)
        XCTAssertEqual(
            try StudioTestPatternRenderer.readPixel(from: frameSixty, x: 128, y: sweepBandY),
            .white
        )
        XCTAssertEqual(
            try StudioTestPatternRenderer.readPixel(from: frameSixty, x: 2, y: sweepBandY),
            .black
        )
    }

    /// End-to-end: ONE clock decides which frame is current, and the rendered
    /// pixels prove the renderer drew that frame. 2.002s at 30000/1001 is
    /// exactly 60060 ticks == frame 60, so the sweep must be at centre.
    func testClockDrivenFrameProducesTheExpectedRenderedFrame() throws {
        let renderer = try makeRenderer()
        var clock = StudioPlaybackClock(timebase: .ntsc2997, durationTicks: 1_800_000)
        clock.play(atHost: 0)

        let snapshot = clock.snapshot(atHost: 2.002)
        XCTAssertEqual(snapshot.positionTicks, 60_060)
        XCTAssertEqual(snapshot.frameIndex, 60)

        let texture = try renderFrame(renderer, frameIndex: snapshot.frameIndex)
        XCTAssertEqual(
            try StudioTestPatternRenderer.readPixel(from: texture, x: 128, y: sweepBandY),
            .white
        )
        // Bars are unaffected by the sweep, so the two bands stay independent.
        XCTAssertEqual(
            try StudioTestPatternRenderer.readPixel(from: texture, x: 16, y: barBandY),
            .white
        )
        XCTAssertEqual(
            try StudioTestPatternRenderer.readPixel(from: texture, x: 240, y: barBandY),
            .black
        )
    }

    func testRenderRejectsAMismatchedPixelFormat() throws {
        let renderer = try makeRenderer()
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .rgba8Unorm,
            width: 64,
            height: 64,
            mipmapped: false
        )
        descriptor.usage = [.renderTarget, .shaderRead]
        descriptor.storageMode = renderer.device.hasUnifiedMemory ? .shared : .managed
        let texture = try XCTUnwrap(renderer.device.makeTexture(descriptor: descriptor))

        XCTAssertThrowsError(try renderer.render(to: texture, frameIndex: 0)) { error in
            guard case StudioRendererError.unsupportedPixelFormat = error else {
                return XCTFail("expected unsupportedPixelFormat, got \(error)")
            }
        }
    }

    func testReadPixelRejectsOutOfBoundsCoordinates() throws {
        let renderer = try makeRenderer()
        let texture = try renderFrame(renderer, frameIndex: 0)

        for point in [(-1, 0), (0, -1), (width, 0), (0, height)] {
            XCTAssertThrowsError(
                try StudioTestPatternRenderer.readPixel(from: texture, x: point.0, y: point.1)
            ) { error in
                XCTAssertEqual(error as? StudioRendererError, .readbackOutOfBounds)
            }
        }
    }
}
