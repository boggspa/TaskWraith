import XCTest
@testable import TaskWraithStudioCore

final class StudioCompanionTests: XCTestCase {
    func testHelloGetDocumentRoundTrip() async {
        let decoder = StudioNdjsonDecoder()
        let encoder = JSONEncoder()
        let errorProvider = StudioErrorCodeProvider.shared

        // Companion hello
        let hello = StudioMessage(
            jsonrpc: "2.0",
            id: 1,
            method: "studio/hello",
            params: ["protocolVersion": AnyCodable("1.0.0")],
            result: nil,
            error: nil
        )
        let helloData = try! encoder.encode(hello)
        let helloEvents = decoder.push(chunk: helloData)
        let decodedHello = helloEvents.first { event in
            if case .message(let message) = event {
                return message.method == "studio/hello"
            }
            return false
        }
        XCTAssertNotNil(decodedHello)

        // Host getDocument response
        let getDocResponse = StudioMessage(
            jsonrpc: "2.0",
            id: 1,
            method: nil,
            params: nil,
            result: AnyCodable(["document": ["id": AnyCodable("default"), "baseRevision": AnyCodable("abc123")]]),
            error: nil
        )
        let getDocData = try! encoder.encode(getDocResponse)
        let getDocEvents = decoder.push(chunk: getDocData)
        let decodedGetDoc = getDocEvents.first { event in
            if case .message(let message) = event {
                if let resultDict = message.result?.value as? [String: Any],
                   let documentDict = resultDict["document"] as? [String: Any] {
                    return documentDict["baseRevision"] as? String == "abc123"
                }
            }
            return false
        }
        XCTAssertNotNil(decodedGetDoc)

        // Error code conformance
        let staleBaseCode = await errorProvider.errorNumber(for: .staleBase)
        XCTAssertEqual(staleBaseCode, 4001)
    }

    func testEOFBehavior() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/swift")
        process.arguments = ["run", "TaskWraithStudioCompanion"]
        process.standardInput = FileHandle.nullDevice
        try! process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)
    }
}