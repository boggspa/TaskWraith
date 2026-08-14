import Metal
import XCTest

@testable import TaskWraithStudioCore

/// Viewer integration: which content reaches the target, decided by the clock.
///
/// StudioViewerWindow itself is untestable AppKit glue with no test target, so
/// the decision it delegates lives in StudioViewerRenderer and is asserted here
/// against real rendered pixels.
final class StudioViewerRendererTests: XCTestCase {
    private let size = 128

    /// Bars are 16px wide at 128; these are the first and last bar centres, and
    /// a row inside the bar band (top half).
    private let firstBarX = 8
    private let lastBarX = 120
    private let barBandY = 32
    private let centre = 64

    private func makeRenderer() throws -> StudioViewerRenderer {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device available on this machine")
        }
        return try StudioViewerRenderer(device: device)
    }

    private func makeTarget(_ renderer: StudioViewerRenderer) throws -> MTLTexture {
        try StudioTestPatternRenderer.makeOffscreenTarget(
            device: renderer.device,
            width: size,
            height: size
        )
    }

    /// 30fps integer timebase keeps frame indices exact and obvious.
    private func snapshot(frame: Int64) -> StudioTransportSnapshot {
        var clock = StudioPlaybackClock(
            timebase: StudioTimebase(timescale: 30, frameDurationTicks: 1)!,
            durationTicks: 0
        )
        clock.seek(toTicks: frame, atHost: 0)
        return clock.snapshot(atHost: 0)
    }

    private func pixel(_ texture: MTLTexture, x: Int, y: Int) throws -> StudioPixel {
        try StudioTestPatternRenderer.readPixel(from: texture, x: x, y: y)
    }

    // MARK: - Pass ordering contract

    /// THE OVERLAY-ORDERING CONTRACT, asserted structurally.
    ///
    /// The content pass clears and draws; the overlay pass LOADS that result and
    /// presents. Metal serialises command buffers within one queue by commit
    /// order and guarantees nothing across queues without an MTLEvent or fence.
    /// These three renderers used to build a queue each, so "the overlay runs
    /// last" was intent that happened to hold because the driver serialised
    /// them — deterministic on this Apple-silicon machine, unproven on the
    /// Intel/discrete-GPU half of the universal build.
    ///
    /// This test is STRUCTURAL rather than red-first on purpose. A cross-queue
    /// race does not fail on demand, and the compositing test passing proves the
    /// ordering happened once, not that it is guaranteed. The only honest
    /// assertion is the invariant itself: one queue, shared by every pass.
    func testEveryViewerPassSharesOneCommandQueue() throws {
        let renderer = try makeRenderer()
        XCTAssertTrue(
            renderer.patternRenderer.commandQueue === renderer.commandQueue,
            "test-pattern pass is on a different queue; ordering is not guaranteed"
        )
        XCTAssertTrue(
            renderer.videoRenderer.commandQueue === renderer.commandQueue,
            "video pass is on a different queue; ordering is not guaranteed"
        )
        XCTAssertTrue(
            renderer.overlayRenderer.commandQueue === renderer.commandQueue,
            "overlay pass is on a different queue; ordering is not guaranteed"
        )
    }

    /// Two viewers must NOT share a queue: they present to different drawables
    /// and have no ordering relationship, so sharing would serialise them for
    /// nothing.
    func testSeparateViewersDoNotShareACommandQueue() throws {
        let first = try makeRenderer()
        let second = try StudioViewerRenderer(device: first.device)
        XCTAssertFalse(first.commandQueue === second.commandQueue)
    }

    /// A standalone renderer still works without an injected queue, so the
    /// injection is a viewer-level contract rather than a construction burden.
    func testAStandaloneRendererStillProvidesItsOwnQueue() throws {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device available on this machine")
        }
        let standalone = try StudioTestPatternRenderer(device: device)
        let injected = try StudioTestPatternRenderer(
            device: device,
            commandQueue: try XCTUnwrap(device.makeCommandQueue())
        )
        XCTAssertFalse(standalone.commandQueue === injected.commandQueue)
    }

    // MARK: - Fallback (no source)

    func testNoSourceRendersTheTestPattern() throws {
        let renderer = try makeRenderer()
        let target = try makeTarget(renderer)

        XCTAssertFalse(renderer.hasSource)
        let outcome = renderer.render(snapshot: snapshot(frame: 0), to: target)

        XCTAssertEqual(outcome, .testPattern(frameIndex: 0))
        XCTAssertTrue(outcome.didDraw)
        // Actual colour bars, so "test pattern" is verified by pixels not by name.
        XCTAssertEqual(try pixel(target, x: firstBarX, y: barBandY), .white)
        XCTAssertEqual(try pixel(target, x: lastBarX, y: barBandY), .black)
        XCTAssertEqual(renderer.testPatternFrameCount, 1)
        XCTAssertEqual(renderer.decodedFrameCount, 0)
        XCTAssertEqual(renderer.failedFrameCount, 0)
    }

    // MARK: - Decoded source

    func testAttachedSourceRendersDecodedFramesInsteadOfThePattern() throws {
        let renderer = try makeRenderer()
        let target = try makeTarget(renderer)
        let source = try StudioTestMedia.makeFrameSource(
            lumaLevels: [32, 224],
            device: renderer.device
        )
        renderer.attach(source: source)
        XCTAssertTrue(renderer.hasSource)

        let outcome = renderer.render(snapshot: snapshot(frame: 0), to: target)
        XCTAssertEqual(outcome, .decodedFrame(frameIndex: 0))

        // At this position the test pattern would be a WHITE bar. A flat Y=32
        // frame is dark, so this distinguishes decoded content from the pattern
        // rather than trusting the outcome label.
        let sampled = try pixel(target, x: firstBarX, y: barBandY)
        XCTAssertLessThan(Int(sampled.green), 96, "decoded frame must replace the test pattern")
        XCTAssertEqual(renderer.decodedFrameCount, 1)
        XCTAssertEqual(renderer.testPatternFrameCount, 0)
    }

    func testClockDrivesWhichDecodedFrameAppears() throws {
        let renderer = try makeRenderer()
        let target = try makeTarget(renderer)
        let levels: [UInt8] = [32, 96, 160, 224]
        renderer.attach(
            source: try StudioTestMedia.makeFrameSource(
                lumaLevels: levels,
                device: renderer.device
            )
        )

        var greens: [Int] = []
        for frame in 0..<levels.count {
            let outcome = renderer.render(snapshot: snapshot(frame: Int64(frame)), to: target)
            XCTAssertEqual(outcome, .decodedFrame(frameIndex: Int64(frame)))
            greens.append(Int(try pixel(target, x: centre, y: centre).green))
        }

        for index in 1..<greens.count {
            XCTAssertGreaterThan(
                greens[index],
                greens[index - 1],
                "frame \(index) must be brighter than \(index - 1): \(greens)"
            )
        }
        XCTAssertEqual(renderer.decodedFrameCount, levels.count)
    }

    // MARK: - Failure policy

    /// The most important behaviour in this file. A decode failure mid-playback
    /// must be reported and drop the frame, NOT quietly draw colour bars: a
    /// viewer that looks like it is working while showing synthetic content
    /// hides a broken decoder indefinitely.
    func testDecodeFailureDoesNotSilentlyFallBackToTestPattern() throws {
        let renderer = try makeRenderer()
        let target = try makeTarget(renderer)
        let source = try StudioTestMedia.makeFrameSource(
            lumaLevels: [128],
            device: renderer.device
        )
        renderer.attach(source: source)

        // Force the source to fail the way a torn-down decoder would.
        source.invalidate()
        let outcome = renderer.render(snapshot: snapshot(frame: 0), to: target)

        guard case .decodeFailed(let frameIndex, _) = outcome else {
            return XCTFail("expected decodeFailed, got \(outcome)")
        }
        XCTAssertEqual(frameIndex, 0)
        XCTAssertFalse(outcome.didDraw)
        XCTAssertEqual(renderer.failedFrameCount, 1)
        XCTAssertEqual(
            renderer.testPatternFrameCount,
            0,
            "a decode failure must NOT be masked by the test pattern"
        )
        XCTAssertEqual(renderer.decodedFrameCount, 0)
    }

    // MARK: - Lifecycle

    func testDetachSourceInvalidatesItAndRevertsToTestPattern() throws {
        let renderer = try makeRenderer()
        let target = try makeTarget(renderer)
        let source = try StudioTestMedia.makeFrameSource(
            lumaLevels: [32],
            device: renderer.device
        )
        renderer.attach(source: source)
        _ = renderer.render(snapshot: snapshot(frame: 0), to: target)
        XCTAssertTrue(source.isValid)

        renderer.detachSource()
        XCTAssertFalse(source.isValid, "detach must invalidate the decoder, not just drop it")
        XCTAssertFalse(renderer.hasSource)
        renderer.detachSource()  // idempotent

        let outcome = renderer.render(snapshot: snapshot(frame: 0), to: target)
        XCTAssertEqual(outcome, .testPattern(frameIndex: 0))
        XCTAssertEqual(try pixel(target, x: firstBarX, y: barBandY), .white)
    }

    /// Switching sources must not strand a decompression session.
    func testAttachingASecondSourceInvalidatesTheFirst() throws {
        let renderer = try makeRenderer()
        let first = try StudioTestMedia.makeFrameSource(
            lumaLevels: [32],
            device: renderer.device
        )
        let second = try StudioTestMedia.makeFrameSource(
            lumaLevels: [224],
            device: renderer.device
        )
        renderer.attach(source: first)
        renderer.attach(source: second)

        XCTAssertFalse(first.isValid, "the replaced source must be invalidated")
        XCTAssertTrue(second.isValid)
    }

    func testDiagnosticsAggregateViewerAndSourceCounters() throws {
        let renderer = try makeRenderer()
        let target = try makeTarget(renderer)

        _ = renderer.render(snapshot: snapshot(frame: 0), to: target)
        XCTAssertEqual(renderer.diagnostics.hasSource, false)
        XCTAssertNil(renderer.diagnostics.sourceDiagnostics)

        renderer.attach(
            source: try StudioTestMedia.makeFrameSource(
                lumaLevels: [32, 224],
                device: renderer.device
            )
        )
        _ = renderer.render(snapshot: snapshot(frame: 0), to: target)
        _ = renderer.render(snapshot: snapshot(frame: 1), to: target)
        _ = renderer.render(snapshot: snapshot(frame: 1), to: target)

        let diagnostics = renderer.diagnostics
        XCTAssertTrue(diagnostics.hasSource)
        XCTAssertEqual(diagnostics.testPatternFrameCount, 1)
        XCTAssertEqual(diagnostics.decodedFrameCount, 3)
        XCTAssertEqual(diagnostics.failedFrameCount, 0)
        XCTAssertEqual(renderer.presentedFrameCount, 4)
        // Two decodes for three decoded frames: the repeat hit the source cache.
        XCTAssertEqual(diagnostics.sourceDiagnostics?.decodeCount, 2)
        XCTAssertEqual(diagnostics.sourceDiagnostics?.cacheHitCount, 1)
    }

    // MARK: - Reused-target residue (the conditional-clear seam)

    /// Full-frame readback. Test-only, per the AVCDAW note; the packaged
    /// corruption showed up as area trails a single-pixel probe cannot see.
    private func fullFrameBytes(_ texture: MTLTexture) -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: size * size * 4)
        texture.getBytes(
            &bytes,
            bytesPerRow: size * 4,
            from: MTLRegionMake2D(0, 0, size, size),
            mipmapLevel: 0
        )
        return bytes
    }

    /// The exact compositing configuration the packaged viewer runs: overlay
    /// present, so the content pass chains and the overlay owns the end of the
    /// frame. `presenting: nil` keeps the result readable offscreen.
    private func makeOverlayModel() -> StudioOverlayModel {
        StudioOverlayLayout.build(
            StudioOverlayState(
                viewport: StudioOverlayViewport(
                    width: Double(size), height: Double(size), scale: 1),
                positionTicks: 0,
                durationTicks: 24,
                isPlaying: true,
                timecodeText: "00:00:00:00",
                sourceLabel: "moving.mov",
                diagnostics: StudioOverlayDiagnostics(
                    presentedFrameCount: 1,
                    droppedFrameCount: 0,
                    retainedFrameCount: 0,
                    hardwareDecodeLabel: "hardware",
                    syncLabel: "a/v +1.0ms",
                    memoryLabel: "rss 1MB",
                    cacheHitCount: 0,
                    boundTextureCount: 1,
                    playerCount: 1
                )
            )
        )
    }

    /// A review whose inserted material has NO attached source, so every frame
    /// inside the insert is a deterministic drop — the branch that makes the
    /// overlay clear first.
    private func makeMissingReview() throws -> StudioReviewContext {
        let timebase = try XCTUnwrap(StudioTimebase(timescale: 30, frameDurationTicks: 1))
        let op = StudioInsertRangeOp(
            itemId: "i1", assetId: "missing", trackId: nil,
            sourceIn: try XCTUnwrap(StudioRationalTime(n: 0, d: 30)),
            sourceOut: try XCTUnwrap(StudioRationalTime(n: 600, d: 30)),
            at: try XCTUnwrap(StudioRationalTime(n: 0, d: 30)))
        return StudioReviewContext(
            version: .proposed,
            timeline: try XCTUnwrap(
                StudioProposedTimeline(
                    proposal: StudioEditProposal(
                        proposalId: "p1", createdRevision: 1, op: op),
                    timebase: timebase)),
            timebase: timebase)
    }

    /// The packaged viewer renders into a POOLED, RECYCLED drawable, and the
    /// no-residue guarantee rests on two joins: a successful content pass
    /// covers the whole target, and a dropped frame makes the overlay clear
    /// first (`clearingFirst: !outcome.didDraw`). A fresh-target-per-frame
    /// harness cannot see either join break, so this drives the real
    /// compositing path into ONE reused target across alternating drawn and
    /// dropped frames, then compares against fresh-target renders of the same
    /// snapshots. Reverting the conditional clear fails the dropped-frame
    /// comparison; anything that leaves residue fails the drawn comparison.
    func testAReusedTargetAccumulatesNoResidueAcrossDrawnAndDroppedFrames() async throws {
        let renderer = try makeRenderer()
        let url = StudioTestMedia.makeTemporaryMovieURL()
        try await StudioTestMedia.writeMovingMovie(
            frameCount: 24, to: url, forceKeyFrames: false)
        defer { try? FileManager.default.removeItem(at: url) }
        let loaded = try await StudioMediaSourceLoader.makeFrameSource(
            asset: StudioMediaAsset(assetId: "moving", path: url.path, mediaKind: .video),
            device: renderer.device
        )
        defer { loaded.source.invalidate() }
        renderer.attach(
            source: loaded.source, assetId: "moving", timebase: loaded.media.timebase)

        let overlay = makeOverlayModel()
        let review = try makeMissingReview()
        let reused = try makeTarget(renderer)

        var frame: Int64 = 20
        for step in 0..<12 {
            if step % 3 == 2 {
                let outcome = renderer.render(
                    snapshot: snapshot(frame: 10), to: reused,
                    overlay: overlay, review: review)
                XCTAssertFalse(
                    outcome.didDraw,
                    "the missing-asset review must drop the frame")
            } else {
                let outcome = renderer.render(
                    snapshot: snapshot(frame: frame), to: reused, overlay: overlay)
                XCTAssertTrue(outcome.didDraw)
                frame = frame >= 6 ? frame - 6 : 20
            }
        }

        // Drawn after the storm: a reused target must not change the picture.
        XCTAssertTrue(
            renderer.render(snapshot: snapshot(frame: 9), to: reused, overlay: overlay)
                .didDraw)
        let reusedDrawn = fullFrameBytes(reused)
        let freshDrawn = try makeTarget(renderer)
        XCTAssertTrue(
            renderer.render(snapshot: snapshot(frame: 9), to: freshDrawn, overlay: overlay)
                .didDraw)
        XCTAssertEqual(
            reusedDrawn, fullFrameBytes(freshDrawn),
            "a reused target changed the picture: residue survived a successful pass")

        // Dropped after drawn content: the conditional clear must leave the
        // same pixels as a dropped frame into a fresh target, not the previous
        // picture under a live HUD.
        let freshDropped = try makeTarget(renderer)
        _ = renderer.render(
            snapshot: snapshot(frame: 10), to: freshDropped,
            overlay: overlay, review: review)
        _ = renderer.render(
            snapshot: snapshot(frame: 10), to: reused,
            overlay: overlay, review: review)
        XCTAssertEqual(
            fullFrameBytes(reused), fullFrameBytes(freshDropped),
            "a dropped frame on a reused target shows the previous picture")
    }
}
