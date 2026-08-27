import Foundation
import Testing

@testable import TaskWraithUI

@Suite("OfflineComposerQueue ordering and flush")
struct OfflineComposerQueueTests {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    private func at(_ seconds: TimeInterval) -> Date { t0.addingTimeInterval(seconds) }

    private func makeQueue(_ ids: [String], capacity: Int = 50) -> OfflineComposerQueue {
        var queue = OfflineComposerQueue(capacity: capacity)
        for (index, id) in ids.enumerated() {
            _ = queue.enqueue(id: id, threadId: "thread-a", text: "prompt \(id)", now: at(Double(index)))
        }
        return queue
    }

    // MARK: - Accept

    @Test("empty or whitespace-only text is rejected, not queued")
    func emptyIsRejected() {
        var queue = OfflineComposerQueue()
        let empty = queue.enqueue(id: "1", threadId: "t", text: "", now: t0)
        let whitespace = queue.enqueue(id: "2", threadId: "t", text: "   \n\t ", now: t0)
        #expect(empty == .rejectedEmpty)
        #expect(whitespace == .rejectedEmpty)
        #expect(queue.isEmpty)
    }

    @Test("oversized text is capped, not dropped")
    func oversizedTextIsCapped() {
        var queue = OfflineComposerQueue()
        let huge = String(repeating: "x", count: OfflineComposerQueue.maxTextChars + 5_000)
        _ = queue.enqueue(id: "1", threadId: "t", text: huge, now: t0)
        #expect(queue.count == 1)
        #expect(queue.entries[0].text.count == OfflineComposerQueue.maxTextChars)
    }

    @Test("queued entries preserve FIFO order")
    func fifoOrdering() {
        let queue = makeQueue(["a", "b", "c"])
        #expect(queue.entries.map(\.id) == ["a", "b", "c"])
    }

    @Test("per-thread counts are exact")
    func perThreadCounts() {
        var queue = OfflineComposerQueue()
        _ = queue.enqueue(id: "1", threadId: "alpha", text: "x", now: t0)
        _ = queue.enqueue(id: "2", threadId: "beta", text: "y", now: at(1))
        _ = queue.enqueue(id: "3", threadId: "alpha", text: "z", now: at(2))
        #expect(queue.count(forThread: "alpha") == 2)
        #expect(queue.count(forThread: "beta") == 1)
        #expect(queue.count(forThread: "gamma") == 0)
    }

    // MARK: - Eviction

    @Test("at capacity the OLDEST pending entry is evicted and reported")
    func evictsOldestPending() {
        var queue = makeQueue(["a", "b"], capacity: 2)
        let outcome = queue.enqueue(id: "c", threadId: "thread-a", text: "third", now: at(9))

        guard case let .queuedEvicting(queued, evicted) = outcome else {
            Issue.record("expected an eviction outcome, got \(outcome)")
            return
        }
        #expect(queued.id == "c")
        #expect(evicted.id == "a", "the oldest waiting prompt is the one dropped")
        #expect(queue.entries.map(\.id) == ["b", "c"])
    }

    @Test("eviction never drops an in-flight entry")
    func neverEvictsInFlight() {
        var queue = makeQueue(["a", "b"], capacity: 2)
        // "a" goes on the wire.
        let handedOut = queue.flush(threadId: "thread-a")
        #expect(handedOut.map(\.id) == ["a", "b"])
        // Both are now in flight; requeue "b" so exactly one is evictable.
        queue.requeue(id: "b")

        let outcome = queue.enqueue(id: "c", threadId: "thread-a", text: "third", now: at(9))
        guard case let .queuedEvicting(_, evicted) = outcome else {
            Issue.record("expected an eviction outcome, got \(outcome)")
            return
        }
        #expect(evicted.id == "b", "in-flight 'a' must survive; only pending 'b' is evictable")
        #expect(queue.entries.contains { $0.id == "a" })
    }

    @Test("an eviction is never silent — the dropped entry is always returned")
    func evictionIsAlwaysReported() {
        var queue = makeQueue(["a"], capacity: 1)
        let outcome = queue.enqueue(id: "b", threadId: "thread-a", text: "second", now: at(5))
        if case .queued = outcome {
            Issue.record("a drop was reported as a plain queue — the user would never be told")
        }
    }

    @Test("at capacity with EVERY entry in flight, the enqueue is refused rather than appended")
    func refusesWhenNoEvictableVictimExists() {
        // Regression guard: an earlier version fell through to `append` when no
        // evictable victim existed, so the advertised bound was fiction.
        var queue = makeQueue(["a", "b"], capacity: 2)
        _ = queue.flush()
        #expect(queue.pending.isEmpty, "precondition: no evictable victim")

        let outcome = queue.enqueue(id: "c", threadId: "thread-a", text: "third", now: at(9))
        guard case let .rejectedFull(capacity) = outcome else {
            Issue.record("expected .rejectedFull, got \(outcome)")
            return
        }
        #expect(capacity == 2)
        #expect(queue.count == 2, "the bound must hold — nothing may be appended")
        #expect(queue.entries.map(\.id) == ["a", "b"], "in-flight entries survive untouched")
    }

    @Test("the bound holds under sustained pressure on both the evict and refuse paths")
    func neverExceedsCapacity() {
        var queue = makeQueue(["a", "b", "c"], capacity: 3)

        // Evict path: everything pending, oldest is dropped each time.
        for index in 0..<20 {
            _ = queue.enqueue(
                id: "pending-\(index)", threadId: "thread-a", text: "x",
                now: at(Double(100 + index)))
            #expect(queue.count <= 3, "bound breached on the evict path at \(index)")
        }

        // Refuse path: everything in flight, so nothing is evictable.
        _ = queue.flush()
        for index in 0..<5 {
            _ = queue.enqueue(
                id: "inflight-\(index)", threadId: "thread-a", text: "y",
                now: at(Double(200 + index)))
            #expect(queue.count <= 3, "bound breached on the refuse path at \(index)")
        }
        #expect(queue.count == 3)
    }

    // MARK: - Flush idempotence

    @Test("a second flush before acknowledgement hands out nothing")
    func flushIsIdempotent() {
        var queue = makeQueue(["a", "b"])
        let first = queue.flush()
        #expect(first.map(\.id) == ["a", "b"])

        let second = queue.flush()
        #expect(second.isEmpty, "racing flush triggers must not send the same prompt twice")
        #expect(queue.count == 2, "nothing is removed until the host acknowledges")
    }

    @Test("three racing flush triggers hand out exactly one copy of each entry")
    func racingFlushTriggers() {
        var queue = makeQueue(["a", "b", "c"])
        // Session-established + scene-foreground + APNs wake, all within a tick.
        let established = queue.flush()
        let foreground = queue.flush()
        let apns = queue.flush()
        let handed = established + foreground + apns
        #expect(handed.map(\.id).sorted() == ["a", "b", "c"])
        #expect(foreground.isEmpty)
        #expect(apns.isEmpty)
    }

    @Test("flush marks entries in flight and increments attempts")
    func flushTracksAttempts() {
        var queue = makeQueue(["a"])
        _ = queue.flush()
        #expect(queue.entries[0].inFlight)
        #expect(queue.entries[0].attempts == 1)

        queue.requeue(id: "a")
        _ = queue.flush()
        #expect(queue.entries[0].attempts == 2)
    }

    @Test("attempts never cause a discard — a week-old prompt still delivers")
    func attemptsNeverDiscard() {
        var queue = makeQueue(["a"])
        for _ in 0..<50 {
            _ = queue.flush()
            queue.requeue(id: "a")
        }
        #expect(queue.count == 1)
        #expect(queue.entries[0].attempts == 50)
    }

    @Test("flush can be scoped to a single thread")
    func scopedFlush() {
        var queue = OfflineComposerQueue()
        _ = queue.enqueue(id: "1", threadId: "alpha", text: "x", now: t0)
        _ = queue.enqueue(id: "2", threadId: "beta", text: "y", now: at(1))

        let alpha = queue.flush(threadId: "alpha")
        #expect(alpha.map(\.id) == ["1"])
        #expect(queue.pending.map(\.id) == ["2"])
    }

    // MARK: - Acknowledge / requeue

    @Test("acknowledge removes once and is idempotent thereafter")
    func acknowledgeIsIdempotent() {
        var queue = makeQueue(["a", "b"])
        _ = queue.flush()
        // Extracted rather than inlined: `#expect` expands its argument, and a
        // mutating call inside the expansion is rejected as a mutation on an
        // immutable value.
        let firstAck = queue.acknowledge(id: "a")
        let duplicateAck = queue.acknowledge(id: "a")
        let unknownAck = queue.acknowledge(id: "nonexistent")
        #expect(firstAck)
        #expect(duplicateAck == false, "a duplicated host receipt must be a no-op")
        #expect(unknownAck == false)
        #expect(queue.entries.map(\.id) == ["b"])
    }

    @Test("requeue preserves FIFO position")
    func requeuePreservesPosition() {
        var queue = makeQueue(["a", "b", "c"])
        _ = queue.flush()
        queue.requeue(id: "a")
        #expect(queue.entries.map(\.id) == ["a", "b", "c"])
        #expect(queue.pending.map(\.id) == ["a"])
    }

    @Test("reclaimInFlight returns a stranded mid-flush batch to pending")
    func reclaimInFlight() {
        var queue = makeQueue(["a", "b"])
        _ = queue.flush()
        #expect(queue.pending.isEmpty)

        // Session dropped mid-flush; nothing was acknowledged.
        queue.reclaimInFlight()
        #expect(queue.pending.map(\.id) == ["a", "b"])
        let reflushed = queue.flush()
        #expect(reflushed.map(\.id) == ["a", "b"])
    }
}

@Suite("OfflineComposerQueue durability")
struct OfflineComposerQueueStoreTests {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    private func scratchDefaults() -> (UserDefaults, String) {
        let suite = "tw.tests.outbox.\(UUID().uuidString)"
        return (UserDefaults(suiteName: suite)!, suite)
    }

    @Test("a queued prompt survives a relaunch")
    func survivesRelaunch() {
        let (defaults, suite) = scratchDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }

        let store = OfflineComposerQueueStore(suiteName: suite)
        var queue = store.load()
        _ = queue.enqueue(id: "a", threadId: "thread-a", text: "written on the train", now: t0)
        store.save(queue)

        // Fresh process: a brand-new store over the same backing defaults.
        let reloaded = OfflineComposerQueueStore(suiteName: suite).load()
        #expect(reloaded.count == 1)
        #expect(reloaded.entries[0].text == "written on the train")
        #expect(reloaded.entries[0].threadId == "thread-a")
    }

    @Test("ordering survives a relaunch")
    func orderingSurvivesRelaunch() {
        let (defaults, suite) = scratchDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }

        let store = OfflineComposerQueueStore(suiteName: suite)
        var queue = store.load()
        for (index, id) in ["a", "b", "c"].enumerated() {
            _ = queue.enqueue(
                id: id, threadId: "t", text: id, now: t0.addingTimeInterval(Double(index)))
        }
        store.save(queue)

        #expect(store.load().entries.map(\.id) == ["a", "b", "c"])
    }

    @Test("an entry interrupted in flight is reclaimed on load, never stranded")
    func inFlightIsReclaimedOnLoad() {
        let (defaults, suite) = scratchDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }

        let store = OfflineComposerQueueStore(suiteName: suite)
        var queue = store.load()
        _ = queue.enqueue(id: "a", threadId: "t", text: "mid-flight", now: t0)
        _ = queue.flush()  // handed out, never acknowledged — then the app died
        store.save(queue)

        let reloaded = store.load()
        #expect(
            reloaded.pending.map(\.id) == ["a"],
            "a prompt interrupted by termination must be sendable again, not stuck in flight")
    }

    @Test("a corrupt blob yields an empty queue instead of bricking the composer")
    func corruptBlobIsSurvivable() {
        let (defaults, suite) = scratchDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }

        defaults.set(Data("not json".utf8), forKey: OfflineComposerQueueStore.defaultsKey)
        let queue = OfflineComposerQueueStore(suiteName: suite).load()
        #expect(queue.isEmpty)
    }

    @Test("an absent blob yields an empty queue at the requested capacity")
    func absentBlobIsEmpty() {
        let (defaults, suite) = scratchDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }

        let queue = OfflineComposerQueueStore(suiteName: suite).load(capacity: 7)
        #expect(queue.isEmpty)
        #expect(queue.capacity == 7)
    }

    @Test("clear removes the persisted outbox")
    func clearRemoves() {
        let (defaults, suite) = scratchDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }

        let store = OfflineComposerQueueStore(suiteName: suite)
        var queue = store.load()
        _ = queue.enqueue(id: "a", threadId: "t", text: "x", now: t0)
        store.save(queue)
        #expect(store.load().count == 1)

        store.clear()
        #expect(store.load().isEmpty)
    }

    @Test("the outbox key is distinct from the drafts key")
    func keyDoesNotCollideWithDrafts() {
        // Drafts and the outbox are different promises to the user; sharing a
        // key would let one clobber the other.
        #expect(OfflineComposerQueueStore.defaultsKey == "tw.composer.outbox.v1")
        #expect(OfflineComposerQueueStore.defaultsKey != "tw.composer.drafts.v1")
    }
}

/// Test double proving the persistence seam is real rather than decorative:
/// the store must work over any backing, not just `UserDefaults`.
///
/// `@unchecked Sendable` is justified here and only here — the mutable state is
/// guarded by an `NSLock` on every access. Production code deliberately avoids
/// this escape hatch; see the note on `UserDefaultsOutboxPersistence`.
private final class InMemoryOutboxPersistence: OfflineComposerQueuePersistence, @unchecked Sendable
{
    private let lock = NSLock()
    private var storage: Data?

    func readOutbox() -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    func writeOutbox(_ data: Data) {
        lock.lock()
        defer { lock.unlock() }
        storage = data
    }

    func clearOutbox() {
        lock.lock()
        defer { lock.unlock() }
        storage = nil
    }
}

@Suite("OfflineOutboxDrainer flush-on-reconnect")
@MainActor
struct OfflineOutboxDrainerTests {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    private func makeQueue(_ ids: [String], capacity: Int = 50) -> OfflineComposerQueue {
        var queue = OfflineComposerQueue(capacity: capacity)
        for (index, id) in ids.enumerated() {
            _ = queue.enqueue(
                id: id, threadId: "thread-a", text: "prompt \(id)",
                now: t0.addingTimeInterval(Double(index)))
        }
        return queue
    }

    @Test("delivers oldest first and removes only what the host accepted")
    func deliversOldestFirst() async {
        let drainer = OfflineOutboxDrainer(queue: makeQueue(["a", "b", "c"]))
        var order: [String] = []

        let report = await drainer.drain { entry in
            order.append(entry.id)
            return .delivered
        }

        #expect(order == ["a", "b", "c"])
        #expect(report.delivered.map(\.id) == ["a", "b", "c"])
        #expect(drainer.queue.isEmpty, "delivered entries leave the outbox")
    }

    @Test("a REJECTION is not a delivery — the prompt is kept and the reason reported")
    func rejectionKeepsThePrompt() async {
        let drainer = OfflineOutboxDrainer(queue: makeQueue(["a"]))

        let report = await drainer.drain { _ in .rejected("provider not ready") }

        #expect(report.delivered.isEmpty)
        #expect(report.rejected.map(\.reason) == ["provider not ready"])
        #expect(drainer.queue.count == 1, "a refused prompt must not vanish")
        #expect(drainer.queue.pending.map(\.id) == ["a"], "and it must be sendable again")
    }

    @Test("an unreachable host defers the whole remainder and stops the drain")
    func unreachableStopsAndDefersRemainder() async {
        let drainer = OfflineOutboxDrainer(queue: makeQueue(["a", "b", "c"]))
        var attempts: [String] = []

        let report = await drainer.drain { entry in
            attempts.append(entry.id)
            return entry.id == "a" ? .delivered : .unreachable
        }

        #expect(attempts == ["a", "b"], "the drain stops instead of failing once per prompt")
        #expect(report.delivered.map(\.id) == ["a"])
        #expect(report.deferred.map(\.id) == ["b", "c"], "including the un-attempted tail")
        #expect(
            drainer.queue.pending.map(\.id) == ["b", "c"],
            "everything not delivered returns to the outbox, sendable again")
    }

    @Test("a mid-flush failure loses nothing — every entry lands in exactly one bucket")
    func midFlushFailureLosesNothing() async {
        let drainer = OfflineOutboxDrainer(queue: makeQueue(["a", "b", "c", "d"]))

        let report = await drainer.drain { entry in
            switch entry.id {
            case "a": return .delivered
            case "b": return .rejected("thread archived")
            default: return .unreachable
            }
        }

        #expect(report.handledCount == 4, "no prompt may go unaccounted for")
        #expect(report.delivered.map(\.id) == ["a"])
        #expect(report.rejected.map(\.entry.id) == ["b"])
        #expect(report.deferred.map(\.id) == ["c", "d"])
        #expect(drainer.queue.pending.map(\.id) == ["b", "c", "d"])
    }

    @Test("a RE-ENTRANT drain no-ops rather than double-sending (the storm guard)")
    func reentrantDrainNoOps() async {
        // A reconnect storm can fire `.established` repeatedly. Sending a
        // prompt twice is worse than sending it late.
        let drainer = OfflineOutboxDrainer(queue: makeQueue(["a", "b"]))
        var sends: [String] = []
        var innerReport: OfflineOutboxDrainReport?

        let report = await drainer.drain { entry in
            sends.append(entry.id)
            if innerReport == nil {
                innerReport = await drainer.drain { inner in
                    sends.append("REENTRANT-\(inner.id)")
                    return .delivered
                }
            }
            return .delivered
        }

        #expect(innerReport?.isEmpty == true, "the concurrent drain must do nothing at all")
        #expect(sends == ["a", "b"], "no prompt may be handed to the send path twice")
        #expect(report.delivered.map(\.id) == ["a", "b"])
    }

    @Test("a second SEQUENTIAL drain after a full delivery has nothing left to do")
    func sequentialDrainIsIdempotent() async {
        let drainer = OfflineOutboxDrainer(queue: makeQueue(["a", "b"]))
        var sends: [String] = []

        _ = await drainer.drain { entry in
            sends.append(entry.id)
            return .delivered
        }
        let second = await drainer.drain { entry in
            sends.append("SECOND-\(entry.id)")
            return .delivered
        }

        #expect(sends == ["a", "b"])
        #expect(second.isEmpty)
    }

    @Test("an empty outbox drains to an empty report without calling the sender")
    func emptyOutboxSendsNothing() async {
        let drainer = OfflineOutboxDrainer(queue: OfflineComposerQueue())
        var called = false

        let report = await drainer.drain { _ in
            called = true
            return .delivered
        }

        #expect(called == false)
        #expect(report.isEmpty)
    }

    @Test("the drained state is persisted, so a relaunch does not resend")
    func drainPersists() async {
        let suite = "tw.tests.outbox.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = OfflineComposerQueueStore(suiteName: suite)
        store.save(makeQueue(["a", "b"]))

        let drainer = OfflineOutboxDrainer(queue: store.load(), store: store)
        _ = await drainer.drain { _ in .delivered }

        #expect(store.load().isEmpty, "delivered prompts must not come back after relaunch")
    }
}

@Suite("OfflineComposerQueue over-capacity restore (upgrade path)")
struct OfflineComposerQueueOverCapacityTests {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    private func entry(_ id: String, at seconds: TimeInterval, inFlight: Bool = false)
        -> QueuedComposerSend
    {
        QueuedComposerSend(
            id: id, threadId: "thread-a", text: "prompt \(id)",
            queuedAt: t0.addingTimeInterval(seconds), attempts: inFlight ? 1 : 0,
            inFlight: inFlight)
    }

    /// Six entries under a bound of three — the shape a blob written by the
    /// build with the leaked bound would restore into.
    private func oversized() -> OfflineComposerQueue {
        OfflineComposerQueue(
            entries: (0..<6).map { entry("e\($0)", at: Double($0)) }, capacity: 3)
    }

    @Test("a restored over-capacity blob is preserved intact, not truncated")
    func restorePreservesEverything() {
        // Deleting real prompts at load would be the silent drop R2 forbids —
        // the user pressed send on every one of these.
        let queue = oversized()
        #expect(queue.count == 6)
        #expect(queue.entries.map(\.id) == ["e0", "e1", "e2", "e3", "e4", "e5"])
    }

    @Test("the over-capacity condition is reported, not hidden")
    func conditionIsVisible() {
        let queue = oversized()
        #expect(queue.isOverCapacity)
        #expect(queue.overflowCount == 3)

        let healthy = OfflineComposerQueue(entries: [entry("a", at: 0)], capacity: 3)
        #expect(healthy.isOverCapacity == false)
        #expect(healthy.overflowCount == 0)
    }

    @Test("enqueue while STRICTLY over capacity refuses and evicts NOTHING")
    func overCapacityEnqueueDoesNotSacrificeAnExistingPrompt() {
        // The discriminating regression guard. The previous implementation used
        // `>= capacity` and evicted-then-appended here, which destroyed the
        // oldest real prompt AND still left the queue over the bound.
        var queue = oversized()
        let outcome = queue.enqueue(id: "new", threadId: "thread-a", text: "newest", now: t0)

        guard case let .rejectedFull(capacity) = outcome else {
            Issue.record("expected .rejectedFull while over capacity, got \(outcome)")
            return
        }
        #expect(capacity == 3)
        #expect(queue.count == 6, "must not grow")
        #expect(
            queue.entries.map(\.id) == ["e0", "e1", "e2", "e3", "e4", "e5"],
            "no existing prompt may be sacrificed to make room for a refused one")
    }

    @Test("ordinary draining heals the overflow with zero loss")
    func drainingHeals() {
        var queue = oversized()
        _ = queue.flush()
        // Host accepts three; the rest stay queued.
        for id in ["e0", "e1", "e2"] { queue.acknowledge(id: id) }

        #expect(queue.count == 3)
        #expect(queue.isOverCapacity == false)
        #expect(queue.overflowCount == 0)

        // And normal behaviour resumes: at capacity with a pending victim, the
        // designed evict-and-report path works again.
        queue.reclaimInFlight()
        let outcome = queue.enqueue(id: "new", threadId: "thread-a", text: "newest", now: t0)
        if case .queuedEvicting = outcome {
            // expected
        } else {
            Issue.record("expected the normal evict path to resume, got \(outcome)")
        }
        #expect(queue.count == 3)
    }

    @Test("shedToCapacity returns EXACTLY what it removed, oldest first")
    func shedIsObservable() {
        var queue = oversized()
        let shed = queue.shedToCapacity()

        #expect(shed.map(\.id) == ["e0", "e1", "e2"], "oldest shed first, and named")
        #expect(queue.count == 3)
        #expect(queue.entries.map(\.id) == ["e3", "e4", "e5"])
        #expect(queue.isOverCapacity == false)
    }

    @Test("shedToCapacity never sheds an in-flight entry")
    func shedSkipsInFlight() {
        var queue = OfflineComposerQueue(
            entries: [
                entry("wire0", at: 0, inFlight: true),
                entry("wire1", at: 1, inFlight: true),
                entry("wire2", at: 2, inFlight: true),
                entry("pending0", at: 3),
                entry("pending1", at: 4),
            ], capacity: 3)

        let shed = queue.shedToCapacity()
        #expect(shed.map(\.id) == ["pending0", "pending1"])
        #expect(queue.entries.map(\.id) == ["wire0", "wire1", "wire2"])
    }

    @Test("shedToCapacity with everything in flight sheds nothing and says so honestly")
    func shedCannotTouchAnAllInFlightQueue() {
        var queue = OfflineComposerQueue(
            entries: (0..<5).map { entry("wire\($0)", at: Double($0), inFlight: true) },
            capacity: 3)

        let shed = queue.shedToCapacity()
        #expect(shed.isEmpty, "nothing is safe to drop, so nothing is dropped")
        #expect(queue.count == 5)
        #expect(queue.isOverCapacity, "and the queue still reports the truth")
    }

    @Test("the upgrade path end to end: oversized blob survives save/load")
    func oversizedBlobSurvivesRoundTrip() {
        let suite = "tw.tests.outbox.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }

        // An older build persisted six entries; this build's bound is three.
        let writer = OfflineComposerQueueStore(suiteName: suite)
        writer.save(oversized())

        let restored = OfflineComposerQueueStore(suiteName: suite).load(capacity: 3)
        #expect(restored.count == 6, "the loader must not quietly normalise the blob")
        #expect(restored.isOverCapacity)
        #expect(restored.overflowCount == 3)
    }
}

@Suite("OfflineComposerQueue persistence seam")
struct OfflineComposerQueuePersistenceSeamTests {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    @Test("the store round-trips over a non-UserDefaults backing")
    func roundTripsOverAnyBacking() {
        let store = OfflineComposerQueueStore(persistence: InMemoryOutboxPersistence())
        var queue = store.load()
        _ = queue.enqueue(id: "a", threadId: "t", text: "held in memory", now: t0)
        store.save(queue)

        let reloaded = store.load()
        #expect(reloaded.entries.map(\.id) == ["a"])
        #expect(reloaded.entries[0].text == "held in memory")
    }

    @Test("in-flight reclaim on load is a store behaviour, not a UserDefaults one")
    func reclaimAppliesToAnyBacking() {
        let store = OfflineComposerQueueStore(persistence: InMemoryOutboxPersistence())
        var queue = store.load()
        _ = queue.enqueue(id: "a", threadId: "t", text: "interrupted", now: t0)
        _ = queue.flush()
        store.save(queue)

        #expect(store.load().pending.map(\.id) == ["a"])
    }

    @Test("clear empties any backing")
    func clearAppliesToAnyBacking() {
        let store = OfflineComposerQueueStore(persistence: InMemoryOutboxPersistence())
        var queue = store.load()
        _ = queue.enqueue(id: "a", threadId: "t", text: "x", now: t0)
        store.save(queue)
        #expect(store.load().count == 1)

        store.clear()
        #expect(store.load().isEmpty)
    }
}
