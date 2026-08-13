import Metal
import XCTest

@testable import TaskWraithStudioCore

/// The seams that existed in Core and were reachable by nobody.
///
/// Advisor's reconciliation found three outcomes whose machinery was real,
/// pixel-tested and independently verified — and which the running product
/// could never invoke. "Core-tested" was being read as "the outcome exists".
/// These tests assert REACHABILITY: that a caller above Core can actually move
/// the behaviour.
final class StudioProductWiringTests: XCTestCase {
    private func makeRenderer() throws -> StudioViewerRenderer {
        guard let device = MTLCreateSystemDefaultDevice() else { throw XCTSkip("no Metal") }
        return try StudioViewerRenderer(device: device)
    }

    /// THE GRADING REACHABILITY TEST. StudioVideoFrameRenderer has taken a
    /// per-render StudioGradeSettings since the grading slice landed and
    /// StudioViewerRenderer never passed one, so the product was pinned to
    /// default Original. Asserting the SETTING EXISTS would prove nothing; this
    /// asserts the pipeline that actually ran changed.
    func testSettingTheGradeChangesWhichPipelineRuns() throws {
        let renderer = try makeRenderer()
        let target = try StudioTestPatternRenderer.makeOffscreenTarget(
            device: renderer.device, width: 64, height: 64)
        let source = try StudioTestMedia.makeFrameSource(
            lumaLevels: [32, 224], device: renderer.device)
        renderer.attach(source: source)
        let timebase = try XCTUnwrap(StudioTimebase(timescale: 600, frameDurationTicks: 20))
        let clock = StudioPlaybackClock(timebase: timebase, durationTicks: 600)

        renderer.grade = StudioGradeSettings()
        _ = renderer.render(snapshot: clock.snapshot(atHost: 0), to: target)
        XCTAssertEqual(
            renderer.videoRenderer.lastPipelineKind, .ungraded,
            "the default must still be a true bypass")

        var effect = StudioGradeSettings()
        effect.mode = .effect
        renderer.grade = effect
        _ = renderer.render(snapshot: clock.snapshot(atHost: 0), to: target)
        XCTAssertEqual(
            renderer.videoRenderer.lastPipelineKind, .graded,
            "setting the grade must change the program that RUNS — if this fails "
                + "the setting is decorative and the product is pinned to Original")

        var split = StudioGradeSettings()
        split.mode = .split
        renderer.grade = split
        _ = renderer.render(snapshot: clock.snapshot(atHost: 0), to: target)
        XCTAssertEqual(renderer.videoRenderer.lastPipelineKind, .split)
    }

    /// The resolve request the companion emits, against the NORMATIVE host
    /// shape in src/main/studio/StudioProtocol.ts (StudioResolveProposalParams).
    func testResolveProposalMatchesTheNormativeHostShape() throws {
        for (accept, expected) in [(true, "accept"), (false, "reject")] {
            let line = StudioProposalRequest.resolveProposal(
                proposalId: "p1", accept: accept, baseRevision: 9, requestId: 101)
            let json = try XCTUnwrap(
                try JSONSerialization.jsonObject(with: line) as? [String: Any])
            XCTAssertEqual(json["method"] as? String, "studio/resolveProposal")
            XCTAssertEqual(json["id"] as? Int, 101)
            let params = try XCTUnwrap(json["params"] as? [String: Any])
            XCTAssertEqual(params["schemaVersion"] as? Int, StudioEditProposal.schemaVersion)
            XCTAssertEqual(params["baseRevision"] as? Int, 9)
            XCTAssertEqual(params["proposalId"] as? String, "p1")
            XCTAssertEqual(
                params["decision"] as? String, expected,
                "the host contract spells these exactly; anything else is rejected")
        }
        // NDJSON framing: one line, newline-terminated.
        let line = StudioProposalRequest.resolveProposal(
            proposalId: "p1", accept: true, baseRevision: 1, requestId: 1)
        XCTAssertEqual(line.last, 0x0A)
        XCTAssertEqual(line.filter { $0 == 0x0A }.count, 1)
    }

    /// A resolve must never be mistaken for a propose: they share the writer and
    /// the id space, and confusing them would apply an edit nobody asked for.
    func testResolveIsNotAProposeEdit() throws {
        let line = StudioProposalRequest.resolveProposal(
            proposalId: "p1", accept: true, baseRevision: 1, requestId: 1)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: line) as? [String: Any])
        XCTAssertNotEqual(json["method"] as? String, "studio/proposeEdit")
        XCTAssertNotEqual(json["method"] as? String, "studio/applyEdit")
        let params = try XCTUnwrap(json["params"] as? [String: Any])
        XCTAssertNil(params["op"], "a resolve carries a decision, never an op")
    }

    /// THE DISPLAY-TRANSFORM REACHABILITY TEST — and lastPipelineKind is the
    /// WRONG instrument here.
    ///
    /// For the bypass, lastPipelineKind was right: neutral grading is
    /// bit-identical to no grading, so pixels could not distinguish them. For
    /// THIS claim it is exactly backwards — the program can switch while the
    /// picture stays put, and that inertness IS the defect. So this asserts
    /// pixels.
    func testEnablingTheDisplayTransformActuallyChangesThePicture() throws {
        let renderer = try makeRenderer()
        let target = try StudioTestPatternRenderer.makeOffscreenTarget(
            device: renderer.device, width: 64, height: 64)
        // A mid-grey: Rec.709 and sRGB differ most in shadows and measurably
        // here. Sampling where the two curves coincide would prove nothing.
        let source = try StudioTestMedia.makeFrameSource(
            lumaLevels: [96], device: renderer.device)
        renderer.attach(source: source)
        let timebase = try XCTUnwrap(StudioTimebase(timescale: 600, frameDurationTicks: 20))
        let clock = StudioPlaybackClock(timebase: timebase, durationTicks: 600)
        let snapshot = clock.snapshot(atHost: 0)

        var effect = StudioGradeSettings()
        effect.mode = .effect
        renderer.grade = effect
        _ = renderer.render(snapshot: snapshot, to: target)
        let inert = try StudioTestPatternRenderer.readPixel(from: target, x: 32, y: 32)

        effect.displayTransform = .rec709ToSRGB
        renderer.grade = effect
        _ = renderer.render(snapshot: snapshot, to: target)
        let transformed = try StudioTestPatternRenderer.readPixel(from: target, x: 32, y: 32)

        XCTAssertNotEqual(
            [inert.red, inert.green, inert.blue],
            [transformed.red, transformed.green, transformed.blue],
            "enabling the display transform did not move a single channel — the "
                + "HUD would claim Effect while the picture is untouched")
        // Direction matters: Rec.709 -> sRGB LIFTS shadows, so mid-grey must
        // come out brighter. An equality-only assertion would pass on a change
        // in the wrong direction.
        XCTAssertGreaterThan(transformed.red, inert.red)
    }

    /// The honesty guard, finally invoked — and it was wrong in the direction
    /// nobody checked.
    func testTheNeutralityGuardAccountsForWhetherALutIsActuallyLoaded() throws {
        let renderer = try makeRenderer()

        // DEFAULT settings, which is what the product uses: lutAmount is 1.0 but
        // no LUT is resident, so the picture is untouched and the guard must
        // say so. The old parameterless form returned false here.
        renderer.grade = StudioGradeSettings()
        XCTAssertTrue(
            renderer.isGradeNeutral,
            "default settings with no LUT leave the picture untouched")

        var transformed = StudioGradeSettings()
        transformed.displayTransform = .rec709ToSRGB
        renderer.grade = transformed
        XCTAssertFalse(renderer.isGradeNeutral, "a display transform is not a no-op")

        // And with a LUT resident, lutAmount decides.
        let identity = try StudioColorLut.parseCube(Self.identityCube)
        try renderer.setLut(identity)
        var withLut = StudioGradeSettings()
        renderer.grade = withLut
        XCTAssertFalse(renderer.isGradeNeutral, "a loaded LUT at full amount is not a no-op")
        withLut.lutAmount = 0
        renderer.grade = withLut
        XCTAssertTrue(renderer.isGradeNeutral, "a LUT at zero amount changes nothing")
    }

    private static let identityCube = """
        LUT_3D_SIZE 2
        0.0 0.0 0.0
        1.0 0.0 0.0
        0.0 1.0 0.0
        1.0 1.0 0.0
        0.0 0.0 1.0
        1.0 0.0 1.0
        0.0 1.0 1.0
        1.0 1.0 1.0
        """
}
