import Metal
import XCTest

@testable import TaskWraithStudioCore

/// The last hop: a host studio/editCommitted notification carrying an
/// open_media operation must end with decoded pixels in the viewer.
///
/// This is the shape of the acceptance path. It exercises the real chain —
/// NDJSON notification -> session -> asset identity -> AVAssetReader ->
/// VideoToolbox -> zero-copy Metal -> rendered pixels — over a real .mov file,
/// rather than asserting that the pieces exist separately.
@MainActor
final class StudioMediaAttachmentTests: XCTestCase {
    private let size = 128

    private func makeDevice() throws -> MTLDevice {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device available on this machine")
        }
        return device
    }

    /// Builds the exact NDJSON line the host emits for a committed open_media.
    private func editCommittedLine(assetId: String, path: String, revision: Int = 2) throws -> Data {
        let payload: [String: Any] = [
            "jsonrpc": "2.0",
            "method": "studio/editCommitted",
            "params": [
                "revision": revision,
                "op": [
                    "type": "open_media",
                    "asset": [
                        "assetId": assetId,
                        "path": path,
                        "mediaKind": "video",
                    ],
                ],
            ],
        ]
        var data = try JSONSerialization.data(withJSONObject: payload)
        data.append(0x0A)
        return data
    }

    // MARK: - Session recognises the operation

    func testSessionSurfacesTheAssetFromAnOpenMediaNotification() throws {
        let session = StudioCompanionSession()
        let step = session.consume(
            chunk: try editCommittedLine(assetId: "asset-1", path: "/tmp/example.mov")
        )

        XCTAssertEqual(step.openedAssets.count, 1)
        XCTAssertEqual(step.openedAssets.first?.assetId, "asset-1")
        XCTAssertEqual(step.openedAssets.first?.path, "/tmp/example.mov")
        XCTAssertEqual(step.openedAssets.first?.mediaKind, .video)
        XCTAssertEqual(session.openedAssetCount, 1)
        XCTAssertEqual(session.lastOpenedAsset?.assetId, "asset-1")
        // The notification is still counted as a commit.
        XCTAssertEqual(session.editCommittedCount, 1)
        // And the session performed no I/O to learn any of this.
        XCTAssertTrue(step.outboundLines.isEmpty)
        XCTAssertNil(step.exitCode)
    }

    /// insert_range commits ride the SAME notification. If the discriminator
    /// were ignored, every edit would look like a media open.
    func testInsertRangeCommitDoesNotSurfaceAnAsset() throws {
        let payload: [String: Any] = [
            "jsonrpc": "2.0",
            "method": "studio/editCommitted",
            "params": [
                "revision": 3,
                "op": ["type": "insert_range", "itemId": "i1", "assetId": "asset-1"],
            ],
        ]
        var line = try JSONSerialization.data(withJSONObject: payload)
        line.append(0x0A)

        let session = StudioCompanionSession()
        let step = session.consume(chunk: line)

        XCTAssertTrue(step.openedAssets.isEmpty)
        XCTAssertEqual(session.openedAssetCount, 0)
        XCTAssertEqual(session.editCommittedCount, 1, "it is still a commit")
    }

    // MARK: - End to end

    /// THE ACCEPTANCE PATH. Real file, real notification, real decoded pixels.
    func testOpenMediaNotificationEndsWithDecodedPixelsInTheViewer() async throws {
        let device = try makeDevice()
        let url = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: url) }

        // Inter-coded, i.e. what real media actually looks like.
        let levels: [UInt8] = [32, 96, 160, 224]
        try await StudioTestMedia.writeFlatMovie(
            lumaLevels: levels,
            to: url,
            forceKeyFrames: false
        )

        let renderer = try StudioViewerRenderer(device: device)
        let attachment = StudioMediaAttachment(renderer: renderer)
        let target = try StudioTestPatternRenderer.makeOffscreenTarget(
            device: device,
            width: size,
            height: size
        )

        // Before the notification the viewer shows the test pattern.
        let before = renderer.render(snapshot: snapshot(frame: 0, timebase: .pal25), to: target)
        XCTAssertEqual(before, .testPattern(frameIndex: 0))
        XCTAssertEqual(
            try StudioTestPatternRenderer.readPixel(from: target, x: 8, y: 32),
            .white,
            "no source yet, so this must be a colour bar"
        )

        // The host commits an open_media; the session recognises it.
        let session = StudioCompanionSession()
        let step = session.consume(
            chunk: try editCommittedLine(assetId: "acceptance", path: url.path)
        )
        let outcomes = await attachment.attach(openedAssets: step.openedAssets)

        guard case .attached(let assetId, let frameCount, let timebase, let durationTicks) =
            try XCTUnwrap(outcomes.first)
        else {
            return XCTFail("expected the asset to attach, got \(outcomes)")
        }
        XCTAssertEqual(assetId, "acceptance")
        XCTAssertEqual(frameCount, levels.count)
        XCTAssertGreaterThan(durationTicks, 0)

        // The viewer now renders DECODED content, driven by the ASSET's timebase.
        var greens: [Int] = []
        for frame in 0..<levels.count {
            let outcome = renderer.render(
                snapshot: snapshot(frame: Int64(frame), timebase: timebase),
                to: target
            )
            XCTAssertEqual(outcome, .decodedFrame(frameIndex: Int64(frame)))
            greens.append(
                Int(try StudioTestPatternRenderer.readPixel(from: target, x: 64, y: 64).green)
            )
        }

        for index in 1..<greens.count {
            XCTAssertGreaterThan(
                greens[index],
                greens[index - 1],
                "decoded frames from the opened file must differ: \(greens)"
            )
        }
        XCTAssertEqual(attachment.attachedAssetId, "acceptance")
        XCTAssertEqual(attachment.failedCount, 0)
    }

    /// THE ACCEPTANCE PATH, WITH THE TRANSPORT VISIBLE. Same chain as above, but
    /// the frame is composited under the on-screen HUD, which is what the viewer
    /// actually presents.
    ///
    /// Asserting both halves in ONE target is the point: the overlay draws in a
    /// second pass into the same drawable, so a mistake there (clearing instead
    /// of loading, presenting too early, the wrong y direction) destroys the
    /// decoded picture. Separate tests for "video renders" and "HUD renders"
    /// would both stay green through exactly that bug.
    func testOpenedMediaRendersUnderneathAVisibleTransportOverlay() async throws {
        let device = try makeDevice()
        let url = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try await StudioTestMedia.writeFlatMovie(
            lumaLevels: [32, 96, 160, 224],
            to: url,
            forceKeyFrames: false
        )

        let renderer = try StudioViewerRenderer(device: device)
        let attachment = StudioMediaAttachment(renderer: renderer)
        // Wide enough for the HUD to lay out; 128 square is not.
        let width = 512
        let height = 256
        let target = try StudioTestPatternRenderer.makeOffscreenTarget(
            device: device,
            width: width,
            height: height
        )

        let session = StudioCompanionSession()
        let step = session.consume(
            chunk: try editCommittedLine(assetId: "overlay-acceptance", path: url.path)
        )
        let outcomes = await attachment.attach(openedAssets: step.openedAssets)
        guard case .attached(_, _, let timebase, let durationTicks) =
            try XCTUnwrap(outcomes.first)
        else {
            return XCTFail("expected the asset to attach, got \(outcomes)")
        }

        // Frame 3 is the brightest of the four, so the picture is unambiguous.
        let frameSnapshot = snapshot(frame: 3, timebase: timebase)
        let overlay = StudioOverlayLayout.build(
            StudioOverlayState(
                viewport: StudioOverlayViewport(
                    width: Double(width),
                    height: Double(height),
                    scale: 1
                ),
                positionTicks: frameSnapshot.positionTicks,
                durationTicks: durationTicks,
                isPlaying: true,
                inPointTicks: 0,
                outPointTicks: durationTicks,
                isLoopingRange: true,
                timecodeText: "00:00:00:03",
                sourceLabel: "overlay-acceptance"
            )
        )

        let outcome = renderer.render(
            snapshot: frameSnapshot,
            to: target,
            overlay: overlay
        )
        XCTAssertEqual(outcome, .decodedFrame(frameIndex: 3))

        // 1. The DECODED picture survived the overlay pass.
        let picture = try StudioTestPatternRenderer.readPixel(from: target, x: 256, y: 60)
        XCTAssertGreaterThan(
            Int(picture.green),
            180,
            "the overlay pass destroyed the decoded frame"
        )

        // 2. The playhead is drawn, and it is at the END of the track because
        //    frame 3 is the last frame.
        let trackMidY = Int(overlay.trackFrame.y + overlay.trackFrame.height / 2)
        let playheadX = Int(overlay.trackFrame.maxX - 1)
        let playhead = try StudioTestPatternRenderer.readPixel(
            from: target,
            x: playheadX,
            y: trackMidY
        )
        let trackOnly = try StudioTestPatternRenderer.readPixel(
            from: target,
            x: Int(overlay.trackFrame.x) + 20,
            y: trackMidY
        )
        XCTAssertGreaterThan(
            Int(playhead.red) + Int(playhead.green) + Int(playhead.blue),
            Int(trackOnly.red) + Int(trackOnly.green) + Int(trackOnly.blue),
            "no visible playhead over decoded media"
        )

        // 3. The HUD emitted real geometry rather than an empty pass.
        XCTAssertGreaterThan(renderer.overlayVertexCount, 100)
    }

    /// A bad path from the host must not take the viewer down.
    func testAnUnopenableAssetLeavesTheViewerRunning() async throws {
        let device = try makeDevice()
        let renderer = try StudioViewerRenderer(device: device)
        let attachment = StudioMediaAttachment(renderer: renderer)
        let target = try StudioTestPatternRenderer.makeOffscreenTarget(
            device: device,
            width: size,
            height: size
        )

        let outcome = await attachment.attach(
            asset: StudioMediaAsset(
                assetId: "missing",
                path: "/tmp/studio-nope-\(UUID().uuidString).mov",
                mediaKind: .video
            )
        )

        guard case .failed(let assetId, _) = outcome else {
            return XCTFail("expected failure, got \(outcome)")
        }
        XCTAssertEqual(assetId, "missing")
        XCTAssertEqual(attachment.failedCount, 1)
        XCTAssertNil(attachment.attachedAssetId)
        XCTAssertFalse(renderer.hasSource)

        // Still alive and drawing intended content.
        XCTAssertEqual(
            renderer.render(snapshot: snapshot(frame: 0, timebase: .pal25), to: target),
            .testPattern(frameIndex: 0)
        )
    }

    /// Reopening must replace cleanly — this is outcome 11's source-switch case
    /// arriving through the real protocol path rather than a direct API call.
    func testReopeningReplacesTheSourceWithoutStrandingSurfaces() async throws {
        let device = try makeDevice()
        let first = StudioTestMedia.makeTemporaryMovieURL()
        let second = StudioTestMedia.makeTemporaryMovieURL()
        defer {
            try? FileManager.default.removeItem(at: first)
            try? FileManager.default.removeItem(at: second)
        }
        try await StudioTestMedia.writeFlatMovie(lumaLevels: [32, 64], to: first)
        try await StudioTestMedia.writeFlatMovie(lumaLevels: [200, 232], to: second)

        let renderer = try StudioViewerRenderer(device: device)
        let attachment = StudioMediaAttachment(renderer: renderer)

        let firstOutcome = await attachment.attach(
            asset: StudioMediaAsset(assetId: "one", path: first.path)
        )
        XCTAssertTrue(firstOutcome.didAttach, "first open failed: \(firstOutcome)")
        let secondOutcome = await attachment.attach(
            asset: StudioMediaAsset(assetId: "two", path: second.path)
        )
        XCTAssertTrue(secondOutcome.didAttach, "second open failed: \(secondOutcome)")

        XCTAssertEqual(attachment.attachedAssetId, "two")
        XCTAssertEqual(attachment.attachedCount, 2)
        XCTAssertEqual(
            renderer.retainedFrameCount,
            0,
            "switching sources through the protocol path must not strand surfaces"
        )

        attachment.detach()
        XCTAssertFalse(renderer.hasSource)
        XCTAssertNil(attachment.attachedAssetId)
    }

    // MARK: - Helpers

    private func snapshot(frame: Int64, timebase: StudioTimebase) -> StudioTransportSnapshot {
        var clock = StudioPlaybackClock(timebase: timebase, durationTicks: 0)
        clock.seek(toTicks: frame * timebase.frameDurationTicks, atHost: 0)
        return clock.snapshot(atHost: 0)
    }
}
