import XCTest

@testable import TaskWraithStudioCore

/// The committed timeline as a PLAYBACK SUBJECT — the distinction the
/// owner-approved briefing draws between Source ("previews the selected asset
/// independently of the timeline") and Review ("plays the committed timeline").
final class StudioTimelineSequenceTests: XCTestCase {
    private let ms = StudioTimebase(timescale: 1000, frameDurationTicks: 1)!

    private func tracks(_ items: [(String, String, Int, Int, Int)]) -> [[String: Any]] {
        [[
            "trackId": "v1", "kind": "video",
            "items": items.map { item in
                [
                    "itemId": item.0, "assetId": item.1,
                    "position": ["n": item.2, "d": 1000],
                    "duration": ["n": item.3, "d": 1000],
                    "sourceIn": ["n": item.4, "d": 1000],
                    "sourceOut": ["n": item.4 + item.3, "d": 1000],
                ] as [String: Any]
            },
        ]]
    }

    /// THE WHOLE POINT: a sequence tick resolves to a DIFFERENT asset and a
    /// DIFFERENT source time than playing one asset would. If Review played the
    /// open asset, position 5000 would be source 5000 of that asset; on this
    /// sequence it is source 200 of a different one.
    func testASequenceTickResolvesToAnAssetAndASourceTimeThatArentTheOpenAsset() {
        let sequence = StudioTimelineSequenceDecoder.sequence(
            fromTracks: tracks([
                ("i1", "clip-a", 0, 3000, 1000),
                ("i2", "clip-b", 3000, 4000, 200),
            ]),
            timebase: ms)

        XCTAssertEqual(
            sequence.timebase,
            ms,
            "a decoded sequence must retain its document clock for resident-audio conversion"
        )
        guard case .item(let id1, let asset1, let source1) = sequence.sample(atTicks: 500) else {
            return XCTFail("expected an item at 500")
        }
        XCTAssertEqual(id1, "i1")
        XCTAssertEqual(asset1, "clip-a")
        XCTAssertEqual(source1, 1500, "source is the clip's own in-point plus the offset")

        guard case .item(let id2, let asset2, let source2) = sequence.sample(atTicks: 3200) else {
            return XCTFail("expected an item at 3200")
        }
        XCTAssertEqual(id2, "i2")
        XCTAssertEqual(asset2, "clip-b", "the second clip is a DIFFERENT asset")
        XCTAssertEqual(
            source2, 400,
            "playing the open asset would give 3200 here; the timeline gives 400")
    }

    /// Half-open boundaries: the cut belongs to the incoming clip, not both.
    func testTheCutBelongsToExactlyOneClip() {
        let sequence = StudioTimelineSequenceDecoder.sequence(
            fromTracks: tracks([
                ("i1", "clip-a", 0, 3000, 0),
                ("i2", "clip-b", 3000, 1000, 0),
            ]),
            timebase: ms)
        guard case .item(let before, _, _) = sequence.sample(atTicks: 2999),
            case .item(let atCut, _, _) = sequence.sample(atTicks: 3000)
        else { return XCTFail("expected items either side of the cut") }
        XCTAssertEqual(before, "i1")
        XCTAssertEqual(atCut, "i2", "the boundary tick must belong to the incoming clip only")
    }

    /// A hole draws NOTHING. Substituting a neighbouring frame would show an
    /// operator material that is not there at that time.
    func testAGapAndThePastTheEndDrawNothing() {
        let sequence = StudioTimelineSequenceDecoder.sequence(
            fromTracks: tracks([
                ("i1", "clip-a", 0, 1000, 0),
                ("i2", "clip-b", 5000, 1000, 0),
            ]),
            timebase: ms)
        XCTAssertEqual(sequence.sample(atTicks: 3000), .gap, "a hole is not the nearest clip")
        XCTAssertEqual(sequence.sample(atTicks: 6000), .gap, "past the end is not the last frame")
        XCTAssertEqual(sequence.sample(atTicks: -1), .gap)
        XCTAssertEqual(sequence.durationTicks, 6000, "duration spans the gap, not the sum")
    }

    /// Audio items are not what a viewer presents; merging them would put two
    /// clips at one tick.
    func testAudioTracksAreNotPlayedAsPicture() {
        let payload: [[String: Any]] = [
            [
                "trackId": "a1", "kind": "audio",
                "items": [[
                    "itemId": "a", "assetId": "clip-a",
                    "position": ["n": 0, "d": 1000], "duration": ["n": 1000, "d": 1000],
                    "sourceIn": ["n": 0, "d": 1000], "sourceOut": ["n": 1000, "d": 1000],
                ] as [String: Any]],
            ],
        ]
        let sequence = StudioTimelineSequenceDecoder.sequence(
            fromTracks: payload, timebase: ms)
        XCTAssertTrue(sequence.isEmpty)
    }

    /// A malformed or zero-length item is SKIPPED rather than guessed at, and
    /// must not take the good items down with it.
    func testMalformedItemsAreSkippedWithoutLosingTheGoodOnes() {
        var payload = tracks([("i1", "clip-a", 0, 1000, 0)])
        var items = payload[0]["items"] as! [[String: Any]]
        items.append(["itemId": "bad", "assetId": "clip-b"])
        items.append([
            "itemId": "zero", "assetId": "clip-b",
            "position": ["n": 2000, "d": 1000], "duration": ["n": 0, "d": 1000],
            "sourceIn": ["n": 0, "d": 1000],
        ])
        payload[0]["items"] = items

        let sequence = StudioTimelineSequenceDecoder.sequence(
            fromTracks: payload, timebase: ms)
        XCTAssertEqual(sequence.items.count, 1, "one good item survived")
        XCTAssertEqual(sequence.items.first?.itemId, "i1")
        XCTAssertEqual(sequence.sample(atTicks: 2000), .gap, "a zero-length item is not time")
    }

    /// Every asset the Review route must have resident to play through.
    func testTheSequenceNamesTheAssetsItNeeds() {
        let sequence = StudioTimelineSequenceDecoder.sequence(
            fromTracks: tracks([
                ("i1", "clip-a", 0, 1000, 0),
                ("i2", "clip-b", 1000, 1000, 0),
                ("i3", "clip-a", 2000, 1000, 0),
            ]),
            timebase: ms)
        XCTAssertEqual(sequence.referencedAssetIds, ["clip-a", "clip-b"])
    }
}

/// The Review route PLAYING the sequence, and the diagnostics that had to grow
/// with it.
final class StudioSequencePlaybackTests: XCTestCase {
    private let timebase = StudioTimebase(timescale: 600, frameDurationTicks: 20)!

    private func renderer() throws -> StudioViewerRenderer {
        guard let device = MTLCreateSystemDefaultDevice() else { throw XCTSkip("no Metal") }
        return try StudioViewerRenderer(device: device)
    }

    private func snapshot(ticks: Int64) -> StudioTransportSnapshot {
        var clock = StudioPlaybackClock(timebase: timebase, durationTicks: 12000)
        clock.seek(toTicks: ticks, atHost: 0)
        return clock.snapshot(atHost: 0)
    }

    /// THE CLAIM: which FILE is on screen depends on the tick. Two clips of
    /// different brightness, and the rendered pixel changes at the cut — an
    /// implementation that played one asset throughout cannot pass this.
    func testTheTickDecidesWhichASSETIsOnScreen() throws {
        let renderer = try renderer()
        let target = try StudioTestPatternRenderer.makeOffscreenTarget(
            device: renderer.device, width: 64, height: 64)

        renderer.attachSequence(
            source: try StudioTestMedia.makeFrameSource(lumaLevels: [32], device: renderer.device),
            assetId: "dark", timebase: timebase)
        renderer.attachSequence(
            source: try StudioTestMedia.makeFrameSource(lumaLevels: [224], device: renderer.device),
            assetId: "bright", timebase: timebase)
        renderer.sequence = StudioTimelineSequence(items: [
            StudioSequenceItem(
                itemId: "i1", assetId: "dark",
                startTicks: 0, endTicks: 3000, sourceInTicks: 0),
            StudioSequenceItem(
                itemId: "i2", assetId: "bright",
                startTicks: 3000, endTicks: 6000, sourceInTicks: 0),
        ])

        _ = renderer.render(snapshot: snapshot(ticks: 1000), to: target)
        let beforeCut = try StudioTestPatternRenderer.readPixel(from: target, x: 32, y: 32)

        _ = renderer.render(snapshot: snapshot(ticks: 4000), to: target)
        let afterCut = try StudioTestPatternRenderer.readPixel(from: target, x: 32, y: 32)

        XCTAssertLessThan(
            beforeCut.red, afterCut.red,
            "the picture did not change across the cut — the route is playing one "
                + "asset, not the timeline")
    }

    /// A gap draws NOTHING rather than the neighbouring clip, all the way
    /// through the render path and not just in the resolver.
    func testAGapInTheSequenceDrawsNothing() throws {
        let renderer = try renderer()
        let target = try StudioTestPatternRenderer.makeOffscreenTarget(
            device: renderer.device, width: 64, height: 64)
        renderer.attachSequence(
            source: try StudioTestMedia.makeFrameSource(lumaLevels: [32], device: renderer.device),
            assetId: "dark", timebase: timebase)
        renderer.sequence = StudioTimelineSequence(items: [
            StudioSequenceItem(
                itemId: "i1", assetId: "dark",
                startTicks: 0, endTicks: 1000, sourceInTicks: 0),
        ])

        let outcome = renderer.render(snapshot: snapshot(ticks: 5000), to: target)
        XCTAssertFalse(outcome.didDraw, "a gap must not present a frame")
        XCTAssertEqual(
            outcome, .proposedMaterialUnavailable(frameIndex: 250, assetId: "sequence-gap"))
    }

    /// A clip whose asset is not resident is REFUSED, not substituted.
    func testAMissingSequenceAssetIsRefusedRatherThanSubstituted() throws {
        let renderer = try renderer()
        let target = try StudioTestPatternRenderer.makeOffscreenTarget(
            device: renderer.device, width: 64, height: 64)
        renderer.attachSequence(
            source: try StudioTestMedia.makeFrameSource(lumaLevels: [32], device: renderer.device),
            assetId: "resident", timebase: timebase)
        renderer.sequence = StudioTimelineSequence(items: [
            StudioSequenceItem(
                itemId: "i1", assetId: "absent",
                startTicks: 0, endTicks: 3000, sourceInTicks: 0),
        ])

        let outcome = renderer.render(snapshot: snapshot(ticks: 1000), to: target)
        XCTAssertFalse(outcome.didDraw)
        XCTAssertEqual(
            outcome, .proposedMaterialUnavailable(frameIndex: 50, assetId: "absent"),
            "a missing clip must name the asset it wanted, not fall back to a resident one")
    }

    /// THE PROSPECTIVE AGING FIX. Orchestrator found this BEFORE the change
    /// landed: cacheHitCount and boundTextureCount read one source, so N
    /// resident sources would have been silently under-reported while the HUD
    /// kept drawing and its test kept passing.
    func testDiagnosticsCountEVERYResidentSourceNotJustTheFirst() throws {
        let renderer = try renderer()
        let target = try StudioTestPatternRenderer.makeOffscreenTarget(
            device: renderer.device, width: 64, height: 64)

        renderer.attach(
            source: try StudioTestMedia.makeFrameSource(
                lumaLevels: [32, 96], device: renderer.device))
        _ = renderer.render(snapshot: snapshot(ticks: 0), to: target)
        let primaryOnly = renderer.boundTextureCount
        XCTAssertGreaterThan(primaryOnly, 0, "the primary source must bind something")

        // A second resident source, driven so it binds too.
        renderer.attachSequence(
            source: try StudioTestMedia.makeFrameSource(
                lumaLevels: [224], device: renderer.device),
            assetId: "second", timebase: timebase)
        renderer.sequence = StudioTimelineSequence(items: [
            StudioSequenceItem(
                itemId: "i1", assetId: "second",
                startTicks: 0, endTicks: 3000, sourceInTicks: 0),
        ])
        _ = renderer.render(snapshot: snapshot(ticks: 0), to: target)

        XCTAssertGreaterThan(
            renderer.boundTextureCount, primaryOnly,
            "textures reported only one source's count while two were resident — "
                + "silently under-reporting is what this fix exists to prevent")
        XCTAssertEqual(renderer.residentSequenceAssetCount, 1)
    }

    /// Hiding the Review route must release SEQUENCE sources too, not just the
    /// A/B pair — the briefing's resource obligation covers all of them.
    func testDetachingReleasesEverySequenceSource() throws {
        let renderer = try renderer()
        renderer.attachSequence(
            source: try StudioTestMedia.makeFrameSource(lumaLevels: [32], device: renderer.device),
            assetId: "a", timebase: timebase)
        renderer.attachSequence(
            source: try StudioTestMedia.makeFrameSource(lumaLevels: [64], device: renderer.device),
            assetId: "b", timebase: timebase)
        XCTAssertEqual(renderer.residentSequenceAssetCount, 2)

        renderer.detachSequenceSources()
        XCTAssertEqual(renderer.residentSequenceAssetCount, 0)
        XCTAssertNil(renderer.sequence, "a released route must not keep a timeline to play")
        XCTAssertEqual(renderer.retainedFrameCount, 0)
    }
}
