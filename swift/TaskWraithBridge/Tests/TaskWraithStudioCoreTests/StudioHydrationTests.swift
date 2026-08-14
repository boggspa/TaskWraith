import XCTest

@testable import TaskWraithStudioCore

/// Reconnect recovery, which was a CLAIM rather than a behaviour until this.
///
/// The companion hydrated to the correct revision number and then threw the
/// document away, so a restarted viewer showed nothing: no media reopened, no
/// ghosts reappeared, no transcript. The host had held all of it durably since
/// the proposal and transcript slices landed.
final class StudioHydrationTests: XCTestCase {
    private func helloResponse() throws -> Data {
        try line(["jsonrpc": "2.0", "id": 1, "result": ["protocolVersion": 1]])
    }

    private func documentResponse(_ document: [String: Any], revision: Int = 5) throws -> Data {
        try line([
            "jsonrpc": "2.0",
            "id": 2,
            "result": ["revision": revision, "document": document],
        ])
    }

    private func line(_ object: [String: Any]) throws -> Data {
        var data = try JSONSerialization.data(withJSONObject: object)
        data.append(0x0A)
        return data
    }

    private func fullDocument() -> [String: Any] {
        [
            "formatVersion": 3,
            "assets": [
                ["assetId": "asset-1", "path": "/tmp/a.mov", "mediaKind": "video"],
                ["assetId": "asset-2", "path": "/tmp/b.mov", "mediaKind": "video"],
            ],
            "proposals": [
                [
                    "schemaVersion": 1,
                    "proposalId": "p-1",
                    "createdRevision": 3,
                    "op": [
                        "type": "insert_range",
                        "itemId": "i-1",
                        "assetId": "asset-2",
                        "sourceIn": ["n": 0, "d": 30],
                        "sourceOut": ["n": 60, "d": 30],
                        "at": ["n": 90, "d": 30],
                    ],
                ]
            ],
            "transcripts": [
                [
                    "schemaVersion": 1,
                    "transcriptId": "t-1",
                    "assetId": "asset-1",
                    "localeIdentifier": "en-GB",
                    "segments": [
                        [
                            "segmentId": "s-1",
                            "text": "hello",
                            "sourceIn": ["n": 0, "d": 30],
                            "sourceOut": ["n": 30, "d": 30],
                            "confidence": 0.91,
                        ]
                    ],
                ]
            ],
            "tracks": [],
        ]
    }

    /// Drives the real hello -> getDocument handshake.
    private func hydrate(document: [String: Any]) throws -> StudioCompanionSession {
        let session = StudioCompanionSession()
        _ = session.consume(chunk: Data())
        _ = session.consume(chunk: try helloResponse())
        _ = session.consume(chunk: try documentResponse(document))
        return session
    }

    // MARK: - The defect

    func testReconnectRestoresAssetsProposalsAndTranscripts() throws {
        let session = try hydrate(document: fullDocument())
        let hydrated = try XCTUnwrap(
            session.hydrated,
            "hydration dropped the document; a restarted viewer would show nothing"
        )
        XCTAssertEqual(hydrated.assets.map(\.assetId), ["asset-1", "asset-2"])
        XCTAssertEqual(hydrated.proposals.map(\.proposalId), ["p-1"])
        XCTAssertEqual(hydrated.transcripts.map(\.transcriptId), ["t-1"])
        XCTAssertEqual(session.documentRevision, 5)
    }

    /// A recovered proposal must be USABLE, not merely present — it has to reach
    /// drawable geometry, which is the whole point of recovering it.
    func testARecoveredProposalBecomesDrawableGeometry() throws {
        let session = try hydrate(document: fullDocument())
        let proposal = try XCTUnwrap(session.hydrated?.proposals.first)
        let timebase = StudioTimebase(timescale: 30, frameDurationTicks: 1)!
        let timeline = try XCTUnwrap(
            StudioProposedTimeline(proposal: proposal, timebase: timebase)
        )
        let ghost = timeline.ghost(in: .proposed)
        XCTAssertEqual(ghost.startTicks, 90)
        XCTAssertEqual(ghost.endTicks, 150)
    }

    // MARK: - Partial and degenerate documents

    /// ONE unreadable ghost must not cost the operator their media and their
    /// transcript too. Partial recovery beats none.
    func testAMalformedEntryIsSkippedWithoutLosingTheRest() throws {
        var document = fullDocument()
        document["proposals"] = [
            ["schemaVersion": 99, "proposalId": "future"],
            (document["proposals"] as! [[String: Any]])[0],
        ]
        let session = try hydrate(document: document)
        let hydrated = try XCTUnwrap(session.hydrated)
        XCTAssertEqual(hydrated.proposals.map(\.proposalId), ["p-1"], "the good ghost survived")
        XCTAssertEqual(hydrated.assets.count, 2, "media must not be lost to a bad ghost")
        XCTAssertEqual(hydrated.transcripts.count, 1)
    }

    func testAnEmptyDocumentHydratesCleanly() throws {
        let session = try hydrate(
            document: [
                "formatVersion": 3, "assets": [], "proposals": [], "transcripts": [], "tracks": [],
            ]
        )
        let hydrated = try XCTUnwrap(session.hydrated)
        XCTAssertTrue(hydrated.isEmpty)
    }

    /// An older host that sends no document at all must still hydrate rather
    /// than refusing to start — the revision is what the handshake requires.
    func testAMissingDocumentStillCompletesHydration() throws {
        let session = StudioCompanionSession()
        _ = session.consume(chunk: Data())
        _ = session.consume(chunk: try helloResponse())
        let step = session.consume(
            chunk: try line(["jsonrpc": "2.0", "id": 2, "result": ["revision": 5]])
        )
        XCTAssertNil(step.exitCode, "a document-less response must not kill the companion")
        XCTAssertEqual(session.documentRevision, 5)
        XCTAssertEqual(session.hydrated, .empty)
    }

    func testHydrationIsNilBeforeTheDocumentResponse() throws {
        let session = StudioCompanionSession()
        _ = session.consume(chunk: Data())
        _ = session.consume(chunk: try helloResponse())
        // Nil and empty are different claims: one means "not yet asked", the
        // other means "asked, and the host has nothing".
        XCTAssertNil(session.hydrated)
    }

    // MARK: - Live transcript commits

    func testASetTranscriptCommitSurfacesTheTranscript() throws {
        let session = try hydrate(document: fullDocument())
        let step = session.consume(
            chunk: try line([
                "jsonrpc": "2.0",
                "method": "studio/editCommitted",
                "params": [
                    "revision": 6,
                    "op": [
                        "type": "set_transcript",
                        "transcript": [
                            "schemaVersion": 1,
                            "transcriptId": "t-2",
                            "assetId": "asset-1",
                            "segments": [
                                [
                                    "segmentId": "s-9",
                                    "text": "later",
                                    "sourceIn": ["n": 60, "d": 30],
                                    "sourceOut": ["n": 90, "d": 30],
                                ]
                            ],
                        ],
                    ],
                ],
            ])
        )
        XCTAssertEqual(step.transcripts.map(\.transcriptId), ["t-2"])
        XCTAssertEqual(session.transcriptCount, 1)
        // And it is still not a proposal, despite sharing the notification.
        XCTAssertTrue(step.proposals.isEmpty)
    }

    func testEffectPreviewHydrationAndCommittedSetClearAreExplicit() throws {
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
        let preview: [String: Any] = [
            "schemaVersion": 1,
            "effectId": StudioEffectPreview.effectId(forCubeText: cubeText),
            "cubeByteLength": cubeText.lengthOfBytes(using: .utf8),
            "cubeText": cubeText,
        ]
        let expected = try StudioEffectPreview.decode(from: preview)
        var document = fullDocument()
        document["effectPreview"] = preview
        let session = try hydrate(document: document)
        XCTAssertEqual(session.hydrated?.effectPreview, .set(expected))

        let set = session.consume(
            chunk: try line([
                "jsonrpc": "2.0",
                "method": "studio/editCommitted",
                "params": [
                    "revision": 6,
                    "op": ["type": "set_effect_preview", "effectPreview": preview],
                ],
            ])
        )
        XCTAssertEqual(set.effectPreview, .set(expected))

        let clear = session.consume(
            chunk: try line([
                "jsonrpc": "2.0",
                "method": "studio/editCommitted",
                "params": [
                    "revision": 7,
                    "op": ["type": "set_effect_preview", "effectPreview": NSNull()],
                ],
            ])
        )
        XCTAssertEqual(clear.effectPreview, .clear)

        let encodedNull = try JSONEncoder().encode(AnyCodable(NSNull()))
        XCTAssertEqual(String(data: encodedNull, encoding: .utf8), "null")
        let decodedNull = try JSONDecoder().decode(AnyCodable.self, from: encodedNull)
        XCTAssertTrue(decodedNull.value is NSNull)

        var wrongHash = preview
        wrongHash["effectId"] = String(repeating: "a", count: 64)
        let rejectedHash = session.consume(
            chunk: try line([
                "jsonrpc": "2.0",
                "method": "studio/editCommitted",
                "params": [
                    "revision": 8,
                    "op": ["type": "set_effect_preview", "effectPreview": wrongHash],
                ],
            ])
        )
        if case .rejected = rejectedHash.effectPreview {
            XCTAssertEqual(rejectedHash.protocolErrors.count, 1)
        } else {
            XCTFail("a wrong effectId must be held as a rejected replacement")
        }

        var wrongLength = preview
        wrongLength["cubeByteLength"] = 1
        let rejectedLength = session.consume(
            chunk: try line([
                "jsonrpc": "2.0",
                "method": "studio/editCommitted",
                "params": [
                    "revision": 9,
                    "op": ["type": "set_effect_preview", "effectPreview": wrongLength],
                ],
            ])
        )
        if case .rejected = rejectedLength.effectPreview {
            XCTAssertEqual(rejectedLength.protocolErrors.count, 1)
        } else {
            XCTFail("a wrong UTF-8 length must be held as a rejected replacement")
        }
    }
}
