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
    private let mallocMegabytes = 64
    private let mallocMinimumObservedMB = 40.0
    private let surfaceFrameCount = 200
    private let surfaceWidth = 640
    private let surfaceHeight = 480
    /// 200 x 640x480 4:2:0 is ~87 MB. If footprint tracked it we would see most
    /// of that; the threshold sits far below it and far above the noise floor.
    private let surfaceMaximumObservedMB = 25.0

    // MARK: - Control A: the probe works

    /// Without this the next test proves nothing: a footprint reading that never
    /// moves would "show blindness" to everything.
    func testFootprintTracksMallocClassAllocation() throws {
        let before = try XCTUnwrap(StudioMemoryProbe.read())
        var held: [UnsafeMutableRawPointer] = []
        for _ in 0..<mallocMegabytes {
            let bytes = 1_048_576
            let pointer = UnsafeMutableRawPointer.allocate(byteCount: bytes, alignment: 8)
            // Touched, or the pages are never faulted in and nothing is resident.
            memset(pointer, 1, bytes)
            held.append(pointer)
        }
        let after = try XCTUnwrap(StudioMemoryProbe.read())
        let delta = after.footprintMegabytes - before.footprintMegabytes
        for pointer in held { pointer.deallocate() }

        XCTAssertGreaterThan(
            delta,
            mallocMinimumObservedMB,
            "phys_footprint did not track \(mallocMegabytes)MB of touched malloc — "
                + "the probe itself is broken, so every other memory claim is void"
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

    // MARK: - The consequence, measured rather than asserted

    /// The half my earlier test only claimed in a comment: the memory TREND does
    /// not flag a surface leak. Measured by running the real sampler across
    /// cycles that accumulate surfaces, and showing it stays quiet while the
    /// surface count climbs.
    func testTheMemoryTrendDoesNotFlagAGrowingSurfaceLeak() async throws {
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
            sampler.record(cycle: cycle)
            _ = cycle
        }
        let trend = sampler.trend
        var surfaceIds: Set<UInt32> = []
        for frame in leaked {
            if let surface = frame.luma.iosurface { surfaceIds.insert(IOSurfaceGetID(surface)) }
        }

        // The leak is real and large.
        XCTAssertGreaterThan(surfaceIds.count, 100, "the leak fixture did not accumulate surfaces")
        // And the trend does not see it. THIS is why the resource count exists.
        XCTAssertFalse(
            trend.isMonotonicallyGrowing,
            "the memory trend DID flag a pure surface leak — if this fails, RSS is no longer "
                + "blind and the resource-count instrument may be redundant: \(trend.summaryText)"
        )
        leaked.removeAll()
    }
}
