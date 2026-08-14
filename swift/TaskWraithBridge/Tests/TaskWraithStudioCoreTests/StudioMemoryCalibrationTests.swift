import AVFoundation
import IOSurface
import Metal
import XCTest

@testable import TaskWraithStudioCore

/// The calibration that justifies outcome 11's dual-instrument design, as
/// EXECUTABLE CODE.
///
/// WHY THIS FILE EXISTS, and it is a correction. I originally measured this in a
/// throwaway file, deleted it, and left the numbers in a commit message and a
/// comment. @Challenge2 caught that: the single most consequential measurement
/// of the stress work could not be re-derived from the repository, so a durable
/// do-not-repeat rested on prose. A claim nobody can reproduce is a claim
/// nobody should have to believe.
///
/// AND MY ORIGINAL DISCRIMINATOR WAS AT THE WRONG LAYER. I checked
/// ObjectIdentifier on the MTLTexture to rule out "the source is recycling a
/// small set of buffers". But ObjectIdentifier identifies the WRAPPER;
/// VideoToolbox owns an internal CVPixelBuffer pool and any recycling happens
/// BELOW it. So the control could not have detected the confound it existed to
/// exclude — and worse, the confound and the finding produce the SAME reading:
/// if the surfaces had recycled, there would never have been 87 MB of distinct
/// pixel data and a ~2 MB footprint move is exactly what no blindness looks
/// like.
///
/// Re-measured here at IOSurface identity, which is the layer where recycling
/// would actually occur. The conclusion survived — but it had been believed for
/// an insufficient reason, which is its own defect.
final class StudioMemoryCalibrationTests: XCTestCase {
    /// Deliberately generous. These bounds are far apart because the point is
    /// the ORDER-OF-MAGNITUDE difference between the two allocation classes, not
    /// a precise figure; a tight bound would make this flaky without making it
    /// more informative.
    private let surfaceFrameCount = 200
    private let surfaceWidth = 640
    private let surfaceHeight = 480
    /// 200 x 640x480 4:2:0 is ~87 MB. If footprint tracked it we would see most
    /// of that; the threshold sits far below it and far above the noise floor.
    private let surfaceMaximumObservedMB = 25.0

    // MARK: - Control A: allocation classes stay distinct

    /// This used to allocate 64 MB and demand a cold-process footprint jump.
    /// That was a real observation, but process-global allocator reuse made the
    /// assertion order-dependent and could warm later tests. The verdict does
    /// not need another cold run: it needs an allocation-class-aware baseline
    /// that proves steady page metrics cannot conceal live malloc growth.
    func testAllocationClassVerdictRejectsWarmMallocGrowthWithoutPageGrowth() {
        let trend = StudioMemoryTrend(
            samples: [
                StudioMemoryReading(
                    footprintBytes: 200 * 1_048_576,
                    residentBytes: 160 * 1_048_576,
                    mallocInUseBytes: 20 * 1_048_576
                ),
                StudioMemoryReading(
                    footprintBytes: 200 * 1_048_576,
                    residentBytes: 160 * 1_048_576,
                    mallocInUseBytes: 52 * 1_048_576
                ),
                StudioMemoryReading(
                    footprintBytes: 200 * 1_048_576,
                    residentBytes: 160 * 1_048_576,
                    mallocInUseBytes: 84 * 1_048_576
                ),
            ],
            liveIOSurfaceIDSamples: [[], [], []]
        )

        XCTAssertEqual(trend.growthBytes, 0, "the page baseline must stay quiet")
        XCTAssertEqual(trend.mallocGrowthBytes, 64 * 1_048_576)
        XCTAssertFalse(
            trend.isStable(withinGrowthBytes: 24 * 1_048_576, surfaceCountLimit: 6),
            "the allocation-class verdict must reject malloc growth after page warm-up"
        )
    }

    // MARK: - Control B: and it is blind to surfaces

    /// THE MEASUREMENT THE WHOLE DUAL-INSTRUMENT DESIGN RESTS ON.
    ///
    /// The discriminator is IOSurface IDENTITY, not texture identity: it is the
    /// only layer at which VideoToolbox's pool could be recycling underneath us,
    /// and ruling that out is the entire reason the control exists.
    func testFootprintIsBlindToDistinctIOSurfaces() async throws {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device available on this machine")
        }
        let url = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try await StudioTestMedia.writeFlatMovie(
            lumaLevels: Array(repeating: 128, count: surfaceFrameCount),
            to: url,
            width: surfaceWidth,
            height: surfaceHeight
        )

        let loaded = try await StudioMediaSourceLoader.makeFrameSource(
            asset: StudioMediaAsset(assetId: "calibration", path: url.path),
            device: device,
            maxSampleCount: surfaceFrameCount * 2
        )
        // Warm first, so this measures RETENTION rather than first-use cost.
        _ = try? loaded.source.textures(forFrameIndex: 0)
        let before = try XCTUnwrap(StudioMemoryProbe.read())

        var retained: [StudioVideoFrameTextures] = []
        for frame in 0..<surfaceFrameCount {
            if let textures = try? loaded.source.textures(forFrameIndex: Int64(frame)) {
                retained.append(textures)
            }
        }
        let after = try XCTUnwrap(StudioMemoryProbe.read())

        // 1. The surfaces are genuinely distinct, checked where it matters.
        var surfaceIds: Set<UInt32> = []
        var withoutSurface = 0
        for frame in retained {
            if let surface = frame.luma.iosurface {
                surfaceIds.insert(IOSurfaceGetID(surface))
            } else {
                withoutSurface += 1
            }
        }
        XCTAssertEqual(retained.count, surfaceFrameCount, "fixture did not decode every frame")
        XCTAssertEqual(withoutSurface, 0, "a plane texture had no IOSurface — not zero-copy")
        XCTAssertEqual(
            surfaceIds.count,
            surfaceFrameCount,
            "VideoToolbox recycled surfaces, so this run holds far less than the expected "
                + "pixel data and CANNOT demonstrate blindness"
        )

        // 2. And the footprint barely moved against that much real memory.
        let expectedMegabytes =
            Double(surfaceWidth * surfaceHeight * 3 / 2 * surfaceFrameCount) / 1_048_576
        let delta = after.footprintMegabytes - before.footprintMegabytes
        XCTAssertGreaterThan(expectedMegabytes, 80, "fixture is too small to be informative")
        XCTAssertLessThan(
            delta,
            surfaceMaximumObservedMB,
            "footprint moved \(delta)MB for ~\(expectedMegabytes)MB of distinct surfaces — "
                + "if this ever fails, RSS has become a usable instrument for video memory "
                + "and the dual-instrument design should be revisited"
        )
        retained.removeAll()
    }

    // MARK: - The allocation-class verdict, measured with real surfaces

    /// This fixture retains real, distinct IOSurfaces. Page metrics can vary
    /// slightly by process history, but the integrated verdict must reject the
    /// live-set growth independently of that noise.
    func testAllocationClassVerdictRejectsAGrowingIOSurfaceLeak() async throws {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device available on this machine")
        }
        let url = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try await StudioTestMedia.writeFlatMovie(
            lumaLevels: Array(repeating: 128, count: 40),
            to: url,
            width: surfaceWidth,
            height: surfaceHeight
        )
        let loaded = try await StudioMediaSourceLoader.makeFrameSource(
            asset: StudioMediaAsset(assetId: "trend", path: url.path),
            device: device,
            maxSampleCount: 80
        )

        var leaked: [StudioVideoFrameTextures] = []
        var sampler = StudioMemorySampler(warmupCycles: 1)
        for cycle in 0..<8 {
            for frame in 0..<40 {
                if let textures = try? loaded.source.textures(forFrameIndex: Int64(frame)) {
                    leaked.append(textures)
                }
            }
            var liveSurfaceIDs: Set<UInt32> = []
            for frame in leaked {
                if let surface = frame.luma.iosurface {
                    liveSurfaceIDs.insert(IOSurfaceGetID(surface))
                }
            }
            sampler.record(cycle: cycle, liveIOSurfaceIDs: liveSurfaceIDs)
        }
        let trend = sampler.trend
        var surfaceIds: Set<UInt32> = []
        for frame in leaked {
            if let surface = frame.luma.iosurface { surfaceIds.insert(IOSurfaceGetID(surface)) }
        }

        // The leak is real and large.
        XCTAssertGreaterThan(surfaceIds.count, 100, "the leak fixture did not accumulate surfaces")
        // The separate footprint calibration above proves the page-metric blind
        // spot. This run contributes a real live IOSurface identity set to the
        // integrated verdict without assuming process-history-independent RSS.
        // The integrated allocation-class verdict closes the former blind spot.
        XCTAssertFalse(
            trend.isStable(
                withinGrowthBytes: 24 * 1_048_576,
                surfaceCountLimit: StudioVideoFrameSource.defaultReorderCacheDepth
            ),
            "growing live IOSurface identities must make the verdict unstable: \(trend.summaryText)"
        )
        XCTAssertTrue(
            trend.hasGrowingLiveIOSurfaceRetention
                || trend.peakLiveIOSurfaceCount > StudioVideoFrameSource.defaultReorderCacheDepth,
            "the fixture did not carry its live IOSurface evidence into the verdict"
        )
        leaked.removeAll()
    }
}
