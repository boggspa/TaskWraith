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
        if ProcessInfo.processInfo.environment["CI"] != nil {
            throw XCTSkip(
                "asserts hardware video decode; the hosted Intel runners are virtualised "
                + "without it, which is why this passes on Apple Silicon and not there"
            )
        }
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

    /// THE EXACT CASE THAT USED TO CORRUPT.
    ///
    /// A normal-GOP .mov (the AVAssetWriter default) is inter-coded. Decoding
    /// its samples in isolation rendered [32, 32, 160, 224] for source levels
    /// [32, 96, 160, 224] — frame 1 silently showed frame 0's picture. With
    /// decode-order submission and decode-forward-from-keyframe, the SAME media
    /// must now render correctly. This is the regression test for the defect,
    /// not a new happy path.
    func testInterCodedMediaNowDecodesCorrectly() async throws {
        let device = try makeDevice()
        let url = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: url) }

        let levels: [UInt8] = [32, 96, 160, 224]
        try await StudioTestMedia.writeFlatMovie(
            lumaLevels: levels,
            to: url,
            forceKeyFrames: false
        )

        let loaded = try await StudioMediaSourceLoader.makeFrameSource(
            asset: asset(at: url),
            device: device
        )
        defer { loaded.source.invalidate() }

        // This is genuinely inter-coded media, not an all-intra fixture.
        XCTAssertFalse(
            loaded.media.allSamplesAreSyncSamples,
            "fixture must be inter-coded or this test proves nothing"
        )

        let renderer = try StudioVideoFrameRenderer(device: device)
        let target = try StudioTestPatternRenderer.makeOffscreenTarget(
            device: device,
            width: size,
            height: size
        )

        var greens: [Int] = []
        for frame in 0..<levels.count {
            let textures = try loaded.source.textures(forFrameIndex: Int64(frame))
            try renderer.render(frame: textures, to: target)
            greens.append(
                Int(try StudioTestPatternRenderer.readPixel(from: target, x: 64, y: 64).green)
            )
        }

        for index in 1..<greens.count {
            XCTAssertGreaterThan(
                greens[index],
                greens[index - 1],
                "inter-coded frame \(index) must be brighter than \(index - 1): \(greens)"
            )
        }
    }

    /// Strict mode still exists for callers that genuinely need all-intra input.
    func testAllIntraCanStillBeRequiredExplicitly() async throws {
        let url = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try await StudioTestMedia.writeFlatMovie(
            lumaLevels: [32, 96],
            to: url,
            forceKeyFrames: false
        )

        do {
            _ = try await StudioMediaSourceLoader.load(
                asset: asset(at: url),
                requireAllSyncSamples: true
            )
            XCTFail("expected interCodedMediaUnsupported under strict mode")
        } catch let error as StudioMediaLoadError {
            guard case .interCodedMediaUnsupported = error else {
                return XCTFail("expected interCodedMediaUnsupported, got \(error)")
            }
        }
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

    // MARK: - Bounded long-media provider

    /// Compressed payload samples from both ingest passes must carry the
    /// format description required by VideoToolbox.
    func testSampleFormatDescriptionPresence() async throws {
        let url = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try await StudioTestMedia.writeFlatMovie(
            lumaLevels: [32, 96, 160, 224],
            to: url
        )

        // Loader path
        let loaded = try await StudioMediaSourceLoader.load(asset: asset(at: url))
        let loaderSample = try XCTUnwrap(loaded.samples.first)
        let loaderFormat = CMSampleBufferGetFormatDescription(loaderSample.sampleBuffer)
        XCTAssertNotNil(loaderFormat, "loader sample must carry a format description")

        // Fresh reader path
        let asset = AVURLAsset(url: url)
        let tracks = try await asset.loadTracks(withMediaType: .video)
        let track = try XCTUnwrap(tracks.first)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        output.alwaysCopiesSampleData = false
        reader.add(output)
        XCTAssertTrue(reader.startReading())
        var freshPayloadCount = 0
        while let sample = output.copyNextSampleBuffer() {
            guard CMSampleBufferGetDataBuffer(sample) != nil else { continue }
            freshPayloadCount += 1
            XCTAssertNotNil(
                CMSampleBufferGetFormatDescription(sample),
                "every compressed payload sample must carry a format description"
            )
        }
        XCTAssertEqual(freshPayloadCount, 4)
    }

    func testFormatDescriptionRepairPreservesSampleAttachments() async throws {
        let url = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try await StudioTestMedia.writeFlatMovie(
            lumaLevels: [32, 96],
            to: url
        )

        let loaded = try await StudioMediaSourceLoader.load(asset: asset(at: url))
        let original = try XCTUnwrap(loaded.samples.first?.sampleBuffer)
        let formatDescription = try XCTUnwrap(
            CMSampleBufferGetFormatDescription(original)
        )
        let dataBuffer = try XCTUnwrap(CMSampleBufferGetDataBuffer(original))
        var timingInfo = CMSampleTimingInfo()
        XCTAssertEqual(
            CMSampleBufferGetSampleTimingInfo(
                original,
                at: 0,
                timingInfoOut: &timingInfo
            ),
            noErr
        )
        var sampleSize = CMSampleBufferGetSampleSize(original, at: 0)
        var stripped: CMSampleBuffer?
        XCTAssertEqual(
            CMSampleBufferCreate(
                allocator: kCFAllocatorDefault,
                dataBuffer: dataBuffer,
                dataReady: true,
                makeDataReadyCallback: nil,
                refcon: nil,
                formatDescription: nil,
                sampleCount: 1,
                sampleTimingEntryCount: 1,
                sampleTimingArray: &timingInfo,
                sampleSizeEntryCount: 1,
                sampleSizeArray: &sampleSize,
                sampleBufferOut: &stripped
            ),
            noErr
        )
        let withoutFormat = try XCTUnwrap(stripped)
        let sourceAttachments = try XCTUnwrap(
            CMSampleBufferGetSampleAttachmentsArray(
                withoutFormat,
                createIfNecessary: true
            ) as? [NSMutableDictionary]
        )
        sourceAttachments[0][kCMSampleAttachmentKey_DependsOnOthers] = true

        let repaired = BoundedStudioSampleProvider.attachingFormatDescription(
            to: withoutFormat,
            formatDescription: formatDescription
        )

        XCTAssertNotNil(CMSampleBufferGetFormatDescription(repaired))
        let repairedAttachments = try XCTUnwrap(
            CMSampleBufferGetSampleAttachmentsArray(
                repaired,
                createIfNecessary: false
            ) as? [[CFString: Any]]
        )
        XCTAssertEqual(
            repairedAttachments.first?[kCMSampleAttachmentKey_DependsOnOthers] as? Bool,
            true
        )
    }

    /// The bounded provider must skip non-payload stream buffers and decode
    /// the first compressed video sample.
    func testBoundedProviderDecodesFirstFrame() async throws {
        let device = try makeDevice()
        let url = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: url) }

        try await StudioTestMedia.writeFlatMovie(
            lumaLevels: [32, 96, 160],
            to: url,
            width: 64,
            height: 64,
            forceKeyFrames: true
        )

        let loaded = try await StudioMediaSourceLoader.makeBoundedFrameSource(
            asset: asset(at: url),
            device: device,
            payloadCacheLimit: 8
        )
        defer { loaded.source.invalidate() }

        let textures = try loaded.source.textures(forFrameIndex: 0)
        XCTAssertNotNil(textures)
    }

    /// The mandatory 600s/30fps packaged asset carries ~18,000 samples, far
    /// past the eager 3,600 cap. The default production factory must fall back
    /// to a bounded provider while the explicit eager loader still refuses.
    func testDefaultFrameSourceFallsBackToBoundedProviderPastTheEagerLimit() async throws {
        let device = try makeDevice()
        let url = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: url) }

        // 4,000 frames is past the 3,600 eager ceiling. Small frames keep the
        // write fast; all-intra keeps each sample independently decodable.
        let frameCount = 4_000
        try await StudioTestMedia.writeFlatMovie(
            lumaLevels: (0..<frameCount).map { UInt8(32 + ($0 % 200)) },
            to: url,
            width: 64,
            height: 64,
            forceKeyFrames: true
        )

        let loaded = try await StudioMediaSourceLoader.makeFrameSource(
            asset: asset(at: url),
            device: device
        )
        defer { loaded.source.invalidate() }

        XCTAssertEqual(loaded.source.sampleCount, frameCount)
        XCTAssertEqual(
            loaded.media.samples.count,
            0,
            "bounded load must not retain the eager sample array"
        )
        XCTAssertTrue(loaded.media.allSamplesAreSyncSamples)

        // Addressability: a frame past the old eager limit must decode.
        let lateTextures = try loaded.source.textures(forFrameIndex: Int64(frameCount - 1))
        XCTAssertNotNil(lateTextures)

        // The payload cache must stay bounded even after a wide seek.
        let bounded = try XCTUnwrap(
            loaded.media.sampleProvider as? BoundedStudioSampleProvider,
            "the default production factory must select the bounded provider"
        )
        XCTAssertLessThanOrEqual(bounded.cacheCount, 240)
    }

    func testBoundedProviderSeeksAcrossInterCodedGops() async throws {
        let device = try makeDevice()
        let url = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: url) }

        let frameCount = 180
        try await StudioTestMedia.writeFlatMovie(
            lumaLevels: (0..<frameCount).map { UInt8(32 + ($0 % 200)) },
            to: url,
            width: 64,
            height: 64,
            forceKeyFrames: false
        )

        let loaded = try await StudioMediaSourceLoader.makeBoundedFrameSource(
            asset: asset(at: url),
            device: device,
            payloadCacheLimit: 16
        )
        defer { loaded.source.invalidate() }
        XCTAssertFalse(loaded.media.allSamplesAreSyncSamples)

        XCTAssertNotNil(try loaded.source.textures(forFrameIndex: 150))
        XCTAssertNotNil(try loaded.source.textures(forFrameIndex: 15))
        XCTAssertNotNil(try loaded.source.textures(forFrameIndex: 170))
        let bounded = try XCTUnwrap(
            loaded.media.sampleProvider as? BoundedStudioSampleProvider
        )
        XCTAssertLessThanOrEqual(bounded.cacheCount, 16)
    }

    /// A seek backwards must restart from the nearest keyframe without growing
    /// the cache beyond its bound.
    func testBoundedProviderSeeksBackwardsWithinTheCacheBound() async throws {
        let device = try makeDevice()
        let url = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: url) }

        let frameCount = 500
        try await StudioTestMedia.writeFlatMovie(
            lumaLevels: (0..<frameCount).map { UInt8(32 + ($0 % 200)) },
            to: url,
            width: 64,
            height: 64,
            forceKeyFrames: true
        )

        let loaded = try await StudioMediaSourceLoader.makeBoundedFrameSource(
            asset: asset(at: url),
            device: device,
            payloadCacheLimit: 32
        )
        defer { loaded.source.invalidate() }

        // Forward pass.
        _ = try loaded.source.textures(forFrameIndex: 400)
        // Backward seek must not blow the bound.
        _ = try loaded.source.textures(forFrameIndex: 10)
        // Forward again.
        _ = try loaded.source.textures(forFrameIndex: 450)

        if let bounded = loaded.media.sampleProvider as? BoundedStudioSampleProvider {
            XCTAssertLessThanOrEqual(bounded.cacheCount, 32)
        } else {
            XCTFail("expected a bounded provider")
        }
    }

    // MARK: - Reader work is bounded by the GOP, not by the frame index

    /// `payloadReadCount` counts every `copyNextSampleBuffer()`, including the
    /// non-payload stream/event buffers the provider discards to stay aligned
    /// with the metadata pass. A few of those can precede the first real
    /// payload, so these controls carry a small allowance.
    ///
    /// The allowance is a CONSTANT on purpose. The claim under test is not
    /// "reads are few", it is "reads do not scale with the requested index" —
    /// an allowance that grew with position would concede the whole point.
    private var eventBufferAllowance: Int { 8 }

    /// Nearest sync sample at or before `index`, derived from the metadata the
    /// loader actually indexed rather than from an assumed keyframe cadence.
    private func precedingSyncDecodeIndex(
        _ provider: BoundedStudioSampleProvider,
        for index: Int
    ) -> Int {
        var cursor = index
        while cursor > 0 {
            if provider.metadata(atDecodeIndex: cursor).isSyncSample { return cursor }
            cursor -= 1
        }
        return 0
    }

    /// CONTROL 1 — the regression that shipped: `startReader` opened the asset
    /// at time zero and discarded payloads one at a time until it reached the
    /// chosen sync sample, while its own comment claimed the skip was "bounded
    /// by the GOP". It was not; the walk started at 0. On this fixture a tail
    /// request discarded ~3,999 samples on the calling actor, and on the
    /// 18,000-frame acceptance asset that was a ~79 second main-thread stall.
    ///
    /// Wall-clock timing would catch that flakily and would not say WHY, so the
    /// assertion is on reader work itself.
    func testALateAllIntraRequestReadsOnlyTheSelectedPayload() async throws {
        let url = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: url) }

        // Same 4,000-frame all-intra shape as the eager-fallback control above,
        // so this measures the production bounded path and not a toy asset.
        let frameCount = 4_000
        try await StudioTestMedia.writeFlatMovie(
            lumaLevels: (0..<frameCount).map { UInt8(32 + ($0 % 200)) },
            to: url,
            width: 64,
            height: 64,
            forceKeyFrames: true
        )

        let media = try await StudioMediaSourceLoader.loadBounded(asset: asset(at: url))
        let bounded = try XCTUnwrap(
            media.sampleProvider as? BoundedStudioSampleProvider,
            "loadBounded must select the bounded provider"
        )
        XCTAssertEqual(bounded.sampleCount, frameCount)
        XCTAssertTrue(
            bounded.isAllIntra,
            "every frame must be a sync sample or the selected payload is not reachable alone"
        )
        XCTAssertEqual(
            bounded.payloadReadCount,
            0,
            "the eager metadata pass owns its own reader and must not charge the payload lane"
        )

        let lateIndex = frameCount - 1
        _ = try bounded.sampleBuffer(atDecodeIndex: lateIndex)

        // Every frame is an IDR, so the only legal decode start IS the selected
        // sample: one payload.
        XCTAssertLessThanOrEqual(
            bounded.payloadReadCount,
            1 + eventBufferAllowance,
            "a late all-intra request must read the selected payload, not the "
                + "\(lateIndex) payloads preceding it"
        )
    }

    /// CONTROL 2 — inter-coded media cannot start anywhere, so the honest bound
    /// is the distance back to the selected sync sample. That span is derived
    /// from the loader's own metadata, not from an assumed keyframe interval,
    /// so the control stays exact if the encoder changes its cadence.
    ///
    /// Cheapness is worthless if the picture is wrong, so the same test then
    /// proves the bytes are unchanged by the restart.
    func testAFarBackwardRestartReadsNoMoreThanItsGopAndKeepsPixels() async throws {
        let device = try makeDevice()
        let url = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: url) }

        // Moving content: a flat fixture hides reference corruption, because a
        // stale reference still yields the same flat luma.
        try await StudioTestMedia.writeMovingVFRMovie(
            sections: [(frameRate: 30, frameCount: 240)],
            to: url,
            maxKeyFrameInterval: 16
        )

        let loaded = try await StudioMediaSourceLoader.makeBoundedFrameSource(
            asset: asset(at: url),
            device: device,
            payloadCacheLimit: 24
        )
        defer { loaded.source.invalidate() }
        XCTAssertFalse(
            loaded.media.allSamplesAreSyncSamples,
            "the fixture must be inter-coded or a GOP bound proves nothing"
        )

        let bounded = try XCTUnwrap(
            loaded.media.sampleProvider as? BoundedStudioSampleProvider
        )

        // Land far forward first so the request below is a real backward
        // restart across many GOPs rather than a cache hit.
        let lateIndex = bounded.sampleCount - 1
        _ = try bounded.sampleBuffer(atDecodeIndex: lateIndex)
        let readsBeforeRestart = bounded.payloadReadCount

        let restartIndex = 40
        let syncIndex = precedingSyncDecodeIndex(bounded, for: restartIndex)
        let gopSpan = restartIndex - syncIndex + 1
        XCTAssertLessThan(
            gopSpan,
            restartIndex,
            "the derived GOP must be shorter than the seek itself or the bound is vacuous"
        )

        _ = try bounded.sampleBuffer(atDecodeIndex: restartIndex)
        let restartReads = bounded.payloadReadCount - readsBeforeRestart

        XCTAssertLessThanOrEqual(
            restartReads,
            gopSpan + eventBufferAllowance,
            "a backward restart must read its own GOP (\(gopSpan) payloads from sync "
                + "sample \(syncIndex)), not \(restartIndex) payloads from the start"
        )

        // Bounded AND correct: the picture must not depend on the seek history
        // that reached it.
        let renderer = try StudioVideoFrameRenderer(device: device)
        let target = try StudioTestPatternRenderer.makeOffscreenTarget(
            device: device,
            width: size,
            height: size
        )
        func renderedBytes(frame: Int64) throws -> [UInt8] {
            let textures = try loaded.source.textures(forFrameIndex: frame)
            try renderer.render(frame: textures, to: target)
            var bytes = [UInt8](repeating: 0, count: size * size * 4)
            target.getBytes(
                &bytes,
                bytesPerRow: size * 4,
                from: MTLRegionMake2D(0, 0, size, size),
                mipmapLevel: 0
            )
            return bytes
        }

        let firstPass = try renderedBytes(frame: 200)
        _ = try renderedBytes(frame: 12)
        _ = try renderedBytes(frame: 175)
        let afterRestartStorm = try renderedBytes(frame: 200)

        XCTAssertEqual(
            firstPass,
            afterRestartStorm,
            "the scoped reader must return the same picture, not merely return sooner"
        )
    }

    /// CONTROL 3 — a time-scoped reader is only as exact as the container's
    /// edit list and rounding. If it hands back a different sample than the
    /// metadata pass indexed, every later decode index is silently off by that
    /// difference: wrong pictures at correct-looking timestamps, which is the
    /// failure class this arc has been chasing since the IDR bug.
    ///
    /// So the guard is proven with a reader that deliberately ignores the
    /// requested start — exactly what a dropped `timeRange`, an edit list, or a
    /// rounding error would produce.
    func testAMisScopedReaderFailsClosedInsteadOfIndexingTheWrongPayload() async throws {
        let url = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: url) }

        try await StudioTestMedia.writeFlatMovie(
            lumaLevels: (0..<200).map { UInt8(32 + ($0 % 200)) },
            to: url,
            width: 64,
            height: 64,
            forceKeyFrames: true
        )

        let media = try await StudioMediaSourceLoader.loadBounded(asset: asset(at: url))
        let honest = try XCTUnwrap(media.sampleProvider as? BoundedStudioSampleProvider)
        let metadata = (0..<honest.sampleCount).map { honest.metadata(atDecodeIndex: $0) }

        let urlAsset = AVURLAsset(url: url)
        let tracks = try await urlAsset.loadTracks(withMediaType: .video)
        let track = try XCTUnwrap(tracks.first)

        let misScoped = BoundedStudioSampleProvider(
            metadata: metadata,
            formatDescription: media.formatDescription,
            makeReader: { _ in
                // Ignores the requested start and opens at zero.
                try AVAssetReader(asset: urlAsset)
            },
            makeOutput: { reader in
                let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
                output.alwaysCopiesSampleData = false
                guard reader.canAdd(output) else {
                    throw StudioMediaLoadError.readerCreationFailed("track output rejected")
                }
                reader.add(output)
                return output
            }
        )

        let lateIndex = metadata.count - 1
        XCTAssertThrowsError(
            try misScoped.sampleBuffer(atDecodeIndex: lateIndex),
            "a reader that lands on the wrong sample must fail, not index blindly"
        ) { error in
            guard
                let loadError = error as? StudioMediaLoadError,
                case .readFailed(let message) = loadError
            else {
                return XCTFail("expected StudioMediaLoadError.readFailed, got \(error)")
            }
            XCTAssertTrue(
                message.contains("scoped reader started at"),
                "the failure must name the scoped-reader identity mismatch, got: \(message)"
            )
        }

        // The wrong payload must not have been cached under the requested
        // index; a silent substitution is the outcome the guard exists to stop.
        XCTAssertEqual(
            misScoped.cacheCount,
            0,
            "no payload may be retained once the reader start is untrustworthy"
        )
    }
}
