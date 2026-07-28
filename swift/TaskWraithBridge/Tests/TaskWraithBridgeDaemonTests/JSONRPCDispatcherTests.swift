import Foundation
import XCTest
@testable import TaskWraithBridgeDaemon

final class JSONRPCDispatcherTests: XCTestCase {
    func testAttachmentDeniedUsesDistinctStructuredError() throws {
        let dispatcher = JSONRPCDispatcher()
        dispatcher.register("test.denied") { _ in
            throw JSONRPCError.attachmentDenied("Wrong consent scope")
        }

        let error = try errorPayload(
            dispatcher.handleLine(
                #"{"jsonrpc":"2.0","id":1,"method":"test.denied","params":{}}"#
            )
        )
        XCTAssertEqual(error["code"] as? Int, JSONRPCErrorCode.attachmentDenied)
        XCTAssertEqual(error["message"] as? String, "Wrong consent scope")
        XCTAssertEqual((error["data"] as? [String: Any])?["kind"] as? String, "attachmentDenied")
    }

    func testAttachmentRevokedUsesDistinctStructuredError() throws {
        let dispatcher = JSONRPCDispatcher()
        dispatcher.register("test.revoked") { _ in
            throw JSONRPCError.attachmentRevoked("Consent was replaced")
        }

        let error = try errorPayload(
            dispatcher.handleLine(
                #"{"jsonrpc":"2.0","id":2,"method":"test.revoked","params":{}}"#
            )
        )
        XCTAssertEqual(error["code"] as? Int, JSONRPCErrorCode.attachmentRevoked)
        XCTAssertEqual(error["message"] as? String, "Consent was replaced")
        XCTAssertEqual((error["data"] as? [String: Any])?["kind"] as? String, "attachmentRevoked")
    }

    private func errorPayload(_ line: String?) throws -> [String: Any] {
        let line = try XCTUnwrap(line)
        let data = try XCTUnwrap(line.data(using: .utf8))
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        return try XCTUnwrap(object["error"] as? [String: Any])
    }
}
