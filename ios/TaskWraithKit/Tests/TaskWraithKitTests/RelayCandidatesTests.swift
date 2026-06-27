// RelayCandidates — the T70 multi-door dial order. One pairing carries both
// the LAN ws:// door and the wss:// Tailscale front door; the phone walks
// them LAN-first (instant at home, a cheap timeout away from it).

import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Relay candidate ordering")
struct RelayCandidatesTests {
    @Test("orders LAN doors before remote doors regardless of input order")
    func lanFirst() {
        let ordered = RelayCandidates.ordered(
            from: ["wss://mac.tailnet.ts.net", "ws://192.168.0.147:8787"],
            fallback: "wss://mac.tailnet.ts.net")
        #expect(ordered == ["ws://192.168.0.147:8787", "wss://mac.tailnet.ts.net"])
    }

    @Test("can prefer remote doors before LAN doors on cellular")
    func remoteFirst() {
        let ordered = RelayCandidates.ordered(
            from: ["ws://192.168.0.147:8787", "wss://mac.tailnet.ts.net"],
            fallback: "wss://mac.tailnet.ts.net",
            preferRemoteFirst: true)
        #expect(ordered == ["wss://mac.tailnet.ts.net", "ws://192.168.0.147:8787"])
    }

    @Test("promotes the last successful relay before generic LAN/remote ordering")
    func preferredDoorFirst() {
        let ordered = RelayCandidates.ordered(
            from: ["ws://192.168.0.147:8787", "wss://mac.tailnet.ts.net"],
            fallback: "ws://192.168.0.147:8787",
            preferRemoteFirst: false,
            preferredFirst: "wss://mac.tailnet.ts.net")
        #expect(ordered == ["wss://mac.tailnet.ts.net", "ws://192.168.0.147:8787"])
    }

    @Test("includes a preferred door missing from the stored candidate list")
    func preferredDoorMissingFromList() {
        let ordered = RelayCandidates.ordered(
            from: ["ws://192.168.0.147:8787"],
            fallback: "ws://192.168.0.147:8787",
            preferredFirst: "wss://new.tailnet.ts.net")
        #expect(ordered == ["wss://new.tailnet.ts.net", "ws://192.168.0.147:8787"])
    }

    @Test("falls back to the single legacy URL when the list is absent or empty")
    func fallback() {
        #expect(
            RelayCandidates.ordered(from: nil, fallback: "ws://192.168.0.147:8787")
                == ["ws://192.168.0.147:8787"])
        #expect(
            RelayCandidates.ordered(from: [], fallback: "wss://mac.tailnet.ts.net")
                == ["wss://mac.tailnet.ts.net"])
    }

    @Test("dedupes and drops blank entries")
    func dedupe() {
        let ordered = RelayCandidates.ordered(
            from: [
                "ws://192.168.0.147:8787", " ws://192.168.0.147:8787 ", "",
                "wss://mac.tailnet.ts.net", "wss://mac.tailnet.ts.net",
            ],
            fallback: "unused")
        #expect(ordered == ["ws://192.168.0.147:8787", "wss://mac.tailnet.ts.net"])
    }

    @Test("LAN doors get the short dial budget, remote doors the long one")
    func budgets() {
        #expect(RelayCandidates.dialTimeoutMs(for: "ws://192.168.0.147:8787") == 5_000)
        #expect(RelayCandidates.dialTimeoutMs(for: "ws://chriss-mac.local:8787") == 5_000)
        #expect(RelayCandidates.dialTimeoutMs(for: "wss://mac.tailnet.ts.net") == 12_000)
        #expect(RelayCandidates.dialTimeoutMs(for: "wss://relay.example.com") == 12_000)
    }

    @Test("local-host classification covers the RFC1918 + mDNS shapes")
    func localHosts() {
        for host in ["localhost", "127.0.0.1", "::1", "mac.local", "192.168.1.2", "10.0.0.9",
            "169.254.1.1", "172.16.0.1", "172.31.255.255"]
        {
            #expect(RelayCandidates.isLocalNetworkHost(host), "expected local: \(host)")
        }
        for host in ["172.32.0.1", "100.99.131.73", "mac.tailnet.ts.net", "example.com"] {
            #expect(!RelayCandidates.isLocalNetworkHost(host), "expected non-local: \(host)")
        }
    }

    @Test("bootstrap with relayUrls decodes; old payloads without it stay nil")
    func bootstrapDecode() throws {
        let multi = """
            {"v":1,"protocol":"taskwraith-e2ee-v1",
             "relayUrl":"wss://mac.tailnet.ts.net",
             "relayUrls":["ws://192.168.0.147:8787","wss://mac.tailnet.ts.net"],
             "sessionId":"s-1","macIdentityPubKey":"AA==","macDisplayName":"Mac",
             "expiresAt":1781275992698}
            """
        let decoded = try JSONDecoder().decode(
            PairingBootstrapPayload.self, from: Data(multi.utf8))
        #expect(decoded.relayUrls == ["ws://192.168.0.147:8787", "wss://mac.tailnet.ts.net"])

        let legacy = """
            {"v":1,"protocol":"taskwraith-e2ee-v1","relayUrl":"ws://192.168.0.147:8787",
             "sessionId":"s-1","macIdentityPubKey":"AA==","macDisplayName":"Mac",
             "expiresAt":1781275992698}
            """
        let decodedLegacy = try JSONDecoder().decode(
            PairingBootstrapPayload.self, from: Data(legacy.utf8))
        #expect(decodedLegacy.relayUrls == nil)
        #expect(
            RelayCandidates.ordered(
                from: decodedLegacy.relayUrls, fallback: decodedLegacy.relayUrl)
                == ["ws://192.168.0.147:8787"])
    }

    @Test("ipv4ToUInt32 parses dotted-quads and rejects non-literals")
    func ipv4Parse() {
        #expect(RelayCandidates.ipv4ToUInt32("192.168.0.147") == 0xC0A8_0093)
        #expect(RelayCandidates.ipv4ToUInt32("10.0.0.1") == 0x0A00_0001)
        #expect(RelayCandidates.ipv4ToUInt32("255.255.255.0") == 0xFFFF_FF00)
        // Rejects hostnames, IPv6, out-of-range octets, wrong arity, empty parts.
        #expect(RelayCandidates.ipv4ToUInt32("mac.local") == nil)
        #expect(RelayCandidates.ipv4ToUInt32("::1") == nil)
        #expect(RelayCandidates.ipv4ToUInt32("192.168.0.256") == nil)
        #expect(RelayCandidates.ipv4ToUInt32("192.168.0") == nil)
        #expect(RelayCandidates.ipv4ToUInt32("192.168..1") == nil)
    }

    @Test("subnet match: a LAN door on this /24 is reachable, a different subnet is not")
    func subnetMatch() {
        // Device on 192.168.1.50/24.
        let iface = (
            addr: RelayCandidates.ipv4ToUInt32("192.168.1.50")!,
            mask: RelayCandidates.ipv4ToUInt32("255.255.255.0")!)
        let sameSubnet = RelayCandidates.ipv4ToUInt32("192.168.1.147")!
        let otherSubnet = RelayCandidates.ipv4ToUInt32("192.168.0.147")!
        // Same /24 → reachable LAN door → callers stay LAN-first.
        #expect(RelayCandidates.anyHost([sameSubnet], inAnyOf: [iface]))
        // Different /24 (the off-LAN case that burns the multi-minute timeout) →
        // not reachable → callers should prefer the wss door first.
        #expect(!RelayCandidates.anyHost([otherSubnet], inAnyOf: [iface]))
        // Any one matching host is enough.
        #expect(RelayCandidates.anyHost([otherSubnet, sameSubnet], inAnyOf: [iface]))
        // A wider /16 device subnet would include 192.168.0.x too.
        let iface16 = (
            addr: RelayCandidates.ipv4ToUInt32("192.168.1.50")!,
            mask: RelayCandidates.ipv4ToUInt32("255.255.0.0")!)
        #expect(RelayCandidates.anyHost([otherSubnet], inAnyOf: [iface16]))
    }

    @Test("anyHostInDeviceSubnet can't evaluate name-only or empty inputs → nil")
    func subnetNonLiteral() {
        // .local mDNS names aren't IPv4 literals, so subnet math is undeterminable
        // and the caller keeps its default ordering (never hard-skips the door).
        #expect(RelayCandidates.anyHostInDeviceSubnet(["mac.local"]) == nil)
        #expect(RelayCandidates.anyHostInDeviceSubnet([]) == nil)
    }
}
