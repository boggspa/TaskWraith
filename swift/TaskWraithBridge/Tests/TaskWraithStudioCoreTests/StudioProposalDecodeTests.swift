import XCTest

@testable import TaskWraithStudioCore

/// Conformance to the NORMATIVE host contract in StudioProtocol.ts.
///
/// Decoding must fail CLOSED. A companion that shrugs at a renamed field
/// silently mis-renders someone's edit, and "the ghost did not appear" is an
/// impossible bug to diagnose from a silent nil.
final class StudioProposalDecodeTests: XCTestCase {
    private func rational(_ n: Int, _ d: Int) -> [String: Any] {
        ["n": NSNumber(value: n), "d": NSNumber(value: d)]
    }

    private func validOp() -> [String: Any] {
        [
            "type": "insert_range",
            "itemId": "item-1",
            "assetId": "asset-1",
            "sourceIn": rational(100, 30),
            "sourceOut": rational(140, 30),
            "at": rational(200, 30),
        ]
    }

    private func validProposal() -> [String: Any] {
        [
            "schemaVersion": 1,
            "proposalId": "p-1",
            "createdRevision": 7,
            "op": validOp(),
        ]
    }

    // MARK: - The happy path

    func testAProposeEditOperationDecodes() throws {
        let payload: [String: Any] = ["type": "propose_edit", "proposal": validProposal()]
        let proposal = try StudioProposalDecoder.proposal(fromProposeEdit: payload)
        XCTAssertEqual(proposal.proposalId, "p-1")
        XCTAssertEqual(proposal.createdRevision, 7)
        XCTAssertEqual(proposal.op.itemId, "item-1")
        XCTAssertEqual(proposal.op.assetId, "asset-1")
        XCTAssertEqual(proposal.op.sourceIn.n, 100)
        XCTAssertEqual(proposal.op.sourceIn.d, 30)
        XCTAssertNil(proposal.op.trackId, "trackId is optional in the contract")
    }

    func testAnOptionalTrackIdIsCarriedWhenPresent() throws {
        var op = validOp()
        op["trackId"] = "V2"
        var body = validProposal()
        body["op"] = op
        XCTAssertEqual(try StudioProposalDecoder.proposal(from: body).op.trackId, "V2")
    }

    // MARK: - Fail closed

    /// The host versions proposals INDEPENDENTLY of the wire protocol, so a
    /// future schema must be refused rather than partially understood — a
    /// half-decoded edit is worse than a rejected one.
    func testAnUnknownSchemaVersionIsRefused() {
        var body = validProposal()
        body["schemaVersion"] = 2
        XCTAssertThrowsError(try StudioProposalDecoder.proposal(from: body)) { error in
            XCTAssertEqual(
                error as? StudioProposalDecodeError,
                .unsupportedSchemaVersion(2)
            )
        }
    }

    /// Every required field, one at a time. A renamed field on the host side is
    /// the realistic failure, and each must name itself in the error.
    func testEveryRequiredFieldIsEnforcedAndNamed() {
        let required = ["schemaVersion", "proposalId", "createdRevision", "op"]
        for field in required {
            var body = validProposal()
            body.removeValue(forKey: field)
            XCTAssertThrowsError(
                try StudioProposalDecoder.proposal(from: body),
                "missing \(field) was accepted"
            ) { error in
                XCTAssertEqual(
                    error as? StudioProposalDecodeError,
                    .missingField(field),
                    "wrong error for missing \(field)"
                )
            }
        }
    }

    func testEveryRequiredOperationFieldIsEnforced() {
        let required = ["itemId", "assetId", "sourceIn", "sourceOut", "at"]
        for field in required {
            var op = validOp()
            op.removeValue(forKey: field)
            XCTAssertThrowsError(
                try StudioProposalDecoder.insertRange(from: op),
                "missing op.\(field) was accepted"
            )
        }
    }

    /// insert_range is the only StudioEditOp today. A later op type must produce
    /// a diagnosable refusal, not a ghost that quietly never draws.
    func testAnUnknownOperationTypeIsNamedInTheRefusal() {
        var op = validOp()
        op["type"] = "trim_item"
        XCTAssertThrowsError(try StudioProposalDecoder.insertRange(from: op)) { error in
            XCTAssertEqual(
                error as? StudioProposalDecodeError,
                .unsupportedOperation("trim_item")
            )
        }
    }

    func testANonProposalOperationIsDistinguishedFromAMalformedOne() {
        // open_media arrives on the SAME notification stream, so "not a
        // proposal" must be distinguishable from "a broken proposal".
        let payload: [String: Any] = ["type": "open_media", "asset": [:]]
        XCTAssertThrowsError(try StudioProposalDecoder.proposal(fromProposeEdit: payload)) {
            error in
            XCTAssertEqual(error as? StudioProposalDecodeError, .notAProposal)
        }
    }

    func testAZeroTimescaleIsRejectedRatherThanDividingByIt() {
        var op = validOp()
        op["at"] = rational(1, 0)
        XCTAssertThrowsError(try StudioProposalDecoder.insertRange(from: op)) { error in
            XCTAssertEqual(
                error as? StudioProposalDecodeError,
                .invalidRationalTime("op.at")
            )
        }
    }

    func testAStringWhereARationalBelongsIsRejected() {
        var op = validOp()
        op["sourceIn"] = "00:00:03:10"
        XCTAssertThrowsError(try StudioProposalDecoder.insertRange(from: op)) { error in
            XCTAssertEqual(
                error as? StudioProposalDecodeError,
                .missingField("op.sourceIn")
            )
        }
    }
}
