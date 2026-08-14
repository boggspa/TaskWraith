import Metal
import XCTest

@testable import TaskWraithStudioCore

/// Regression cover for two defects found by adversarial review of already
/// landed, already independently verified code.
///
/// Both are worth understanding, because neither was catchable by the
/// verification that passed them:
///
/// 1. StudioViewerRenderer.attach(source:) invalidated the outgoing source but
///    did NOT flush the video renderer's in-flight ring, while detachSource()
///    did. Each method read as correct in isolation; only comparing them
///    exposes the asymmetry. The cost is up to inFlightRetentionDepth
///    IOSurface-backed buffers stranded per source switch, evicted only if the
///    NEW source happens to present that many frames — which is precisely
///    outcome 11's 20-source-switch case.
///
/// 2. StudioVideoDecoder reported hardware use based on which creation path
///    succeeded. EnableHardwareAcceleratedVideoDecoder is a HINT: VideoToolbox
///    may return a software session anyway. The diagnostic was an assumption
///    presented as a measurement.
final class StudioResourceLifetimeTests: XCTestCase {
    private func makeRenderer() throws -> StudioViewerRenderer {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device available on this machine")
        }
        return try StudioViewerRenderer(device: device)
    }

    /// The offscreen render path deliberately does not retain (it waits), so
    /// the ring is seeded the way the present path would fill it.
    private func fillRetentionRing(
        _ renderer: StudioViewerRenderer,
        from source: StudioVideoFrameSource
    ) throws {
        let textures = try source.textures(forFrameIndex: 0)
        for _ in 0..<StudioVideoFrameRenderer.inFlightRetentionDepth {
            renderer.videoRenderer.retain(textures)
        }
    }

    // MARK: - Defect 1: stranded surfaces on source switch

    func testSwitchingSourcesReleasesTheOldSessionsRetainedFrames() throws {
        let renderer = try makeRenderer()
        let first = try StudioTestMedia.makeFrameSource(
            lumaLevels: [32],
            device: renderer.device
        )
        renderer.attach(source: first)
        try fillRetentionRing(renderer, from: first)
        XCTAssertEqual(
            renderer.retainedFrameCount,
            StudioVideoFrameRenderer.inFlightRetentionDepth
        )

        let second = try StudioTestMedia.makeFrameSource(
            lumaLevels: [224],
            device: renderer.device
        )
        renderer.attach(source: second)

        XCTAssertEqual(
            renderer.retainedFrameCount,
            0,
            "switching sources must not strand the old session's IOSurface-backed frames"
        )
        XCTAssertFalse(first.isValid, "the replaced source must also be invalidated")
        XCTAssertTrue(second.isValid)
    }

    /// The control that makes the asymmetry explicit: detach and attach must
    /// leave the ring in the same state, or one of them is wrong.
    func testDetachAndSwitchLeaveTheRingEquallyEmpty() throws {
        let renderer = try makeRenderer()

        let detachSource = try StudioTestMedia.makeFrameSource(
            lumaLevels: [32],
            device: renderer.device
        )
        renderer.attach(source: detachSource)
        try fillRetentionRing(renderer, from: detachSource)
        renderer.detachSource()
        let afterDetach = renderer.retainedFrameCount

        let switchFrom = try StudioTestMedia.makeFrameSource(
            lumaLevels: [32],
            device: renderer.device
        )
        renderer.attach(source: switchFrom)
        try fillRetentionRing(renderer, from: switchFrom)
        renderer.attach(
            source: try StudioTestMedia.makeFrameSource(
                lumaLevels: [224],
                device: renderer.device
            )
        )
        let afterSwitch = renderer.retainedFrameCount

        XCTAssertEqual(afterDetach, 0)
        XCTAssertEqual(
            afterSwitch,
            afterDetach,
            "attach() and detachSource() must handle the in-flight ring identically"
        )
    }

    func testRepeatedSourceSwitchesDoNotAccumulateRetainedFrames() throws {
        let renderer = try makeRenderer()

        // Outcome 11 exercises 20 source switches; this is a bounded proxy for
        // the retention half of it. It measures no RSS and is not an outcome-11
        // claim, but unbounded growth here would be visible.
        for index in 0..<20 {
            let source = try StudioTestMedia.makeFrameSource(
                lumaLevels: [UInt8(32 + index * 8)],
                device: renderer.device
            )
            renderer.attach(source: source)
            try fillRetentionRing(renderer, from: source)
        }
        renderer.detachSource()

        XCTAssertEqual(renderer.retainedFrameCount, 0)
        XCTAssertEqual(renderer.diagnostics.retainedFrameCount, 0)
    }

    func testSourceCacheIOSurfacesAreBoundedAndClearedOnDetach() throws {
        let renderer = try makeRenderer()
        let source = try StudioTestMedia.makeFrameSource(
            lumaLevels: [32, 48, 64, 80, 96, 112, 128, 144],
            device: renderer.device
        )
        renderer.attach(source: source)

        for frame in 0..<8 {
            _ = try source.textures(forFrameIndex: Int64(frame))
        }

        XCTAssertLessThanOrEqual(
            source.liveIOSurfaceIDs.count,
            source.reorderCacheCapacity,
            "eviction must cap the source's live IOSurface set"
        )
        XCTAssertEqual(renderer.liveIOSurfaceIDs, source.liveIOSurfaceIDs)
        XCTAssertEqual(
            renderer.liveIOSurfaceCapacity,
            source.reorderCacheCapacity + StudioVideoFrameRenderer.inFlightRetentionDepth
        )

        renderer.detachSource()

        XCTAssertTrue(renderer.liveIOSurfaceIDs.isEmpty)
        XCTAssertEqual(renderer.liveIOSurfaceCapacity, 0)
    }

    func testViewerUnionsPrimaryProposedAndInFlightIOSurfaceSets() throws {
        let renderer = try makeRenderer()
        let primary = try StudioTestMedia.makeFrameSource(
            lumaLevels: [32, 64],
            device: renderer.device
        )
        let proposed = try StudioTestMedia.makeFrameSource(
            lumaLevels: [160, 224],
            device: renderer.device
        )
        let timebase = try XCTUnwrap(StudioTimebase(timescale: 30, frameDurationTicks: 1))

        renderer.attach(source: primary)
        renderer.attachProposed(
            source: proposed,
            assetId: "proposed",
            timebase: timebase
        )
        renderer.videoRenderer.retain(try primary.textures(forFrameIndex: 0))
        _ = try proposed.textures(forFrameIndex: 0)

        let expected = primary.liveIOSurfaceIDs
            .union(proposed.liveIOSurfaceIDs)
            .union(renderer.videoRenderer.liveIOSurfaceIDs)
        XCTAssertEqual(renderer.liveIOSurfaceIDs, expected)
        XCTAssertEqual(
            renderer.liveIOSurfaceCapacity,
            primary.reorderCacheCapacity
                + proposed.reorderCacheCapacity
                + StudioVideoFrameRenderer.inFlightRetentionDepth
        )

        renderer.detachProposedSource()

        XCTAssertEqual(renderer.liveIOSurfaceIDs, primary.liveIOSurfaceIDs)
        renderer.detachSource()
        XCTAssertTrue(renderer.liveIOSurfaceIDs.isEmpty)
        XCTAssertEqual(renderer.liveIOSurfaceCapacity, 0)
    }

    // MARK: - Defect 2: hardware diagnostic must be measured

    /// `.unknown` is the value the decoder holds when nothing has queried the
    /// session, so asserting it is NOT unknown is exactly the claim "we
    /// measured this" — and it is red against a decoder that only assumes.
    func testHardwareDecodeStatusIsMeasuredFromTheSession() throws {
        let encoded = try StudioTestMedia.encodeFlatFrames(lumaLevels: [128])
        let decoder = try StudioVideoDecoder(formatDescription: encoded.formatDescription)
        defer { decoder.invalidate() }

        XCTAssertNotEqual(
            decoder.hardwareDecodeStatus,
            .unknown,
            "hardware use must be read from the session, not inferred from which create succeeded"
        )
        XCTAssertTrue(
            decoder.hardwareDecodeStatus == .hardware || decoder.hardwareDecodeStatus == .software,
            "expected a definite measured status, got \(decoder.hardwareDecodeStatus)"
        )
    }

    func testFrameSourceDiagnosticsCarryTheMeasuredHardwareStatus() throws {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device available on this machine")
        }
        let source = try StudioTestMedia.makeFrameSource(lumaLevels: [128], device: device)
        defer { source.invalidate() }

        XCTAssertNotEqual(source.hardwareDecodeStatus, .unknown)
        XCTAssertEqual(source.diagnostics.hardwareDecodeStatus, source.hardwareDecodeStatus)
    }
}
