// QR-optional discovery wire shapes: the /v1/beginpair endpoint derivation and
// the DiscoveredHostInfo ack payload the phone offers to pair from.

import Foundation
import Testing

@testable import TaskWraithKit

@Suite("beginPair endpoint derivation")
struct BeginPairURLTests {
    @Test("wss relay → https /v1/beginpair on the same origin")
    func wssToHttps() {
        #expect(
            RelayCandidates.beginPairURL(fromRelay: "wss://studio.tailnet.ts.net")?.absoluteString
                == "https://studio.tailnet.ts.net/v1/beginpair")
    }

    @Test("ws LAN relay → http /v1/beginpair preserving the port")
    func wsToHttp() {
        #expect(
            RelayCandidates.beginPairURL(fromRelay: "ws://192.168.0.147:8787")?.absoluteString
                == "http://192.168.0.147:8787/v1/beginpair")
    }

    @Test("drops an existing path/query/fragment and trims whitespace")
    func normalizes() {
        #expect(
            RelayCandidates.beginPairURL(fromRelay: "  wss://h.ts.net/v1/resolve?x=1#frag  ")?
                .absoluteString == "https://h.ts.net/v1/beginpair")
    }

    @Test("returns nil for an unparseable relay URL")
    func invalid() {
        #expect(RelayCandidates.beginPairURL(fromRelay: "") == nil)
    }
}

@Suite("DiscoveredHostInfo decode")
struct DiscoveredHostInfoTests {
    private func decodeAck(_ json: String) throws -> BridgeActionAck {
        try JSONDecoder().decode(BridgeActionAck.self, from: Data(json.utf8))
    }

    @Test("decodes the discoverTailnetHosts ack with its hosts list")
    func decodesHosts() throws {
        let ack = try decodeAck(
            """
            {"accepted":true,"executed":true,"data":{"hosts":[
              {"macIdentityPubKey":"PUB1","macDisplayName":"Studio","relayUrls":["ws://lan:8787","wss://studio.ts.net"],"hostPlatform":"mac"},
              {"macIdentityPubKey":"PUB2","relayUrls":["wss://pc.ts.net"]}
            ]}}
            """)
        let hosts = try #require(ack.data?.hosts)
        #expect(hosts.count == 2)
        #expect(hosts[0].macIdentityPubKey == "PUB1")
        #expect(hosts[0].macDisplayName == "Studio")
        #expect(hosts[0].relayUrls == ["ws://lan:8787", "wss://studio.ts.net"])
        #expect(hosts[0].hostPlatform == "mac")
        #expect(hosts[0].id == "PUB1")
        // Optional fields absent → nil; required fields still decode.
        #expect(hosts[1].macDisplayName == nil)
        #expect(hosts[1].hostPlatform == nil)
        #expect(hosts[1].relayUrls == ["wss://pc.ts.net"])
    }

    @Test("an ack without hosts decodes hosts as nil (backward compatible)")
    func noHostsField() throws {
        let ack = try decodeAck(#"{"accepted":true,"executed":true,"data":{"git":null}}"#)
        #expect(ack.data?.hosts == nil)
    }
}
