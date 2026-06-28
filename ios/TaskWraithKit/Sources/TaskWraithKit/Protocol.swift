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
    /// Host OS — "mac" | "windows" | "linux". Additive on v1 (absent in old
    /// payloads → nil); drives a per-OS glyph + host-generic copy. NOT part of
    /// the transcript hash, so it never affects the 6-digit SAS.
    public var hostPlatform: String?
    public var expiresAt: Double          // ms epoch

    public init(
        v: Int, protocol p: String, relayUrl: String, relayUrls: [String]? = nil,
        sessionId: String, macIdentityPubKey: String, macDisplayName: String,
        hostPlatform: String? = nil, expiresAt: Double
    ) {
        self.v = v
        self.protocol = p
        self.relayUrl = relayUrl
        self.relayUrls = relayUrls
        self.sessionId = sessionId
        self.macIdentityPubKey = macIdentityPubKey
        self.macDisplayName = macDisplayName
        self.hostPlatform = hostPlatform
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
        from relayUrls: [String]?,
        fallback: String,
        preferRemoteFirst: Bool = false,
        preferredFirst: String? = nil
    ) -> [String] {
        var seen = Set<String>()
        var raw = (relayUrls?.isEmpty == false ? relayUrls! : [fallback])
        if let preferredFirst,
            !preferredFirst.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            raw.append(preferredFirst)
        }
        let cleaned = raw
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
        let local = cleaned.filter { isLocalCandidate($0) }
        let remote = cleaned.filter { !isLocalCandidate($0) }
        let ordered = preferRemoteFirst ? remote + local : local + remote
        guard let preferred = preferredFirst?.trimmingCharacters(in: .whitespacesAndNewlines),
            !preferred.isEmpty,
            !(preferRemoteFirst && isLocalCandidate(preferred))
        else {
            return ordered
        }
        return [preferred] + ordered.filter { $0 != preferred }
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

    /// Whether any of `hosts` (IPv4 dotted-quad literals) sits in one of THIS
    /// device's active IPv4 subnets — i.e. a LAN door we could actually reach on
    /// the current network. Returns nil when it can't be determined (no usable
    /// interface address, or no host is an IPv4 literal), so callers keep their
    /// default ordering instead of hard-skipping a door that might still route.
    public static func anyHostInDeviceSubnet(_ hosts: [String]) -> Bool? {
        let hostAddrs = hosts.compactMap { ipv4ToUInt32($0) }
        guard !hostAddrs.isEmpty else { return nil }
        guard let interfaces = deviceIPv4Interfaces(), !interfaces.isEmpty else { return nil }
        return anyHost(hostAddrs, inAnyOf: interfaces)
    }

    /// Pure subnet test (no syscalls): is any host address on the same subnet as
    /// any interface, per that interface's mask? Exposed for tests.
    static func anyHost(
        _ hostAddrs: [UInt32], inAnyOf interfaces: [(addr: UInt32, mask: UInt32)]
    ) -> Bool {
        for iface in interfaces {
            for hostAddr in hostAddrs where (hostAddr & iface.mask) == (iface.addr & iface.mask) {
                return true
            }
        }
        return false
    }

    /// Parse an IPv4 dotted-quad into a host-order UInt32; nil for non-literals
    /// (hostnames, IPv6, malformed) so the caller can treat them as unknown.
    static func ipv4ToUInt32(_ s: String) -> UInt32? {
        let parts = s.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var value: UInt32 = 0
        for part in parts {
            guard let octet = UInt32(part), octet <= 255 else { return nil }
            value = (value << 8) | octet
        }
        return value
    }

    /// This device's active IPv4 (address, netmask) pairs from getifaddrs, in
    /// host byte order; loopback and down interfaces are skipped. nil if the
    /// syscall fails.
    static func deviceIPv4Interfaces() -> [(addr: UInt32, mask: UInt32)]? {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0 else { return nil }
        defer { freeifaddrs(head) }
        var result: [(addr: UInt32, mask: UInt32)] = []
        var cursor = head
        while let iface = cursor {
            cursor = iface.pointee.ifa_next
            guard
                let addrPtr = iface.pointee.ifa_addr,
                addrPtr.pointee.sa_family == sa_family_t(AF_INET),
                let maskPtr = iface.pointee.ifa_netmask
            else { continue }
            let flags = iface.pointee.ifa_flags
            if (flags & UInt32(IFF_UP)) == 0 || (flags & UInt32(IFF_LOOPBACK)) != 0 { continue }
            let addr = addrPtr.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
                UInt32(bigEndian: $0.pointee.sin_addr.s_addr)
            }
            let mask = maskPtr.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
                UInt32(bigEndian: $0.pointee.sin_addr.s_addr)
            }
            result.append((addr: addr, mask: mask))
        }
        return result
    }

    /// Derive a host's `/v1/beginpair` HTTP(S) endpoint from one of its relay
    /// URLs (QR-optional discovery): wss→https, ws→http — the SAME origin
    /// `tailscale serve` fronts the relay's ws + http on. Returns nil for an
    /// unparseable URL. Query/fragment are dropped.
    public static func beginPairURL(fromRelay relayUrl: String) -> URL? {
        guard
            var comps = URLComponents(
                string: relayUrl.trimmingCharacters(in: .whitespacesAndNewlines)),
            // A scheme-less / hostless string (e.g. "") yields a useless relative
            // URL — reject it so a malformed relay can't produce a bogus POST.
            let host = comps.host, !host.isEmpty
        else { return nil }
        switch comps.scheme?.lowercased() {
        case "wss": comps.scheme = "https"
        case "ws": comps.scheme = "http"
        // Only ws/wss relay URLs are valid; reject anything else rather than POST
        // to an unexpected scheme that would skip the ATS cleartext preflight.
        default: return nil
        }
        comps.path = "/v1/beginpair"
        comps.query = nil
        comps.fragment = nil
        return comps.url
    }
}
