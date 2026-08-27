import Foundation
import TaskWraithKit
import Testing

@testable import TaskWraithUI

@Suite("Offline outbox action verdict")
struct OfflineOutboxActionVerdictTests {
    @Test("an outer no-ack failure is unreachable, never a refusal")
    func outerFailureIsUnreachable() {
        let ack = AckResult(ok: false, result: nil, error: "timeout")
        #expect(RemoteSessionModel.actionDeliveryVerdict(ack) == .unreachable)
    }

    @Test("a Mac-authored action refusal stays rejected")
    func actionRefusalIsRejected() {
        let ack = AckResult(
            ok: true,
            result: Data(#"{"accepted":false,"executed":false,"message":"Denied"}"#.utf8),
            error: nil)
        #expect(
            RemoteSessionModel.actionDeliveryVerdict(ack)
                == .rejected("your Mac declined it"))
    }

    @Test("an accepted and executed action is delivered")
    func acceptedActionIsDelivered() {
        let ack = AckResult(
            ok: true,
            result: Data(#"{"accepted":true,"executed":true}"#.utf8),
            error: nil)
        #expect(RemoteSessionModel.actionDeliveryVerdict(ack) == .delivered)
    }
}
