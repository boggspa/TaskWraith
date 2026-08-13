import CoreVideo
import Metal
import XCTest

@testable import TaskWraithStudioCore

/// Grading-aware preview (mission outcome 8), bounded to the mission's list.
///
/// Two properties decide whether any of this is real, and both are the kind a
/// passing test can hide:
///  * BYPASS MUST BE A REAL BYPASS. If Original ran the grading shader with
///    neutral values, the toggle would prove nothing about whether the
///    transform does anything.
///  * SPLIT MUST BE ONE FRAME. Both halves at the same instant, or the seam is
///    a timing artefact rather than a grading difference.
final class StudioColorGradeTests: XCTestCase {
    private let size = 64

    private func makeDevice() throws -> MTLDevice {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device available on this machine")
        }
        return device
    }

    /// A LUT that drives everything hard toward red: unmistakable, so "did the
    /// grade run" is never a judgement call about a few code values.
    private func redShiftLut() throws -> StudioColorLut {
        var entries: [SIMD3<Float>] = []
        for _ in 0..<8 { entries.append(SIMD3(1, 0, 0)) }
        return try StudioColorLut(size: 2, entries: entries)
    }

    private func renderFrame(
        _ renderer: StudioVideoFrameRenderer,
        device: MTLDevice,
        grade: StudioGradeSettings
    ) throws -> MTLTexture {
        let target = try StudioTestPatternRenderer.makeOffscreenTarget(
            device: device,
            width: size,
            height: size
        )
        // Mid-grey 4:2:0, so every channel has room to move in both directions.
        let bridge = try StudioVideoTextureBridge(device: device)
        let frame = try bridge.makeTextures(from: try makeGreyPixelBuffer())
        try renderer.render(frame: frame, to: target, grade: grade)
        return target
    }

    /// Mid-grey NV12, built the same way the bridge tests build theirs.
    private func makeGreyPixelBuffer() throws -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        let attributes: [CFString: Any] = [
            kCVPixelBufferMetalCompatibilityKey: true,
            kCVPixelBufferIOSurfacePropertiesKey: [CFString: Any]() as CFDictionary,
        ]
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            size,
            size,
            kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
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
                    pointer[y * stride + x] = 128
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

    private func pixel(_ texture: MTLTexture) throws -> StudioPixel {
        try StudioTestPatternRenderer.readPixel(from: texture, x: size / 4, y: size / 2)
    }

    // MARK: - Bypass

    /// THE BYPASS ASSERTION. With an extreme LUT loaded, Original must be
    /// BIT-IDENTICAL to Original with no LUT at all. A bypass implemented as
    /// "same shader, identity coefficients" could not make that promise.
    func testOriginalIsUnchangedByALoadedLut() throws {
        let device = try makeDevice()
        let renderer = try StudioVideoFrameRenderer(device: device)

        let before = try pixel(
            renderFrame(renderer, device: device, grade: StudioGradeSettings(mode: .original))
        )
        try renderer.setLut(try redShiftLut())
        XCTAssertTrue(renderer.hasLut)
        let after = try pixel(
            renderFrame(renderer, device: device, grade: StudioGradeSettings(mode: .original))
        )

        XCTAssertEqual(before, after, "Original changed when a LUT was loaded — not a bypass")
    }

    /// And the control: the same LUT must visibly change Effect, or the previous
    /// test passes for the trivial reason that the LUT does nothing.
    func testEffectIsChangedByTheSameLut() throws {
        let device = try makeDevice()
        let renderer = try StudioVideoFrameRenderer(device: device)
        try renderer.setLut(try redShiftLut())

        let original = try pixel(
            renderFrame(renderer, device: device, grade: StudioGradeSettings(mode: .original))
        )
        let effect = try pixel(
            renderFrame(renderer, device: device, grade: StudioGradeSettings(mode: .effect))
        )

        XCTAssertGreaterThan(
            Int(effect.red) - Int(original.red),
            60,
            "the LUT did not reach the picture: \(original) vs \(effect)"
        )
        XCTAssertLessThan(Int(effect.green), Int(original.green))
    }

    /// THE ASSERTION THAT ACTUALLY PROVES THE BYPASS, and the reason the pixel
    /// tests above cannot.
    ///
    /// I implemented the fake bypass — Original routed through the grading
    /// pipeline with neutral uniforms — and ALL THIRTEEN pixel tests still
    /// passed, because neutral grading is bit-identical to no grading. Pixel
    /// equality is therefore an instrument that cannot see this defect. The only
    /// distinguishing fact is WHICH PROGRAM RAN.
    func testOriginalActuallySelectsTheUngradedPipeline() throws {
        let device = try makeDevice()
        let renderer = try StudioVideoFrameRenderer(device: device)
        try renderer.setLut(try redShiftLut())

        _ = try renderFrame(renderer, device: device, grade: StudioGradeSettings(mode: .original))
        XCTAssertEqual(
            renderer.lastPipelineKind,
            .ungraded,
            "Original ran the grading program — a neutral-uniform bypass is not a bypass"
        )

        _ = try renderFrame(renderer, device: device, grade: StudioGradeSettings(mode: .effect))
        XCTAssertEqual(renderer.lastPipelineKind, .graded)

        _ = try renderFrame(renderer, device: device, grade: StudioGradeSettings(mode: .split))
        XCTAssertEqual(renderer.lastPipelineKind, .split)
    }

    /// And the three programs are genuinely distinct objects, so selecting the
    /// ungraded one means something.
    func testOriginalAndEffectAreDistinctPipelines() throws {
        let renderer = try StudioVideoFrameRenderer(device: try makeDevice())
        let mirror = Mirror(reflecting: renderer)
        let states = mirror.children.compactMap { child -> ObjectIdentifier? in
            guard let name = child.label, name.hasSuffix("PipelineState") || name == "pipelineState"
            else { return nil }
            guard let object = child.value as? AnyObject else { return nil }
            return ObjectIdentifier(object)
        }
        XCTAssertEqual(Set(states).count, 3, "expected three distinct pipeline states")
    }

    // MARK: - Split

    /// THE SPLIT ASSERTION. Left of the boundary must equal Original and right
    /// must equal Effect — from ONE draw, so both halves are provably the same
    /// frame.
    func testSplitShowsOriginalLeftAndEffectRightOfTheSameFrame() throws {
        let device = try makeDevice()
        let renderer = try StudioVideoFrameRenderer(device: device)
        try renderer.setLut(try redShiftLut())

        let originalPixel = try pixel(
            renderFrame(renderer, device: device, grade: StudioGradeSettings(mode: .original))
        )
        let effectPixel = try pixel(
            renderFrame(renderer, device: device, grade: StudioGradeSettings(mode: .effect))
        )

        let split = try renderFrame(
            renderer,
            device: device,
            grade: StudioGradeSettings(mode: .split, splitPosition: 0.5)
        )
        let left = try StudioTestPatternRenderer.readPixel(from: split, x: size / 4, y: size / 2)
        let right = try StudioTestPatternRenderer.readPixel(
            from: split,
            x: size * 3 / 4,
            y: size / 2
        )

        XCTAssertEqual(left, originalPixel, "left of the split is not the ungraded picture")
        XCTAssertEqual(right, effectPixel, "right of the split is not the graded picture")
        XCTAssertNotEqual(left, right, "the split shows no difference at all")
    }

    func testSplitPositionMovesTheBoundary() throws {
        let device = try makeDevice()
        let renderer = try StudioVideoFrameRenderer(device: device)
        try renderer.setLut(try redShiftLut())

        // Boundary at 0.9: a sample at 3/4 width is now on the ORIGINAL side.
        let split = try renderFrame(
            renderer,
            device: device,
            grade: StudioGradeSettings(mode: .split, splitPosition: 0.9)
        )
        let sample = try StudioTestPatternRenderer.readPixel(
            from: split,
            x: size * 3 / 4,
            y: size / 2
        )
        let original = try pixel(
            renderFrame(renderer, device: device, grade: StudioGradeSettings(mode: .original))
        )
        XCTAssertEqual(sample, original)
    }

    // MARK: - Display transform

    /// The transform must actually move pixels, and in the direction the maths
    /// says. Asserted against an independently-derived CPU oracle rather than
    /// against the shader's own output.
    func testDisplayTransformMatchesTheReferenceImplementation() throws {
        let device = try makeDevice()
        let renderer = try StudioVideoFrameRenderer(device: device)

        let plain = try pixel(
            renderFrame(renderer, device: device, grade: StudioGradeSettings(mode: .original))
        )
        let transformed = try pixel(
            renderFrame(
                renderer,
                device: device,
                grade: StudioGradeSettings(mode: .effect, displayTransform: .rec709ToSRGB)
            )
        )

        let expected = StudioDisplayTransform.rec709ToSRGB.apply(Double(plain.green) / 255.0)
        XCTAssertEqual(
            Double(transformed.green) / 255.0,
            expected,
            accuracy: 0.02,
            "shader transform disagrees with the reference implementation"
        )
        XCTAssertNotEqual(plain.green, transformed.green, "the transform changed nothing")
    }

    /// Rec.709 and sRGB genuinely differ — most in the shadows, which is the
    /// whole reason handing 709 values to an sRGB surface is wrong rather than
    /// merely imprecise.
    func testTheTwoTransferCurvesDifferMostInShadows() {
        let shadow = abs(StudioDisplayTransform.rec709ToSRGB.apply(0.1) - 0.1)
        let highlight = abs(StudioDisplayTransform.rec709ToSRGB.apply(0.9) - 0.9)
        XCTAssertGreaterThan(shadow, highlight)
        // And .none must be exactly a pass-through, not "nearly".
        XCTAssertEqual(StudioDisplayTransform.none.apply(0.42), 0.42)
    }

    // MARK: - LUT parsing

    func testACubeFileParses() throws {
        let text = """
            # A comment
            TITLE "test"
            LUT_3D_SIZE 2
            DOMAIN_MIN 0.0 0.0 0.0
            DOMAIN_MAX 1.0 1.0 1.0
            0.0 0.0 0.0
            1.0 0.0 0.0
            0.0 1.0 0.0
            1.0 1.0 0.0
            0.0 0.0 1.0
            1.0 0.0 1.0
            0.0 1.0 1.0
            1.0 1.0 1.0
            """
        let lut = try StudioColorLut.parseCube(text)
        XCTAssertEqual(lut.size, 2)
        XCTAssertEqual(lut.entries.count, 8)
        XCTAssertEqual(lut.entries[1], SIMD3(1, 0, 0), "R must vary fastest per the .cube contract")
        XCTAssertEqual(lut.textureData.count, 32, "RGBA float upload")
    }

    /// Fail closed. A half-loaded LUT grades the picture wrongly and looks
    /// deliberate, which is worse than refusing the file.
    func testMalformedLutsAreRefused() {
        XCTAssertThrowsError(try StudioColorLut.parseCube("0.0 0.0 0.0")) { error in
            XCTAssertEqual(error as? StudioLutError, .missingSize)
        }
        XCTAssertThrowsError(
            try StudioColorLut.parseCube("LUT_3D_SIZE 2\n0.0 0.0 0.0")
        ) { error in
            XCTAssertEqual(error as? StudioLutError, .entryCountMismatch(expected: 8, found: 1))
        }
        XCTAssertThrowsError(
            try StudioColorLut.parseCube("LUT_3D_SIZE 2\n0.0 0.0\n")
        ) { error in
            XCTAssertEqual(error as? StudioLutError, .malformedEntry(line: 2))
        }
        // A 1D LUT is a different animal; refusing it names the reason.
        XCTAssertThrowsError(try StudioColorLut.parseCube("LUT_1D_SIZE 16\n"))
    }

    /// The size cap is a resource bound, not taste: a 256-cube is 64 MB of
    /// texture, and outcome 11 has to be able to bound this.
    func testOversizedLutsAreRefused() {
        XCTAssertThrowsError(try StudioColorLut.identity(size: 128)) { error in
            XCTAssertEqual(error as? StudioLutError, .unsupportedSize(128))
        }
        XCTAssertNoThrow(try StudioColorLut.identity(size: 33))
    }

    /// An identity LUT must be a no-op through the real shader path. This is
    /// the control that shows the LUT machinery is not adding its own tint.
    func testAnIdentityLutLeavesThePictureAlone() throws {
        let device = try makeDevice()
        let renderer = try StudioVideoFrameRenderer(device: device)
        let ungraded = try pixel(
            renderFrame(renderer, device: device, grade: StudioGradeSettings(mode: .original))
        )
        try renderer.setLut(try StudioColorLut.identity(size: 33))
        let graded = try pixel(
            renderFrame(renderer, device: device, grade: StudioGradeSettings(mode: .effect))
        )
        XCTAssertEqual(Int(graded.red), Int(ungraded.red), accuracy: 3)
        XCTAssertEqual(Int(graded.green), Int(ungraded.green), accuracy: 3)
        XCTAssertEqual(Int(graded.blue), Int(ungraded.blue), accuracy: 3)
    }

    func testClearingTheLutRestoresTheUngradedPicture() throws {
        let device = try makeDevice()
        let renderer = try StudioVideoFrameRenderer(device: device)
        let ungraded = try pixel(
            renderFrame(renderer, device: device, grade: StudioGradeSettings(mode: .effect))
        )
        try renderer.setLut(try redShiftLut())
        try renderer.setLut(nil)
        XCTAssertFalse(renderer.hasLut)
        let cleared = try pixel(
            renderFrame(renderer, device: device, grade: StudioGradeSettings(mode: .effect))
        )
        XCTAssertEqual(ungraded, cleared)
    }

    // MARK: - Settings hygiene

    func testSettingsClampAndReportNeutrality() {
        XCTAssertEqual(StudioGradeSettings(splitPosition: 5).splitPosition, 1)
        XCTAssertEqual(StudioGradeSettings(splitPosition: -5).splitPosition, 0)
        XCTAssertEqual(StudioGradeSettings(lutAmount: 9).lutAmount, 1)
        // "FX" that changes nothing is the same lie as a bypass that is not one.
        XCTAssertTrue(StudioGradeSettings(mode: .effect, lutAmount: 0).isNeutral)
        XCTAssertFalse(
            StudioGradeSettings(mode: .effect, displayTransform: .rec709ToSRGB).isNeutral
        )
    }
}
