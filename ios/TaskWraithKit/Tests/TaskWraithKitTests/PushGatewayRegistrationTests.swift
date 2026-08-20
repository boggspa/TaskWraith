import CryptoKit
import Foundation
import Testing

@testable import TaskWraithKit

private actor PushGatewayRequestRecorder {
    private var requests: [URLRequest] = []
    private let statusCode: Int

    init(statusCode: Int = 200) {
        self.statusCode = statusCode
    }

    func send(_ request: URLRequest) -> Int {
        requests.append(request)
        return statusCode
    }

    func recorded() -> [URLRequest] {
        requests
    }
}

@Suite("Tier-2 push gateway registration")
struct PushGatewayRegistrationTests {
    private let identitySeed = Data(repeating: 7, count: 32)
    private let macIdentity = Data(repeating: 9, count: 32).base64EncodedString()
    private let nonce = Data(repeating: 3, count: 16)

    @Test("register maps wss to HTTPS and signs every routing field")
    func registerRequest() async throws {
        let recorder = PushGatewayRequestRecorder()
        let client = PushGatewayRegistrationClient(
            sendRequest: { request in await recorder.send(request) },
            nowMs: { 1_700_000_000_000 },
            nonce: { nonce })

        let receipt = try await client.register(
            gatewayUrl: "wss://push.taskwraith.example/",
            macIdentityPubKey: macIdentity,
            identitySeed: identitySeed,
            deviceTokenHex: "aabbccdd00112233",
            env: "production",
            notifyFinishedTurns: false)

        #expect(receipt.statusCode == 200)
        #expect(receipt.endpoint.absoluteString == "https://push.taskwraith.example/v1/apns/register")
        let request = try #require(await recorder.recorded().first)
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "content-type") == "application/json")
        let body = try JSONDecoder().decode(
            TWPush.ApnsRegisterRequest.self, from: try #require(request.httpBody))
        #expect(body.macIdentityPubKey == macIdentity)
        #expect(body.deviceTokenHex == "aabbccdd00112233")
        #expect(body.env == "production")
        #expect(body.notifyFinishedTurns == false)
        #expect(body.issuedAt == 1_700_000_000_000)
        #expect(body.nonce == nonce.base64EncodedString())

        let identity = try Curve25519.Signing.PrivateKey(rawRepresentation: identitySeed)
        let signed = TWPush.apnsRegisterSigningString(
            macIdentityPubKey: body.macIdentityPubKey,
            iphoneIdentityPubKey: body.iphoneIdentityPubKey,
            deviceTokenHex: body.deviceTokenHex,
            env: body.env,
            notifyFinishedTurns: body.notifyFinishedTurns,
            issuedAt: body.issuedAt,
            nonce: body.nonce)
        #expect(
            identity.publicKey.isValidSignature(
                try #require(Data(base64Encoded: body.sig)), for: Data(signed.utf8)))
    }

    @Test("deregister is phone-signed and uses the dedicated route")
    func deregisterRequest() async throws {
        let recorder = PushGatewayRequestRecorder()
        let client = PushGatewayRegistrationClient(
            sendRequest: { request in await recorder.send(request) },
            nowMs: { 1_700_000_000_000 },
            nonce: { nonce })

        let receipt = try await client.deregister(
            gatewayUrl: "https://push.taskwraith.example/base",
            macIdentityPubKey: macIdentity,
            identitySeed: identitySeed)

        #expect(receipt.endpoint.absoluteString == "https://push.taskwraith.example/base/v1/apns/deregister")
        let request = try #require(await recorder.recorded().first)
        let body = try JSONDecoder().decode(
            TWPush.ApnsDeregisterRequest.self, from: try #require(request.httpBody))
        #expect(body.macIdentityPubKey == macIdentity)
        #expect(body.issuedAt == 1_700_000_000_000)
        #expect(body.nonce == nonce.base64EncodedString())
    }

    @Test("cleartext is limited to local or Tailscale hosts")
    func cleartextBoundary() throws {
        #expect(
            try PushGatewayRegistrationClient.endpoint(
                gatewayUrl: "ws://192.168.0.10:8788", route: .register
            ).absoluteString == "http://192.168.0.10:8788/v1/apns/register")
        #expect(
            try PushGatewayRegistrationClient.endpoint(
                gatewayUrl: "http://100.99.131.73:8788", route: .register
            ).absoluteString == "http://100.99.131.73:8788/v1/apns/register")
        #expect(throws: PushGatewayRegistrationError.self) {
            try PushGatewayRegistrationClient.endpoint(
                gatewayUrl: "ws://public.example", route: .register)
        }
        #expect(throws: PushGatewayRegistrationError.self) {
            try PushGatewayRegistrationClient.endpoint(
                gatewayUrl: "https://user:password@push.example", route: .register)
        }
    }

    @Test("a non-200 response is not accepted as registration")
    func nonSuccessResponse() async {
        let recorder = PushGatewayRequestRecorder(statusCode: 503)
        let client = PushGatewayRegistrationClient(
            sendRequest: { request in await recorder.send(request) },
            nowMs: { 1_700_000_000_000 },
            nonce: { nonce })

        await #expect(throws: PushGatewayRegistrationError.self) {
            try await client.register(
                gatewayUrl: "https://push.taskwraith.example",
                macIdentityPubKey: macIdentity,
                identitySeed: identitySeed,
                deviceTokenHex: "aabbccdd00112233",
                env: "production",
                notifyFinishedTurns: true)
        }
    }
}
