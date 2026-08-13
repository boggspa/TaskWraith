import Metal
import XCTest

@testable import TaskWraithStudioCore

/// The overlay as actually rendered: real Metal, real glyph atlas, real pixels.
///
/// The point of these is that the transport is VISIBLE. A layout model that
/// computes perfect geometry into a pass that never draws is exactly the kind of
/// green this round exists to refuse.
final class StudioOverlayRendererTests: XCTestCase {
    private let width = 512
    private let height = 256
    /// scale 1 so the point metrics and the pixel assertions are the same
    /// numbers, which keeps these tests readable.
    private lazy var viewport = StudioOverlayViewport(
        width: Double(width),
        height: Double(height),
        scale: 1
    )
    private let duration: Int64 = 300

    private func makeDevice() throws -> MTLDevice {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device available on this machine")
        }
        return device
    }

    private func makeTarget(_ device: MTLDevice) throws -> MTLTexture {
        try StudioTestPatternRenderer.makeOffscreenTarget(
            device: device,
            width: width,
            height: height
        )
    }

    private func state(position: Int64 = 150) -> StudioOverlayState {
        StudioOverlayState(
            viewport: viewport,
            positionTicks: position,
            durationTicks: duration,
            isPlaying: true,
            timecodeText: "00:00:05:00",
            sourceLabel: "clip.mov"
        )
    }

    private func luminance(_ pixel: StudioPixel) -> Double {
        Double(pixel.red) * 0.299 + Double(pixel.green) * 0.587 + Double(pixel.blue) * 0.114
    }

    private func pixel(_ texture: MTLTexture, _ x: Int, _ y: Int) throws -> StudioPixel {
        try StudioTestPatternRenderer.readPixel(from: texture, x: x, y: y)
    }

    // MARK: - Atlas

    /// The atlas is rasterised ONCE at construction. If it comes out empty the
    /// HUD still "renders" — it just draws invisible text, which is the failure
    /// mode most likely to be mistaken for success.
    func testAtlasHasCoverageForDigitsAndNoneForSpace() throws {
        let device = try makeDevice()
        let atlas = try StudioTextAtlas(device: device)

        func coverage(of character: Character) throws -> Int {
            let uv = try XCTUnwrap(atlas.uvRect(for: character))
            let originX = Int(uv.u0 * Double(atlas.texture.width))
            let originY = Int(uv.v0 * Double(atlas.texture.height))
            let cellWidth = Int(atlas.cellWidth)
            let cellHeight = Int(atlas.cellHeight)
            var bytes = [UInt8](repeating: 0, count: cellWidth * cellHeight)
            atlas.texture.getBytes(
                &bytes,
                bytesPerRow: cellWidth,
                from: MTLRegionMake2D(originX, originY, cellWidth, cellHeight),
                mipmapLevel: 0
            )
            return bytes.filter { $0 > 32 }.count
        }

        XCTAssertGreaterThan(try coverage(of: "0"), 20, "digit zero rasterised empty")
        XCTAssertGreaterThan(try coverage(of: "8"), 20)
        XCTAssertGreaterThan(try coverage(of: ":"), 2)
        XCTAssertEqual(try coverage(of: " "), 0, "space must have no coverage")
    }

    func testAtlasRejectsCharactersOutsidePrintableAscii() throws {
        let atlas = try StudioTextAtlas(device: try makeDevice())
        // A HUD is not a text engine; anything outside the sheet is skipped
        // rather than drawn as tofu.
        XCTAssertNil(atlas.uvRect(for: "é"))
        XCTAssertNil(atlas.uvRect(for: "→"))
        XCTAssertNotNil(atlas.uvRect(for: "~"))
    }

    // MARK: - Vertex assembly

    func testVerticesEmitSixPerQuadAndSkipSpaces() throws {
        let renderer = try StudioOverlayRenderer(device: try makeDevice())
        let model = StudioOverlayModel(
            rects: [
                StudioOverlayRect(
                    frame: StudioOverlayFrame(x: 0, y: 0, width: 10, height: 10),
                    color: .playhead
                )
            ],
            texts: [
                StudioOverlayText(string: "A A", x: 0, y: 0, pointSize: 20, color: .text)
            ],
            accessibilityElements: [],
            trackFrame: StudioOverlayFrame(x: 0, y: 0, width: 10, height: 10),
            grabFrame: StudioOverlayFrame(x: 0, y: 0, width: 10, height: 10),
            isVisible: true
        )
        let vertices = renderer.vertices(for: model, width: 100, height: 100)
        // One rect + two glyphs (the space is skipped) = 3 quads = 18 vertices.
        XCTAssertEqual(vertices.count, 18)
        XCTAssertEqual(vertices.prefix(6).filter { $0.textured == 0 }.count, 6)
        XCTAssertEqual(vertices.suffix(12).filter { $0.textured == 1 }.count, 12)
    }

    /// Top-left pixel space to Metal's centre-origin, y-up NDC. Getting the y
    /// flip wrong draws the whole HUD at the top of the window.
    func testPixelSpaceConvertsToNdcWithTheYAxisFlipped() throws {
        let renderer = try StudioOverlayRenderer(device: try makeDevice())
        let model = StudioOverlayModel(
            rects: [
                StudioOverlayRect(
                    frame: StudioOverlayFrame(x: 0, y: 0, width: 50, height: 50),
                    color: .playhead
                )
            ],
            texts: [],
            accessibilityElements: [],
            trackFrame: StudioOverlayFrame(x: 0, y: 0, width: 0, height: 0),
            grabFrame: StudioOverlayFrame(x: 0, y: 0, width: 0, height: 0),
            isVisible: true
        )
        let vertices = renderer.vertices(for: model, width: 100, height: 100)
        // Pixel (0,0) is top-left => NDC (-1, +1).
        XCTAssertEqual(vertices[0].x, -1, accuracy: 0.0001)
        XCTAssertEqual(vertices[0].y, 1, accuracy: 0.0001)
        // Pixel (50,50) is the centre => NDC (0, 0).
        XCTAssertEqual(vertices[4].x, 0, accuracy: 0.0001)
        XCTAssertEqual(vertices[4].y, 0, accuracy: 0.0001)
    }

    func testAHiddenOverlayEmitsNoVertices() throws {
        let renderer = try StudioOverlayRenderer(device: try makeDevice())
        var tiny = state()
        tiny.viewport = StudioOverlayViewport(width: 30, height: 20, scale: 1)
        let model = StudioOverlayLayout.build(tiny)
        XCTAssertTrue(renderer.vertices(for: model, width: 30, height: 20).isEmpty)
    }

    // MARK: - Rendered pixels

    /// THE ASSERTION THAT MATTERS: the overlay composites ON TOP of the picture
    /// rather than replacing it. A `.clear` load action here would wipe the
    /// decoded frame and leave a HUD floating on black.
    func testTheOverlayCompositesOverThePictureRatherThanReplacingIt() throws {
        let device = try makeDevice()
        // ONE QUEUE. `chaining: true` commits WITHOUT waiting, and its own
        // documentation says a later pass "in this queue" owns readback. Two
        // device-built renderers get two queues, and Metal orders within a
        // queue only — so the overlay could load a target the pattern pass had
        // not finished writing. MEASURED at 1 in 40 trials before this fix and
        // 0 in 40 x 3 after. This is Challenge2's Finding 2 surviving in the
        // tests after production was fixed: 64ed303e6 injected a shared queue
        // into StudioViewerRenderer, and these tests bypass it.
        let queue = try XCTUnwrap(device.makeCommandQueue())
        let patternRenderer = try StudioTestPatternRenderer(
            device: device, commandQueue: queue)
        let overlayRenderer = try StudioOverlayRenderer(device: device, commandQueue: queue)

        // Frame 60 puts the pattern's sweep bar at x=256, so the probe below
        // sits on a WHITE part of the picture. Sampling somewhere the pattern is
        // black would prove nothing: a translucent dark scrim over black adds
        // light rather than removing it, which is how the first version of this
        // test managed to fail on correct code.
        let litFrame: Int64 = 60
        let hudX = 256
        let hudY = 210
        let pictureX = 40
        let pictureY = 40

        let bare = try makeTarget(device)
        try patternRenderer.render(to: bare, frameIndex: litFrame)
        let bareBar = try pixel(bare, pictureX, pictureY)
        let bareHud = try pixel(bare, hudX, hudY)
        XCTAssertGreaterThan(luminance(bareHud), 200, "probe point is not lit; test proves nothing")

        let composited = try makeTarget(device)
        try patternRenderer.render(to: composited, frameIndex: litFrame, chaining: true)
        try overlayRenderer.render(model: StudioOverlayLayout.build(state()), to: composited)

        // Picture area, well above the HUD strip: untouched.
        XCTAssertEqual(
            try pixel(composited, pictureX, pictureY),
            bareBar,
            "the overlay damaged the picture"
        )

        // HUD strip: darkened by the scrim, but still carrying the picture
        // underneath rather than being replaced by flat black.
        let hudPixel = try pixel(composited, hudX, hudY)
        XCTAssertLessThan(luminance(hudPixel), luminance(bareHud), "scrim did not darken the HUD")
        XCTAssertGreaterThan(luminance(hudPixel), 0.0, "HUD is flat black; picture was replaced")
    }

    /// The playhead has to stand out from the track it sits on, or the operator
    /// cannot see where they are.
    func testThePlayheadIsBrighterThanTheTrackItSitsOn() throws {
        let device = try makeDevice()
        // ONE QUEUE. `chaining: true` commits WITHOUT waiting, and its own
        // documentation says a later pass "in this queue" owns readback. Two
        // device-built renderers get two queues, and Metal orders within a
        // queue only — so the overlay could load a target the pattern pass had
        // not finished writing. MEASURED at 1 in 40 trials before this fix and
        // 0 in 40 x 3 after. This is Challenge2's Finding 2 surviving in the
        // tests after production was fixed: 64ed303e6 injected a shared queue
        // into StudioViewerRenderer, and these tests bypass it.
        let queue = try XCTUnwrap(device.makeCommandQueue())
        let overlayRenderer = try StudioOverlayRenderer(device: device, commandQueue: queue)
        let target = try makeTarget(device)
        try StudioTestPatternRenderer(device: device, commandQueue: queue).render(
            to: target,
            frameIndex: 0,
            chaining: true
        )

        let model = StudioOverlayLayout.build(state(position: 150))
        try overlayRenderer.render(model: model, to: target)

        let trackMidY = Int(model.trackFrame.y + model.trackFrame.height / 2)
        // Sample the playhead where the MODEL puts it, not where the test
        // assumes it is. The old version computed the track midpoint from
        // position 150 of 300 and sampled that, so a layout shift would move
        // the sample onto track and fail for a reason unrelated to brightness -
        // a reading derived from an assumption about the thing being measured.
        // The drawn playhead is 2pt wide, so the guess also sat one pixel from
        // the rect's edge.
        let playheadRect = try XCTUnwrap(
            model.rects.first {
                $0.color == .playhead
                    && $0.frame.y < model.trackFrame.maxY
                    && $0.frame.maxY > model.trackFrame.y
            },
            "the layout drew no playhead over the track")
        let playheadX = Int(playheadRect.frame.x + playheadRect.frame.width / 2)
        let trackX = Int(model.trackFrame.x) + 40
        let playheadPixel = try pixel(target, playheadX, trackMidY)
        let trackPixel = try pixel(target, trackX, trackMidY)

        // SELF-DESCRIBING FAILURE. "not distinguishable" on its own cannot tell
        // you whether the playhead dimmed or whether the sample landed on the
        // wrong pixel, and an order-sensitive failure you cannot diagnose from
        // one reproduction becomes a hunt. Everything needed is in the message.
        let diagnosis = """
            playhead is not distinguishable from the track
              sampled playhead (\(playheadX), \(trackMidY)) rgba=\
            (\(playheadPixel.red),\(playheadPixel.green),\(playheadPixel.blue),\
            \(playheadPixel.alpha)) luma=\(luminance(playheadPixel))
              sampled track    (\(trackX), \(trackMidY)) rgba=\
            (\(trackPixel.red),\(trackPixel.green),\(trackPixel.blue),\
            \(trackPixel.alpha)) luma=\(luminance(trackPixel))
              required margin  40, actual \
            \(luminance(playheadPixel) - luminance(trackPixel))
              model.trackFrame  \(model.trackFrame)
              model.playheadRect \(playheadRect.frame)
              model.grabFrame  \(model.grabFrame)
              timeline visible \(model.timeline.isVisible), \
            rects=\(model.rects.count) texts=\(model.texts.count)
              viewport \(width)x\(height)
            """

        XCTAssertGreaterThan(
            luminance(playheadPixel),
            luminance(trackPixel) + 40,
            diagnosis
        )
    }

    /// Glyphs actually reach the target. Scanned rather than point-sampled
    /// because a '0' is mostly hole, and asserting one pixel inside a letterform
    /// is a flake waiting to happen.
    func testTimecodeTextIsActuallyDrawn() throws {
        let device = try makeDevice()
        let overlayRenderer = try StudioOverlayRenderer(device: device)

        let withoutText = try makeTarget(device)
        let withText = try makeTarget(device)
        var blank = state()
        blank.timecodeText = "           "
        try overlayRenderer.render(model: StudioOverlayLayout.build(blank), to: withoutText)
        try overlayRenderer.render(model: StudioOverlayLayout.build(state()), to: withText)

        let model = StudioOverlayLayout.build(state())
        let readout = try XCTUnwrap(model.texts.first)
        let scanY = Int(readout.y + StudioOverlayRenderMetrics.cellHeight(
            forPointSize: readout.pointSize
        ) / 2)
        let scanEnd = Int(
            readout.x
                + StudioOverlayRenderMetrics.width(
                    of: readout.string,
                    pointSize: readout.pointSize
                )
        )

        var brighter = 0
        for x in Int(readout.x)..<scanEnd {
            let lit = try pixel(withText, x, scanY)
            let unlit = try pixel(withoutText, x, scanY)
            if luminance(lit) > luminance(unlit) + 20 { brighter += 1 }
        }
        XCTAssertGreaterThan(brighter, 8, "the timecode readout drew no visible glyphs")
    }

    /// A dropped frame must LOOK dropped. Without the clear the target keeps the
    /// previous picture, so a live HUD sits over a frozen image — which reads as
    /// working playback and is exactly what the fallback policy forbids.
    func testClearingFirstWipesTheStalePictureUnderTheHud() throws {
        let device = try makeDevice()
        let overlayRenderer = try StudioOverlayRenderer(device: device)
        let target = try makeTarget(device)
        try StudioTestPatternRenderer(device: device).render(to: target, frameIndex: 0)
        XCTAssertGreaterThan(luminance(try pixel(target, 40, 40)), 100)

        try overlayRenderer.render(
            model: StudioOverlayLayout.build(state()),
            to: target,
            clearingFirst: true
        )
        XCTAssertEqual(luminance(try pixel(target, 40, 40)), 0, accuracy: 1)
        // ...and the HUD is still drawn on top of the cleared picture.
        let model = StudioOverlayLayout.build(state())
        let trackMidY = Int(model.trackFrame.y + model.trackFrame.height / 2)
        XCTAssertGreaterThan(
            luminance(try pixel(target, Int(model.trackFrame.x) + 40, trackMidY)),
            0
        )
    }

    // MARK: - Layout invariant

    /// The bug this caught: with the track at the BOTTOM of a 62pt strip, the
    /// info row landed at 230..245 and the track at 235..240, so the source
    /// label was drawn straight through the scrub bar.
    func testNoTextRowOverlapsTheScrubTrack() {
        var busy = state()
        busy.inPointTicks = 30
        busy.outPointTicks = 200
        busy.isLoopingRange = true
        busy.diagnostics = StudioOverlayDiagnostics(
            presentedFrameCount: 900,
            droppedFrameCount: 2,
            retainedFrameCount: 3,
            hardwareDecodeLabel: "hardware"
        )
        let model = StudioOverlayLayout.build(busy)
        XCTAssertFalse(model.texts.isEmpty)
        for text in model.texts {
            let top = text.y
            let bottom = text.y + StudioOverlayRenderMetrics.cellHeight(
                forPointSize: text.pointSize
            )
            let overlaps = bottom > model.trackFrame.y && top < model.trackFrame.maxY
            XCTAssertFalse(overlaps, "\"\(text.string)\" is drawn through the scrub track")
        }
    }

    func testEveryDrawnElementStaysInsideTheViewport() {
        let model = StudioOverlayLayout.build(state(position: duration))
        for rect in model.rects {
            XCTAssertGreaterThanOrEqual(rect.frame.x, -0.001)
            XCTAssertLessThanOrEqual(rect.frame.maxX, viewport.width + 0.001)
            XCTAssertLessThanOrEqual(rect.frame.maxY, viewport.height + 0.001)
        }
        for text in model.texts {
            let bottom = text.y + StudioOverlayRenderMetrics.cellHeight(
                forPointSize: text.pointSize
            )
            XCTAssertLessThanOrEqual(bottom, viewport.height + 0.001, "\(text.string) hangs off")
        }
    }
}
