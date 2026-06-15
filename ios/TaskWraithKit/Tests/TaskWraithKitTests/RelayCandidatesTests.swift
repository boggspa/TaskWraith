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
}
