import AVFoundation
import Metal
import XCTest

@testable import TaskWraithStudioCore

/// Current/Proposed A/B as TWO REAL PICTURES (mission outcome 3).
///
/// Everything before this slice was geometry: the ripple mapping said WHICH
/// material belongs at a review position, and the ghost said where it sits on
/// the scrub bar. Neither put a second picture on screen. The assertion that
/// matters here is that toggling the version at ONE position renders visibly
/// different pixels — and that it does NOT when the proposal changes nothing
/// there, because an A/B that always differs is as useless as one that never
/// does.
@MainActor
final class StudioReviewAbTests: XCTestCase {
    private let timebase = StudioTimebase(timescale: 30, frameDurationTicks: 1)!
    private let size = 128

    private func rational(_ n: Int64) -> StudioRationalTime { StudioRationalTime(n: n, d: 30)! }

    private func makeDevice() throws -> MTLDevice {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device available on this machine")
        }
        return device
    }

    /// Inserts source 0..2 of the proposal's asset at sequence position 2.
    private func timeline(assetId: String = "insert-asset") throws -> StudioProposedTimeline {
        let proposal = StudioEditProposal(
            proposalId: "p-1",
            createdRevision: 2,
            op: StudioInsertRangeOp(
                itemId: "i-1",
                assetId: assetId,
                sourceIn: rational(0),
                sourceOut: rational(2),
                at: rational(2)
            )
        )
        return try XCTUnwrap(StudioProposedTimeline(proposal: proposal, timebase: timebase))
    }

    private func snapshot(ticks: Int64) -> StudioTransportSnapshot {
        var clock = StudioPlaybackClock(timebase: timebase, durationTicks: 1_000)
        clock.seek(toTicks: ticks, atHost: 0)
        return clock.snapshot(atHost: 0)
    }

    private func green(_ texture: MTLTexture) throws -> Int {
        Int(try StudioTestPatternRenderer.readPixel(from: texture, x: 64, y: 64).green)
    }

    // MARK: - The A/B itself

    /// THE ASSERTION THAT CLOSES OUTCOME 3. Same review position, two versions,
    /// two genuinely different decoded pictures from two different files.
    func testTogglingVersionRendersDifferentPicturesFromTwoSources() async throws {
        let device = try makeDevice()
        let currentUrl = StudioTestMedia.makeTemporaryMovieURL()
        let insertUrl = StudioTestMedia.makeTemporaryMovieURL()
        defer {
            try? FileManager.default.removeItem(at: currentUrl)
            try? FileManager.default.removeItem(at: insertUrl)
        }
        // Deliberately far apart in brightness so "different picture" is not a
        // judgement call about a few code values.
        try await StudioTestMedia.writeFlatMovie(lumaLevels: [16, 16, 16, 16], to: currentUrl)
        try await StudioTestMedia.writeFlatMovie(lumaLevels: [235, 235], to: insertUrl)

        let renderer = try StudioViewerRenderer(device: device)
        let target = try StudioTestPatternRenderer.makeOffscreenTarget(
            device: device,
            width: size,
            height: size
        )

        let primary = try await StudioMediaSourceLoader.makeFrameSource(
            asset: StudioMediaAsset(assetId: "current-asset", path: currentUrl.path),
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
        XCTAssertEqual(renderer.activeSourceCount, 2, "cross-asset review retains two sources")

        let reviewTimeline = try timeline()
        // Sequence tick 2 is the first frame of the insert in PROPOSED, and
        // ordinary existing material in CURRENT.
        let position = snapshot(ticks: 2)

        let currentOutcome = renderer.render(
            snapshot: position,
            to: target,
            review: StudioReviewContext(
                version: .current,
                timeline: reviewTimeline,
                timebase: timebase
            )
        )
        XCTAssertTrue(currentOutcome.didDraw, "current version drew nothing: \(currentOutcome)")
        let currentGreen = try green(target)

        let proposedOutcome = renderer.render(
            snapshot: position,
            to: target,
            review: StudioReviewContext(
                version: .proposed,
                timeline: reviewTimeline,
                timebase: timebase
            )
        )
        XCTAssertTrue(proposedOutcome.didDraw, "proposed version drew nothing: \(proposedOutcome)")
        let proposedGreen = try green(target)

        XCTAssertGreaterThan(
            abs(proposedGreen - currentGreen),
            60,
            "A/B rendered the same picture for both versions (\(currentGreen) vs \(proposedGreen))"
        )
        XCTAssertGreaterThan(proposedGreen, currentGreen, "the inserted clip is the brighter one")
    }

    /// An insertion from the asset already open in Source must reuse the
    /// resident primary decoder. Creating a second decoder for the same file
    /// wastes resources; refusing it leaves the canonical trim/reinsert review
    /// blank. The affected range must draw a different source-time picture,
    /// while unaffected material stays identical.
    func testSameAssetInsertRendersFromTheResidentPrimarySource() async throws {
        let device = try makeDevice()
        let currentUrl = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: currentUrl) }
        try await StudioTestMedia.writeFlatMovie(
            lumaLevels: [16, 80, 160, 235],
            to: currentUrl
        )

        let renderer = try StudioViewerRenderer(device: device)
        let target = try StudioTestPatternRenderer.makeOffscreenTarget(
            device: device,
            width: size,
            height: size
        )
        let primary = try await StudioMediaSourceLoader.makeFrameSource(
            asset: StudioMediaAsset(assetId: "current-asset", path: currentUrl.path),
            device: device
        )
        renderer.attach(
            source: primary.source,
            assetId: "current-asset",
            timebase: primary.media.timebase
        )
        let reviewTimeline = try timeline(assetId: "current-asset")

        let currentOutcome = renderer.render(
            snapshot: snapshot(ticks: 2),
            to: target,
            review: StudioReviewContext(
                version: .current,
                timeline: reviewTimeline,
                timebase: timebase
            )
        )
        XCTAssertTrue(currentOutcome.didDraw, "current version drew nothing: \\(currentOutcome)")
        let currentGreen = try green(target)

        let proposedOutcome = renderer.render(
            snapshot: snapshot(ticks: 2),
            to: target,
            review: StudioReviewContext(
                version: .proposed,
                timeline: reviewTimeline,
                timebase: timebase
            )
        )
        XCTAssertTrue(
            proposedOutcome.didDraw,
            "same-asset insertion must not be unavailable: \\(proposedOutcome)"
        )
        let proposedGreen = try green(target)
        XCTAssertGreaterThan(
            abs(proposedGreen - currentGreen),
            60,
            "the affected range must show the inserted source-time picture"
        )
        XCTAssertEqual(renderer.activeSourceCount, 1, "same-asset review must reuse the primary source")

        let outsideOutcome = renderer.render(
            snapshot: snapshot(ticks: 1),
            to: target,
            review: StudioReviewContext(
                version: .proposed,
                timeline: reviewTimeline,
                timebase: timebase
            )
        )
        XCTAssertTrue(outsideOutcome.didDraw)
        let proposedOutsideGreen = try green(target)
        renderer.render(
            snapshot: snapshot(ticks: 1),
            to: target,
            review: StudioReviewContext(
                version: .current,
                timeline: reviewTimeline,
                timebase: timebase
            )
        )
        XCTAssertEqual(try green(target), proposedOutsideGreen, "unaffected material must stay identical")
    }

    /// The other half, and it is not optional. Outside the affected range the
    /// two versions show the SAME material, so an A/B must be visibly inert
    /// there. A Review viewer that always shows a difference is telling the
    /// reviewer that every frame changed.
    func testOutsideTheAffectedRangeBothVersionsShowTheSameMaterial() async throws {
        let device = try makeDevice()
        let currentUrl = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: currentUrl) }
        try await StudioTestMedia.writeFlatMovie(lumaLevels: [16, 80, 160, 235], to: currentUrl)

        let renderer = try StudioViewerRenderer(device: device)
        let target = try StudioTestPatternRenderer.makeOffscreenTarget(
            device: device,
            width: size,
            height: size
        )
        let primary = try await StudioMediaSourceLoader.makeFrameSource(
            asset: StudioMediaAsset(assetId: "current-asset", path: currentUrl.path),
            device: device
        )
        renderer.attach(source: primary.source)

        let reviewTimeline = try timeline()
        // Tick 1 is BEFORE the insertion point at 2.
        let position = snapshot(ticks: 1)

        renderer.render(
            snapshot: position,
            to: target,
            review: StudioReviewContext(
                version: .current,
                timeline: reviewTimeline,
                timebase: timebase
            )
        )
        let currentGreen = try green(target)

        renderer.render(
            snapshot: position,
            to: target,
            review: StudioReviewContext(
                version: .proposed,
                timeline: reviewTimeline,
                timebase: timebase
            )
        )
        XCTAssertEqual(try green(target), currentGreen, "versions must match outside the insert")
        XCTAssertFalse(
            StudioReviewRouter.versionsDiffer(atTicks: 1, timeline: reviewTimeline),
            "the router must agree there is nothing to compare here"
        )
        XCTAssertTrue(StudioReviewRouter.versionsDiffer(atTicks: 2, timeline: reviewTimeline))
    }

    /// THE HONEST REFUSAL. A proposal may insert material from an asset the
    /// viewer has never opened. Nothing is drawn, and the reason names the
    /// asset — a neighbouring frame here would show a comparison that does not
    /// exist.
    func testMaterialWithNoAttachedSourceDrawsNothingAndSaysWhy() async throws {
        let device = try makeDevice()
        let currentUrl = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: currentUrl) }
        try await StudioTestMedia.writeFlatMovie(lumaLevels: [16, 80, 160, 235], to: currentUrl)

        let renderer = try StudioViewerRenderer(device: device)
        let target = try StudioTestPatternRenderer.makeOffscreenTarget(
            device: device,
            width: size,
            height: size
        )
        let primary = try await StudioMediaSourceLoader.makeFrameSource(
            asset: StudioMediaAsset(assetId: "current-asset", path: currentUrl.path),
            device: device
        )
        renderer.attach(source: primary.source)
        // NO proposed source attached.

        let outcome = renderer.render(
            snapshot: snapshot(ticks: 2),
            to: target,
            review: StudioReviewContext(
                version: .proposed,
                timeline: try timeline(),
                timebase: timebase
            )
        )
        XCTAssertEqual(
            outcome,
            .proposedMaterialUnavailable(frameIndex: 2, assetId: "insert-asset")
        )
        XCTAssertFalse(outcome.didDraw)
    }

    /// A different asset than the one attached must NOT be quietly decoded from
    /// the wrong file. Matching is by identity.
    func testAMismatchedAssetIdIsRefusedRatherThanSubstituted() async throws {
        let device = try makeDevice()
        let url = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try await StudioTestMedia.writeFlatMovie(lumaLevels: [235, 235], to: url)

        let renderer = try StudioViewerRenderer(device: device)
        let source = try await StudioMediaSourceLoader.makeFrameSource(
            asset: StudioMediaAsset(assetId: "some-other-asset", path: url.path),
            device: device
        )
        renderer.attachProposed(
            source: source.source,
            assetId: "some-other-asset",
            timebase: source.media.timebase
        )

        let request = StudioReviewRouter.request(
            atTicks: 2,
            version: .proposed,
            timeline: try timeline(assetId: "insert-asset"),
            availableProposedAssetId: renderer.proposedAssetId
        )
        XCTAssertEqual(request, .unavailable(assetId: "insert-asset"))
    }

    // MARK: - Routing

    func testRoutingResolvesEachRegionOfTheProposedTimeline() throws {
        let reviewTimeline = try timeline()
        func route(_ ticks: Int64, _ version: StudioReviewVersion) -> StudioReviewFrameRequest {
            StudioReviewRouter.request(
                atTicks: ticks,
                version: version,
                timeline: reviewTimeline,
                availableProposedAssetId: "insert-asset"
            )
        }
        // Current version ignores the proposal entirely.
        XCTAssertEqual(route(2, .current), .current(ticks: 2))
        // Proposed: before, inside, after.
        XCTAssertEqual(route(1, .proposed), .current(ticks: 1))
        XCTAssertEqual(route(2, .proposed), .proposed(assetId: "insert-asset", ticks: 0))
        XCTAssertEqual(route(3, .proposed), .proposed(assetId: "insert-asset", ticks: 1))
        XCTAssertEqual(route(4, .proposed), .current(ticks: 2))
    }

    func testNoOpenProposalAlwaysRoutesToTheCurrentSource() {
        XCTAssertEqual(
            StudioReviewRouter.request(
                atTicks: 99,
                version: .proposed,
                timeline: nil,
                availableProposedAssetId: "anything"
            ),
            .current(ticks: 99)
        )
    }

    /// The inserted asset can run at a different rate than the sequence.
    /// Indexing it with sequence ticks lands on the wrong picture.
    func testTicksConvertBetweenTimebases() {
        let pal = StudioTimebase.pal25
        let ntsc = StudioTimebase.ntsc2997
        // One second, whatever the timescale.
        XCTAssertEqual(
            StudioReviewRouter.convert(
                ticks: Int64(pal.timescale),
                from: pal,
                to: ntsc
            ),
            Int64(ntsc.timescale)
        )
        // Identity when the timebases match — no needless arithmetic.
        XCTAssertEqual(StudioReviewRouter.convert(ticks: 1234, from: ntsc, to: ntsc), 1234)
    }

    // MARK: - Lifecycle (outcome 11 will measure this)

    /// The second source is a second decoder, texture cache and reorder buffer.
    /// Resolving a ghost must release it, or a review session accumulates
    /// decompression sessions one proposal at a time.
    func testResolvingAProposalReleasesTheSecondSource() async throws {
        let device = try makeDevice()
        let url = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try await StudioTestMedia.writeFlatMovie(lumaLevels: [235, 235], to: url)

        let renderer = try StudioViewerRenderer(device: device)
        let source = try await StudioMediaSourceLoader.makeFrameSource(
            asset: StudioMediaAsset(assetId: "insert-asset", path: url.path),
            device: device
        )
        renderer.attachProposed(
            source: source.source,
            assetId: "insert-asset",
            timebase: source.media.timebase
        )
        XCTAssertEqual(renderer.proposedAssetId, "insert-asset")

        renderer.detachProposedSource()
        XCTAssertNil(renderer.proposedAssetId)
        XCTAssertEqual(renderer.retainedFrameCount, 0, "second source stranded surfaces")
        // And the source itself is invalidated, not merely dropped.
        XCTAssertThrowsError(try source.source.textures(forFrameIndex: 0))
    }

    /// Detaching the primary must drop the proposal's source too: reviewing
    /// material that is no longer open is not a review.
    func testDetachingThePrimaryAlsoDropsTheProposedSource() async throws {
        let device = try makeDevice()
        let url = StudioTestMedia.makeTemporaryMovieURL()
        defer { try? FileManager.default.removeItem(at: url) }
        try await StudioTestMedia.writeFlatMovie(lumaLevels: [235, 235], to: url)

        let renderer = try StudioViewerRenderer(device: device)
        let source = try await StudioMediaSourceLoader.makeFrameSource(
            asset: StudioMediaAsset(assetId: "insert-asset", path: url.path),
            device: device
        )
        renderer.attachProposed(
            source: source.source,
            assetId: "insert-asset",
            timebase: source.media.timebase
        )
        renderer.detachSource()
        XCTAssertNil(renderer.proposedAssetId)
        XCTAssertEqual(renderer.retainedFrameCount, 0)
    }
}
