// Swift Session state-machine round-trip (the analog of session.test.ts) —
// validates the port in isolation by wiring a mac + iphone E2eeSession through
// an in-memory frame pump, with no relay. T4d exercises the same machine live
// against the Node Mac; this catches port bugs early and offline.

import Foundation
import CryptoKit
import Testing

@testable import TaskWraithKit

/// Drives two sessions: drains each one's outbox into the other, draining
/// recursively until the wire is quiet. Mirrors session.test.ts's `pump`.
private final class Wire {
    let mac: E2eeSession
    let iphone: E2eeSession
    init(mac: E2eeSession, iphone: E2eeSession) {
        self.mac = mac
        self.iphone = iphone
    }

    /// Deliver all pending frames both ways until neither side emits more.
    func pump() {
        var guardCount = 0
        while guardCount < 1000 {
            let toIphone = mac.drainOutbox()
            let toMac = iphone.drainOutbox()
            if toIphone.isEmpty && toMac.isEmpty { return }
            for f in toIphone { iphone.handleFrame(f) }
            for f in toMac { mac.handleFrame(f) }
            guardCount += 1
        }
    }

    /// Drop frames currently queued on both sides (simulates a socket close).
    func drop() {
        _ = mac.drainOutbox()
        _ = iphone.drainOutbox()
    }
}

private func makeWire() -> (Wire, macId: Curve25519.Signing.PublicKey) {
    let macIdentity = TWKeys.generateIdentity()
    let iphoneIdentity = TWKeys.generateIdentity()
    let mac = E2eeSession(role: .mac, sessionId: "sess-swift", identity: macIdentity)
    let iphone = E2eeSession(
        role: .iphone, sessionId: "sess-swift", identity: iphoneIdentity,
        peerIdentity: macIdentity.publicKey)  // pinned from the QR bootstrap
    return (Wire(mac: mac, iphone: iphone), macIdentity.publicKey)
}

private func paramsData(_ obj: [String: Any]) -> Data {
    try! JSONSerialization.data(withJSONObject: obj)
}
private func intField(_ data: Data?, _ key: String) -> Int? {
    guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    return obj[key] as? Int
}

@Suite("E2eeSession round-trip")
struct SessionRoundTripTests {
    @Test("both sides establish with the same confirm code")
    func handshake() {
        let (wire, _) = makeWire()
        wire.mac.start()
        wire.iphone.start()
        wire.pump()
        #expect(wire.mac.isEstablished)
        #expect(wire.iphone.isEstablished)
        #expect(wire.iphone.takeConfirmCode() != nil)
    }

    @Test("app messages round-trip both directions")
    func appChannel() {
        let (wire, _) = makeWire()
        wire.mac.start()
        wire.iphone.start()
        wire.pump()
        _ = wire.mac.takeEstablishedEdge()
        _ = wire.iphone.takeEstablishedEdge()
        _ = wire.mac.drainMessages()
        _ = wire.iphone.drainMessages()

        try! wire.mac.sendApp("bridge.runEvent", params: paramsData(["n": 1]))
        try! wire.iphone.sendApp("bridge.requestActionAck", params: paramsData(["ok": 1]))
        wire.pump()

        let iphoneMsgs = wire.iphone.drainMessages()
        let macMsgs = wire.mac.drainMessages()
        #expect(iphoneMsgs.contains { $0.method == "bridge.runEvent" && intField($0.params, "n") == 1 })
        #expect(macMsgs.contains { $0.method == "bridge.requestActionAck" })
    }

    @Test("encrypted ping proves the authenticated peer is awake")
    func peerPong() {
        let (wire, _) = makeWire()
        wire.mac.start()
        wire.iphone.start()
        wire.pump()

        let iphoneBaseline = wire.iphone.peerPongCount
        wire.iphone.ping()
        wire.pump()
        #expect(wire.iphone.peerPongCount == iphoneBaseline + 1)

        let macBaseline = wire.mac.peerPongCount
        wire.mac.ping()
        wire.pump()
        #expect(wire.mac.peerPongCount == macBaseline + 1)
    }

    @Test("a buffered message replays after reconnect")
    func reconnectReplay() {
        let (wire, _) = makeWire()
        wire.mac.start()
        wire.iphone.start()
        wire.pump()
        _ = wire.iphone.drainMessages()

        try! wire.mac.sendApp("bridge.runEvent", params: paramsData(["n": 42]))
        wire.drop()  // in-flight frame lost before delivery
        #expect(wire.iphone.drainMessages().isEmpty)

        wire.mac.reconnect()
        wire.iphone.reconnect()
        wire.pump()
        #expect(wire.mac.isEstablished)
        #expect(wire.iphone.isEstablished)
        let replayed = wire.iphone.drainMessages()
        #expect(replayed.contains { $0.method == "bridge.runEvent" && intField($0.params, "n") == 42 })
    }

    @Test("an established session rejects a tampered ciphertext")
    func tamperRejected() {
        let (wire, _) = makeWire()
        wire.mac.start()
        wire.iphone.start()
        wire.pump()
        _ = wire.iphone.drainMessages()

        try! wire.mac.sendApp("bridge.runEvent", params: paramsData(["n": 7]))
        // Grab + corrupt the enc frame before it reaches the iphone.
        var frames = wire.mac.drainOutbox()
        frames = frames.map { frame in
            if case .enc(var enc) = frame, var ct = Base64.decode(enc.ct) {
                ct[0] ^= 0xff
                enc.ct = Base64.encode(ct)
                return .enc(enc)
            }
            return frame
        }
        for f in frames { wire.iphone.handleFrame(f) }
        #expect(wire.iphone.drainMessages().isEmpty)  // tag failed → never delivered
        #expect(wire.iphone.takeError() != nil)
    }
}
