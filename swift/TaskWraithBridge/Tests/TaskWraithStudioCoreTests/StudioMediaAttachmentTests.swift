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
