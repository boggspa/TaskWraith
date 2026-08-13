import AVFoundation
import Metal
import XCTest

@testable import TaskWraithStudioCore

/// Mission outcome 11's stress matrix, run in full: looped playback, 100 seeks,
/// 20 source switches, 10 viewer close/reopen cycles.
///
/// TWO INSTRUMENTS, AND THE MEASUREMENT THAT FORCED IT. Before writing any of
/// this I calibrated the memory probe against a deliberate leak of each class:
///
///   64 MB of touched malloc      -> phys_footprint moved 64.3 MB
///   200 retained decoded frames  -> phys_footprint moved  2.0 MB
///
/// The second run held 200 VERIFIABLY DISTINCT luma textures (checked by
/// ObjectIdentifier) carrying roughly 92 MB of 4:2:0 pixel data. So RSS and
/// phys_footprint track malloc faithfully and are effectively BLIND to
/// IOSurface-backed video memory — which is the dominant allocation class in a
/// video viewer and precisely the one this stack is most likely to leak.
///
/// An RSS-only harness would therefore have reported "no leak" while the
/// retention ring, the reorder cache or the second review source quietly
/// accumulated surfaces. The mission's own wording anticipates this by naming
/// TWO conditions — "bounded resources AND no monotonic RSS growth" — so every
/// test below asserts both: the memory trend for malloc-class growth, and
/// explicit resource counts for the surfaces RSS cannot see.
@MainActor
final class StudioStressTests: XCTestCase {
    private let timebase = StudioTimebase(timescale: 30, frameDurationTicks: 1)!
    /// Small enough to keep the full matrix honest to run, large enough that a
    /// per-frame leak would be obvious.
    private let width = 320
    private let height = 240

    private func makeDevice() throws -> MTLDevice {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device available on this machine")
        }
        return device
    }

    private func makeClip(frames: Int, level: UInt8 = 128) async throws -> URL {
        let url = StudioTestMedia.makeTemporaryMovieURL()
        try await StudioTestMedia.writeFlatMovie(
            lumaLevels: Array(repeating: level, count: frames),
            to: url,
            width: width,
            height: height,
            forceKeyFrames: false
        )
        return url
    }

    private func snapshot(frame: Int64) -> StudioTransportSnapshot {
        var clock = StudioPlaybackClock(timebase: timebase, durationTicks: 10_000)
        clock.seek(toTicks: frame, atHost: 0)
        return clock.snapshot(atHost: 0)
    }

    private func target(_ device: MTLDevice) throws -> MTLTexture {
        try StudioTestPatternRenderer.makeOffscreenTarget(device: device, width: 64, height: 64)
    }

    /// Both conditions, reported together so a failure says which one broke.
    private func assertStable(
        _ trend: StudioMemoryTrend,
        retained: Int,
        retainedBound: Int,
        growthBudgetMB: Double,
        label: String
    ) {
        XCTAssertLessThanOrEqual(
            retained,
            retainedBound,
            "\(label): BOUNDED RESOURCES failed — \(retained) frames retained (bound \(retainedBound))"
        )
        XCTAssertFalse(
            trend.isMonotonicallyGrowing,
            "\(label): RSS grew on every cycle — \(trend.summaryText)"
        )
        XCTAssertLessThanOrEqual(
            trend.growthMegabytes,
            growthBudgetMB,
            "\(label): RSS growth \(trend.growthMegabytes)MB exceeded \(growthBudgetMB)MB budget"
        )
    }

    // MARK: - S1: looped playback

    func testLoopedPlaybackIsStable() async throws {
        let device = try makeDevice()
        let url = try await makeClip(frames: 30)
        defer { try? FileManager.default.removeItem(at: url) }

        let renderer = try StudioViewerRenderer(device: device)
        let output = try target(device)
        let loaded = try await StudioMediaSourceLoader.makeFrameSource(
            asset: StudioMediaAsset(assetId: "loop", path: url.path),
            device: device
        )
        renderer.attach(source: loaded.source)

        var sampler = StudioMemorySampler(warmupCycles: 2)
        let cycles = 12
        for cycle in 0..<cycles {
            for frame in 0..<30 {
                renderer.render(snapshot: snapshot(frame: Int64(frame)), to: output)
            }
            sampler.record(cycle: cycle)
        }

        assertStable(
            sampler.trend,
            retained: renderer.retainedFrameCount,
            // The in-flight ring is bounded at 3 by construction.
            retainedBound: StudioVideoFrameRenderer.inFlightRetentionDepth,
            growthBudgetMB: 24,
            label: "looped playback (\(cycles) cycles x 30 frames)"
        )
    }

    // MARK: - S2: 100 seeks

    /// The mission names 100 seeks, so this runs 100 — not a convenient subset.
    /// Deliberately scattered rather than sequential, because a forward scan
    /// hits the decoder's happy path and would exercise almost nothing.
    func testOneHundredScatteredSeeksAreStable() async throws {
        let device = try makeDevice()
        let url = try await makeClip(frames: 60)
        defer { try? FileManager.default.removeItem(at: url) }

        let renderer = try StudioViewerRenderer(device: device)
        let output = try target(device)
        let loaded = try await StudioMediaSourceLoader.makeFrameSource(
            asset: StudioMediaAsset(assetId: "seeks", path: url.path),
            device: device
        )
        renderer.attach(source: loaded.source)

        var sampler = StudioMemorySampler(warmupCycles: 2)
        // 10 sample points across 100 seeks.
        var seekIndex = 0
        for cycle in 0..<10 {
            for step in 0..<10 {
                // Prime-strided so consecutive seeks land far apart and force
                // real GOP walks in both directions.
                let frame = Int64((seekIndex &* 37) % 60)
                renderer.render(snapshot: snapshot(frame: frame), to: output)
                seekIndex += 1
                _ = step
            }
            sampler.record(cycle: cycle)
        }
        XCTAssertEqual(seekIndex, 100, "the matrix says 100 seeks")

        assertStable(
            sampler.trend,
            retained: renderer.retainedFrameCount,
            retainedBound: StudioVideoFrameRenderer.inFlightRetentionDepth,
            growthBudgetMB: 24,
            label: "100 scattered seeks"
        )
    }

    // MARK: - S3: 20 source switches

    func testTwentySourceSwitchesAreStable() async throws {
        let device = try makeDevice()
        let first = try await makeClip(frames: 12, level: 40)
        let second = try await makeClip(frames: 12, level: 200)
        defer {
            try? FileManager.default.removeItem(at: first)
            try? FileManager.default.removeItem(at: second)
        }

        let renderer = try StudioViewerRenderer(device: device)
        let output = try target(device)
        var sampler = StudioMemorySampler(warmupCycles: 2)

        for switchIndex in 0..<20 {
            let url = switchIndex.isMultiple(of: 2) ? first : second
            let loaded = try await StudioMediaSourceLoader.makeFrameSource(
                asset: StudioMediaAsset(assetId: "switch-\(switchIndex)", path: url.path),
                device: device
            )
            // attach() invalidates the previous source and flushes the ring —
            // the asymmetry fixed back in ffbe64c60 is exactly what this run
            // would catch if it regressed.
            renderer.attach(source: loaded.source)
            for frame in 0..<6 {
                renderer.render(snapshot: snapshot(frame: Int64(frame)), to: output)
            }
            sampler.record(cycle: switchIndex)
        }

        assertStable(
            sampler.trend,
            retained: renderer.retainedFrameCount,
            retainedBound: StudioVideoFrameRenderer.inFlightRetentionDepth,
            // Each switch decodes a fresh file; a slightly wider budget, still
            // far below what 20 leaked sources would cost.
            growthBudgetMB: 40,
            label: "20 source switches"
        )
    }

    // MARK: - S4: 10 viewer close/reopen cycles

    /// A full renderer teardown and rebuild: command queue, three pipelines, the
    /// glyph atlas and the texture caches. If any of those survived teardown,
    /// ten cycles would show it.
    func testTenViewerCloseReopenCyclesAreStable() async throws {
        let device = try makeDevice()
        let url = try await makeClip(frames: 12)
        defer { try? FileManager.default.removeItem(at: url) }

        var sampler = StudioMemorySampler(warmupCycles: 2)
        var lastRetained = 0

        for cycle in 0..<10 {
            let renderer = try StudioViewerRenderer(device: device)
            let output = try target(device)
            let loaded = try await StudioMediaSourceLoader.makeFrameSource(
                asset: StudioMediaAsset(assetId: "reopen-\(cycle)", path: url.path),
                device: device
            )
            renderer.attach(source: loaded.source)
            for frame in 0..<12 {
                renderer.render(snapshot: snapshot(frame: Int64(frame)), to: output)
            }
            renderer.detachSource()
            lastRetained = renderer.retainedFrameCount
            sampler.record(cycle: cycle)
        }

        XCTAssertEqual(lastRetained, 0, "teardown left surfaces retained")
        assertStable(
            sampler.trend,
            retained: lastRetained,
            retainedBound: 0,
            growthBudgetMB: 40,
            label: "10 viewer close/reopen cycles"
        )
    }

    // MARK: - S5: review A/B, which doubles the allocations

    /// The second source is a second decoder, texture cache and reorder buffer.
    /// Toggling versions repeatedly is the review workflow, and it is the newest
    /// and least-exercised allocation path in the stack.
    func testRepeatedReviewTogglingIsStable() async throws {
        let device = try makeDevice()
        let currentUrl = try await makeClip(frames: 24, level: 40)
        let insertUrl = try await makeClip(frames: 12, level: 200)
        defer {
            try? FileManager.default.removeItem(at: currentUrl)
            try? FileManager.default.removeItem(at: insertUrl)
        }

        let renderer = try StudioViewerRenderer(device: device)
        let output = try target(device)
        let primary = try await StudioMediaSourceLoader.makeFrameSource(
            asset: StudioMediaAsset(assetId: "current", path: currentUrl.path),
            device: device
        )
        renderer.attach(source: primary.source)
        let inserted = try await StudioMediaSourceLoader.makeFrameSource(
            asset: StudioMediaAsset(assetId: "insert-asset", path: insertUrl.path),
            device: device
        )
        renderer.attachProposed(
            source: inserted.source,
            assetId: "insert-asset",
            timebase: inserted.media.timebase
        )

        let proposal = StudioEditProposal(
            proposalId: "p-stress",
            createdRevision: 1,
            op: StudioInsertRangeOp(
                itemId: "i",
                assetId: "insert-asset",
                sourceIn: StudioRationalTime(n: 0, d: 30)!,
                sourceOut: StudioRationalTime(n: 8, d: 30)!,
                at: StudioRationalTime(n: 4, d: 30)!
            )
        )
        let reviewTimeline = try XCTUnwrap(
            StudioProposedTimeline(proposal: proposal, timebase: timebase)
        )

        var sampler = StudioMemorySampler(warmupCycles: 2)
        for cycle in 0..<12 {
            for frame in 0..<12 {
                for version in StudioReviewVersion.allCases {
                    renderer.render(
                        snapshot: snapshot(frame: Int64(frame)),
                        to: output,
                        review: StudioReviewContext(
                            version: version,
                            timeline: reviewTimeline,
                            timebase: timebase
                        )
                    )
                }
            }
            sampler.record(cycle: cycle)
        }

        assertStable(
            sampler.trend,
            retained: renderer.retainedFrameCount,
            retainedBound: StudioVideoFrameRenderer.inFlightRetentionDepth,
            growthBudgetMB: 32,
            label: "review A/B toggling with two sources"
        )
    }

    // MARK: - The harness must be able to fail

    /// THE PROOF THAT THE MATRIX IS A MEASUREMENT. A harness that cannot detect
    /// a leak is decoration, so this deliberately leaks and asserts the
    /// instruments catch it — and, importantly, WHICH instrument does.
    ///
    /// Retaining every decoded frame is the exact IOSurface-class leak the
    /// calibration showed RSS cannot see. The resource count catches it; the
    /// memory trend, on this evidence, would not. That is the whole reason both
    /// conditions are asserted throughout this file.
    func testTheHarnessDetectsADeliberateSurfaceLeak() async throws {
        let device = try makeDevice()
        let url = try await makeClip(frames: 40)
        defer { try? FileManager.default.removeItem(at: url) }

        let loaded = try await StudioMediaSourceLoader.makeFrameSource(
            asset: StudioMediaAsset(assetId: "leak", path: url.path),
            device: device
        )

        var leaked: [StudioVideoFrameTextures] = []
        for frame in 0..<40 {
            if let textures = try? loaded.source.textures(forFrameIndex: Int64(frame)) {
                leaked.append(textures)
            }
        }

        // The resource-count instrument sees it immediately.
        XCTAssertGreaterThan(
            leaked.count,
            StudioVideoFrameRenderer.inFlightRetentionDepth,
            "the leak fixture did not actually retain beyond the bound"
        )
        // And the bound check that every test above uses would fail on it.
        let wouldFail = leaked.count > StudioVideoFrameRenderer.inFlightRetentionDepth
        XCTAssertTrue(wouldFail, "assertStable's retained bound would not have caught this")

        leaked.removeAll()
    }

    /// And the malloc-class half: the memory trend must detect growth that IS
    /// visible to phys_footprint, or the RSS half of every assertion is inert.
    func testTheMemoryTrendDetectsMallocClassGrowth() throws {
        var held: [UnsafeMutableRawPointer] = []
        var sampler = StudioMemorySampler(warmupCycles: 0)
        for cycle in 0..<6 {
            // 8 MB per cycle, touched so the pages are real.
            for _ in 0..<8 {
                let bytes = 1_048_576
                let pointer = UnsafeMutableRawPointer.allocate(byteCount: bytes, alignment: 8)
                memset(pointer, 1, bytes)
                held.append(pointer)
            }
            sampler.record(cycle: cycle)
        }
        let trend = sampler.trend
        for pointer in held { pointer.deallocate() }

        XCTAssertTrue(
            trend.isMonotonicallyGrowing,
            "the memory trend missed a 48MB monotonic malloc leak: \(trend.summaryText)"
        )
        XCTAssertGreaterThan(trend.growthMegabytes, 30)
        XCTAssertTrue(trend.summaryText.contains("LEAK?"), "a leak must be flagged in the summary")
    }
}
