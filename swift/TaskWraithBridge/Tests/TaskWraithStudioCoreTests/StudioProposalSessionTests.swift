import XCTest

@testable import TaskWraithStudioCore

/// The last hop for outcome 6's client half: a host `propose_edit` commit must
/// end as drawable ghost geometry.
///
/// Shaped like the acceptance path rather than as three isolated unit tests,
/// because the interesting failures live in the joins — a decoder that works, a
/// timeline that works, and a session that never hands one to the other would
/// leave every unit test green and no ghost on screen.
final class StudioProposalSessionTests: XCTestCase {
    private let timebase = StudioTimebase(timescale: 30, frameDurationTicks: 1)!

    private func line(_ op: [String: Any], revision: Int = 2) throws -> Data {
        let payload: [String: Any] = [
            "jsonrpc": "2.0",
            "method": "studio/editCommitted",
            "params": ["revision": revision, "op": op],
        ]
        var data = try JSONSerialization.data(withJSONObject: payload)
        data.append(0x0A)
        return data
    }

    private func proposeOp(proposalId: String = "p-1") -> [String: Any] {
        [
            "type": "propose_edit",
            "proposal": [
                "schemaVersion": 1,
                "proposalId": proposalId,
                "createdRevision": 2,
                "op": [
                    "type": "insert_range",
                    "itemId": "item-1",
                    "assetId": "asset-1",
                    "sourceIn": ["n": 100, "d": 30],
                    "sourceOut": ["n": 140, "d": 30],
                    "at": ["n": 200, "d": 30],
                ],
            ],
        ]
    }

    // MARK: - End to end

    func testAProposeEditCommitBecomesDrawableGhostGeometry() throws {
        let session = StudioCompanionSession()
        let step = session.consume(chunk: try line(proposeOp()))

        XCTAssertEqual(step.proposals.count, 1)
        XCTAssertEqual(session.proposalCount, 1)
        let proposal = try XCTUnwrap(step.proposals.first)

        let timeline = try XCTUnwrap(
            StudioProposedTimeline(proposal: proposal, timebase: timebase)
        )
        let ghost = timeline.ghost(in: .proposed)
        XCTAssertEqual(ghost.startTicks, 200)
        XCTAssertEqual(ghost.endTicks, 240)
        XCTAssertEqual(ghost.proposalId, "p-1")

        // And it reaches the overlay as an actual drawn rect.
        var state = StudioOverlayState(
            viewport: StudioOverlayViewport(width: 1920, height: 1080, scale: 2),
            durationTicks: 300
        )
        state.ghosts = [ghost]
        state.reviewVersion = .proposed
        let model = StudioOverlayLayout.build(state)
        XCTAssertNotNil(model.rects.first { $0.color == StudioOverlayColor.ghost })
    }

    /// A resolved ghost must stop being drawn whichever way it went: an accepted
    /// proposal is now part of the sequence, and a rejected one never will be.
    /// Leaving it up would show phantom material in both cases.
    func testResolvingAProposalIsReportedForBothDecisions() throws {
        for decision in ["accept", "reject"] {
            let session = StudioCompanionSession()
            _ = session.consume(chunk: try line(proposeOp()))
            let step = session.consume(
                chunk: try line(
                    ["type": "resolve_proposal", "proposalId": "p-1", "decision": decision],
                    revision: 3
                )
            )
            XCTAssertEqual(step.resolvedProposalIds, ["p-1"], "decision \(decision)")
            XCTAssertEqual(session.resolvedProposalCount, 1)
        }
    }

    // MARK: - Operations sharing the notification

    /// open_media, insert_range and propose_edit all arrive on the SAME
    /// notification. Each must be recognised only by the others' absence of a
    /// discriminator, never by a field that happens to be present.
    func testOtherOperationsOnTheSameNotificationSurfaceNoProposal() throws {
        let session = StudioCompanionSession()

        let openMedia = try line([
            "type": "open_media",
            "asset": ["assetId": "a-1", "path": "/tmp/x.mov", "mediaKind": "video"],
        ])
        let openStep = session.consume(chunk: openMedia)
        XCTAssertTrue(openStep.proposals.isEmpty)
        XCTAssertTrue(openStep.resolvedProposalIds.isEmpty)
        XCTAssertEqual(openStep.openedAssets.count, 1, "open_media must still work")

        let insert = try line([
            "type": "insert_range",
            "itemId": "i-1",
            "assetId": "a-1",
            "sourceIn": ["n": 0, "d": 30],
            "sourceOut": ["n": 30, "d": 30],
            "at": ["n": 0, "d": 30],
        ])
        let insertStep = session.consume(chunk: insert)
        XCTAssertTrue(
            insertStep.proposals.isEmpty,
            "a direct insert_range is not a proposal"
        )
    }

    /// A malformed proposal must not take the session down or be silently
    /// counted. The companion stays resident and the ghost simply does not
    /// appear, which is the honest outcome for material it cannot understand.
    func testAMalformedProposalIsSkippedWithoutKillingTheSession() throws {
        let session = StudioCompanionSession()
        let step = session.consume(
            chunk: try line([
                "type": "propose_edit",
                "proposal": ["schemaVersion": 99, "proposalId": "bad"],
            ])
        )
        XCTAssertTrue(step.proposals.isEmpty)
        XCTAssertEqual(session.proposalCount, 0)
        XCTAssertNil(step.exitCode, "the session must stay resident")
        // It still counts as a commit, because the host did commit something.
        XCTAssertEqual(session.editCommittedCount, 1)
    }

    func testSeveralProposalsInOneChunkAllSurface() throws {
        let session = StudioCompanionSession()
        var chunk = try line(proposeOp(proposalId: "p-1"))
        chunk.append(try line(proposeOp(proposalId: "p-2"), revision: 3))
        let step = session.consume(chunk: chunk)
        XCTAssertEqual(step.proposals.map(\.proposalId), ["p-1", "p-2"])
        XCTAssertEqual(session.proposalCount, 2)
    }

    /// The session holds no proposal state of its own. Durable proposal state is
    /// the HOST's, and re-deriving it here would create a second source of truth
    /// that can disagree after a restart.
    func testTheSessionKeepsCountsButNotProposalState() throws {
        let session = StudioCompanionSession()
        _ = session.consume(chunk: try line(proposeOp()))
        XCTAssertEqual(session.proposalCount, 1)
        // Counters only — no accessor returns a live proposal set, by design.
        XCTAssertEqual(session.resolvedProposalCount, 0)
    }
}
