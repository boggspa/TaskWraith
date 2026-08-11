import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Remote terminal actions")
struct TerminalActionTests {
    private func payload(_ params: [String: Any]) throws -> [String: Any] {
        let base64 = try #require(params["payloadBase64"] as? String)
        let data = try #require(Data(base64Encoded: base64))
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test func openAlwaysCarriesTheElevationReceipt() throws {
        // The receipt is not optional and not settable false — the builder
        // exists only behind the elevation sheet, so the frame says so.
        let open = try payload(BridgeAction.terminalOpen(workspaceId: "ws-1", cols: 100, rows: 30))
        #expect(open["kind"] as? String == "terminalOpen")
        #expect(open["elevationAcknowledged"] as? Bool == true)
        #expect(open["cols"] as? Int == 100)
        #expect(open["workspaceId"] as? String == "ws-1")
        // No path anywhere in the contract — workspaces travel by ID only.
        #expect(open["path"] == nil)
        #expect(open["workspacePath"] == nil)
    }

    @Test func inputReadAndCloseCarryTheSessionContract() throws {
        let input = try payload(
            BridgeAction.terminalInput(
                workspaceId: "ws-1", terminalId: "terminal-abc",
                dataBase64: Data("ls\n".utf8).base64EncodedString()))
        #expect(input["terminalId"] as? String == "terminal-abc")
        #expect(input["dataBase64"] as? String == Data("ls\n".utf8).base64EncodedString())

        let read = try payload(
            BridgeAction.terminalRead(workspaceId: "ws-1", terminalId: "terminal-abc", afterSeq: 7))
        #expect(read["afterSeq"] as? Int == 7)

        let close = try payload(
            BridgeAction.terminalClose(workspaceId: "ws-1", terminalId: "terminal-abc"))
        #expect(close["kind"] as? String == "terminalClose")
    }

    @Test func readAckDecodesChunksInSequence() throws {
        let json = """
            {"ok":true,"data":{"terminalId":"terminal-abc",
             "terminalChunks":[{"seq":1,"dataBase64":"aGVsbG8g"},{"seq":2,"dataBase64":"d29ybGQ="}],
             "terminalLatestSeq":2,"terminalExited":false}}
            """
        let ack = try JSONDecoder().decode(BridgeActionAck.self, from: Data(json.utf8))
        #expect(ack.data?.terminalId == "terminal-abc")
        #expect(ack.data?.terminalChunks?.map(\.seq) == [1, 2])
        #expect(ack.data?.terminalLatestSeq == 2)
        #expect(ack.data?.terminalExited == false)
    }
}
