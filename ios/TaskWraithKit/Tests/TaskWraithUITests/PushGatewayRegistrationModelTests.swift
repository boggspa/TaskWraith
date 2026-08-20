import Foundation
import Testing

@testable import TaskWraithKit
@testable import TaskWraithUI

private struct PushGatewayStaticIdentitySeed: IdentitySeedStore {
    func loadOrCreateSeed() throws -> Data {
        Data(repeating: 7, count: 32)
    }
}

private actor PushGatewayModelRequestRecorder {
    private var requests: [URLRequest] = []

    func send(_ request: URLRequest) -> Int {
        requests.append(request)
        return 200
    }

    func recorded() -> [URLRequest] {
        requests
    }
}

@Suite("Remote session Tier-2 push registration", .serialized)
@MainActor
struct PushGatewayRegistrationModelTests {
    @Test("token, opt-out, and host removal reach the project gateway")
    func registrationLifecycle() async throws {
        let pairingDefaults = freshDefaults("pairing")
        let preferenceDefaults = freshDefaults("preference")
        let pairingStore = UserDefaultsPairedHostStore(defaults: pairingDefaults)
        pairingStore.upsert(
            PairedHostRecord(
                relayUrl: "wss://host.taskwraith.example",
                macIdentityPubKey: Data(repeating: 9, count: 32).base64EncodedString(),
                macDisplayName: "Test Mac",
                pushGatewayUrl: "wss://push.taskwraith.example"))
        let recorder = PushGatewayModelRequestRecorder()
        let client = PushGatewayRegistrationClient(
            sendRequest: { request in await recorder.send(request) },
            nowMs: { 1_700_000_000_000 },
            nonce: { Data(repeating: 3, count: 16) })
        let model = RemoteSessionModel(
            identityStore: PushGatewayStaticIdentitySeed(),
            pairingStore: pairingStore,
            pushGatewayClient: client,
            pushGatewayDefaults: preferenceDefaults)

        model.handleApnsToken(String(repeating: "ab", count: 32), env: "production")
        try await waitForRequestCount(1, recorder: recorder)
        let first = try #require(await recorder.recorded().first)
        let enabled = try JSONDecoder().decode(
            TWPush.ApnsRegisterRequest.self, from: try #require(first.httpBody))
        #expect(enabled.notifyFinishedTurns)
        #expect(model.completionPushGatewayStatus == .registered(hosts: 1))

        model.setNotifyFinishedTurns(false)
        try await waitForRequestCount(2, recorder: recorder)
        let disabledRequest = try #require(await recorder.recorded().last)
        let disabled = try JSONDecoder().decode(
            TWPush.ApnsRegisterRequest.self, from: try #require(disabledRequest.httpBody))
        #expect(disabled.notifyFinishedTurns == false)
        #expect(model.completionPushGatewayStatus == .optedOut(hosts: 1))

        model.forgetHost(macIdentityPubKey: enabled.macIdentityPubKey)
        try await waitForRequestCount(3, recorder: recorder)
        let deregister = try #require(await recorder.recorded().last)
        #expect(deregister.url?.path == "/v1/apns/deregister")
        #expect(model.completionPushGatewayStatus == .directOnly)
    }

    @Test("older hosts use their authenticated relay doors as the gateway")
    func pairedRelayFallback() async throws {
        let pairingDefaults = freshDefaults("legacy-pairing")
        let pairingStore = UserDefaultsPairedHostStore(defaults: pairingDefaults)
        pairingStore.upsert(
            PairedHostRecord(
                relayUrl: "ws://192.168.0.10:8787",
                macIdentityPubKey: Data(repeating: 8, count: 32).base64EncodedString(),
                macDisplayName: "Older Mac",
                relayUrls: [
                    "ws://192.168.0.10:8787",
                    "wss://paired-relay.taskwraith.example",
                ]))
        let recorder = PushGatewayModelRequestRecorder()
        let model = RemoteSessionModel(
            identityStore: PushGatewayStaticIdentitySeed(),
            pairingStore: pairingStore,
            pushGatewayClient: PushGatewayRegistrationClient(
                sendRequest: { request in await recorder.send(request) },
                nowMs: { 1_700_000_000_000 },
                nonce: { Data(repeating: 3, count: 16) }),
            pushGatewayDefaults: freshDefaults("legacy-preference"))

        model.handleApnsToken(String(repeating: "cd", count: 32), env: "sandbox")
        try await waitForRequestCount(1, recorder: recorder)
        let request = try #require(await recorder.recorded().first)
        #expect(request.url?.absoluteString == "https://paired-relay.taskwraith.example/v1/apns/register")
        #expect(model.completionPushGatewayStatus == .registered(hosts: 1))
    }

    @Test("authenticated token acknowledgements decode the gateway advertisement")
    func gatewayAckDecode() throws {
        let ack = try JSONDecoder().decode(
            BridgeActionAck.self,
            from: Data(
                """
                {"accepted":true,"data":{"pushGatewayConfigured":true,
                "pushGatewayUrl":"https://push.taskwraith.example"}}
                """.utf8))
        #expect(ack.data?.pushGatewayConfigured == true)
        #expect(ack.data?.pushGatewayUrl == "https://push.taskwraith.example")
    }

    private func freshDefaults(_ label: String) -> UserDefaults {
        let suite = "PushGatewayRegistrationModelTests.\(label).\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    private func waitForRequestCount(
        _ expected: Int,
        recorder: PushGatewayModelRequestRecorder
    ) async throws {
        let deadline = ContinuousClock.now + .seconds(2)
        while await recorder.recorded().count < expected, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(await recorder.recorded().count == expected)
    }
}
