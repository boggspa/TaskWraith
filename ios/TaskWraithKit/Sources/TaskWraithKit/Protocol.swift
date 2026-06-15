// taskwraith-e2ee-v1 — wire protocol definitions (Swift port of
// src/shared/e2ee/protocol.ts). Pure types + constants; the frames are Codable
// so URLSessionWebSocketTask text messages decode/encode directly.

import Foundation

public enum TWProtocol {
    public static let id = "taskwraith-e2ee-v1"
    public static let hkdfInfoMacToIphone = "taskwraith-e2ee-v1 mac->iphone"
    public static let hkdfInfoIphoneToMac = "taskwraith-e2ee-v1 iphone->mac"

    /// 4-byte big-endian nonce prefix per send-direction.
    public static let noncePrefixMacToIphone: UInt32 = 0x0000_0001
    public static let noncePrefixIphoneToMac: UInt32 = 0x0000_0002

    public static let transportPing = "transport.ping"
    public static let transportPong = "transport.pong"
    public static let transportResume = "transport.resume"
}

public enum Role: String, Codable, Sendable {
    case mac
    case iphone
}

public enum Direction: Sendable {
    case macToIphone
    case iphoneToMac

    public var noncePrefix: UInt32 {
        switch self {
        case .macToIphone: return TWProtocol.noncePrefixMacToIphone
        case .iphoneToMac: return TWProtocol.noncePrefixIphoneToMac
        }
    }

    public var hkdfInfo: String {
        switch self {
        case .macToIphone: return TWProtocol.hkdfInfoMacToIphone
        case .iphoneToMac: return TWProtocol.hkdfInfoIphoneToMac
        }
    }
}

public func sendDirection(for role: Role) -> Direction {
    role == .mac ? .macToIphone : .iphoneToMac
}

public func recvDirection(for role: Role) -> Direction {
    role == .mac ? .iphoneToMac : .macToIphone
}

// ── Control + data plane frames (one JSON object per WS text message) ──────────
//
// Encoded/decoded as a discriminated union keyed on `t`. Swift's Codable has no
// native union, so `E2eeFrame` hand-rolls the dispatch in init(from:)/encode(to:).

public struct ClientHelloFrame: Codable, Sendable {
    public var t = "clientHello"
    public var `protocol`: String
    public var sessionId: String
    public var role = "iphone"
    public var ephemeralPubKey: String  // base64 raw 32B X25519
    public var nonce: String            // base64 16B
}

public struct ServerHelloFrame: Codable, Sendable {
    public var t = "serverHello"
    public var `protocol`: String
    public var sessionId: String
    public var ephemeralPubKey: String
    public var nonce: String
    public var macIdentityPubKey: String  // base64 raw 32B Ed25519
}

public struct ClientAuthFrame: Codable, Sendable {
    public var t = "clientAuth"
    public var sessionId: String
    public var iphoneIdentityPubKey: String  // base64 raw 32B Ed25519
    public var confirmCode: String
    public var transcriptSig: String         // base64 64B
}

public struct ServerAuthFrame: Codable, Sendable {
    public var t = "serverAuth"
    public var sessionId: String
    public var transcriptSig: String
}

public struct EncryptedFrame: Codable, Sendable {
    public var t = "enc"
    public var sessionId: String
    public var seq: Int
    public var nonce: String  // base64 12B
    public var ct: String     // base64
    public var tag: String    // base64 16B
    public var ack: Int?
}

public enum E2eeFrame: Codable, Sendable {
    case clientHello(ClientHelloFrame)
    case serverHello(ServerHelloFrame)
    case clientAuth(ClientAuthFrame)
    case serverAuth(ServerAuthFrame)
    case enc(EncryptedFrame)

    private enum TypeKey: String, CodingKey { case t }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: TypeKey.self)
        let t = try container.decode(String.self, forKey: .t)
        let single = try decoder.singleValueContainer()
        switch t {
        case "clientHello": self = .clientHello(try single.decode(ClientHelloFrame.self))
        case "serverHello": self = .serverHello(try single.decode(ServerHelloFrame.self))
        case "clientAuth": self = .clientAuth(try single.decode(ClientAuthFrame.self))
        case "serverAuth": self = .serverAuth(try single.decode(ServerAuthFrame.self))
        case "enc": self = .enc(try single.decode(EncryptedFrame.self))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .t, in: container, debugDescription: "unknown frame type \(t)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var single = encoder.singleValueContainer()
        switch self {
        case .clientHello(let f): try single.encode(f)
        case .serverHello(let f): try single.encode(f)
        case .clientAuth(let f): try single.encode(f)
        case .serverAuth(let f): try single.encode(f)
        case .enc(let f): try single.encode(f)
        }
    }
}

/// The decrypted payload of an `enc` frame — `method`/`params` mirror the exact
/// shape BridgeBroadcaster/BridgeRunEventSink produce and BridgeActionRouter
/// consumes. `params` stays as raw JSON (AnyCodable) so the transport never has
/// to know the domain types; the app layer decodes per-method.
public struct AppMessage: Sendable {
    public var msgId: Int
    public var method: String
    public var params: Data?  // raw JSON bytes of the `params` value, if present
}

/// QR / deep-link bootstrap payload the Mac shows and the iPhone scans.
public struct PairingBootstrapPayload: Codable, Sendable {
    public var v: Int
    public var `protocol`: String
    public var relayUrl: String
    /// Ordered relay candidates (LAN ws:// first, wss front door second).
    /// Additive on v1 — absent in old payloads (decodes nil); new payloads
    /// carry it so ONE pairing works on home Wi-Fi and cellular alike.
    public var relayUrls: [String]?
    public var sessionId: String
    public var macIdentityPubKey: String  // base64 raw 32B Ed25519
    public var macDisplayName: String
    public var expiresAt: Double          // ms epoch

    public init(
        v: Int, protocol p: String, relayUrl: String, relayUrls: [String]? = nil,
        sessionId: String, macIdentityPubKey: String, macDisplayName: String, expiresAt: Double
    ) {
        self.v = v
        self.protocol = p
        self.relayUrl = relayUrl
        self.relayUrls = relayUrls
        self.sessionId = sessionId
        self.macIdentityPubKey = macIdentityPubKey
        self.macDisplayName = macDisplayName
        self.expiresAt = expiresAt
    }
}

/// Candidate ordering for multi-door relay dials. Pure + unit-tested.
public enum RelayCandidates {
    /// Hosts reachable only on the local network (ATS also allows
    /// cleartext ws:// to exactly these).
    public static func isLocalNetworkHost(_ host: String) -> Bool {
        if host == "localhost" || host == "127.0.0.1" || host == "::1" { return true }
        if host.hasSuffix(".local") { return true }
        if host.hasPrefix("192.168.") || host.hasPrefix("10.") || host.hasPrefix("169.254.") {
            return true
        }
        // 172.16.0.0/12
        if host.hasPrefix("172.") {
            let parts = host.split(separator: ".")
            if parts.count == 4, let second = Int(parts[1]), (16...31).contains(second) {
                return true
            }
        }
        return false
    }

    /// The ordered, deduped dial list: the multi-URL set when present,
    /// else the single legacy URL. LAN-first is fastest at home; remote-first
    /// avoids burning a LAN timeout on cellular before trying the WSS door.
    public static func ordered(
        from relayUrls: [String]?, fallback: String, preferRemoteFirst: Bool = false
    ) -> [String] {
        var seen = Set<String>()
        let raw = (relayUrls?.isEmpty == false ? relayUrls! : [fallback])
        let cleaned = raw
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
        let local = cleaned.filter { isLocalCandidate($0) }
        let remote = cleaned.filter { !isLocalCandidate($0) }
        return preferRemoteFirst ? remote + local : local + remote
    }

    /// Per-candidate dial budget: LAN doors are same-network-or-nothing, so
    /// fail them fast; remote doors get room for TLS + tailnet routing.
    public static func dialTimeoutMs(for url: String) -> Int {
        isLocalCandidate(url) ? 5_000 : 12_000
    }

    public static func isLocalCandidate(_ url: String) -> Bool {
        guard let host = URL(string: url)?.host else { return false }
        return isLocalNetworkHost(host)
    }
}
