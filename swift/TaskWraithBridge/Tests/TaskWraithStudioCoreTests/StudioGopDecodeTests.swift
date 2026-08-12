import CoreMedia
import Metal
import XCTest

@testable import TaskWraithStudioCore

/// GOP-aware decode and seeking over genuinely inter-coded media.
///
/// Every fixture here is written WITHOUT forced keyframes, so the samples carry
/// real dependencies. These are the properties that make scrubbing possible:
/// a frame must render the same picture no matter which direction it was
/// reached from, and sequential playback must not pay a keyframe restart per
/// frame.
final class StudioGopDecodeTests: XCTestCase {
    private let size = 128
    /// Distinct, monotonically increasing so a rendered value identifies its
    /// frame without ambiguity.
    private let levels: [UInt8] = [16, 36, 56, 76, 96, 116, 136, 156, 176, 196, 216, 236]

    private func makeDevice() throws -> MTLDevice {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device available on this machine")
        }
        return device
    }

    private struct Harness {
        let source: StudioVideoFrameSource
        let media: StudioLoadedMedia
        let renderer: StudioVideoFrameRenderer
        let target: MTLTexture
        let url: URL
    }

    private func makeInterCodedHarness(device: MTLDevice) async throws -> Harness {
        let url = StudioTestMedia.makeTemporaryMovieURL()
        try await StudioTestMedia.writeFlatMovie(
            lumaLevels: levels,
            to: url,
            forceKeyFrames: false
        )
        let loaded = try await StudioMediaSourceLoader.makeFrameSource(
            asset: StudioMediaAsset(assetId: "gop", path: url.path, mediaKind: .video),
            device: device
        )
        XCTAssertFalse(
            loaded.media.allSamplesAreSyncSamples,
            "fixture must be inter-coded or these tests prove nothing"
        )
        return Harness(
            source: loaded.source,
            media: loaded.media,
            renderer: try StudioVideoFrameRenderer(device: device),
            target: try StudioTestPatternRenderer.makeOffscreenTarget(
                device: device,
                width: size,
                height: size
            ),
            url: url
        )
    }

    private func renderedGreen(_ harness: Harness, frame: Int64) throws -> Int {
        let textures = try harness.source.textures(forFrameIndex: frame)
        try harness.renderer.render(frame: textures, to: harness.target)
        return Int(
            try StudioTestPatternRenderer.readPixel(from: harness.target, x: 64, y: 64).green
        )
    }

    // MARK: - Correctness

    /// Every frame of an inter-coded asset must be reachable and distinct.
    func testEveryFrameOfAnInterCodedAssetDecodesInOrder() async throws {
        let harness = try await makeInterCodedHarness(device: try makeDevice())
        defer {
            harness.source.invalidate()
            try? FileManager.default.removeItem(at: harness.url)
        }

        var greens: [Int] = []
        for frame in 0..<levels.count {
            greens.append(try renderedGreen(harness, frame: Int64(frame)))
        }

        for index in 1..<greens.count {
            XCTAssertGreaterThan(
                greens[index],
                greens[index - 1],
                "frame \(index) must be brighter than \(index - 1): \(greens)"
            )
        }
    }

    /// THE seeking property. The picture for a frame cannot depend on the route
    /// taken to it — if it does, the decoder's reference state is leaking into
    /// the output, which is exactly what isolated decoding did.
    func testAFrameRendersIdenticallyRegardlessOfSeekDirection() async throws {
        let harness = try await makeInterCodedHarness(device: try makeDevice())
        defer {
            harness.source.invalidate()
            try? FileManager.default.removeItem(at: harness.url)
        }

        // Arrive at frame 9 by playing forward.
        for frame in 0...9 {
            _ = try renderedGreen(harness, frame: Int64(frame))
        }
        let forwards = try renderedGreen(harness, frame: 9)

        // Arrive at frame 9 by seeking backwards then jumping forward.
        _ = try renderedGreen(harness, frame: 2)
        let afterBackwardSeek = try renderedGreen(harness, frame: 9)

        // And by jumping straight to it from the end.
        _ = try renderedGreen(harness, frame: 11)
        let afterJump = try renderedGreen(harness, frame: 9)

        XCTAssertEqual(forwards, afterBackwardSeek, "backward seek changed the picture")
        XCTAssertEqual(forwards, afterJump, "forward jump changed the picture")
    }

    func testBackwardSeekReturnsTheEarlierFrameNotTheLaterOne() async throws {
        let harness = try await makeInterCodedHarness(device: try makeDevice())
        defer {
            harness.source.invalidate()
            try? FileManager.default.removeItem(at: harness.url)
        }

        let late = try renderedGreen(harness, frame: 11)
        let early = try renderedGreen(harness, frame: 1)
        XCTAssertLessThan(early, late, "seeking back must show the earlier, darker frame")

        // And back forward again.
        XCTAssertEqual(try renderedGreen(harness, frame: 11), late)
    }

    // MARK: - Cost

    /// Sequential playback must continue from the decoder's current position.
    /// If every frame restarted at the keyframe, a full pass would cost roughly
    /// n^2/2 decodes instead of n.
    func testSequentialPlaybackDoesNotRestartAtTheKeyframeEveryFrame() async throws {
        let harness = try await makeInterCodedHarness(device: try makeDevice())
        defer {
            harness.source.invalidate()
            try? FileManager.default.removeItem(at: harness.url)
        }

        for frame in 0..<levels.count {
            _ = try renderedGreen(harness, frame: Int64(frame))
        }

        let diagnostics = harness.source.diagnostics
        let decodeOrder = harness.media.samples.map(\.frameIndex)
        let syncs = harness.media.samples.map(\.isSyncSample)
        XCTAssertLessThanOrEqual(
            diagnostics.decodeCount,
            levels.count + 1,
            """
            a full sequential pass must cost about one decode per frame.
            decodes=\(diagnostics.decodeCount) restarts=\(diagnostics.keyframeRestartCount)
            decodeOrderPTS=\(decodeOrder) sync=\(syncs)
            """
        )
        XCTAssertLessThanOrEqual(
            diagnostics.keyframeRestartCount,
            1,
            "only the first frame should need a keyframe restart"
        )
    }

    /// A seek costs at most the distance back to a keyframe, which is what
    /// bounds scrub latency.
    func testSeekDecodeChainIsBoundedByTheGopLength() async throws {
        let harness = try await makeInterCodedHarness(device: try makeDevice())
        defer {
            harness.source.invalidate()
            try? FileManager.default.removeItem(at: harness.url)
        }

        _ = try renderedGreen(harness, frame: 11)
        _ = try renderedGreen(harness, frame: 3)
        _ = try renderedGreen(harness, frame: 8)

        XCTAssertLessThanOrEqual(
            harness.source.diagnostics.longestDecodeChain,
            levels.count,
            "no single request may decode more than the whole asset"
        )
    }

    func testRepeatedRequestsForTheSameFrameStillHitTheCache() async throws {
        let harness = try await makeInterCodedHarness(device: try makeDevice())
        defer {
            harness.source.invalidate()
            try? FileManager.default.removeItem(at: harness.url)
        }

        _ = try renderedGreen(harness, frame: 5)
        let decodesAfterFirst = harness.source.decodeCount
        _ = try renderedGreen(harness, frame: 5)
        _ = try renderedGreen(harness, frame: 5)

        XCTAssertEqual(harness.source.decodeCount, decodesAfterFirst)
        XCTAssertEqual(harness.source.cacheHitCount, 2)
    }

    // MARK: - Structural guards

    /// Without a leading keyframe there is no legal place to begin decoding, so
    /// the source must refuse rather than emit whatever the decoder produces.
    func testSourceRefusesAStreamThatDoesNotBeginWithAKeyframe() async throws {
        let device = try makeDevice()
        let encoded = try StudioTestMedia.encodeFlatFrames(lumaLevels: [32, 96])
        let dependentFirst = encoded.samples.enumerated().map { index, sample in
            StudioCompressedSample(
                frameIndex: sample.frameIndex,
                isSyncSample: index != 0,
                sampleBuffer: sample.sampleBuffer
            )
        }

        XCTAssertThrowsError(
            try StudioVideoFrameSource(
                formatDescription: encoded.formatDescription,
                samples: dependentFirst,
                device: device
            )
        ) { error in
            XCTAssertEqual(error as? StudioVideoFrameSourceError, .noLeadingKeyframe)
        }
    }

    func testAllIntraAssetsAreStillReportedAsSuch() async throws {
        let device = try makeDevice()
        let source = try StudioTestMedia.makeFrameSource(
            lumaLevels: [32, 96, 160],
            device: device
        )
        defer { source.invalidate() }

        XCTAssertTrue(source.isAllIntra)
        XCTAssertEqual(source.diagnostics.syncSampleCount, 3)
    }
}
