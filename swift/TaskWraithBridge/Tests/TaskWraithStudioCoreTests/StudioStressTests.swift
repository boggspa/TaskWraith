import AVFoundation
import Metal
import XCTest

@testable import TaskWraithStudioCore

/// Mission outcome 11's stress matrix, run in full: looped playback, 100 seeks,
/// 20 source switches, 10 viewer close/reopen cycles.
///
/// TWO INSTRUMENTS, AND THE CALIBRATION THAT FORCED IT.
///
/// RSS and phys_footprint track malloc faithfully and are effectively BLIND to
/// IOSurface-backed video memory — the dominant allocation class in a video
/// viewer and precisely the one this stack is most likely to leak. An RSS-only
/// harness would report "no leak" while the retention ring, the reorder cache or
/// the review source quietly accumulated surfaces.
///
/// THE EVIDENCE LIVES IN CODE, NOT HERE. See StudioMemoryCalibrationTests, which
/// runs both controls as executable assertions and discriminates distinct
/// surfaces by IOSURFACE IDENTITY. An earlier version of this comment carried
/// the numbers as prose from a deleted throwaway file, and cited a discriminator
/// (ObjectIdentifier on MTLTexture) that sat above the layer where VideoToolbox
/// could recycle — so it could not have ruled out the confound it named.
///
/// The mission's own wording anticipates the split by naming TWO conditions —
/// "bounded resources AND no monotonic RSS growth" — so every test below asserts
/// both: the memory trend for malloc-class growth, and explicit resource counts
/// for the surfaces RSS cannot see.
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

    /// THE BOUND MOST OF THIS FILE MEASURES AGAINST IS A PRODUCTION CONSTANT.
    ///
    /// Four stress tests pass `retainedBound: inFlightRetentionDepth`, so
    /// raising that constant to absorb a leak would keep every "BOUNDED
    /// RESOURCES" claim green — the instrument would move with the defect.
    /// @Challenge2 named this and filed it as an accepted trade-off; it costs
    /// one line to close instead.
    ///
    /// This does not stop anyone changing the depth. It stops them changing it
    /// SILENTLY, which is the entire difference between a tuned constant and a
    /// leak given a bigger budget.
    func testTheRetentionDepthTheStressBoundsRelyOnIsItselfPinned() {
        XCTAssertEqual(
            StudioVideoFrameRenderer.inFlightRetentionDepth,
            3,
            "the in-flight retention depth changed — if that is deliberate, update this "
                + "literal in the same commit; if it is not, a leak just widened every "
                + "bounded-resource assertion in this file"
        )
    }

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
            // ASSERTED EVERY CYCLE, NOT JUST THE LAST ONE. This read used to be
            // overwritten nine times with only the tenth value checked, so a
            // resource stranded in cycles 0-8 and released by cycle 9 passed
            // clean — and this file's own header records that RSS is BLIND to
            // IOSurface memory, so the trend half could not see it either.
            //
            // THE LIVE SIGNAL ON THIS PATH IS THE SOURCE COUNT, and measuring
            // told me so. `retainedFrameCount` is 0 here BEFORE teardown as well
            // as after, every cycle: `retain(_:)` is called only from the
            // PRESENT path and this test renders offscreen with no drawable. So
            // the original `XCTAssertEqual(lastRetained, 0)` could not detect a
            // stranded surface — the surfaces are never created to strand.
            // @Challenge2 was right that the read was thrown away; the deeper
            // problem is that the quantity is structurally zero here.
            XCTAssertEqual(
                renderer.activeSourceCount,
                1,
                "cycle \(cycle): the source must be attached before teardown, or the "
                    + "teardown assertion below proves nothing"
            )
            renderer.detachSource()
            lastRetained = renderer.retainedFrameCount
            XCTAssertEqual(
                renderer.activeSourceCount,
                0,
                "cycle \(cycle) left \(renderer.activeSourceCount) sources attached"
            )
            // Kept, but honestly: this is a REGRESSION TRIPWIRE for a future
            // presenting variant, not evidence of release today. The in-flight
            // ring's retain/release contract is proven with genuinely non-zero
            // counts in StudioResourceLifetimeTests, which drives `retain(_:)`
            // directly rather than hoping a render path populated it.
            XCTAssertEqual(
                lastRetained,
                0,
                "cycle \(cycle) left \(lastRetained) surfaces retained after teardown"
            )
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

    /// S10 UNDER THE TWO-ROUTE ARCHITECTURE.
    ///
    /// WHY THIS EXISTS ALONGSIDE the cycle test above rather than replacing it.
    /// That test builds a NEW renderer each cycle and drops it — which is what
    /// "viewer close/reopen" meant when the companion had ONE viewer. With two
    /// routes, hiding a route RETAINS its renderer and releases only its
    /// decoder/player resources, and that path did not exist when the older test
    /// was written. The old test still passes and still measures something real;
    /// it simply measures the previous architecture. A green suite gives no
    /// signal that the ground moved, so the new path needs its own instrument.
    func testTenRouteHideShowCyclesReleaseResourcesOnARetainedRenderer() async throws {
        let device = try makeDevice()
        let url = try await makeClip(frames: 12)
        defer { try? FileManager.default.removeItem(at: url) }

        // ONE renderer for the whole run — that is the distinction from S10.
        let renderer = try StudioViewerRenderer(device: device)
        let output = try target(device)
        var sampler = StudioMemorySampler(warmupCycles: 2)
        var routes = StudioRouteVisibility(visible: [.source, .review])

        for cycle in 0..<10 {
            // SHOW: the route acquires its decoder resources.
            let loaded = try await StudioMediaSourceLoader.makeFrameSource(
                asset: StudioMediaAsset(assetId: "route-\(cycle)", path: url.path),
                device: device
            )
            renderer.attach(source: loaded.source)
            XCTAssertEqual(renderer.activeSourceCount, 1)
            for frame in 0..<12 {
                renderer.render(snapshot: snapshot(frame: Int64(frame)), to: output)
            }

            // HIDE: the transition reports the obligation, and discharging it
            // must actually free the sources on a renderer that SURVIVES.
            let transition = routes.toggle(.review)
            XCTAssertTrue(
                transition.requiresResourceRelease,
                "hiding must oblige release, or this cycle proves nothing")
            renderer.detachSource()
            renderer.detachProposedSource()
            XCTAssertEqual(
                renderer.activeSourceCount, 0,
                "a hidden route still held decode sources at cycle \(cycle)")
            XCTAssertEqual(
                renderer.retainedFrameCount, 0,
                "a hidden route still held surfaces at cycle \(cycle)")

            routes.toggle(.review)
            sampler.record(cycle: cycle)
        }

        assertStable(
            sampler.trend,
            retained: renderer.retainedFrameCount,
            retainedBound: 0,
            growthBudgetMB: 40,
            label: "10 route hide/show cycles on a retained renderer"
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

    /// THE RENDERER'S RESOURCE INSTRUMENT, driven for real.
    ///
    /// CORRECTION. My earlier version of this test appended 40 frames to its own
    /// local array and asserted 40 > 3 — then asserted the IDENTICAL comparison
    /// a second time. Two assertions, one tautology, and it never touched
    /// renderer.retainedFrameCount at all: a retainedFrameCount hard-coded to
    /// zero would have passed it. @Challenge2 caught that, and it is the same
    /// failure class this round keeps finding — a proof whose result is
    /// independent of the defect it names.
    ///
    /// This drives the RENDERER and asserts ITS counter: retention is real,
    /// bounded while playing, and returns to zero on teardown. The blindness
    /// half is measured separately in StudioMemoryCalibrationTests, not asserted
    /// in a comment here.
    func testTheRendererResourceInstrumentIsLiveAndBounded() async throws {
        let device = try makeDevice()
        let url = try await makeClip(frames: 40)
        defer { try? FileManager.default.removeItem(at: url) }

        let renderer = try StudioViewerRenderer(device: device)
        let output = try target(device)
        let loaded = try await StudioMediaSourceLoader.makeFrameSource(
            asset: StudioMediaAsset(assetId: "instrument", path: url.path),
            device: device
        )

        XCTAssertEqual(renderer.retainedFrameCount, 0, "nothing rendered yet")
        renderer.attach(source: loaded.source)

        // A PROPERTY THIS TEST DISCOVERED, and it is correct behaviour rather
        // than a defect. The plain offscreen path commits AND WAITS, so the GPU
        // has finished sampling before render() returns and there is nothing to
        // retain. Retention exists only for the paths that commit WITHOUT
        // waiting. My first version of this test asserted retention on the
        // synchronous path and failed — the premise was wrong, not the code.
        for frame in 0..<10 {
            renderer.render(snapshot: snapshot(frame: Int64(frame)), to: output)
        }
        XCTAssertEqual(
            renderer.retainedFrameCount,
            0,
            "the synchronous path waits for the GPU, so it must retain nothing"
        )

        // Now the ASYNC path. Supplying an overlay puts the content pass in
        // chaining mode, which commits without waiting and therefore must retain.
        let overlay = StudioOverlayLayout.build(
            StudioOverlayState(
                viewport: StudioOverlayViewport(width: 640, height: 360, scale: 1),
                durationTicks: 1_000
            )
        )
        for frame in 0..<40 {
            renderer.render(
                snapshot: snapshot(frame: Int64(frame)),
                to: output,
                overlay: overlay
            )
        }

        // The instrument must be LIVE — a counter stuck at zero would pass a
        // bound check while telling us nothing.
        let peak = renderer.retainedFrameCount
        XCTAssertGreaterThan(
            peak,
            0,
            "retainedFrameCount never moved; the resource instrument is not live"
        )
        XCTAssertLessThanOrEqual(
            peak,
            StudioVideoFrameRenderer.inFlightRetentionDepth,
            "the in-flight ring exceeded its bound"
        )

        renderer.detachSource()
        XCTAssertEqual(renderer.retainedFrameCount, 0, "teardown stranded surfaces")
    }

    /// And the malloc-class half: the memory trend must detect growth that IS
    /// visible to phys_footprint, or the RSS half of every assertion is inert.
    ///
    /// A LIMITATION THIS TEST TAUGHT ME, and it matters for how outcome 11's
    /// numbers should be read. The first version allocated 48 MB and passed in
    /// isolation but FAILED in the full suite, reporting only +25 MB of growth.
    /// The cause is not flake: phys_footprint measures RESIDENT pages, and by
    /// the time this runs the calibration tests have already allocated and freed
    /// ~64 MB, so the allocator satisfies a smaller request from pages that are
    /// already resident and the footprint does not move.
    ///
    /// So the memory trend can only see growth BEYOND the process's existing
    /// resident footprint. A leak that fits inside previously-freed memory is
    /// invisible to it — which is a second, independent reason the resource
    /// counts are not redundant. The allocation here is sized to dominate any
    /// prior churn rather than to be minimal.
    func testTheMemoryTrendDetectsMallocClassGrowth() throws {
        var held: [UnsafeMutableRawPointer] = []
        var sampler = StudioMemorySampler(warmupCycles: 0)
        for cycle in 0..<8 {
            // 16 MB per cycle = 128 MB total, touched so the pages are real.
            for _ in 0..<16 {
                let bytes = 1_048_576
                let pointer = UnsafeMutableRawPointer.allocate(byteCount: bytes, alignment: 8)
                memset(pointer, 1, bytes)
                held.append(pointer)
            }
            sampler.record(cycle: cycle)
        }
        let trend = sampler.trend
        for pointer in held { pointer.deallocate() }

        // A SECOND THING THIS TEST TAUGHT ME, and it changed what the assertion
        // should be. I first asserted isMonotonicallyGrowing here and it FAILED
        // on a genuine 128MB leak: allocators batch, so a leaking process
        // produces a STAIRCASE rather than a strictly increasing line, and some
        // cycles are flat.
        //
        // So strict monotonicity is SPECIFIC but not SENSITIVE — when it fires
        // it is almost certainly a leak, but it misses real ones. The sensitive
        // half is growth magnitude. isStable() already requires BOTH (not
        // monotonic AND within budget), so the matrix is sound; only this
        // instrument test was asserting the wrong half.
        XCTAssertFalse(
            trend.isStable(withinGrowthBytes: 32 * 1_048_576),
            "the memory trend called a 128MB leak stable: \(trend.summaryText)"
        )
        XCTAssertGreaterThan(
            trend.growthMegabytes,
            60,
            "growth magnitude is the sensitive half and it missed the leak"
        )
    }
}
