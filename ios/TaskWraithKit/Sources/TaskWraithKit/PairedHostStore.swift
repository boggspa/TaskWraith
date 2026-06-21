/*
 * PairedHostStore — the phone's MULTI-HOST pairing memory.
 *
 * The companion can pair with many hosts (Macs, and — with the cross-platform
 * bridge — Windows/Linux machines). After the first pairing the phone remembers
 * WHO it paired with so app relaunches and host restarts reconnect silently via
 * the relay's resolve directory (each host pins this phone's identity and
 * accepts without a prompt). This is PUBLIC material only — each host's identity
 * public key, relay URLs, display name; the phone's PRIVATE identity seed stays
 * in the Keychain via IdentitySeedStore and is the SAME single seed for every
 * host (one phone identity pinned by N hosts).
 *
 * This is the phone-side mirror of the Mac's `RemotePairingStore`
 * (src/main/remote/RemotePairingStore.ts), which is already a v2 `{v, devices[]}`
 * collection with v1→v2 migration. Here the collection is keyed by
 * `macIdentityPubKey` (the natural primary key — it's what the relay resolve
 * directory is keyed on, and it's unique even when two hosts share a display
 * name / hostname).
 *
 * Design notes:
 *  - ALL migration / collection / selection logic lives in the pure value types
 *    (`PairedHostsDocument` + `PairedHostsCodec`) so it is exhaustively unit
 *    testable with plain `Data`, no UserDefaults and no SwiftUI.
 *  - `UserDefaultsPairedHostStore` is a thin imperative shell over those pure
 *    helpers; its `UserDefaults` is injectable so it can be integration-tested
 *    against an isolated `UserDefaults(suiteName:)` domain.
 *
 * "mac" in the field/key names is retained for WIRE/CRYPTO compatibility (the
 * e2ee handshake bakes the role string "mac" into its key schedule, and the
 * legacy single-host UserDefaults key was "taskwraith.pairedMac.v1"). The
 * user-facing vocabulary ("host") is a UI concern handled in the view layer.
 */

import Foundation

// ── The record ──────────────────────────────────────────────────────────────

/// One paired host. Field-compatible with the legacy single-host
/// `PairedMacRecord` (relayUrl / relayUrls / macIdentityPubKey / macDisplayName)
/// so a legacy blob decodes straight into this type during migration; adds an
/// optional `pairedAt` (ISO8601) used only for stable display ordering.
public struct PairedHostRecord: Codable, Sendable, Equatable, Identifiable {
    /// Primary relay URL captured at pairing (kept for records persisted before
    /// the multi-door `relayUrls` feature; reconnect falls back to this).
    public let relayUrl: String
    /// Ordered relay candidates captured at pairing time (LAN first, wss front
    /// door second). Optional so older records still decode.
    public let relayUrls: [String]?
    /// base64 raw 32B Ed25519 host identity public key — the primary key.
    public let macIdentityPubKey: String
    /// Human label for the host (e.g. "TaskWraith on studio.local"). Display
    /// only; never used for identity (hosts can collide on display name).
    public let macDisplayName: String
    /// ISO8601 timestamp of the pairing (optional; absent on migrated legacy
    /// records). Used to order the host list newest-first.
    public let pairedAt: String?

    /// Stable identity for SwiftUI `ForEach` / `Identifiable`.
    public var id: String { macIdentityPubKey }

    public init(
        relayUrl: String,
        macIdentityPubKey: String,
        macDisplayName: String,
        relayUrls: [String]? = nil,
        pairedAt: String? = nil
    ) {
        self.relayUrl = relayUrl
        self.relayUrls = relayUrls
        self.macIdentityPubKey = macIdentityPubKey
        self.macDisplayName = macDisplayName
        self.pairedAt = pairedAt
    }
}

// ── The document (pure, value-typed, fully testable) ─────────────────────────

/// The persisted multi-host document. `v` mirrors the Mac store's schema
/// version (2 = the collection era). `selectedHostId` is the
/// `macIdentityPubKey` of the host the phone should connect to / show as active.
public struct PairedHostsDocument: Codable, Sendable, Equatable {
    public static let schemaVersion = 2

    public var v: Int
    public var hosts: [PairedHostRecord]
    /// macIdentityPubKey of the active host, or nil if none paired/selected.
    public var selectedHostId: String?

    public init(
        v: Int = PairedHostsDocument.schemaVersion,
        hosts: [PairedHostRecord] = [],
        selectedHostId: String? = nil
    ) {
        self.v = v
        self.hosts = hosts
        self.selectedHostId = selectedHostId
    }

    /// The currently selected host record, if the selection points at a known
    /// host. Always consult this rather than indexing — `normalized()`
    /// guarantees the selection is valid, but callers may hold a pre-normalized
    /// value.
    public var selectedHost: PairedHostRecord? {
        guard let id = selectedHostId else { return nil }
        return hosts.first { $0.macIdentityPubKey == id }
    }

    public var isEmpty: Bool { hosts.isEmpty }

    // ── Pure mutations (value semantics — return a fresh, normalized doc) ──

    /// Insert or replace a host (dedupe on `macIdentityPubKey`, keeping the
    /// existing position when replacing). The first host ever added becomes the
    /// selection; otherwise selection is preserved.
    public func upserting(_ record: PairedHostRecord) -> PairedHostsDocument {
        var next = self
        if let index = next.hosts.firstIndex(where: {
            $0.macIdentityPubKey == record.macIdentityPubKey
        }) {
            next.hosts[index] = record
        } else {
            next.hosts.append(record)
        }
        // Auto-select the very first host so a fresh pairing is immediately the
        // active host (matches single-host behavior where pairing == active).
        if next.selectedHostId == nil {
            next.selectedHostId = record.macIdentityPubKey
        }
        return next.normalized()
    }

    /// Remove one host by identity key. If it was the selected host, the
    /// selection moves to the first remaining host (or nil when none remain).
    public func removing(macIdentityPubKey id: String) -> PairedHostsDocument {
        var next = self
        next.hosts.removeAll { $0.macIdentityPubKey == id }
        if next.selectedHostId == id {
            next.selectedHostId = next.hosts.first?.macIdentityPubKey
        }
        return next.normalized()
    }

    /// Choose the active host. A nil or unknown id normalizes to "first host"
    /// (or nil when the list is empty).
    public func selecting(_ id: String?) -> PairedHostsDocument {
        var next = self
        next.selectedHostId = id
        return next.normalized()
    }

    /// Defensive cleanup applied after every decode/mutation:
    ///  - drop duplicate identity keys (keep first position, last data wins),
    ///  - force `v` to the current schema version,
    ///  - guarantee `selectedHostId` points at an existing host (or nil).
    public func normalized() -> PairedHostsDocument {
        var seen: [String: Int] = [:]
        var deduped: [PairedHostRecord] = []
        for host in hosts {
            if let existing = seen[host.macIdentityPubKey] {
                deduped[existing] = host // last data wins, original slot kept
            } else {
                seen[host.macIdentityPubKey] = deduped.count
                deduped.append(host)
            }
        }
        var selected = selectedHostId
        if let current = selected, !seen.keys.contains(current) {
            selected = deduped.first?.macIdentityPubKey
        } else if selected == nil {
            selected = deduped.first?.macIdentityPubKey
        }
        return PairedHostsDocument(
            v: PairedHostsDocument.schemaVersion,
            hosts: deduped,
            selectedHostId: deduped.isEmpty ? nil : selected
        )
    }
}

// ── Migration codec (pure) ───────────────────────────────────────────────────

/// Decodes the persisted document, migrating the legacy single-host blob when
/// the v2 document is absent. The migration is ONE-SHOT and irreversible-by-
/// design: once a v2 document exists (even an empty one), the legacy blob is
/// IGNORED forever — so "forget all hosts" can't be undone by a stale legacy
/// record resurfacing on the next launch.
public enum PairedHostsCodec {
    /// - Parameters:
    ///   - v2Data: bytes under the v2 key (`taskwraith.pairedHosts.v2`), or nil.
    ///   - legacyData: bytes under the legacy single-host key
    ///     (`taskwraith.pairedMac.v1`), a bare `PairedHostRecord`-shaped blob.
    public static func decode(v2Data: Data?, legacyData: Data?) -> PairedHostsDocument {
        let decoder = JSONDecoder()
        // v2 era: trust the v2 document and NEVER fall back to legacy (even on
        // decode failure — a corrupt v2 starts clean rather than resurrecting a
        // host the user may have intentionally forgotten).
        if let v2Data {
            if let doc = try? decoder.decode(PairedHostsDocument.self, from: v2Data) {
                return doc.normalized()
            }
            return PairedHostsDocument()
        }
        // Pre-v2: migrate the single legacy record into a one-element list and
        // select it, so the user's existing pairing keeps reconnecting silently.
        if let legacyData,
            let legacy = try? decoder.decode(PairedHostRecord.self, from: legacyData)
        {
            return PairedHostsDocument(
                hosts: [legacy],
                selectedHostId: legacy.macIdentityPubKey
            ).normalized()
        }
        return PairedHostsDocument()
    }

    public static func encode(_ doc: PairedHostsDocument) -> Data? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try? encoder.encode(doc.normalized())
    }
}

// ── Store protocol + UserDefaults-backed implementation ──────────────────────

/// The phone's pairing memory, generalized from one record to a keyed
/// collection. Mirrors the Mac `RemotePairingStore` surface (list / upsert /
/// remove) plus an active-host selection the Mac side doesn't need.
public protocol PairedHostStore {
    func load() -> PairedHostsDocument
    func list() -> [PairedHostRecord]
    func find(macIdentityPubKey: String) -> PairedHostRecord?
    func upsert(_ record: PairedHostRecord)
    func remove(macIdentityPubKey: String)
    func selectedHostId() -> String?
    func setSelectedHostId(_ id: String?)
    /// Forget every host (persists an empty v2 document so the legacy blob can
    /// never resurrect a forgotten host).
    func clearAll()
}

/// UserDefaults-backed store. The legacy key is read once for migration and
/// then removed; the v2 key is authoritative thereafter.
public struct UserDefaultsPairedHostStore: PairedHostStore, @unchecked Sendable {
    static let legacyKey = "taskwraith.pairedMac.v1"
    static let documentKey = "taskwraith.pairedHosts.v2"

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func load() -> PairedHostsDocument {
        let v2 = defaults.data(forKey: Self.documentKey)
        let legacy = defaults.data(forKey: Self.legacyKey)
        let doc = PairedHostsCodec.decode(v2Data: v2, legacyData: legacy)
        // Persist the migrated document on first read so the legacy key can be
        // retired and subsequent reads take the fast v2 path.
        if v2 == nil {
            persist(doc)
        }
        return doc
    }

    public func list() -> [PairedHostRecord] { load().hosts }

    public func find(macIdentityPubKey: String) -> PairedHostRecord? {
        load().hosts.first { $0.macIdentityPubKey == macIdentityPubKey }
    }

    public func upsert(_ record: PairedHostRecord) {
        persist(load().upserting(record))
    }

    public func remove(macIdentityPubKey: String) {
        persist(load().removing(macIdentityPubKey: macIdentityPubKey))
    }

    public func selectedHostId() -> String? { load().selectedHostId }

    public func setSelectedHostId(_ id: String?) {
        persist(load().selecting(id))
    }

    public func clearAll() {
        persist(PairedHostsDocument())
    }

    private func persist(_ doc: PairedHostsDocument) {
        guard let data = PairedHostsCodec.encode(doc) else { return }
        defaults.set(data, forKey: Self.documentKey)
        // The v2 document is authoritative once written; drop the legacy blob so
        // a downgrade-then-upgrade can't reintroduce a stale single host.
        if defaults.data(forKey: Self.legacyKey) != nil {
            defaults.removeObject(forKey: Self.legacyKey)
        }
    }
}
