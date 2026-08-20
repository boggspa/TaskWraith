import CryptoKit
import Foundation

public enum PushGatewayRegistrationRoute: String, Sendable {
    case register = "/v1/apns/register"
    case deregister = "/v1/apns/deregister"
}

public struct PushGatewayRegistrationReceipt: Sendable, Equatable {
    public let endpoint: URL
    public let statusCode: Int

    public init(endpoint: URL, statusCode: Int) {
        self.endpoint = endpoint
        self.statusCode = statusCode
    }
}

public enum PushGatewayRegistrationError: Error, LocalizedError, Equatable {
    case invalidGatewayUrl
    case unsafeCleartextGateway
    case invalidIdentity
    case invalidDeviceToken
    case invalidEnvironment
    case invalidNonce
    case invalidResponse
    case httpStatus(Int)

    public var errorDescription: String? {
        switch self {
        case .invalidGatewayUrl:
            return "The project push gateway URL is invalid."
        case .unsafeCleartextGateway:
            return "A cleartext project push gateway must be local or on this tailnet."
        case .invalidIdentity:
            return "The device or host identity is invalid."
        case .invalidDeviceToken:
            return "The APNs device token is invalid."
        case .invalidEnvironment:
            return "The APNs environment is invalid."
        case .invalidNonce:
            return "The push registration nonce is invalid."
        case .invalidResponse:
            return "The project push gateway returned an invalid response."
        case .httpStatus(let status):
            return "The project push gateway declined registration (HTTP \(status))."
        }
    }
}

/// Phone-owned client for the project-operated Tier-2 APNs gateway.
///
/// The Mac may advertise a gateway URL only through the authenticated E2EE
/// bridge acknowledgement. The phone still authors and signs the registration:
/// the relay derives pairID from this device's public key and never trusts a
/// caller-supplied routing identity.
public struct PushGatewayRegistrationClient: Sendable {
    public typealias RequestSender = @Sendable (URLRequest) async throws -> Int
    public typealias Clock = @Sendable () -> Int64
    public typealias NonceSource = @Sendable () -> Data

    private let sendRequest: RequestSender
    private let nowMs: Clock
    private let nonce: NonceSource

    public init(
        sendRequest: RequestSender? = nil,
        nowMs: @escaping Clock = { Int64(Date().timeIntervalSince1970 * 1_000) },
        nonce: @escaping NonceSource = {
            Data((0..<16).map { _ in UInt8.random(in: 0...255) })
        }
    ) {
        self.sendRequest = sendRequest ?? { request in
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw PushGatewayRegistrationError.invalidResponse
            }
            return http.statusCode
        }
        self.nowMs = nowMs
        self.nonce = nonce
    }

    public func register(
        gatewayUrl: String,
        macIdentityPubKey: String,
        identitySeed: Data,
        deviceTokenHex: String,
        env: String,
        notifyFinishedTurns: Bool
    ) async throws -> PushGatewayRegistrationReceipt {
        let endpoint = try Self.endpoint(gatewayUrl: gatewayUrl, route: .register)
        let identity = try signingIdentity(seed: identitySeed)
        guard isBase64Identity(macIdentityPubKey) else {
            throw PushGatewayRegistrationError.invalidIdentity
        }
        guard
            !deviceTokenHex.isEmpty,
            deviceTokenHex.count.isMultiple(of: 2),
            deviceTokenHex.allSatisfy(\.isHexDigit)
        else {
            throw PushGatewayRegistrationError.invalidDeviceToken
        }
        guard env == "production" || env == "sandbox" else {
            throw PushGatewayRegistrationError.invalidEnvironment
        }
        let nonce = try registrationNonce()
        let body = try TWPush.signApnsRegisterRequest(
            identity: identity,
            macIdentityPubKey: macIdentityPubKey,
            deviceTokenHex: deviceTokenHex,
            env: env,
            notifyFinishedTurns: notifyFinishedTurns,
            nonce: nonce,
            issuedAt: nowMs())
        return try await post(body, endpoint: endpoint)
    }

    public func deregister(
        gatewayUrl: String,
        macIdentityPubKey: String,
        identitySeed: Data
    ) async throws -> PushGatewayRegistrationReceipt {
        let endpoint = try Self.endpoint(gatewayUrl: gatewayUrl, route: .deregister)
        let identity = try signingIdentity(seed: identitySeed)
        guard isBase64Identity(macIdentityPubKey) else {
            throw PushGatewayRegistrationError.invalidIdentity
        }
        let body = try TWPush.signApnsDeregisterRequest(
            identity: identity,
            macIdentityPubKey: macIdentityPubKey,
            nonce: try registrationNonce(),
            issuedAt: nowMs())
        return try await post(body, endpoint: endpoint)
    }

    public static func endpoint(
        gatewayUrl: String,
        route: PushGatewayRegistrationRoute
    ) throws -> URL {
        let trimmed = gatewayUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed),
            let originalScheme = components.scheme?.lowercased(),
            let host = components.host?.lowercased(),
            !host.isEmpty,
            components.user == nil,
            components.password == nil,
            components.query == nil,
            components.fragment == nil
        else {
            throw PushGatewayRegistrationError.invalidGatewayUrl
        }
        switch originalScheme {
        case "wss":
            components.scheme = "https"
        case "https":
            break
        case "ws", "http":
            guard
                RelayCandidates.isLocalNetworkHost(host)
                    || RelayCandidates.isTailscaleIPv4Host(host)
            else {
                throw PushGatewayRegistrationError.unsafeCleartextGateway
            }
            components.scheme = "http"
        default:
            throw PushGatewayRegistrationError.invalidGatewayUrl
        }
        components.path = components.path.replacingOccurrences(
            of: "/+$", with: "", options: .regularExpression) + route.rawValue
        guard let endpoint = components.url else {
            throw PushGatewayRegistrationError.invalidGatewayUrl
        }
        return endpoint
    }

    private func signingIdentity(seed: Data) throws -> Curve25519.Signing.PrivateKey {
        guard seed.count == 32,
            let identity = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        else {
            throw PushGatewayRegistrationError.invalidIdentity
        }
        return identity
    }

    private func isBase64Identity(_ value: String) -> Bool {
        guard let decoded = Data(base64Encoded: value), decoded.count == 32 else { return false }
        return value == decoded.base64EncodedString()
    }

    private func registrationNonce() throws -> Data {
        let value = nonce()
        guard value.count == 16 else { throw PushGatewayRegistrationError.invalidNonce }
        return value
    }

    private func post<T: Encodable>(
        _ body: T,
        endpoint: URL
    ) async throws -> PushGatewayRegistrationReceipt {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 12
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        let status = try await sendRequest(request)
        guard status == 200 else { throw PushGatewayRegistrationError.httpStatus(status) }
        return PushGatewayRegistrationReceipt(endpoint: endpoint, statusCode: status)
    }
}
