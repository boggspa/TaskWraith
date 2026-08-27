import Foundation

/// One prompt the user sent while the Mac was not answering.
///
/// Distinct from a *draft* (`TWDraftPersistence`): a draft is text the user is
/// still writing and has not committed; an outbox entry is text the user
/// **pressed send on**. The difference matters for both copy and durability —
/// losing a draft is an annoyance, losing something the user believed they sent
/// is the exact "app seems broken" failure this feature exists to remove.
public struct QueuedComposerSend: Codable, Sendable, Equatable, Identifiable {
    /// Stable across relaunch and across flush attempts. Supplied by the caller
    /// so the send path can de-duplicate against a host-side receipt.
    public let id: String
    public let threadId: String
    public let text: String
    public let queuedAt: Date
    /// How many times `flush` has handed this entry out. Not a retry *limit* —
    /// the queue never discards on attempt count, because a Mac that has been
    /// off for a week should still deliver what the user typed. It exists so the
    /// UI can say "tried 3 times" honestly.
    public private(set) var attempts: Int
    /// True between a `flush` that handed this entry out and the matching
    /// `acknowledge`/`requeue`. Prevents the same prompt being sent twice when
    /// two flush triggers race (reconnect + foreground both fire).
    public private(set) var inFlight: Bool

    public init(
        id: String,
        threadId: String,
        text: String,
        queuedAt: Date,
        attempts: Int = 0,
        inFlight: Bool = false
    ) {
        self.id = id
        self.threadId = threadId
        self.text = text
        self.queuedAt = queuedAt
        self.attempts = attempts
        self.inFlight = inFlight
    }

    fileprivate mutating func markHandedOut() {
        inFlight = true
        attempts += 1
    }

    fileprivate mutating func markReturned() {
        inFlight = false
    }
}

/// Result of accepting a prompt into the outbox.
public enum OfflineComposerEnqueueOutcome: Sendable, Equatable {
    case queued(QueuedComposerSend)
    /// Accepted, but the queue was full and the oldest waiting prompt was
    /// dropped to make room. Callers MUST surface this — a silent drop is the
    /// same broken promise as a silent send failure.
    case queuedEvicting(QueuedComposerSend, evicted: QueuedComposerSend)
    /// Nothing was queued because the text was empty/whitespace.
    case rejectedEmpty
    /// Nothing was queued: the outbox is at capacity and EVERY entry is already
    /// in flight, so there is no evictable victim.
    ///
    /// Refusing is the only honest option here. Growing past the advertised
    /// bound would make `capacity` a lie and let `UserDefaults` swell without
    /// limit; evicting an in-flight entry is unsound because it may already be
    /// on the wire, which would break the queue's own de-duplication.
    ///
    /// **Caller contract:** on this outcome the composer MUST keep the user's
    /// text (do not clear the field) and MUST tell them the send did not go
    /// anywhere. Silently discarding it would be the same broken promise this
    /// whole type exists to remove.
    case rejectedFull(capacity: Int)
}

/// Durable FIFO outbox of prompts the user sent while the host was unreachable.
///
/// A pure value type: every operation is a `mutating func` on in-memory state
/// with no I/O, so the whole lifecycle is testable without `UserDefaults`, a
/// relay, or a host. Persistence is a separate, injectable adapter
/// (`OfflineComposerQueueStore`).
///
/// ## What queuing does and does not promise
///
/// Queuing promises **delivery of the attempt**, never acceptance of the work.
/// When the outbox flushes, the Mac is still fully authoritative and may reject
/// the prompt — provider not ready, permission denied, workspace revoked, thread
/// archived. Copy must therefore say "this sends when your Mac answers", never
/// "this will run". That mirrors the existing peer-message queue doctrine, where
/// the Mac's gate is the decision point and the phone only guarantees the
/// message survives until it can be offered.
public struct OfflineComposerQueue: Codable, Sendable, Equatable {
    /// Chosen to be generous enough that a normal offline session (a commute, a
    /// closed lid overnight) never evicts, while still bounding a UserDefaults
    /// blob. At the 8 KB text cap below, a full queue is ~400 KB worst case.
    public static let defaultCapacity = 50
    /// Per-entry text cap, mirroring the spirit of `TWDraftPersistence`'s cap.
    /// A pasted novel stays in the composer; it does not become a permanent
    /// resident of `UserDefaults`.
    public static let maxTextChars = 8_000

    public private(set) var entries: [QueuedComposerSend]
    public var capacity: Int

    /// Constructs a queue over `entries` as given.
    ///
    /// ## Over-capacity restores are PRESERVED, never truncated
    ///
    /// `entries.count > capacity` is accepted intact. That is deliberate and it
    /// is the whole answer to the upgrade path: a persisted blob written by an
    /// older, buggy build contains real prompts the user pressed send on, and
    /// silently deleting them at load would be precisely the dishonesty this
    /// type exists to remove — the same rule that makes `.queuedEvicting` and
    /// `.rejectedFull` observable outcomes rather than quiet drops.
    ///
    /// The invariant is instead enforced going FORWARD:
    ///   * `isOverCapacity` reports the condition so the UI can say so;
    ///   * `enqueue` refuses while over the bound, so it can never grow;
    ///   * ordinary draining (`flush` -> `acknowledge`) heals it with zero loss;
    ///   * a caller that wants to force it down calls `shedToCapacity()`, which
    ///     RETURNS exactly what it shed so nothing disappears unannounced.
    public init(entries: [QueuedComposerSend] = [], capacity: Int = defaultCapacity) {
        self.entries = entries
        self.capacity = max(1, capacity)
    }

    public var isEmpty: Bool { entries.isEmpty }
    public var count: Int { entries.count }

    /// True when a restored blob (or an older build) left more entries than the
    /// current bound allows. Surface this — the outbox is holding more than it
    /// promises to, and the user should be told rather than discover it when a
    /// send is refused.
    public var isOverCapacity: Bool { entries.count > capacity }

    /// How many entries beyond `capacity` are currently held. Zero when healthy.
    public var overflowCount: Int { max(0, entries.count - capacity) }

    /// Entries waiting to be handed out (not currently in flight).
    public var pending: [QueuedComposerSend] { entries.filter { !$0.inFlight } }

    /// Count for a single thread — drives a per-thread "N waiting" affordance.
    public func count(forThread threadId: String) -> Int {
        entries.reduce(into: 0) { $0 += ($1.threadId == threadId ? 1 : 0) }
    }

    /// Accept a prompt the user pressed send on while the host was not
    /// answering.
    ///
    /// Eviction rule: when the queue is at capacity, the **oldest pending**
    /// entry is dropped. Oldest-first is deliberate — the newest prompt is the
    /// one the user just typed and is actively watching, so dropping it is the
    /// most visible possible failure. In-flight entries are never evicted; they
    /// may already be on the wire, and dropping one would make the queue's own
    /// de-duplication unsound.
    ///
    /// When the queue is at capacity and every entry is in flight there is no
    /// evictable victim, and the enqueue is REFUSED with `.rejectedFull` rather
    /// than appended. See that case for the caller contract — the composer must
    /// keep the text and say so.
    ///
    /// When the queue is STRICTLY OVER capacity (only reachable from a blob
    /// persisted by an older build) the enqueue is refused outright and nothing
    /// is evicted — see `init` for why preserving those entries is the honest
    /// choice, and `shedToCapacity()` for the explicit way down.
    /// NOT `@discardableResult`, deliberately. The returned outcome is the ONLY
    /// record that a prompt was evicted (`.queuedEvicting`) or refused
    /// (`.rejectedFull`), so allowing a caller to drop it on the floor would let
    /// the silent loss this type exists to prevent back in through the TYPE
    /// SIGNATURE rather than the logic. A caller that genuinely does not need
    /// the value must write `_ =` and thereby say so at the call site.
    public mutating func enqueue(
        id: String,
        threadId: String,
        text: String,
        now: Date
    ) -> OfflineComposerEnqueueOutcome {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .rejectedEmpty
        }
        let capped =
            text.count > Self.maxTextChars ? String(text.prefix(Self.maxTextChars)) : text
        let entry = QueuedComposerSend(
            id: id, threadId: threadId, text: capped, queuedAt: now)

        // Strictly OVER the bound — reachable only from a blob persisted by an
        // older build. Refuse WITHOUT evicting: trading an existing prompt for
        // this one would destroy real user work and STILL leave the queue over
        // the bound, so it buys nothing. Draining, or an explicit
        // `shedToCapacity()`, is what heals it.
        if entries.count > capacity { return .rejectedFull(capacity: capacity) }

        var evicted: QueuedComposerSend?
        if entries.count == capacity {
            guard let victimIndex = entries.firstIndex(where: { !$0.inFlight }) else {
                // At capacity AND every entry is in flight: no evictable victim
                // exists. Refuse rather than append — an earlier version fell
                // through to `append` here and quietly grew past `capacity`,
                // making the advertised bound fiction.
                return .rejectedFull(capacity: capacity)
            }
            evicted = entries.remove(at: victimIndex)
        }
        entries.append(entry)

        if let evicted { return .queuedEvicting(entry, evicted: evicted) }
        return .queued(entry)
    }

    /// Hand out everything waiting, oldest first, and mark it in flight.
    ///
    /// **Idempotent by construction.** A second `flush` before the first is
    /// acknowledged returns an empty array, because every entry it would have
    /// returned is already `inFlight`. This is what makes it safe to wire flush
    /// to several triggers at once — session-established, scene-foreground and
    /// an APNs wake can all fire within milliseconds of each other, and only the
    /// first hands anything out.
    ///
    /// Pass `threadId` to flush a single thread; `nil` flushes everything.
    public mutating func flush(threadId: String? = nil) -> [QueuedComposerSend] {
        var handedOut: [QueuedComposerSend] = []
        for index in entries.indices {
            guard !entries[index].inFlight else { continue }
            if let threadId, entries[index].threadId != threadId { continue }
            entries[index].markHandedOut()
            handedOut.append(entries[index])
        }
        return handedOut
    }

    /// Remove an entry after the host accepted it. Idempotent: acknowledging an
    /// unknown or already-removed id is a no-op returning `false`, so a
    /// duplicated host receipt cannot corrupt the queue.
    @discardableResult
    public mutating func acknowledge(id: String) -> Bool {
        guard let index = entries.firstIndex(where: { $0.id == id }) else { return false }
        entries.remove(at: index)
        return true
    }

    /// Return an entry to the pending pool after a failed send, preserving its
    /// position (and therefore FIFO order) and its incremented attempt count.
    @discardableResult
    public mutating func requeue(id: String) -> Bool {
        guard let index = entries.firstIndex(where: { $0.id == id }) else { return false }
        entries[index].markReturned()
        return true
    }

    /// Drop an entry at the user's request (a "discard" affordance).
    @discardableResult
    public mutating func discard(id: String) -> Bool { acknowledge(id: id) }

    /// Force an over-capacity queue back down to `capacity`, returning EXACTLY
    /// the entries that were shed, oldest pending first.
    ///
    /// Never called implicitly — not by `init`, not by `Store.load`, not by
    /// `enqueue`. A restored over-capacity outbox holds real prompts, and the
    /// decision to discard any of them belongs to the user, not to a loader
    /// silently normalising a data structure. The return value exists so the
    /// caller can name what it dropped, exactly as `.queuedEvicting` does.
    ///
    /// In-flight entries are never shed: they may already be on the wire, and
    /// removing one would break the queue's de-duplication. If everything is in
    /// flight this returns empty and the queue stays over capacity — which is
    /// the truthful outcome, because there is nothing safe to drop.
    ///
    /// Ordinary draining (`flush` -> `acknowledge`) heals the same condition
    /// with zero loss and should always be preferred.
    /// NOT `@discardableResult`, deliberately — see `enqueue`. The returned
    /// array is the only record of which prompts were discarded; ignoring it is
    /// exactly the silent drop this API refuses to make possible.
    public mutating func shedToCapacity() -> [QueuedComposerSend] {
        var shed: [QueuedComposerSend] = []
        while entries.count > capacity,
            let victimIndex = entries.firstIndex(where: { !$0.inFlight })
        {
            shed.append(entries.remove(at: victimIndex))
        }
        return shed
    }

    /// Return every in-flight entry to pending. Call when a session drops
    /// mid-flush, so prompts that were handed out but never acknowledged are not
    /// stranded in flight forever.
    public mutating func reclaimInFlight() {
        for index in entries.indices where entries[index].inFlight {
            entries[index].markReturned()
        }
    }
}

/// Storage backing for the outbox.
///
/// A protocol so the outbox can persist anywhere and so a test needs no real
/// defaults suite. It refines `Sendable`, which is what lets
/// `OfflineComposerQueueStore` stay `Sendable` without an escape hatch.
public protocol OfflineComposerQueuePersistence: Sendable {
    func readOutbox() -> Data?
    func writeOutbox(_ data: Data)
    func clearOutbox()
}

/// `UserDefaults`-backed persistence, following the `TWDraftPersistence`
/// storage pattern (one JSON blob under one key).
///
/// ## Why this holds a suite NAME rather than a `UserDefaults`
///
/// `UserDefaults` is thread-safe at runtime but is not annotated `Sendable`, so
/// storing an instance here would force the enclosing type to
/// `@unchecked Sendable`. That escape hatch would suppress exactly the question
/// a reader should be able to answer from the declaration alone — and it would
/// keep suppressing it after some later edit made the type genuinely unsafe.
///
/// A `String?` suite name is trivially `Sendable`, and resolving the suite per
/// call is correct rather than merely convenient: every `UserDefaults` instance
/// for a given suite shares one backing store, so a freshly resolved handle
/// reads and writes the same data. The cost is a lookup on a path that runs
/// once per send or acknowledgement — not per keystroke, which is why drafts
/// debounce their writes and this does not.
public struct UserDefaultsOutboxPersistence: OfflineComposerQueuePersistence {
    private let suiteName: String?
    private let key: String

    /// `suiteName: nil` uses the standard defaults.
    public init(suiteName: String? = nil, key: String = OfflineComposerQueueStore.defaultsKey) {
        self.suiteName = suiteName
        self.key = key
    }

    private var defaults: UserDefaults {
        guard let suiteName, let suite = UserDefaults(suiteName: suiteName) else {
            return .standard
        }
        return suite
    }

    public func readOutbox() -> Data? { defaults.data(forKey: key) }
    public func writeOutbox(_ data: Data) { defaults.set(data, forKey: key) }
    public func clearOutbox() { defaults.removeObject(forKey: key) }
}

/// Reads a superseded host partition when the current key is absent, then
/// migrates it on the next save. The old bytes are cleared only after the new
/// key has been written, so changing the key format cannot strand a prompt.
private struct MigratingOutboxPersistence: OfflineComposerQueuePersistence {
    let primary: UserDefaultsOutboxPersistence
    let legacy: UserDefaultsOutboxPersistence

    func readOutbox() -> Data? {
        primary.readOutbox() ?? legacy.readOutbox()
    }

    func writeOutbox(_ data: Data) {
        primary.writeOutbox(data)
        // Clear only when the legacy bytes are the exact queue just copied.
        // If both keys somehow hold different data, preserving the older bytes
        // is safer than guessing that they are duplicates.
        if legacy.readOutbox() == data { legacy.clearOutbox() }
    }

    func clearOutbox() {
        primary.clearOutbox()
        legacy.clearOutbox()
    }
}

/// Durable persistence for the outbox over any `OfflineComposerQueuePersistence`.
///
/// Injectable rather than a static singleton, so tests can hand it a scratch
/// suite or an in-memory backing.
public struct OfflineComposerQueueStore: Sendable {
    public static let defaultsKey = "tw.composer.outbox.v1"

    private let persistence: any OfflineComposerQueuePersistence

    public init(persistence: any OfflineComposerQueuePersistence) {
        self.persistence = persistence
    }

    /// Convenience for the app and for suite-scoped tests.
    public init(suiteName: String? = nil, key: String = defaultsKey) {
        self.init(persistence: UserDefaultsOutboxPersistence(suiteName: suiteName, key: key))
    }

    /// Per-paired-host key. **Use this, not the legacy global one.**
    ///
    /// Queued prompts are addressed by thread id, and thread ids are not
    /// globally unique across Macs. A single shared outbox therefore risks
    /// delivering one Mac's prompt CONTENT into a colliding thread on a
    /// DIFFERENT Mac — a leak, not a tidiness problem.
    ///
    /// Distinct host identities CANNOT share a key. That is a property of the
    /// encoding, not a probability: the suffix is an injective (reversible)
    /// escape of the identity's UTF-8 bytes, so two different byte sequences
    /// always produce two different keys.
    ///
    /// Precondition, stated because it is the one way this could bite: the
    /// derivation is over UTF-8 BYTES, while Swift `String` equality is
    /// Unicode canonical equivalence. A caller that passed the same identity
    /// in two different normalisation forms would get two partitions for one
    /// Mac — losing a queue rather than mixing two. `pinnedMacIdentityB64` is
    /// ASCII base64, which has no normalisation variance, so this cannot arise
    /// today; a non-ASCII identity source would need normalising first.
    public static func key(forHostIdentity identity: String) -> String {
        // History, so nobody "simplifies" this back: the first version built
        // the key by sanitizing punctuation OUT of the identity. Pinned
        // identities are base64, where `+` and `/` are ordinary characters, so
        // `abc+def` and `abc/def` — two DIFFERENT Macs — collapsed onto ONE
        // partition, wearing a key that looked correctly scoped. The second
        // version hashed with FNV-1a, which fixed that collision but left a
        // 64-bit non-cryptographic hash as the only thing separating one
        // user's prompt text from another host's queue. Deterministic is not
        // the same as collision-resistant, and a probabilistic argument is the
        // wrong shape of guarantee in front of message content.
        //
        // So: escape rather than hash or digest. Unreserved bytes pass through
        // (the key stays readable for a base64 identity, which is almost all of
        // it); everything else becomes `~XX`. The escape marker is ITSELF
        // escaped, which is what makes the encoding unambiguous and therefore
        // injective — decode is a pure function of the output.
        //
        // Not `hashValue`: it is seeded per process, so the same Mac would get
        // a fresh partition on every launch and silently lose its queue.
        var encoded = ""
        encoded.reserveCapacity(identity.utf8.count + 8)
        for byte in identity.utf8 {
            let isUnreserved =
                (byte >= 0x41 && byte <= 0x5A)  // A-Z
                || (byte >= 0x61 && byte <= 0x7A)  // a-z
                || (byte >= 0x30 && byte <= 0x39)  // 0-9
                || byte == 0x2D  // -
                || byte == 0x5F  // _
            // `~` is deliberately NOT unreserved: it is the escape marker, and
            // admitting it here lets identity `~2B` forge the encoding of `+`,
            // putting two different Macs on one queue. Verified by deleting
            // this exclusion and watching both partition tests go red.
            if isUnreserved {
                encoded.append(Character(UnicodeScalar(byte)))
            } else {
                encoded.append("~")
                encoded.append(Self.hexDigits[Int(byte >> 4)])
                encoded.append(Self.hexDigits[Int(byte & 0x0F)])
            }
        }
        return "tw.composer.outbox.v2.\(encoded)"
    }

    private static let hexDigits: [Character] = Array("0123456789ABCDEF")

    /// Recover the identity a key was built for. Exists to make the injectivity
    /// claim above CHECKABLE rather than merely asserted — a round-trip test
    /// proves distinct identities cannot share a key far more directly than
    /// enumerating pairs that happen not to collide.
    public static func hostIdentity(fromKey key: String) -> String? {
        let prefix = "tw.composer.outbox.v2."
        guard key.hasPrefix(prefix) else { return nil }
        var bytes: [UInt8] = []
        var rest = Substring(key.dropFirst(prefix.count))
        while let next = rest.first {
            if next == "~" {
                let hex = rest.dropFirst().prefix(2)
                guard hex.count == 2, let byte = UInt8(hex, radix: 16) else { return nil }
                bytes.append(byte)
                rest = rest.dropFirst(3)
            } else {
                guard let ascii = next.asciiValue else { return nil }
                bytes.append(ascii)
                rest = rest.dropFirst()
            }
        }
        return String(bytes: bytes, encoding: .utf8)
    }

    /// Partition key emitted by the first host-scoped implementation. Keep it
    /// as a migration source; changing algorithms without this dual-read would
    /// make already queued prompts appear to vanish.
    private static func legacyHashedKey(forHostIdentity identity: String) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in identity.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        let readable = String(identity.filter { $0.isLetter || $0.isNumber }.prefix(24))
        return "tw.composer.outbox.v2.\(readable).\(String(hash, radix: 16))"
    }

    /// Build a store scoped to one paired Mac.
    public init(hostIdentity: String, suiteName: String? = nil) {
        self.init(
            persistence: MigratingOutboxPersistence(
                primary: UserDefaultsOutboxPersistence(
                    suiteName: suiteName, key: Self.key(forHostIdentity: hostIdentity)),
                legacy: UserDefaultsOutboxPersistence(
                    suiteName: suiteName,
                    key: Self.legacyHashedKey(forHostIdentity: hostIdentity))))
    }

    /// How many prompts are stranded in the LEGACY global outbox written by a
    /// build that shared one queue across every paired Mac.
    ///
    /// They are deliberately never adopted into a host partition — we cannot
    /// know which Mac they were meant for, and guessing is exactly the
    /// misdelivery partitioning prevents. They are also never deleted: silently
    /// discarding prompts the user pressed send on is the loss this whole type
    /// exists to prevent. They are quarantined and COUNTED, so the user can be
    /// told they exist and decide what happens to them.
    public static func legacyQuarantinedCount(suiteName: String? = nil) -> Int {
        legacyQuarantinedPrompts(suiteName: suiteName).count
    }

    /// The quarantined prompts THEMSELVES, not just how many.
    ///
    /// A count alone tells the user something of theirs is stranded and gives
    /// them no way to read it back — which is a quieter version of the loss
    /// this type exists to prevent. Recovery UI is not in this file's scope,
    /// but the data it needs is, and withholding it would force the surface to
    /// re-derive the legacy key by hand.
    ///
    /// Read-only by construction: nothing here deletes or migrates the legacy
    /// blob. Deciding which Mac these belong to is the user's call, not ours.
    public static func legacyQuarantinedPrompts(suiteName: String? = nil)
        -> [QueuedComposerSend]
    {
        let persistence = UserDefaultsOutboxPersistence(suiteName: suiteName, key: defaultsKey)
        guard let data = persistence.readOutbox(),
            let decoded = try? JSONDecoder().decode([QueuedComposerSend].self, from: data)
        else { return [] }
        return decoded
    }

    /// Load the persisted outbox. A missing or undecodable blob yields an empty
    /// queue rather than throwing — a corrupt outbox must not brick the
    /// composer, and the user's worst case is losing queued prompts they were
    /// already told might be delayed.
    ///
    /// A blob holding MORE than `capacity` entries (written by an older build
    /// whose bound leaked) is loaded INTACT, not truncated. Check
    /// `isOverCapacity` after loading and tell the user; see `init` for why
    /// silently normalising it here would be the wrong kind of tidy.
    public func load(capacity: Int = OfflineComposerQueue.defaultCapacity) -> OfflineComposerQueue
    {
        guard let data = persistence.readOutbox(),
            let decoded = try? JSONDecoder().decode([QueuedComposerSend].self, from: data)
        else { return OfflineComposerQueue(capacity: capacity) }
        // Anything persisted as in-flight was interrupted by termination, not
        // acknowledged. Reclaim it on load so a relaunch never strands a prompt.
        var queue = OfflineComposerQueue(entries: decoded, capacity: capacity)
        queue.reclaimInFlight()
        return queue
    }

    public func save(_ queue: OfflineComposerQueue) {
        guard let data = try? JSONEncoder().encode(queue.entries) else { return }
        persistence.writeOutbox(data)
    }

    public func clear() { persistence.clearOutbox() }
}

/// What the host did with one queued prompt on flush.
///
/// The distinction between `.rejected` and `.unreachable` is load-bearing: one
/// means the Mac ANSWERED and said no, the other means we never got there. They
/// call for different handling and different words, and collapsing them would
/// make "your prompt was refused" indistinguishable from "we couldn't ask".
public enum OfflineOutboxDelivery: Sendable, Equatable {
    /// The host accepted it. Only this removes the entry from the outbox.
    case delivered
    /// The host was reached and REFUSED — provider not ready, permission
    /// denied, thread archived. **A rejection is not a delivery.** The entry
    /// returns to the outbox and the reason is reported, because the Mac stays
    /// authoritative and the user is entitled to know their prompt did not run.
    case rejected(String)
    /// The host could not be reached at all. The entry returns and the drain
    /// stops — continuing would just fail once per remaining prompt.
    case unreachable
}

public struct OfflineOutboxRejection: Sendable, Equatable {
    public let entry: QueuedComposerSend
    public let reason: String

    public init(entry: QueuedComposerSend, reason: String) {
        self.entry = entry
        self.reason = reason
    }
}

/// Exactly what one drain did. Every entry handed out lands in precisely one
/// bucket, so nothing can be delivered "somewhere" — the caller can always name
/// what happened to each prompt.
public struct OfflineOutboxDrainReport: Sendable, Equatable {
    public var delivered: [QueuedComposerSend] = []
    public var rejected: [OfflineOutboxRejection] = []
    public var deferred: [QueuedComposerSend] = []

    public init() {}

    public var isEmpty: Bool {
        delivered.isEmpty && rejected.isEmpty && deferred.isEmpty
    }
    /// Total entries this drain accounted for.
    public var handledCount: Int { delivered.count + rejected.count + deferred.count }
}

/// Drains the offline outbox once a session is established.
///
/// Split out of `RemoteSessionModel` so the SEQUENCING — the part with the
/// interesting failure modes — is unit-testable against a stub sender, with no
/// transport, no host and no session. The model supplies the real send closure
/// and nothing else.
///
/// ## Guarantees
///
/// * **Idempotent.** Two guards, deliberately — and it is worth knowing which
///   one actually carries the weight. `OfflineComposerQueue.flush()` is
///   idempotent by construction: the first call marks everything in flight, so a
///   second returns nothing. THAT is the load-bearing protection against a
///   double-send, and it was verified by deleting the `draining` guard and
///   re-running this file's drain suite, which stayed green. `draining` is
///   therefore defence-in-depth: it stops a reconnect storm from launching
///   pointless concurrent drains, and it makes the intent legible, but the
///   correctness guarantee lives in the queue. Do not "simplify" by removing the
///   flush-side in-flight marking on the grounds that `draining` covers it — it
///   is the other way round.
/// * **Oldest first**, because `flush()` preserves FIFO.
/// * **Nothing vanishes on failure.** A rejected entry is requeued; an
///   unreachable host reclaims the whole un-attempted remainder. The only path
///   that removes an entry is an explicit `.delivered`.
@MainActor
public final class OfflineOutboxDrainer {
    public private(set) var queue: OfflineComposerQueue
    private let store: OfflineComposerQueueStore?
    private var draining = false

    public init(queue: OfflineComposerQueue, store: OfflineComposerQueueStore? = nil) {
        self.queue = queue
        self.store = store
    }

    /// True while a drain is running — a concurrent call will no-op.
    public var isDraining: Bool { draining }

    /// Accept a prompt into the outbox and persist it.
    ///
    /// NOT `@discardableResult`, for the same reason as
    /// `OfflineComposerQueue.enqueue`: the outcome is the only record of an
    /// eviction or refusal.
    public func enqueue(id: String, threadId: String, text: String, now: Date)
        -> OfflineComposerEnqueueOutcome
    {
        let outcome = queue.enqueue(id: id, threadId: threadId, text: text, now: now)
        store?.save(queue)
        return outcome
    }

    /// Attempt delivery of everything waiting, oldest first.
    ///
    /// Returns an empty report when a drain is already running; that is the
    /// storm guard doing its job, and `isEmpty` distinguishes it from "there was
    /// nothing to send" only in combination with the queue's own state, which is
    /// why the report is returned rather than discarded.
    public func drain(
        send: (QueuedComposerSend) async -> OfflineOutboxDelivery
    ) async -> OfflineOutboxDrainReport {
        guard !draining else { return OfflineOutboxDrainReport() }
        draining = true
        defer { draining = false }

        var report = OfflineOutboxDrainReport()
        let batch = queue.flush()

        var index = 0
        while index < batch.count {
            let entry = batch[index]
            switch await send(entry) {
            case .delivered:
                queue.acknowledge(id: entry.id)
                report.delivered.append(entry)
            case let .rejected(reason):
                // Reached the Mac; it said no. Keep the prompt and say why.
                queue.requeue(id: entry.id)
                report.rejected.append(OfflineOutboxRejection(entry: entry, reason: reason))
            case .unreachable:
                // The path is gone mid-drain. Return this entry AND every
                // un-attempted one still marked in flight, then stop.
                queue.reclaimInFlight()
                report.deferred.append(contentsOf: batch[index...])
                store?.save(queue)
                return report
            }
            index += 1
        }

        store?.save(queue)
        return report
    }
}

// MARK: - Pass-2 integration surface
//
// Headless by design; `ComposerView.swift` and `RemoteSessionModel.swift` belong
// to other lanes this pass. A pass-2 integration lane should:
//
//  1. Hold one `OfflineComposerQueue` loaded via `OfflineComposerQueueStore` at
//     session start, and `save` after every mutation. Check `isOverCapacity`
//     right after loading — an upgrade from a build with the leaked bound can
//     restore more entries than the bound allows. Tell the user, let draining
//     heal it, and offer `shedToCapacity()` only as an explicit user action
//     whose return value names every prompt discarded.
//  2. In the composer send path, when `HostLiveness.shouldQueueOutbound` is
//     true, call `enqueue(id:threadId:text:now:)` with a fresh stable id and
//     show `HostLiveness.copy.queueNotice`. Handle `.queuedEvicting` by telling
//     the user which prompt was dropped — never swallow it. Handle
//     `.rejectedFull` by KEEPING the composer text and reporting that the send
//     did not happen; clearing the field there would lose the prompt outright.
//  3. On session `.connected`, call `flush()` and feed each entry through the
//     normal send path, then `acknowledge(id:)` on host receipt or
//     `requeue(id:)` on failure.
//  4. Call `reclaimInFlight()` if the session drops mid-flush.
//
// Deliberately NOT decided here: the id scheme. The send path already has to
// de-duplicate against host receipts, so the id should come from whatever
// identifier that path already trusts rather than a UUID invented here.
