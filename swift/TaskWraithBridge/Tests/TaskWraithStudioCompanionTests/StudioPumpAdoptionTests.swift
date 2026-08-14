import AVFoundation
import CoreMedia
import CoreVideo
import Metal
import XCTest

@testable import TaskWraithStudioCompanion
@testable import TaskWraithStudioCore

/// Guards the hop that has silently dropped a payload TWICE.
///
/// HISTORY, because it is the entire justification for this file. The stdio pump
/// parsed proposals and discarded them until `5ca5a06e2`; it then parsed the
/// committed sequence and discarded that until `c062d109b`. Both were found by
/// hand — one by @Advisor reading the code, one by @Orchestrator probing for a
/// callback that did not exist. Neither was found by a test, because until now
/// nothing under Tests/ referenced `StudioCompanionStdioPump` at all.
///
/// WHAT `c062d109b` ACTUALLY FIXED, stated more carefully than I stated it at
/// the time. Making the pump forward one `Update` moved the enumeration; it did
/// not remove it. The pump can no longer forget a payload — but
/// `StudioViewerAppState.adopt(update:)` still needs one branch per payload, and
/// the compiler does not ask for it. The compiler forced that site to be
/// rewritten ONCE. It does not force it to stay complete.
///
/// WHAT THIS FILE DOES AND DOES NOT PROVE — said plainly, because a guard that
/// reads stronger than it is would be the exact failure this round keeps
/// catching. The first three controls pin the SHAPE of the payload types, so
/// adding a seventh field sends the next person to the adoption list. The
/// lower controls execute that list through the real app state, attachment,
/// controller and renderer paths. Neither kind substitutes for the other.
@MainActor
final class StudioPumpAdoptionTests: XCTestCase {

    func testOnlyTheActiveRouteMayScheduleTheSharedAudioPlayer() {
        let scheduling = StudioAudioSchedulingAuthority(owner: .source)
        XCTAssertTrue(scheduling.permits(.source))
        XCTAssertFalse(scheduling.permits(.review))

        scheduling.activate(.review)
        XCTAssertFalse(scheduling.permits(.source))
        XCTAssertTrue(scheduling.permits(.review))

        scheduling.activate(.source)
        XCTAssertTrue(scheduling.permits(.source))
        XCTAssertFalse(scheduling.permits(.review))
    }

    /// Every payload `Step` carries must have a branch in
    /// `StudioViewerAppState.adopt(update:)`.
    ///
    /// If this fails you have added a field. That is fine — add its branch to
    /// `adopt(update:)`, confirm the pump forwards it, then update this number
    /// IN THE SAME COMMIT. The number is not the point; being made to look at
    /// the adoption list is.
    func testStepCarriesExactlyTheFieldsAdoptionKnowsAbout() {
        let step = StudioCompanionSession.Step(
            outboundLines: [],
            exitCode: nil,
            protocolErrors: [],
            openedAssets: [],
            proposals: [],
            resolvedProposalIds: [],
            transcripts: []
        )
        let fields = Mirror(reflecting: step).children.compactMap(\.label).sorted()
        XCTAssertEqual(
            fields,
            [
                "effectPreview", "exitCode", "openedAssets", "outboundLines", "proposals",
                "protocolErrors", "resolvedProposalIds", "transcripts",
            ],
            "StudioCompanionSession.Step changed shape — does "
                + "StudioViewerAppState.adopt(update:) handle the new field, or is it "
                + "being dropped the way proposals were before 5ca5a06e2 and the "
                + "sequence was before c062d109b?"
        )
    }

    /// Same guard for the hydration payload, which is where the sequence lives —
    /// the field that was parsed and reached nothing at all.
    func testHydrationCarriesExactlyTheFieldsAdoptionKnowsAbout() {
        let fields = Mirror(reflecting: StudioCompanionSession.Hydration.empty)
            .children.compactMap(\.label).sorted()
        XCTAssertEqual(
            fields,
            ["assets", "effectPreview", "proposals", "sequence", "transcripts"],
            "StudioCompanionSession.Hydration changed shape — adopt(update:) reads "
                + "sequence and assets from it; a new field reaches nothing until it "
                + "is added there"
        )
    }

    /// And the transport value itself. `Update` is the shape that made carrying
    /// compiler-enforced; this pins that it still carries all three parts, so a
    /// field cannot be quietly dropped from the envelope either.
    func testUpdateCarriesStepRevisionAndHydration() {
        let update = StudioCompanionStdioPump.Update(
            step: StudioCompanionSession.Step(
                outboundLines: [],
                exitCode: nil,
                protocolErrors: [],
                openedAssets: [],
                proposals: [],
                resolvedProposalIds: [],
                transcripts: []
            ),
            latestRevision: 7,
            hydration: .empty
        )
        let fields = Mirror(reflecting: update).children.compactMap(\.label).sorted()
        XCTAssertEqual(fields, ["hydration", "latestRevision", "step"])
        XCTAssertEqual(update.latestRevision, 7, "the envelope must carry what it was given")
    }
    /// Executes the real update-adoption path over media that the production
    /// attachment can decode. A hydration that merely mirrors its fields while
    /// leaving the Source picture, transcript band, or ghost empty is broken.
    func testHydrationRestoresMediaTranscriptAndGhostWithoutPresenting() async throws {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device")
        }
        let movie = try await makeMovie(lumaLevels: [16, 235])
        defer { try? FileManager.default.removeItem(at: movie) }

        let timebase = try XCTUnwrap(StudioTimebase(timescale: 30, frameDurationTicks: 1))
        let authority = StudioPlaybackAuthority(
            clock: StudioPlaybackClock(timebase: timebase, durationTicks: 300)
        )
        let sourceRenderer = try StudioViewerRenderer(device: device)
        let reviewRenderer = try StudioViewerRenderer(device: device)
        let sourceController = StudioViewerWindowController(
            renderer: sourceRenderer, authority: authority, route: .source
        )
        let reviewController = StudioViewerWindowController(
            renderer: reviewRenderer, authority: authority, route: .review
        )
        var presentationCount = 0
        let state = StudioViewerAppState(
            controller: sourceController,
            renderer: sourceRenderer,
            reviewController: reviewController,
            presentSource: { presentationCount += 1 }
        )

        let asset = StudioMediaAsset(assetId: "recovered", path: movie.path)
        let transcript = StudioTranscript(
            transcriptId: "recovered-transcript",
            assetId: asset.assetId,
            segments: [
                StudioTranscriptSegment(
                    segmentId: "word-1",
                    text: "restored",
                    sourceIn: try XCTUnwrap(StudioRationalTime(n: 0, d: 30)),
                    sourceOut: try XCTUnwrap(StudioRationalTime(n: 1, d: 30))
                )
            ]
        )
        let proposal = StudioEditProposal(
            proposalId: "recovered-proposal",
            createdRevision: 7,
            op: StudioInsertRangeOp(
                itemId: "recovered-item",
                assetId: asset.assetId,
                sourceIn: try XCTUnwrap(StudioRationalTime(n: 0, d: 30)),
                sourceOut: try XCTUnwrap(StudioRationalTime(n: 1, d: 30)),
                at: try XCTUnwrap(StudioRationalTime(n: 1, d: 30))
            )
        )
        let update = StudioCompanionStdioPump.Update(
            step: StudioCompanionSession.Step(
                outboundLines: [], exitCode: nil, protocolErrors: []
            ),
            latestRevision: 7,
            hydration: StudioCompanionSession.Hydration(
                assets: [asset],
                proposals: [proposal],
                transcripts: [transcript],
                sequence: StudioTimelineSequence(items: [
                    StudioSequenceItem(
                        itemId: "recovered-sequence-item", assetId: asset.assetId,
                        startTicks: 0, endTicks: 2, sourceInTicks: 0
                    )
                ])
            )
        )

        await state.adopt(update: update)

        XCTAssertEqual(presentationCount, 0, "hydration must not foreground Studio")
        XCTAssertFalse(sourceController.isPresentationAttached)
        XCTAssertTrue(
            sourceRenderer.diagnostics.hasSource,
            "the recovered asset was not actually attached to the Source renderer"
        )
        XCTAssertTrue(
            reviewRenderer.diagnostics.hasSource,
            "the recovered asset was not attached to the independent Review renderer"
        )
        XCTAssertEqual(
            reviewRenderer.sequence?.sample(atTicks: 0),
            .item(itemId: "recovered-sequence-item", assetId: asset.assetId, sourceTicks: 0),
            "hydration must retain the exact committed asset rather than substituting another"
        )
        XCTAssertEqual(
            reviewRenderer.residentSequenceAssetCount,
            1,
            "the recovered committed sequence did not make its named asset resident"
        )
        XCTAssertEqual(
            sourceController.transcriptSegmentCount,
            1,
            "the recovered transcript never reached the visible Source band"
        )
        XCTAssertTrue(
            reviewController.hasOpenReview,
            "the recovered ghost never reached the Review controller"
        )
        XCTAssertEqual(
            state.sharedDecoderCreationCount,
            1,
            "Source, Review, and the matching hydrated sequence must lease one decoder"
        )
        XCTAssertEqual(state.sharedResidentDecoderCount, 1)

        var clock = StudioPlaybackClock(timebase: timebase, durationTicks: 300)
        clock.seek(toTicks: 1, atHost: 0)
        let target = try StudioTestPatternRenderer.makeOffscreenTarget(
            device: device, width: 128, height: 128)
        func green(_ texture: MTLTexture) throws -> Int {
            Int(try StudioTestPatternRenderer.readPixel(from: texture, x: 64, y: 64).green)
        }
        let current = try XCTUnwrap(reviewController.activeReviewContext)
        XCTAssertTrue(reviewRenderer.render(
            snapshot: clock.snapshot(atHost: 0), to: target, review: current
        ).didDraw)
        let currentGreen = try green(target)
        reviewController.toggleReviewVersion()
        let proposed = try XCTUnwrap(reviewController.activeReviewContext)
        XCTAssertTrue(reviewRenderer.render(
            snapshot: clock.snapshot(atHost: 0), to: target, review: proposed
        ).didDraw)
        XCTAssertGreaterThan(
            abs(try green(target) - currentGreen),
            60,
            "an open hydrated ghost must win over the committed sequence at its affected range"
        )
    }

    /// Executes the hydration -> app state -> two real renderer hop. The pixel
    /// assertions distinguish a delivered LUT from a payload merely reflected
    /// in state: Effect changes, Original bypasses, rejection holds, and clear
    /// restores neutral output.
    func testEffectPreviewHydratesBothRenderersAndClearRestoresNeutralOutput() async throws {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device")
        }
        let movie = try await makeMovie(lumaLevels: [128])
        defer { try? FileManager.default.removeItem(at: movie) }

        let timebase = try XCTUnwrap(StudioTimebase(timescale: 30, frameDurationTicks: 1))
        let authority = StudioPlaybackAuthority(
            clock: StudioPlaybackClock(timebase: timebase, durationTicks: 300)
        )
        let sourceRenderer = try StudioViewerRenderer(device: device)
        let reviewRenderer = try StudioViewerRenderer(device: device)
        let sourceController = StudioViewerWindowController(
            renderer: sourceRenderer, authority: authority, route: .source
        )
        let reviewController = StudioViewerWindowController(
            renderer: reviewRenderer, authority: authority, route: .review
        )
        var presentationCount = 0
        let state = StudioViewerAppState(
            controller: sourceController,
            renderer: sourceRenderer,
            reviewController: reviewController,
            presentSource: { presentationCount += 1 }
        )
        let cubeText = """
        LUT_3D_SIZE 2
        1.0 0.0 0.0
        1.0 0.0 0.0
        1.0 0.0 0.0
        1.0 0.0 0.0
        1.0 0.0 0.0
        1.0 0.0 0.0
        1.0 0.0 0.0
        1.0 0.0 0.0
        """
        let preview = try StudioEffectPreview(
            schemaVersion: 1,
            effectId: StudioEffectPreview.effectId(forCubeText: cubeText),
            cubeByteLength: cubeText.lengthOfBytes(using: .utf8),
            cubeText: cubeText
        )
        let asset = StudioMediaAsset(assetId: "preview-asset", path: movie.path)
        await state.adopt(
            update: StudioCompanionStdioPump.Update(
                step: StudioCompanionSession.Step(
                    outboundLines: [], exitCode: nil, protocolErrors: []
                ),
                latestRevision: 3,
                hydration: StudioCompanionSession.Hydration(
                    assets: [asset],
                    proposals: [],
                    transcripts: [],
                    effectPreview: .set(preview),
                    sequence: StudioTimelineSequence(items: [])
                )
            )
        )
        XCTAssertEqual(presentationCount, 0, "hydration must not foreground Studio")
        XCTAssertTrue(sourceRenderer.diagnostics.hasSource)
        XCTAssertTrue(reviewRenderer.diagnostics.hasSource)

        var clock = StudioPlaybackClock(timebase: timebase, durationTicks: 300)
        clock.seek(toTicks: 0, atHost: 0)
        let snapshot = clock.snapshot(atHost: 0)
        let target = try StudioTestPatternRenderer.makeOffscreenTarget(
            device: device, width: 128, height: 128
        )
        func pixel(
            _ renderer: StudioViewerRenderer,
            grade: StudioGradeMode
        ) throws -> StudioPixel {
            renderer.grade = StudioGradeSettings(mode: grade)
            XCTAssertTrue(renderer.render(snapshot: snapshot, to: target).didDraw)
            return try StudioTestPatternRenderer.readPixel(from: target, x: 64, y: 64)
        }

        let sourceOriginal = try pixel(sourceRenderer, grade: .original)
        let reviewOriginal = try pixel(reviewRenderer, grade: .original)
        let sourceEffect = try pixel(sourceRenderer, grade: .effect)
        let reviewEffect = try pixel(reviewRenderer, grade: .effect)
        XCTAssertEqual(
            sourceOriginal,
            try pixel(sourceRenderer, grade: .original),
            "Original must bypass a resident preview in the Source renderer"
        )
        XCTAssertEqual(
            reviewOriginal,
            try pixel(reviewRenderer, grade: .original),
            "Original must bypass a resident preview in the Review renderer"
        )
        XCTAssertNotEqual(sourceEffect, sourceOriginal, "Source Effect never received the LUT")
        XCTAssertNotEqual(reviewEffect, reviewOriginal, "Review Effect never received the LUT")

        await state.adopt(
            update: StudioCompanionStdioPump.Update(
                step: StudioCompanionSession.Step(
                    outboundLines: [],
                    exitCode: nil,
                    protocolErrors: [],
                    effectPreview: .rejected("effectIdMismatch")
                ),
                latestRevision: 4,
                hydration: nil
            )
        )
        XCTAssertEqual(
            try pixel(sourceRenderer, grade: .effect),
            sourceEffect,
            "a rejected replacement must not substitute Source's valid preview"
        )
        XCTAssertEqual(
            try pixel(reviewRenderer, grade: .effect),
            reviewEffect,
            "a rejected replacement must not substitute Review's valid preview"
        )

        await state.adopt(
            update: StudioCompanionStdioPump.Update(
                step: StudioCompanionSession.Step(
                    outboundLines: [],
                    exitCode: nil,
                    protocolErrors: [],
                    effectPreview: .clear
                ),
                latestRevision: 5,
                hydration: nil
            )
        )
        XCTAssertEqual(try pixel(sourceRenderer, grade: .effect), sourceOriginal)
        XCTAssertEqual(try pixel(reviewRenderer, grade: .effect), reviewOriginal)
    }

    /// Exercises the product handoff between two distinct controllers. The
    /// Review context comes from the Review controller itself; rendering it
    /// verifies that its independent renderer has real material, rather than
    /// merely proving the Core renderer can draw a lookalike context.
    func testReviewControllerUsesResidentPrimaryForSameAssetAndSecondaryForCrossAsset() async throws {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device")
        }
        let primaryURL = try await makeMovie(lumaLevels: [16, 80, 160, 235])
        let insertedURL = try await makeMovie(lumaLevels: [235, 235])
        defer {
            try? FileManager.default.removeItem(at: primaryURL)
            try? FileManager.default.removeItem(at: insertedURL)
        }

        let timebase = try XCTUnwrap(StudioTimebase(timescale: 30, frameDurationTicks: 1))
        let authority = StudioPlaybackAuthority(
            clock: StudioPlaybackClock(timebase: timebase, durationTicks: 300)
        )
        let sourceRenderer = try StudioViewerRenderer(device: device)
        let reviewRenderer = try StudioViewerRenderer(device: device)
        let sourceController = StudioViewerWindowController(
            renderer: sourceRenderer, authority: authority, route: .source
        )
        let reviewController = StudioViewerWindowController(
            renderer: reviewRenderer, authority: authority, route: .review
        )
        let state = StudioViewerAppState(
            controller: sourceController,
            renderer: sourceRenderer,
            reviewController: reviewController,
            presentSource: {}
        )
        let primary = StudioMediaAsset(assetId: "primary", path: primaryURL.path)
        let inserted = StudioMediaAsset(assetId: "inserted", path: insertedURL.path)

        await state.open(assets: [primary])
        XCTAssertTrue(sourceRenderer.diagnostics.hasSource)
        XCTAssertTrue(
            reviewRenderer.diagnostics.hasSource,
            "Review needs a presentation slot for the shared primary material"
        )
        XCTAssertEqual(
            state.sharedDecoderCreationCount,
            1,
            "opening one asset across Source and Review must construct one decoder"
        )
        XCTAssertEqual(state.sharedResidentDecoderCount, 1)

        func proposal(id: String, assetId: String) throws -> StudioEditProposal {
            StudioEditProposal(
                proposalId: id,
                createdRevision: 7,
                op: StudioInsertRangeOp(
                    itemId: "\(id)-item",
                    assetId: assetId,
                    sourceIn: try XCTUnwrap(StudioRationalTime(n: 0, d: 30)),
                    sourceOut: try XCTUnwrap(StudioRationalTime(n: 2, d: 30)),
                    at: try XCTUnwrap(StudioRationalTime(n: 2, d: 30))
                )
            )
        }
        var clock = StudioPlaybackClock(timebase: timebase, durationTicks: 300)
        clock.seek(toTicks: 2, atHost: 0)
        let snapshot = clock.snapshot(atHost: 0)
        let target = try StudioTestPatternRenderer.makeOffscreenTarget(
            device: device,
            width: 128,
            height: 128
        )
        func green(_ texture: MTLTexture) throws -> Int {
            Int(try StudioTestPatternRenderer.readPixel(from: texture, x: 64, y: 64).green)
        }

        let sameAsset = try proposal(id: "same-asset", assetId: primary.assetId)
        await state.adopt(proposals: [sameAsset])
        let sameCurrent = try XCTUnwrap(reviewController.activeReviewContext)
        XCTAssertTrue(reviewRenderer.render(snapshot: snapshot, to: target, review: sameCurrent).didDraw)
        let sameCurrentGreen = try green(target)

        reviewController.toggleReviewVersion()
        let sameProposed = try XCTUnwrap(reviewController.activeReviewContext)
        XCTAssertTrue(reviewRenderer.render(snapshot: snapshot, to: target, review: sameProposed).didDraw)
        let sameProposedGreen = try green(target)
        XCTAssertGreaterThan(
            abs(sameProposedGreen - sameCurrentGreen),
            60,
            "the same-asset affected range must display a different source-time picture"
        )
        XCTAssertEqual(
            reviewRenderer.activeSourceCount,
            1,
            "same-asset Proposed must reuse Review's resident primary decoder"
        )
        XCTAssertEqual(
            state.sharedDecoderCreationCount,
            1,
            "same-asset Proposed must not create a route-local or proposal-local decoder"
        )

        XCTAssertEqual(state.toggleRoute(.review), .shown(.review))
        XCTAssertEqual(state.toggleRoute(.review), .hidden(.review))
        XCTAssertTrue(
            sourceRenderer.diagnostics.hasSource,
            "hiding Review must not invalidate Source's lease"
        )
        XCTAssertFalse(reviewRenderer.diagnostics.hasSource)
        await state.restoreReviewRoute()
        XCTAssertTrue(
            reviewRenderer.diagnostics.hasSource,
            "showing Review must re-establish its primary slot rather than trusting stale identity"
        )
        let restoredProposed = try XCTUnwrap(reviewController.activeReviewContext)
        XCTAssertTrue(reviewRenderer.render(
            snapshot: snapshot, to: target, review: restoredProposed
        ).didDraw)
        XCTAssertEqual(
            try green(target),
            sameProposedGreen,
            "show-hide-show must restore the same-asset Proposed picture"
        )
        XCTAssertEqual(
            state.sharedDecoderCreationCount,
            1,
            "show-hide-show must reacquire a lease, not decode the same asset again"
        )

        state.adopt(resolvedProposals: [sameAsset.proposalId])
        XCTAssertFalse(reviewController.hasOpenReview)

        // Registering a known but unopened asset lets the actual proposal path
        // attach it as the cross-asset Review secondary without changing Source.
        await state.adopt(
            sequence: StudioTimelineSequence(items: []),
            knownAssets: [inserted]
        )
        let crossAsset = try proposal(id: "cross-asset", assetId: inserted.assetId)
        await state.adopt(proposals: [crossAsset])
        XCTAssertEqual(
            reviewRenderer.activeSourceCount,
            2,
            "cross-asset Proposed needs the independent secondary resident source"
        )
        XCTAssertEqual(
            state.sharedDecoderCreationCount,
            2,
            "cross-asset Proposed must add exactly one distinct decoder"
        )
        let crossCurrent = try XCTUnwrap(reviewController.activeReviewContext)
        XCTAssertTrue(reviewRenderer.render(snapshot: snapshot, to: target, review: crossCurrent).didDraw)
        let crossCurrentGreen = try green(target)
        reviewController.toggleReviewVersion()
        let crossProposed = try XCTUnwrap(reviewController.activeReviewContext)
        XCTAssertTrue(reviewRenderer.render(snapshot: snapshot, to: target, review: crossProposed).didDraw)
        XCTAssertGreaterThan(
            abs(try green(target) - crossCurrentGreen),
            60,
            "cross-asset Proposed must display its secondary material, not Source"
        )

        state.adopt(resolvedProposals: [crossAsset.proposalId])
        let missing = try proposal(id: "missing-asset", assetId: "not-resident")
        await state.adopt(proposals: [missing])
        XCTAssertFalse(
            reviewController.hasOpenReview,
            "a missing identity must be held rather than shown with another asset's picture"
        )
        XCTAssertEqual(reviewRenderer.activeSourceCount, 1)

        XCTAssertEqual(state.toggleRoute(.review), .shown(.review))
        XCTAssertEqual(state.toggleRoute(.review), .hidden(.review))
        XCTAssertTrue(
            sourceRenderer.diagnostics.hasSource,
            "hiding Review must not tear down the material Source is still presenting"
        )
        XCTAssertFalse(reviewRenderer.diagnostics.hasSource)
        XCTAssertEqual(
            state.sharedResidentDecoderCount,
            1,
            "releasing Review must leave only Source's visible primary decoder"
        )

        // The AppKit close path must release Source's pool lease, not call the
        // renderer's default invalidating detach while Review still holds it.
        XCTAssertEqual(state.toggleRoute(.review), .shown(.review))
        await state.restoreReviewRoute()
        XCTAssertTrue(reviewRenderer.diagnostics.hasSource)
        sourceController.presentationDidDetach()
        XCTAssertFalse(sourceRenderer.diagnostics.hasSource)
        XCTAssertTrue(
            reviewRenderer.diagnostics.hasSource,
            "closing Source must not invalidate Review's shared decoder lease"
        )
        XCTAssertEqual(state.sharedResidentDecoderCount, 1)
    }

    /// The actual Review controller must not fall back to the opened source when
    /// a committed multi-asset sequence names an unknown later clip.
    func testMultiAssetSequenceUsesOnlyItsExactResidentAsset() async throws {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("no Metal device")
        }
        let primaryURL = try await makeMovie(lumaLevels: [16, 16])
        let secondaryURL = try await makeMovie(lumaLevels: [235, 235])
        defer {
            try? FileManager.default.removeItem(at: primaryURL)
            try? FileManager.default.removeItem(at: secondaryURL)
        }

        let timebase = try XCTUnwrap(StudioTimebase(timescale: 30, frameDurationTicks: 1))
        let authority = StudioPlaybackAuthority(
            clock: StudioPlaybackClock(timebase: timebase, durationTicks: 300)
        )
        let sourceRenderer = try StudioViewerRenderer(device: device)
        let reviewRenderer = try StudioViewerRenderer(device: device)
        let sourceController = StudioViewerWindowController(
            renderer: sourceRenderer, authority: authority, route: .source
        )
        let reviewController = StudioViewerWindowController(
            renderer: reviewRenderer, authority: authority, route: .review
        )
        let state = StudioViewerAppState(
            controller: sourceController,
            renderer: sourceRenderer,
            reviewController: reviewController,
            presentSource: {}
        )
        let primary = StudioMediaAsset(assetId: "primary", path: primaryURL.path)
        let secondary = StudioMediaAsset(assetId: "secondary", path: secondaryURL.path)
        await state.open(assets: [primary])
        await state.adopt(
            sequence: StudioTimelineSequence(items: [
                StudioSequenceItem(
                    itemId: "secondary-item", assetId: secondary.assetId,
                    startTicks: 0, endTicks: 2, sourceInTicks: 0
                ),
                StudioSequenceItem(
                    itemId: "missing-item", assetId: "missing",
                    startTicks: 2, endTicks: 4, sourceInTicks: 0
                ),
            ]),
            knownAssets: [secondary]
        )

        XCTAssertEqual(
            state.sharedDecoderCreationCount,
            2,
            "the sequence may add its distinct asset but must reuse Source/Review primary"
        )
        let target = try StudioTestPatternRenderer.makeOffscreenTarget(
            device: device, width: 128, height: 128
        )
        var clock = StudioPlaybackClock(timebase: timebase, durationTicks: 300)
        clock.seek(toTicks: 0, atHost: 0)
        XCTAssertTrue(reviewRenderer.render(snapshot: clock.snapshot(atHost: 0), to: target).didDraw)
        let secondaryGreen = Int(
            try StudioTestPatternRenderer.readPixel(from: target, x: 64, y: 64).green
        )
        XCTAssertGreaterThan(
            secondaryGreen,
            180,
            "the Review sequence must render its named secondary clip, not Source"
        )

        clock.seek(toTicks: 2, atHost: 0)
        XCTAssertEqual(
            reviewRenderer.render(snapshot: clock.snapshot(atHost: 0), to: target),
            .proposedMaterialUnavailable(frameIndex: 2, assetId: "missing"),
            "a missing sequence identity must not substitute either resident asset"
        )
    }

    private func makeMovie(lumaLevels: [UInt8] = [128, 128]) async throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("studio-pump-adoption-\(UUID().uuidString).mov")
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let input = AVAssetWriterInput(
            mediaType: .video,
            outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: 64,
                AVVideoHeightKey: 64,
                AVVideoCompressionPropertiesKey: [
                    AVVideoMaxKeyFrameIntervalKey: 1,
                    AVVideoAllowFrameReorderingKey: false,
                ],
            ]
        )
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: Int(
                    kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
                ),
                kCVPixelBufferWidthKey as String: 64,
                kCVPixelBufferHeightKey as String: 64,
                kCVPixelBufferIOSurfacePropertiesKey as String: [CFString: Any]() as CFDictionary,
            ]
        )
        guard writer.canAdd(input) else { throw XCTSkip("asset writer rejected fixture") }
        writer.add(input)
        guard writer.startWriting() else {
            throw XCTSkip("asset writer could not start: \(String(describing: writer.error))")
        }
        writer.startSession(atSourceTime: .zero)
        guard !lumaLevels.isEmpty else { throw XCTSkip("fixture needs at least one frame") }

        for index in lumaLevels.indices {
            while !input.isReadyForMoreMediaData {
                try await Task.sleep(nanoseconds: 1_000_000)
            }
            XCTAssertTrue(
                adaptor.append(
                    try makePixelBuffer(luma: lumaLevels[index]),
                    withPresentationTime: CMTime(value: Int64(index), timescale: 30)
                ),
                "fixture append failed: \(String(describing: writer.error))"
            )
        }
        input.markAsFinished()
        await writer.finishWriting()
        guard writer.status == .completed else {
            throw XCTSkip("asset writer finished \(writer.status): \(String(describing: writer.error))")
        }
        return url
    }

    private func makePixelBuffer(luma: UInt8 = 128) throws -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            64,
            64,
            kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
            [
                kCVPixelBufferMetalCompatibilityKey: true,
                kCVPixelBufferIOSurfacePropertiesKey: [CFString: Any]() as CFDictionary,
            ] as CFDictionary,
            &buffer
        )
        let pixelBuffer = try XCTUnwrap(buffer, "CVPixelBufferCreate failed: \(status)")
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        for plane in 0..<CVPixelBufferGetPlaneCount(pixelBuffer) {
            guard let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, plane) else {
                continue
            }
            memset(
                base,
                plane == 0 ? Int32(luma) : 128,
                CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, plane)
                    * CVPixelBufferGetHeightOfPlane(pixelBuffer, plane)
            )
        }
        return pixelBuffer
    }

}
