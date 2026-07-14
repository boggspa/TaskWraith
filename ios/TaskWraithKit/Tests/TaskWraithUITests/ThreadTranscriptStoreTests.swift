import Combine
import Foundation
import Testing
@testable import TaskWraithKit
@testable import TaskWraithUI

/// Proves the per-thread re-render gate scopes correctly and closes the two holes
/// an adversarial review surfaced: a stale key set swallowing streaming that
/// arrives under an alias before its projection snapshot, and a bind that starts a
/// thread one update behind.
@MainActor
struct ThreadTranscriptStoreTests {
    private func makeModel() -> RemoteSessionModel {
        let defaults = UserDefaults(suiteName: "TWStoreTests.\(UUID().uuidString)")!
        return RemoteSessionModel(
            identityStore: StaticSeed(),
            pairingStore: UserDefaultsPairedHostStore(defaults: defaults))
    }

    private struct StaticSeed: IdentitySeedStore {
        func loadOrCreateSeed() throws -> Data { Data(repeating: 7, count: 32) }
    }

    @Test func scopesStreamingToTheOpenThread() {
        let model = makeModel()
        let store = ThreadTranscriptStore()
        store.bind(model: model, taskId: "thread-A")

        var fires = 0
        let sub = store.objectWillChange.sink { _ in fires += 1 }
        defer { sub.cancel() }

        // A DIFFERENT thread streaming must NOT re-render thread A's transcript.
        model.seedStreamingStateForTesting(threadId: "thread-B", runId: "run-B")
        #expect(fires == 0)

        // The open thread's OWN streaming must still fire (not over-scoped/dead).
        model.seedStreamingStateForTesting(threadId: "thread-A", runId: "run-A")
        #expect(fires >= 1)

        // A no-op restamp of the SAME value for the open thread must not re-fire
        // (removeDuplicates), and another thread's continued streaming stays silent.
        let after = fires
        model.seedStreamingStateForTesting(threadId: "thread-A", runId: "run-A")
        model.seedStreamingStateForTesting(threadId: "thread-B", runId: "run-B2")
        #expect(fires == after)
    }

    /// The reveal-drain hole: agent-exit after the last coalesce window republishes
    /// byte-identical staging (swallowed by removeDuplicates), so terminal
    /// membership is the ONLY thing that changes — the gate must fire on it or the
    /// transcript never re-renders and TokenRevealText's isComplete never flips.
    @Test func firesWhenStreamingTurnsTerminalWithoutTextChange() {
        let model = makeModel()
        let store = ThreadTranscriptStore()
        store.bind(model: model, taskId: "thread-A")
        model.appendStreamingDeltasForTesting(
            threadId: "thread-A", data: #"{"type":"content","text":"Answer"}"#,
            runId: "run-A")

        var fires = 0
        let sub = store.objectWillChange.sink { _ in fires += 1 }
        defer { sub.cancel() }

        // Exit's flush republishes identical staging; only the terminal set flips.
        model.markStreamingTerminalForTesting(threadId: "thread-A", exitRunId: "run-A")
        #expect(fires >= 1)

        // Another thread going terminal stays silent for this store (scoped).
        model.appendStreamingDeltasForTesting(
            threadId: "thread-B", data: #"{"type":"content","text":"Other"}"#,
            runId: "run-B")
        let afterOtherStream = fires
        model.markStreamingTerminalForTesting(threadId: "thread-B", exitRunId: "run-B")
        #expect(fires == afterOtherStream)
    }

    /// The ordering hole: streaming lands under the Mac's wire thread-id BEFORE the
    /// projection snapshot registers that id as an alias of the open taskId. When
    /// the alias finally registers, the gate MUST fire so the view re-reads the
    /// already-arrived streaming under the freshly-known alias.
    @Test func firesWhenAliasRegistersAfterStreaming() {
        let model = makeModel()
        let store = ThreadTranscriptStore()
        store.bind(model: model, taskId: "T")  // cachedKeys == ["T"]

        var fires = 0
        let sub = store.objectWillChange.sink { _ in fires += 1 }
        defer { sub.cancel() }

        // Streaming arrives under the wire id before iOS knows it aliases "T".
        model.seedStreamingStateForTesting(threadId: "T-wire", runId: "run-1")
        #expect(fires == 0)

        // Projection now says the "T"-keyed snapshot carries threadId "T-wire".
        // resolvedThreadKeys("T") therefore expands to ["T", "T-wire"] → fire.
        model.seedThreadSnapshotForTesting(
            RemoteThreadSnapshot(threadId: "T-wire", provider: "codex"), key: "T")
        #expect(fires >= 1)
    }

    /// The willSet-freshness fix: once the alias is registered from the FRESH
    /// emitted snapshot (not a stale `model.threadSnapshots` re-read), streaming
    /// that subsequently arrives under that alias is attributed to the open thread.
    @Test func streamingUnderARegisteredAliasFires() {
        let model = makeModel()
        let store = ThreadTranscriptStore()
        store.bind(model: model, taskId: "T")

        var fires = 0
        let sub = store.objectWillChange.sink { _ in fires += 1 }
        defer { sub.cancel() }

        model.seedThreadSnapshotForTesting(
            RemoteThreadSnapshot(threadId: "T-thread", provider: "codex"), key: "T")
        let baseline = fires
        #expect(baseline >= 1)  // the alias registration itself fired

        // cachedKeys now holds "T-thread" (recomputed from the fresh snapshot),
        // so streaming under it must fire — the pre-fix stale-key read swallowed it.
        model.seedStreamingStateForTesting(threadId: "T-thread", runId: "run-x")
        #expect(fires > baseline)
    }

    /// Rebinding to a new thread tears down the old thread's subscriptions: the old
    /// thread's continued streaming must go silent while the new thread's fires.
    @Test func rebindStopsFiringForThePreviousThread() {
        let model = makeModel()
        let store = ThreadTranscriptStore()
        store.bind(model: model, taskId: "A")
        store.bind(model: model, taskId: "B")

        var fires = 0
        let sub = store.objectWillChange.sink { _ in fires += 1 }
        defer { sub.cancel() }

        model.seedStreamingStateForTesting(threadId: "A", runId: "run-A")
        #expect(fires == 0)  // no lingering old-thread subscription

        model.seedStreamingStateForTesting(threadId: "B", runId: "run-B")
        #expect(fires >= 1)
    }

    /// The cold-start guarantee: state that already exists when bind() runs must
    /// produce a catch-up fire, so a thread opened mid-stream never starts one
    /// update behind. (Subscribe BEFORE bind so the bind-time replay is counted.)
    @Test func bindFiresCatchUpForPreexistingState() {
        let model = makeModel()
        model.seedStreamingStateForTesting(threadId: "A", runId: "run-A")

        let store = ThreadTranscriptStore()
        var fires = 0
        let sub = store.objectWillChange.sink { _ in fires += 1 }
        defer { sub.cancel() }

        store.bind(model: model, taskId: "A")
        #expect(fires >= 1)
    }

    /// The store's key set must match the view's exactly (shared resolver) — no
    /// superset that would over-fire, no subset that would miss a read.
    @Test func resolvedThreadKeysMatchViewAlgorithm() {
        let keys = ThreadTranscriptStore.resolvedThreadKeys(
            taskId: "T",
            cards: [],
            snapshots: ["T": RemoteThreadSnapshot(threadId: "T-wire", provider: "codex")])
        #expect(keys == ["T", "T-wire"])
    }
}
