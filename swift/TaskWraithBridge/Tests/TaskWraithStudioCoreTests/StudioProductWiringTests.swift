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
}
