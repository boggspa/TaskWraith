import Foundation
import Testing

@testable import TaskWraithKit

@Suite("threadMessage bridge action")
struct ThreadMessageActionTests {
    private func payload(_ params: [String: Any]) throws -> [String: Any] {
        let base64 = try #require(params["payloadBase64"] as? String)
        let data = try #require(Data(base64Encoded: base64))
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("threadMessage encodes the send with an exact target id")
    func encodesSend() throws {
        let params = BridgeAction.threadMessage(
            workspaceId: "ws-1",
            threadId: "t-from",
            toThreadId: "t-to",
            message: "The byte budget assertion is red on master.")
        let payload = try payload(params)
        #expect(payload["kind"] as? String == "threadMessage")
        #expect(payload["workspaceId"] as? String == "ws-1")
        #expect(payload["threadId"] as? String == "t-from")
        #expect(payload["toThreadId"] as? String == "t-to")
        #expect(payload["message"] as? String == "The byte budget assertion is red on master.")
        #expect(payload["actionId"] as? String != nil)
    }

    /// The Mac's gate DENIES a remote wake outright, so the wire format must not be
    /// able to express one. If a `wake` key ever appears here, the Mac validator
    /// rejects the whole action — this pins the absence rather than trusting it.
    @Test("threadMessage never emits a wake key")
    func neverEmitsWake() throws {
        let payload = try payload(
            BridgeAction.threadMessage(
                workspaceId: "ws-1", threadId: "t-from", toThreadId: "t-to", message: "hi"))
        #expect(payload["wake"] == nil)
        #expect(payload.keys.contains { $0.lowercased().contains("wake") } == false)
    }

    @Test("threadMessage carries an idempotency key when given one")
    func carriesIdempotencyKey() throws {
        let payload = try payload(
            BridgeAction.threadMessage(
                workspaceId: "ws-1", threadId: "t-from", toThreadId: "t-to", message: "hi",
                idempotencyKey: "tm-42"))
        #expect(payload["idempotencyKey"] as? String == "tm-42")
    }

    // An empty key is the same as no key: sending `""` would make every retry look
    // like the same message to some validators and like none to others.
    @Test("threadMessage omits a blank idempotency key")
    func omitsBlankIdempotencyKey() throws {
        let payload = try payload(
            BridgeAction.threadMessage(
                workspaceId: "ws-1", threadId: "t-from", toThreadId: "t-to", message: "hi",
                idempotencyKey: ""))
        #expect(payload["idempotencyKey"] == nil)
    }
}

@Suite("peer thread-message inbox decode")
struct ThreadMessageInboxDecodeTests {
    private func decode(_ json: String) throws -> RemoteThreadSnapshot {
        try JSONDecoder().decode(RemoteThreadSnapshot.self, from: Data(json.utf8))
    }

    @Test("decodes counts and sender names")
    func decodesSummary() throws {
        let snapshot = try decode(
            """
            {"threadId":"t-1","threadMessageInbox":{"pendingCount":3,"hasWakeRequest":true,
            "senders":["Byte pin fix","Ratchet"],"oldestPendingAt":1700000000000}}
            """)
        let inbox = try #require(snapshot.threadMessageInbox)
        #expect(inbox.count == 3)
        #expect(inbox.wantsWake)
        #expect(inbox.senders?.count == 2)
    }

    // A partial decode must under-report rather than invent mail: an absent count
    // reads as zero, and zero suppresses the wake flag too.
    @Test("a missing count reads as an empty inbox")
    func missingCountIsEmpty() throws {
        let snapshot = try decode(
            #"{"threadId":"t-1","threadMessageInbox":{"hasWakeRequest":true}}"#)
        let inbox = try #require(snapshot.threadMessageInbox)
        #expect(inbox.count == 0)
        #expect(inbox.wantsWake == false)
    }

    @Test("a negative count is clamped rather than rendered")
    func negativeCountClamped() throws {
        let snapshot = try decode(
            #"{"threadId":"t-1","threadMessageInbox":{"pendingCount":-4}}"#)
        #expect(snapshot.threadMessageInbox?.count == 0)
    }

    @Test("an absent inbox decodes without error")
    func absentInbox() throws {
        #expect(try decode(#"{"threadId":"t-1"}"#).threadMessageInbox == nil)
    }
}
