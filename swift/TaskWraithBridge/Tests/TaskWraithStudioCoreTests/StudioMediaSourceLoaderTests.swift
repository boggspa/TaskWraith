import AVFoundation
import CoreMedia
import Metal
import XCTest

@testable import TaskWraithStudioCore

/// File-backed ingest verification.
///
/// These write a REAL .mov, demux it with AVAssetReader, decode the resulting
/// compressed samples through VideoToolbox and assert the pixels that reach a
/// Metal texture. That closes the loop this project has been missing: until now
/// every video test synthesised its own samples, so nothing proved a file could
/// become a frame.
final class StudioMediaSourceLoaderTests: XCTestCase {
    private let size = 128

    private func makeDevice() throws -> MTLDevice {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device available on this machine")
        }
        return device
    }

    private func asset(at url: URL) -> StudioMediaAsset {
        StudioMediaAsset(assetId: "asset-under-test", path: url.path, mediaKind: .video)
    }

    // MARK: - Exact frame indexing (no file needed)

    /// The time model is integer ticks everywhere else; ingest must not quietly
    /// reintroduce seconds-as-Double at the boundary.
    func testFrameIndexArithmeticIsExactForNtsc() {
        let frameDuration = CMTime(value: 1001, timescale: 30000)

        XCTAssertEqual(
            StudioMediaSourceLoader.frameIndex(
                of: CMTime(value: 60_060, timescale: 30000),
                frameDuration: frameDuration
            ),
            60
        )
        XCTAssertEqual(
            StudioMediaSourceLoader.frameIndex(
                of: CMTime(value: 0, timescale: 30000),
                frameDuration: frameDuration
            ),
            0
        )
        // 29.97fps frame 1000 is 1_001_000 ticks; a seconds-based Double would
        // be the obvious place for this to land on 999.
        XCTAssertEqual(
            StudioMediaSourceLoader.frameIndex(
                of: CMTime(value: 1_001_000, timescale: 30000),
                frameDuration: frameDuration
            ),
            1000
        )
        // Differing timescales must still resolve exactly.
        XCTAssertEqual(
            StudioMediaSourceLoader.frameIndex(
                of: CMTime(value: 2, timescale: 30),
                frameDuration: CMTime(value: 1, timescale: 30)
            ),
            2
        )
        XCTAssertNil(
            StudioMediaSourceLoader.frameIndex(
                of: CMTime(value: 1, timescale: 30),
                frameDuration: CMTime(value: 0, timescale: 30)
            )
        )
    }

    func testFrameDurationFallsBackToMeasuredPresentationDelta() throws {
        // An asset that declares no usable minFrameDuration still has exact
        // deltas between presentation times for constant-frame-rate content.
        let resolved = try StudioMediaSourceLoader.resolveFrameDuration(
            minFrameDuration: .invalid,
            presentationTimes: [
                CMTime(value: 0, timescale: 600),
                CMTime(value: 20, timescale: 600),
            ]
        )
        XCTAssertEqual(resolved.value, 20)
        XCTAssertEqual(resolved.timescale, 600)

        XCTAssertThrowsError(
            try StudioMediaSourceLoader.resolveFrameDuration(
                minFrameDuration: .invalid,
                presentationTimes: [CMTime(value: 0, timescale: 600)]
            )
        ) { error in
            XCTAssertEqual(error as? StudioMediaLoadError, .indeterminateFrameDuration)
        }
    }

    // MARK: - Real container

    func testLoadsRealMovieIntoOrderedCompressedSamples() async throws {
        let url = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try await StudioTestMedia.writeFlatMovie(lumaLevels: [32, 96, 160, 224], to: url)

        let media = try await StudioMediaSourceLoader.load(asset: asset(at: url))

        XCTAssertEqual(media.samples.count, 4)
        XCTAssertEqual(media.samples.map(\.frameIndex), [0, 1, 2, 3])
        // The .mov muxer stores this 30fps track as 20/600; the loader reduces
        // it to the canonical 1/30 rather than propagating the container's
        // arbitrary timescale into the playback clock.
        XCTAssertEqual(media.timebase.timescale, 30)
        XCTAssertEqual(media.timebase.frameDurationTicks, 1)
        XCTAssertTrue(media.allSamplesAreSyncSamples)
        XCTAssertEqual(media.naturalSize.width, CGFloat(size))
        XCTAssertEqual(media.naturalSize.height, CGFloat(size))
        XCTAssertGreaterThan(media.durationTicks, 0)
        XCTAssertEqual(media.asset.assetId, "asset-under-test")

        let dimensions = CMVideoFormatDescriptionGetDimensions(media.formatDescription)
        XCTAssertEqual(Int(dimensions.width), size)
        XCTAssertEqual(Int(dimensions.height), size)
    }

    /// THE headline: a real file on disk becomes decoded pixels in a Metal
    /// texture, with the playback clock choosing which frame.
    func testFileFramesRenderThroughTheZeroCopyPathUnderClockControl() async throws {
        let device = try makeDevice()
        let url = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: url) }

        let levels: [UInt8] = [32, 96, 160, 224]
        try await StudioTestMedia.writeFlatMovie(lumaLevels: levels, to: url)

        let loaded = try await StudioMediaSourceLoader.makeFrameSource(
            asset: asset(at: url),
            device: device
        )
        defer { loaded.source.invalidate() }

        let renderer = try StudioVideoFrameRenderer(device: device)
        let target = try StudioTestPatternRenderer.makeOffscreenTarget(
            device: device,
            width: size,
            height: size
        )
        // The clock derived from the asset, not invented by the test.
        var clock = StudioPlaybackClock(
            timebase: loaded.media.timebase,
            durationTicks: loaded.media.durationTicks
        )

        var greens: [Int] = []
        for frame in 0..<levels.count {
            clock.seek(toTicks: Int64(frame) * loaded.media.timebase.frameDurationTicks, atHost: 0)
            let snapshot = clock.snapshot(atHost: 0)
            XCTAssertEqual(snapshot.frameIndex, Int64(frame))

            let textures = try loaded.source.textures(at: snapshot)
            try renderer.render(frame: textures, to: target)
            greens.append(
                Int(try StudioTestPatternRenderer.readPixel(from: target, x: 64, y: 64).green)
            )
        }

        for index in 1..<greens.count {
            XCTAssertGreaterThan(
                greens[index],
                greens[index - 1],
                "frame \(index) from the FILE must be brighter than \(index - 1): \(greens)"
            )
        }
        XCTAssertEqual(loaded.source.decodeCount, levels.count)
        XCTAssertNotEqual(loaded.source.hardwareDecodeStatus, .unknown)
    }

    /// THE MEASURED REASON THE REFUSAL EXISTS.
    ///
    /// A normal-GOP .mov (the AVAssetWriter default) is inter-coded. Decoding
    /// its samples in isolation rendered [32, 32, 160, 224] for source levels
    /// [32, 96, 160, 224] — frame 1 silently showed frame 0's picture. That is
    /// worse than failing, because it looks like working playback, so the
    /// loader now refuses the asset outright.
    func testInterCodedMediaIsRefusedRatherThanRenderedWrong() async throws {
        let url = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try await StudioTestMedia.writeFlatMovie(
            lumaLevels: [32, 96, 160, 224],
            to: url,
            forceKeyFrames: false
        )

        do {
            _ = try await StudioMediaSourceLoader.load(asset: asset(at: url))
            XCTFail("inter-coded media must be refused until GOP-aware decoding exists")
        } catch let error as StudioMediaLoadError {
            guard case .interCodedMediaUnsupported(let dependentSampleCount) = error else {
                return XCTFail("expected interCodedMediaUnsupported, got \(error)")
            }
            XCTAssertGreaterThan(dependentSampleCount, 0)
        }

        // The escape hatch exists for the future GOP-aware path and for
        // diagnostics; it must still surface the truth about the asset.
        let unchecked = try await StudioMediaSourceLoader.load(
            asset: asset(at: url),
            requireAllSyncSamples: false
        )
        XCTAssertFalse(unchecked.allSamplesAreSyncSamples)
    }

    // MARK: - Failure modes

    func testRejectsMissingFile() async throws {
        let missing = StudioMediaAsset(
            assetId: "gone",
            path: "/tmp/studio-does-not-exist-\(UUID().uuidString).mov",
            mediaKind: .video
        )
        do {
            _ = try await StudioMediaSourceLoader.load(asset: missing)
            XCTFail("expected fileNotFound")
        } catch let error as StudioMediaLoadError {
            guard case .fileNotFound = error else {
                return XCTFail("expected fileNotFound, got \(error)")
            }
        }
    }

    func testRejectsADirectory() async throws {
        let directory = StudioMediaAsset(
            assetId: "dir",
            path: FileManager.default.temporaryDirectory.path,
            mediaKind: .video
        )
        do {
            _ = try await StudioMediaSourceLoader.load(asset: directory)
            XCTFail("expected notARegularFile")
        } catch let error as StudioMediaLoadError {
            guard case .notARegularFile = error else {
                return XCTFail("expected notARegularFile, got \(error)")
            }
        }
    }

    /// Eager loading must fail loudly rather than quietly consuming a whole
    /// feature film's worth of memory.
    func testSampleLimitIsEnforced() async throws {
        let url = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try await StudioTestMedia.writeFlatMovie(lumaLevels: [32, 96, 160, 224], to: url)

        do {
            _ = try await StudioMediaSourceLoader.load(asset: asset(at: url), maxSampleCount: 2)
            XCTFail("expected sampleLimitExceeded")
        } catch let error as StudioMediaLoadError {
            XCTAssertEqual(error, .sampleLimitExceeded(limit: 2))
        }
    }

    // MARK: - Normative identity conformance

    func testAssetIdentityDecodesTheHostShapeExactly() {
        let decoded = StudioMediaAsset.decode(from: [
            "assetId": "abc123",
            "path": "/canonical/real/path.mov",
            "mediaKind": "video",
        ])
        XCTAssertEqual(decoded?.assetId, "abc123")
        XCTAssertEqual(decoded?.path, "/canonical/real/path.mov")
        XCTAssertEqual(decoded?.mediaKind, .video)

        // A renamed or missing field must fail closed, not silently default.
        XCTAssertNil(
            StudioMediaAsset.decode(from: ["assetId": "abc", "path": "/p"])
        )
        XCTAssertNil(
            StudioMediaAsset.decode(from: [
                "assetId": "abc", "path": "/p", "mediaKind": "audio",
            ])
        )
        XCTAssertEqual(StudioMediaAsset.openMediaSchemaVersion, 1)
    }

    func testOnlyOpenMediaOperationsYieldAnAsset() {
        let openMedia: [String: Any] = [
            "type": "open_media",
            "asset": ["assetId": "a1", "path": "/p.mov", "mediaKind": "video"],
        ]
        XCTAssertEqual(StudioMediaAsset.fromDocumentOperation(openMedia)?.assetId, "a1")

        // insert_range commits arrive on the SAME notification; the type
        // discriminator is what stops them being read as media opens.
        let insertRange: [String: Any] = [
            "type": "insert_range",
            "itemId": "i1",
            "assetId": "a1",
        ]
        XCTAssertNil(StudioMediaAsset.fromDocumentOperation(insertRange))
    }
}
