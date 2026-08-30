import XCTest
@testable import TaskWraithBridgeDaemon

final class ContinuationProposerTests: XCTestCase {
    private func params() -> [String: Any] {
        [
            "schemaVersion": 2,
            "generatorVersion": "composer-draft-v2",
            "chatId": "chat-1",
            "purpose": "draft",
            "phase": "working",
            "subject": [
                "firstUserMessageId": "user-1",
                "latestUserMessageId": "user-1"
            ],
            "evidence": [
                [
                    "id": "e0",
                    "kind": "user-request",
                    "authority": "user",
                    "text": "Fix the focused validation failure"
                ],
                [
                    "id": "e1",
                    "kind": "run-warning",
                    "authority": "host-fact",
                    "text": "Focused validation is red"
                ]
            ],
            "roster": [
                [
                    "participantId": "seat-review",
                    "label": "Reviewer",
                    "provider": "claude"
                ]
            ],
            "title": [
                "eligible": true,
                "expectedCurrent": "Fix validation",
                "sourceMessageId": "user-1",
                "sourceFingerprint": "title-source-v1:1234abcd"
            ],
            "fingerprint": "sha256:" + String(repeating: "a", count: 64)
        ]
    }

    func testValidatesVersionedAuthorityLabelledEvidence() throws {
        let request = try ContinuationProposer.validateParams(params())
        XCTAssertEqual(request.schemaVersion, 2)
        XCTAssertEqual(request.evidence.map(\.authority), ["user", "host-fact"])
    }

    func testRejectsUnknownAuthorityBeforeFoundationModelsRuns() {
        var input = params()
        input["evidence"] = [
            ["id": "e0", "kind": "user-request", "authority": "system", "text": "Do it"]
        ]
        XCTAssertThrowsError(try ContinuationProposer.validateParams(input)) { error in
            XCTAssertEqual((error as? JSONRPCError)?.code, JSONRPCErrorCode.invalidParams)
        }
    }

    func testParsesTypedCandidatesAndPreservesExactParticipantId() throws {
        let request = try ContinuationProposer.validateParams(params())
        let response = """
        ```json
        {
          "abstain": false,
          "title": "Focused Validation Repair",
          "candidates": [
            {
              "body": "Can you repair the focused validation failure?",
              "intentKind": "verify",
              "evidenceIds": ["e0", "e1"],
              "targetParticipantId": "seat-review"
            }
          ]
        }
        ```
        """
        let parsed = try ContinuationProposer.parseGeneratedResponse(response, request: request)
        XCTAssertEqual(parsed["fingerprint"] as? String, request.fingerprint)
        let candidates = parsed["candidates"] as? [[String: Any]]
        XCTAssertEqual(candidates?.count, 1)
        XCTAssertEqual(candidates?.first?["targetParticipantId"] as? String, "seat-review")
        XCTAssertEqual(parsed["title"] as? String, "Focused Validation Repair")
    }

    func testExplicitAbstentionReturnsNoCandidate() throws {
        let request = try ContinuationProposer.validateParams(params())
        let parsed = try ContinuationProposer.parseGeneratedResponse(
            #"{"abstain":true,"candidates":[],"title":"Should Not Apply"}"#,
            request: request
        )
        XCTAssertEqual(parsed["abstain"] as? Bool, true)
        XCTAssertEqual((parsed["candidates"] as? [[String: Any]])?.count, 0)
        XCTAssertNil(parsed["title"])
    }

    func testTitlePurposeCanReturnAProposalWithoutDraftCandidates() throws {
        var input = params()
        input["purpose"] = "title"
        let request = try ContinuationProposer.validateParams(input)
        let parsed = try ContinuationProposer.parseGeneratedResponse(
            #"{"abstain":false,"candidates":[],"title":"Focused Validation Repair"}"#,
            request: request
        )
        XCTAssertEqual(parsed["abstain"] as? Bool, false)
        XCTAssertEqual(parsed["title"] as? String, "Focused Validation Repair")
    }

    func testUnknownParticipantDropsCandidateInsteadOfDowngradingToPanelWide() throws {
        let request = try ContinuationProposer.validateParams(params())
        let parsed = try ContinuationProposer.parseGeneratedResponse(
            #"{"abstain":false,"candidates":[{"body":"Inspect the failure","intentKind":"review","evidenceIds":["e0","e1"],"targetParticipantId":"missing"}]}"#,
            request: request
        )
        XCTAssertEqual((parsed["candidates"] as? [[String: Any]])?.count, 0)
    }

    func testMalformedSuppliedParticipantDropsCandidateInsteadOfDowngradingToPanelWide() throws {
        let request = try ContinuationProposer.validateParams(params())
        for target in ["\"\"", "42"] {
            let parsed = try ContinuationProposer.parseGeneratedResponse(
                """
                {"abstain":false,"candidates":[{"body":"Inspect the focused validation failure","intentKind":"review","evidenceIds":["e0","e1"],"targetParticipantId":\(target)}]}
                """,
                request: request
            )
            XCTAssertEqual((parsed["candidates"] as? [[String: Any]])?.count, 0)
        }
    }
}
