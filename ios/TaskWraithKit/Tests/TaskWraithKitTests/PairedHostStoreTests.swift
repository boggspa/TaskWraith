// PairedHostStore — the phone's multi-host pairing memory. These tests pin the
// pure document/migration logic (no UserDefaults, no SwiftUI) plus the
// UserDefaults-backed shell against an isolated suite domain.
//
// The single-host → multi-host migration is the load-bearing behavior: a phone
// upgrading from 1.5.x must keep reconnecting to its one existing host, and a
// "forget all" must never be undone by the legacy blob resurfacing.

import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Paired host store")
struct PairedHostStoreTests {
    // 32-byte base64 identity keys (the real records hold raw Ed25519 pubkeys).
    private func key(_ seed: UInt8) -> String {
        Data(repeating: seed, count: 32).base64EncodedString()
    }

    private func host(_ seed: UInt8, name: String? = nil) -> PairedHostRecord {
        PairedHostRecord(
            relayUrl: "ws://10.0.0.\(seed):8787",
            macIdentityPubKey: key(seed),
            macDisplayName: name ?? "Host \(seed)",
            relayUrls: ["ws://10.0.0.\(seed):8787", "wss://host\(seed).ts.net"],
            pairedAt: "2026-06-2\(seed % 10)T00:00:00Z"
        )
    }

    // ── Document mutations ──────────────────────────────────────────────────

    @Test("first upsert auto-selects; the host becomes active immediately")
    func firstUpsertSelects() {
        let doc = PairedHostsDocument().upserting(host(1))
        #expect(doc.hosts.count == 1)
        #expect(doc.selectedHostId == key(1))
        #expect(doc.selectedHost?.macDisplayName == "Host 1")
    }

    @Test("later upserts append without changing the active selection")
    func laterUpsertsPreserveSelection() {
        let doc = PairedHostsDocument()
            .upserting(host(1))
            .upserting(host(2))
        #expect(doc.hosts.map(\.macIdentityPubKey) == [key(1), key(2)])
        #expect(doc.selectedHostId == key(1)) // still the first one
    }

    @Test("upsert replaces an existing host in place (dedupe on identity key)")
    func upsertReplacesInPlace() {
        let doc = PairedHostsDocument()
            .upserting(host(1))
            .upserting(host(2))
            .upserting(host(1, name: "Renamed"))
        #expect(doc.hosts.count == 2)
        #expect(doc.hosts.map(\.macIdentityPubKey) == [key(1), key(2)]) // order kept
        #expect(doc.hosts[0].macDisplayName == "Renamed") // data updated
    }

    @Test("removing the active host re-points selection to the first remaining")
    func removeActiveRepoints() {
        let doc = PairedHostsDocument()
            .upserting(host(1))
            .upserting(host(2))
            .removing(macIdentityPubKey: key(1))
        #expect(doc.hosts.map(\.macIdentityPubKey) == [key(2)])
        #expect(doc.selectedHostId == key(2))
    }

    @Test("removing a non-active host leaves selection untouched")
    func removeInactiveKeepsSelection() {
        let doc = PairedHostsDocument()
            .upserting(host(1))
            .upserting(host(2))
            .removing(macIdentityPubKey: key(2))
        #expect(doc.selectedHostId == key(1))
    }

    @Test("removing the last host clears the selection to nil")
    func removeLastClearsSelection() {
        let doc = PairedHostsDocument()
            .upserting(host(1))
            .removing(macIdentityPubKey: key(1))
        #expect(doc.isEmpty)
        #expect(doc.selectedHostId == nil)
    }

    @Test("selecting a known host switches the active host")
    func selectKnown() {
        let doc = PairedHostsDocument()
            .upserting(host(1))
            .upserting(host(2))
            .selecting(key(2))
        #expect(doc.selectedHostId == key(2))
    }

    @Test("selecting an unknown id normalizes back to the first host")
    func selectUnknownNormalizes() {
        let doc = PairedHostsDocument()
            .upserting(host(1))
            .selecting("not-a-real-key")
        #expect(doc.selectedHostId == key(1))
    }

    @Test("normalize dedupes duplicate identity keys, last data wins, slot kept")
    func normalizeDedupes() {
        let raw = PairedHostsDocument(
            hosts: [host(1, name: "First"), host(2), host(1, name: "Dup")],
            selectedHostId: key(2)
        )
        let doc = raw.normalized()
        #expect(doc.hosts.map(\.macIdentityPubKey) == [key(1), key(2)])
        #expect(doc.hosts[0].macDisplayName == "Dup")
        #expect(doc.selectedHostId == key(2))
        #expect(doc.v == PairedHostsDocument.schemaVersion)
    }

    // ── Migration codec ─────────────────────────────────────────────────────

    @Test("absent data decodes to an empty document")
    func decodeEmpty() {
        let doc = PairedHostsCodec.decode(v2Data: nil, legacyData: nil)
        #expect(doc.isEmpty)
        #expect(doc.selectedHostId == nil)
    }

    @Test("legacy single record migrates to a one-host doc and is auto-selected")
    func migrateLegacy() {
        // The exact legacy shape: a bare PairedMacRecord with no relayUrls /
        // pairedAt keys (those post-date the single-host era).
        let legacyJSON = """
            {"relayUrl":"ws://10.0.0.9:8787",\
            "macIdentityPubKey":"\(key(9))",\
            "macDisplayName":"My Mac"}
            """
        let doc = PairedHostsCodec.decode(
            v2Data: nil, legacyData: Data(legacyJSON.utf8))
        #expect(doc.hosts.count == 1)
        #expect(doc.hosts[0].macIdentityPubKey == key(9))
        #expect(doc.hosts[0].macDisplayName == "My Mac")
        #expect(doc.hosts[0].relayUrls == nil)
        #expect(doc.selectedHostId == key(9))
    }

    @Test("a present v2 doc wins and the legacy blob is ignored (one-shot guard)")
    func v2IgnoresLegacy() {
        let v2 = PairedHostsCodec.encode(
            PairedHostsDocument().upserting(host(2)))!
        let legacyJSON = """
            {"relayUrl":"ws://x","macIdentityPubKey":"\(key(9))","macDisplayName":"Stale"}
            """
        let doc = PairedHostsCodec.decode(
            v2Data: v2, legacyData: Data(legacyJSON.utf8))
        #expect(doc.hosts.map(\.macIdentityPubKey) == [key(2)]) // no key(9)
    }

    @Test("an EMPTY v2 doc still suppresses the legacy blob (forget-all is durable)")
    func emptyV2SuppressesLegacy() {
        let emptyV2 = PairedHostsCodec.encode(PairedHostsDocument())!
        let legacyJSON = """
            {"relayUrl":"ws://x","macIdentityPubKey":"\(key(9))","macDisplayName":"Stale"}
            """
        let doc = PairedHostsCodec.decode(
            v2Data: emptyV2, legacyData: Data(legacyJSON.utf8))
        #expect(doc.isEmpty) // legacy NOT resurrected
    }

    @Test("a corrupt v2 doc starts clean and does not fall back to legacy")
    func corruptV2StartsClean() {
        let legacyJSON = """
            {"relayUrl":"ws://x","macIdentityPubKey":"\(key(9))","macDisplayName":"Stale"}
            """
        let doc = PairedHostsCodec.decode(
            v2Data: Data("not json".utf8), legacyData: Data(legacyJSON.utf8))
        #expect(doc.isEmpty)
    }

    @Test("encode/decode round-trips a multi-host document")
    func roundTrip() {
        let original = PairedHostsDocument()
            .upserting(host(1))
            .upserting(host(2))
            .selecting(key(2))
        let data = PairedHostsCodec.encode(original)!
        let restored = PairedHostsCodec.decode(v2Data: data, legacyData: nil)
        #expect(restored == original)
    }

    // ── UserDefaults-backed shell (isolated suite domain) ────────────────────

    private func freshDefaults() -> UserDefaults {
        let suite = "test.pairedhost.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    @Test("store migrates a legacy blob on first load and retires the legacy key")
    func storeMigratesAndRetiresLegacy() {
        let defaults = freshDefaults()
        let legacyJSON = """
            {"relayUrl":"ws://10.0.0.9:8787",\
            "macIdentityPubKey":"\(key(9))","macDisplayName":"My Mac"}
            """
        defaults.set(
            Data(legacyJSON.utf8),
            forKey: UserDefaultsPairedHostStore.legacyKey)

        let store = UserDefaultsPairedHostStore(defaults: defaults)
        let hosts = store.list()
        #expect(hosts.map(\.macIdentityPubKey) == [key(9)])
        #expect(store.selectedHostId() == key(9))
        // Legacy key retired; v2 key now authoritative.
        #expect(defaults.data(forKey: UserDefaultsPairedHostStore.legacyKey) == nil)
        #expect(defaults.data(forKey: UserDefaultsPairedHostStore.documentKey) != nil)
    }

    @Test("store persists upsert / select / remove across re-reads")
    func storePersists() {
        let defaults = freshDefaults()
        let store = UserDefaultsPairedHostStore(defaults: defaults)
        store.upsert(host(1))
        store.upsert(host(2))
        store.setSelectedHostId(key(2))

        // A fresh store reading the same defaults sees the persisted state.
        let reread = UserDefaultsPairedHostStore(defaults: defaults)
        #expect(reread.list().map(\.macIdentityPubKey) == [key(1), key(2)])
        #expect(reread.selectedHostId() == key(2))

        reread.remove(macIdentityPubKey: key(2))
        #expect(reread.list().map(\.macIdentityPubKey) == [key(1)])
        #expect(reread.selectedHostId() == key(1)) // re-pointed off the removed host
    }

    @Test("clearAll forgets every host durably (legacy can't resurrect them)")
    func storeClearAllIsDurable() {
        let defaults = freshDefaults()
        // Seed BOTH a legacy blob and v2 content, then clear.
        defaults.set(
            Data("""
                {"relayUrl":"ws://x","macIdentityPubKey":"\(key(9))","macDisplayName":"Stale"}
                """.utf8),
            forKey: UserDefaultsPairedHostStore.legacyKey)
        let store = UserDefaultsPairedHostStore(defaults: defaults)
        store.upsert(host(1))
        store.clearAll()

        let reread = UserDefaultsPairedHostStore(defaults: defaults)
        #expect(reread.list().isEmpty)
        #expect(reread.selectedHostId() == nil)
    }

    // ── Push agreement key (macAgreePub) + App Group migration ──────────────

    @Test("macAgreePub round-trips and is nil on records that predate it")
    func macAgreePubRoundTrip() throws {
        let rec = host(1).withMacAgreePub("YWdyZWVwdWI=")
        #expect(rec.macAgreePub == "YWdyZWVwdWI=")
        #expect(rec.macIdentityPubKey == key(1)) // other fields preserved
        #expect(rec.relayUrls?.count == 2)
        let data = try #require(PairedHostsCodec.encode(PairedHostsDocument().upserting(rec)))
        #expect(PairedHostsCodec.decode(v2Data: data, legacyData: nil).hosts.first?.macAgreePub == "YWdyZWVwdWI=")
        // A v2 record written before the field decodes as nil, not a failure.
        let old = Data(
            "{\"v\":2,\"hosts\":[{\"relayUrl\":\"ws://x\",\"macIdentityPubKey\":\"\(key(2))\",\"macDisplayName\":\"Old\"}],\"selectedHostId\":\"\(key(2))\"}"
                .utf8)
        #expect(PairedHostsCodec.decode(v2Data: old, legacyData: nil).hosts.first?.macAgreePub == nil)
    }

    @Test("migrate copies the document into the App Group suite, once")
    func migrateToAppGroup() {
        let appPrivate = freshDefaults()
        let group = freshDefaults()
        UserDefaultsPairedHostStore(defaults: appPrivate).upsert(host(1).withMacAgreePub("AAAA"))
        UserDefaultsPairedHostStore.migrate(from: appPrivate, to: group)
        #expect(
            UserDefaultsPairedHostStore(defaults: group).find(macIdentityPubKey: key(1))?.macAgreePub
                == "AAAA")
        // Destination already has data → no-op (never clobber newer group data).
        UserDefaultsPairedHostStore(defaults: appPrivate).upsert(host(2))
        UserDefaultsPairedHostStore.migrate(from: appPrivate, to: group)
        #expect(UserDefaultsPairedHostStore(defaults: group).find(macIdentityPubKey: key(2)) == nil)
    }

    @Test("migrate folds a legacy v1 record when the source has no v2 document")
    func migrateFoldsLegacyV1() {
        let appPrivate = freshDefaults()
        let group = freshDefaults()
        // A phone upgrading straight from a pre-multi-host build: only the legacy
        // single-host key exists in the private domain (no v2 document yet).
        let legacyJSON = """
            {"relayUrl":"ws://10.0.0.9:8787",\
            "macIdentityPubKey":"\(key(9))","macDisplayName":"My Mac"}
            """
        appPrivate.set(Data(legacyJSON.utf8), forKey: UserDefaultsPairedHostStore.legacyKey)

        UserDefaultsPairedHostStore.migrate(from: appPrivate, to: group)

        let migrated = UserDefaultsPairedHostStore(defaults: group)
        #expect(migrated.list().map(\.macIdentityPubKey) == [key(9)])
        #expect(migrated.selectedHostId() == key(9))
    }

    @Test("migrate is a no-op on a fresh install (no legacy, no v2)")
    func migrateNoOpWhenEmpty() {
        let appPrivate = freshDefaults()
        let group = freshDefaults()
        UserDefaultsPairedHostStore.migrate(from: appPrivate, to: group)
        #expect(group.data(forKey: UserDefaultsPairedHostStore.documentKey) == nil)
    }
}
