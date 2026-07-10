import Testing

@testable import TaskWraithUI

@MainActor
@Suite("Relay cleartext preflight")
struct RelayPreflightTests {
    @Test("allows LAN and direct Tailscale IP WebSockets")
    func allowedCleartextRoutes() {
        #expect(RemoteSessionModel.cleartextRelayProblem("ws://192.168.1.20:8787") == nil)
        #expect(RemoteSessionModel.cleartextRelayProblem("ws://100.64.0.1:8787") == nil)
        #expect(RemoteSessionModel.cleartextRelayProblem("ws://100.127.255.254:8787") == nil)
        #expect(RemoteSessionModel.cleartextRelayProblem("wss://relay.example.com") == nil)
    }

    @Test("rejects cleartext routes outside LAN and the tailnet range")
    func rejectedCleartextRoutes() {
        #expect(RemoteSessionModel.cleartextRelayProblem("ws://100.63.255.255:8787") != nil)
        #expect(RemoteSessionModel.cleartextRelayProblem("ws://100.128.0.1:8787") != nil)
        #expect(RemoteSessionModel.cleartextRelayProblem("ws://203.0.113.10:8787") != nil)
        #expect(RemoteSessionModel.cleartextRelayProblem("ws://relay.example.com:8787") != nil)
    }
}
