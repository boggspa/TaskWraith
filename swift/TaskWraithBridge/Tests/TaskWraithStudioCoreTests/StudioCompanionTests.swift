import XCTest
@testable import TaskWraithStudioCore

/// Deterministic, in-process coverage for the companion state machine and its
/// conformance to the normative TS protocol (src/main/studio/StudioProtocol.ts).
///
/// Deliberately NO nested `swift run` / `swift build` in here: a nested build
/// deadlocks against the outer test invocation's build lock (previously
/// observed as an indefinite `swift test` timeout). Process-level end-to-end
/// coverage runs from the host side instead, via the gated
/// StudioCompanionSwiftInterop vitest that drives the built binary under
/// StudioCompanionSupervisor.
final class StudioCompanionTests: XCTestCase {
    private func jsonObject(from line: Data) throws -> [String: Any] {
        var data = line
        if data.last == 0x0A {
            data.removeLast()
        }
        let object = try JSONSerialization.jsonObject(with: data)
        return (object as? [String: Any]) ?? [:]
    }

    private func line(_ object: [String: Any]) -> Data {
        var data = try! JSONSerialization.data(withJSONObject: object)
        data.append(0x0A)
        return data
    }

    private func helloResponseLine(revision: Int = 0) -> Data {
        line([
            "jsonrpc": "2.0",
            "id": 1,
            "result": [
                "protocolVersion": 1,
                "server": "taskwraith-studio-host",
                "revision": revision
            ]
        ])
    }

    private func documentResponseLine(revision: Int) -> Data {
        line([
            "jsonrpc": "2.0",
            "id": 2,
            "result": [
                "revision": revision,
                "document": ["formatVersion": 1, "tracks": [[String: Any]]()]
            ]
        ])
    }

    func testHelloIsFirstAndCarriesNumericProtocolVersion() throws {
        let session = StudioCompanionSession()
        let start = session.startLines()
        XCTAssertEqual(start.count, 1)
        let hello = try jsonObject(from: start[0])
        XCTAssertEqual(hello["jsonrpc"] as? String, "2.0")
        XCTAssertEqual(hello["id"] as? Int, 1)
        XCTAssertEqual(hello["method"] as? String, "studio/hello")
        let params = hello["params"] as? [String: Any]
        // Numeric 1, never "1.0.0": the TS dispatcher requires a number, so a
        // string version can never hydrate. This is the drift the previous
        // companion commit shipped.
        XCTAssertEqual(params?["protocolVersion"] as? Int, 1)
        XCTAssertNil(params?["protocolVersion"] as? String)
    }

    func testHydratesAcrossChunkSplitInsideMultiByteUtf8() throws {
        let session = StudioCompanionSession()
        _ = session.startLines()

        let response = line([
            "jsonrpc": "2.0",
            "id": 1,
            "result": [
                "protocolVersion": 1,
                "server": "taskwraith-studio-host 🎬",
                "revision": 0
            ]
        ])
        guard let emojiFirstByte = response.firstIndex(of: 0xF0) else {
            XCTFail("fixture should contain a 4-byte UTF-8 scalar")
            return
        }
        let splitIndex = emojiFirstByte + 2

        let first = session.consume(chunk: response.subdata(in: 0..<splitIndex))
        XCTAssertTrue(first.outboundLines.isEmpty)
        XCTAssertEqual(first.protocolErrors, [])
        XCTAssertNil(first.exitCode)

        let second = session.consume(chunk: response.subdata(in: splitIndex..<response.count))
        XCTAssertEqual(second.protocolErrors, [])
        XCTAssertEqual(second.outboundLines.count, 1)
        let getDocument = try jsonObject(from: second.outboundLines[0])
        XCTAssertEqual(getDocument["jsonrpc"] as? String, "2.0")
        XCTAssertEqual(getDocument["id"] as? Int, 2)
        XCTAssertEqual(getDocument["method"] as? String, "studio/getDocument")
        XCTAssertEqual(session.phase, .awaitingDocumentResponse)

        let third = session.consume(chunk: documentResponseLine(revision: 7))
        XCTAssertNil(third.exitCode)
        XCTAssertEqual(third.protocolErrors, [])
        XCTAssertEqual(session.phase, .hydrated)
        XCTAssertEqual(session.documentRevision, 7)
        XCTAssertEqual(session.eofExitCode(), 0)
    }

    func testToleratesCrlfAndGarbageLinesWithoutDying() throws {
        let session = StudioCompanionSession()
        _ = session.startLines()

        let garbage = session.consume(chunk: Data("this is not json\r\n".utf8))
        XCTAssertEqual(garbage.protocolErrors.count, 1)
        XCTAssertNil(garbage.exitCode)
        XCTAssertEqual(session.phase, .awaitingHelloResponse)

        var crlfResponse = try! JSONSerialization.data(withJSONObject: [
            "jsonrpc": "2.0",
            "id": 1,
            "result": ["protocolVersion": 1, "server": "host", "revision": 0]
        ])
        crlfResponse.append(0x0D)
        crlfResponse.append(0x0A)
        let step = session.consume(chunk: crlfResponse)
        XCTAssertEqual(step.protocolErrors, [])
        XCTAssertEqual(step.outboundLines.count, 1)
        XCTAssertEqual(session.phase, .awaitingDocumentResponse)
    }

    func testHelloErrorResponseExitsTwo() {
        let session = StudioCompanionSession()
        _ = session.startLines()
        let step = session.consume(
            chunk: line([
                "jsonrpc": "2.0",
                "id": 1,
                "error": [
                    "code": 4007,
                    "message": "unsupported",
                    "data": ["studioCode": "unsupported_protocol_version"]
                ]
            ])
        )
        XCTAssertEqual(step.exitCode, 2)
    }

    func testMalformedStringVersionInHelloResultExitsThree() {
        let session = StudioCompanionSession()
        _ = session.startLines()
        let step = session.consume(
            chunk: line([
                "jsonrpc": "2.0",
                "id": 1,
                "result": ["protocolVersion": "1.0.0", "server": "host", "revision": 0]
            ])
        )
        XCTAssertEqual(step.exitCode, 3)
    }

    func testDocumentErrorResponseExitsFour() {
        let session = StudioCompanionSession()
        _ = session.startLines()
        _ = session.consume(chunk: helloResponseLine())
        let step = session.consume(
            chunk: line([
                "jsonrpc": "2.0",
                "id": 2,
                "error": ["code": 4008, "message": "store failure", "data": ["studioCode": "store_failure"]]
            ])
        )
        XCTAssertEqual(step.exitCode, 4)
    }

    func testPrematureEofExitsFive() {
        let beforeHello = StudioCompanionSession()
        _ = beforeHello.startLines()
        XCTAssertEqual(beforeHello.eofExitCode(), 5)

        let beforeDocument = StudioCompanionSession()
        _ = beforeDocument.startLines()
        _ = beforeDocument.consume(chunk: helloResponseLine())
        XCTAssertEqual(beforeDocument.eofExitCode(), 5)
    }

    func testHydrateOnceRequestsExitZeroAfterDocumentResponse() {
        let session = StudioCompanionSession(hydrateOnce: true)
        _ = session.startLines()
        _ = session.consume(chunk: helloResponseLine())
        let step = session.consume(chunk: documentResponseLine(revision: 3))
        XCTAssertEqual(step.exitCode, 0)
        XCTAssertEqual(session.phase, .hydrated)
        XCTAssertEqual(session.documentRevision, 3)
    }

    func testEditCommittedNotificationsAreCountedWhileResident() {
        let session = StudioCompanionSession()
        _ = session.startLines()
        _ = session.consume(chunk: helloResponseLine())
        _ = session.consume(chunk: documentResponseLine(revision: 1))
        let step = session.consume(
            chunk: line([
                "jsonrpc": "2.0",
                "method": "studio/editCommitted",
                "params": ["revision": 2, "op": ["type": "insert_range"]]
            ])
        )
        XCTAssertNil(step.exitCode)
        XCTAssertTrue(step.outboundLines.isEmpty)
        XCTAssertEqual(session.editCommittedCount, 1)
        XCTAssertEqual(session.eofExitCode(), 0)
    }

    func testErrorCodeTableMatchesNormativeSpec() async {
        let provider = StudioErrorCodeProvider.shared
        let expected: [(StudioErrorCode, Int)] = [
            (.parseError, -32700),
            (.invalidRequest, -32600),
            (.methodNotFound, -32601),
            (.invalidParams, -32602),
            (.staleBase, 4001),
            (.invalidOp, 4002),
            (.insertionInsideItem, 4003),
            (.duplicateItem, 4004),
            (.unrepresentableTime, 4005),
            (.misalignedTime, 4006),
            (.unsupportedProtocolVersion, 4007),
            (.storeFailure, 4008)
        ]
        for (code, number) in expected {
            let actual = await provider.errorNumber(for: code)
            XCTAssertEqual(actual, number, "\(code.rawValue) must map to \(number)")
        }
    }
}
