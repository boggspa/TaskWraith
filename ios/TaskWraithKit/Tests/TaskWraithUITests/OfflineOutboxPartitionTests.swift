import Foundation
import Testing

@testable import TaskWraithUI

/// The outbox is partitioned per paired Mac.
///
/// This is a correctness boundary, not tidiness: queued prompts are addressed
/// by thread id, thread ids are not unique across Macs, so a shared outbox
/// could deliver one Mac's prompt CONTENT into a colliding thread on another
/// Mac. These tests pin the two properties that make that impossible —
/// distinct hosts never share a partition, and no partition is ever destroyed.
@Suite("Offline outbox host partitioning")
struct OfflineOutboxPartitionTests {

    private func scratchSuite() -> String { "tw.tests.outbox.\(UUID().uuidString)" }

    private func clean(_ suite: String) {
        UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite)
    }

    private func queue(_ text: String, thread: String = "T", id: String = UUID().uuidString)
        -> OfflineComposerQueue
    {
        var q = OfflineComposerQueue()
        _ = q.enqueue(id: id, threadId: thread, text: text, now: Date())
        return q
    }

    @Test("Distinct host identities get distinct partitions")
    func distinctHostsDistinctKeys() {
        #expect(
            OfflineComposerQueueStore.key(forHostIdentity: "HOST-A")
                != OfflineComposerQueueStore.key(forHostIdentity: "HOST-B"))
    }

    /// Pinned host identities are **base64**, where `+`, `/` and `=` are
    /// ordinary characters. A key built by folding punctuation into a single
    /// placeholder maps these two DIFFERENT Macs onto ONE partition — which is
    /// exactly the cross-host mixing the partition exists to prevent, hidden
    /// behind a key that looks scoped.
    @Test("Base64 identities differing only in punctuation must not collide")
    func punctuationDoesNotCollide() {
        #expect(
            OfflineComposerQueueStore.key(forHostIdentity: "abc+def")
                != OfflineComposerQueueStore.key(forHostIdentity: "abc/def"))
        #expect(
            OfflineComposerQueueStore.key(forHostIdentity: "AA==")
                != OfflineComposerQueueStore.key(forHostIdentity: "AA//"))
    }

    /// A GOLDEN value, not a self-comparison.
    ///
    /// Comparing two calls in one process proves nothing about the property
    /// that matters: `hashValue` is stable within a process and different on
    /// every launch, so it would pass a self-comparison while handing the same
    /// Mac a new partition after each relaunch — losing the user's queued
    /// prompts silently, which is the exact loss this feature prevents. Only a
    /// literal pinned across runs can catch that.
    @Test("A host identity resolves to the same partition on every launch")
    func keysAreStableAcrossLaunches() {
        #expect(
            OfflineComposerQueueStore.key(forHostIdentity: "stable-identity")
                == "tw.composer.outbox.v2.stable-identity")
    }

    /// THE injectivity proof, and the reason the encoding is an escape rather
    /// than a hash.
    ///
    /// A digest can only ever be checked by enumerating pairs that happen not
    /// to collide, which demonstrates nothing about the pairs you did not
    /// think of. A reversible encoding can be checked directly: if every key
    /// decodes back to exactly the identity it came from, then two distinct
    /// identities cannot possibly share a key. This is the difference between
    /// "no collision has been observed" and "a collision cannot exist".
    @Test("Every key decodes back to its exact identity")
    func keyEncodingIsReversible() {
        let identities = [
            "abc+def", "abc/def", "AA==", "AA//", "~", "~~", "~7E", "tw~2Bx",
            "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA+/x=", "unpaired",
            "", " ", ".", "a.b", "emoji-🔑-identity", "tab\tsep", "new\nline",
        ]
        for identity in identities {
            let key = OfflineComposerQueueStore.key(forHostIdentity: identity)
            #expect(
                OfflineComposerQueueStore.hostIdentity(fromKey: key) == identity,
                "round-trip failed for \(identity.debugDescription) via \(key)")
        }
        // Injectivity restated as the property callers actually rely on.
        let keys = Set(identities.map(OfflineComposerQueueStore.key(forHostIdentity:)))
        #expect(keys.count == identities.count, "distinct identities produced a shared key")
    }

    /// The escape marker must itself be escaped, or the encoding is ambiguous
    /// and the round-trip above would be the only thing hiding it. A literal
    /// `~` in an identity must not be able to imitate an escape sequence.
    @Test("The escape marker cannot be forged by a literal in the identity")
    func escapeMarkerIsItselfEscaped() {
        #expect(
            OfflineComposerQueueStore.key(forHostIdentity: "~2B")
                != OfflineComposerQueueStore.key(forHostIdentity: "+"))
        #expect(!OfflineComposerQueueStore.key(forHostIdentity: "~").hasSuffix("."))
    }

    @Test("Prompts queued for one host are invisible to another")
    func partitionsAreIsolated() {
        let suite = scratchSuite()
        defer { clean(suite) }

        OfflineComposerQueueStore(hostIdentity: "HOST-A", suiteName: suite)
            .save(queue("for A"))

        let onB = OfflineComposerQueueStore(hostIdentity: "HOST-B", suiteName: suite).load()
        #expect(onB.entries.isEmpty, "B must not see a prompt the user addressed to A")

        let onA = OfflineComposerQueueStore(hostIdentity: "HOST-A", suiteName: suite).load()
        #expect(onA.entries.map(\.text) == ["for A"])
    }

    /// Switching hosts must PARK the previous Mac's prompts, never drop them.
    @Test("Re-pairing a previous host restores its prompts verbatim")
    func switchingHostsPreservesBothPartitions() {
        let suite = scratchSuite()
        defer { clean(suite) }

        OfflineComposerQueueStore(hostIdentity: "HOST-A", suiteName: suite)
            .save(queue("typed on A"))
        // Switch to B and write there.
        OfflineComposerQueueStore(hostIdentity: "HOST-B", suiteName: suite)
            .save(queue("typed on B"))
        // Switch back.
        let backOnA = OfflineComposerQueueStore(hostIdentity: "HOST-A", suiteName: suite).load()

        #expect(backOnA.entries.map(\.text) == ["typed on A"])
        #expect(
            OfflineComposerQueueStore(hostIdentity: "HOST-B", suiteName: suite)
                .load().entries.map(\.text) == ["typed on B"],
            "writing A must not have disturbed B either")
    }

    /// Prompts written before partitioning cannot be attributed to a Mac. They
    /// are counted so the user can be told, never adopted (that would be the
    /// misdelivery), and never deleted (that would be the silent loss).
    @Test("Legacy global prompts are counted, not adopted, not deleted")
    func legacyPromptsAreQuarantined() {
        let suite = scratchSuite()
        defer { clean(suite) }

        OfflineComposerQueueStore(suiteName: suite).save(queue("written before partitioning"))

        #expect(
            OfflineComposerQueueStore(hostIdentity: "HOST-A", suiteName: suite).load().entries
                .isEmpty,
            "a legacy prompt must not be adopted into an arbitrary host's outbox")
        #expect(OfflineComposerQueueStore.legacyQuarantinedCount(suiteName: suite) == 1)

        // Using a host partition must not disturb the quarantine.
        OfflineComposerQueueStore(hostIdentity: "HOST-A", suiteName: suite).save(queue("new"))
        #expect(
            OfflineComposerQueueStore.legacyQuarantinedCount(suiteName: suite) == 1,
            "legacy prompts must survive normal outbox use")
    }

    /// A count tells the user something of theirs is stranded and gives them
    /// no way to read it back. The data has to be retrievable before any
    /// recovery surface can exist.
    @Test("Quarantined prompts are retrievable, not just countable")
    func quarantinedPromptsAreReadable() {
        let suite = scratchSuite()
        defer { clean(suite) }

        OfflineComposerQueueStore(suiteName: suite).save(queue("stranded text", thread: "T-old"))

        let recovered = OfflineComposerQueueStore.legacyQuarantinedPrompts(suiteName: suite)
        #expect(recovered.map(\.text) == ["stranded text"])
        #expect(recovered.map(\.threadId) == ["T-old"])

        // Reading must not consume them.
        #expect(OfflineComposerQueueStore.legacyQuarantinedPrompts(suiteName: suite).count == 1)
    }

    @Test("The first host-scoped key migrates without losing its queue")
    func hashedHostPartitionMigratesToTheCollisionFreeKey() {
        let suite = scratchSuite()
        defer { clean(suite) }
        let oldKey = "tw.composer.outbox.v2.stableidentity.1e31ee615006832f"
        let oldStore = OfflineComposerQueueStore(suiteName: suite, key: oldKey)
        oldStore.save(queue("survives key migration"))

        let migrated = OfflineComposerQueueStore(
            hostIdentity: "stable-identity", suiteName: suite)
        #expect(migrated.load().entries.map(\.text) == ["survives key migration"])

        migrated.save(migrated.load())
        #expect(oldStore.load().entries.isEmpty)
        #expect(migrated.load().entries.map(\.text) == ["survives key migration"])
    }

    @Test("An empty legacy outbox reports nothing to quarantine")
    func legacyCountIsZeroWhenAbsent() {
        let suite = scratchSuite()
        defer { clean(suite) }
        #expect(OfflineComposerQueueStore.legacyQuarantinedCount(suiteName: suite) == 0)
    }
}
