import Foundation
import Testing

@testable import TaskWraithKit
@testable import TaskWraithUI

private struct FlushStaticIdentitySeedStore: IdentitySeedStore {
    func loadOrCreateSeed() throws -> Data { Data(repeating: 7, count: 32) }
}

/// Integration coverage for `RemoteSessionModel.flushOfflineOutbox`.
///
/// ## Why this file exists
///
/// The drainer had eight passing unit tests and was still wrong in production.
/// Those tests drove `OfflineOutboxDrainer` with an HONEST stub — one that
/// actually returned `.rejected` and `.unreachable` — while the real closure on
/// the model called fire-and-forget `continueTask` and returned `.delivered`
/// unconditionally. The protocol was tested; the wiring was not, and the two
/// non-delivery branches were dead code in the shipping app.
///
/// So these tests drive `flushOfflineOutbox()` itself. They still substitute the
/// bridge send (there is no transport in a unit test), but the substitution now
/// happens BELOW the code under test rather than replacing it.
@Suite("Offline outbox flush — model integration")
@MainActor
struct OfflineOutboxFlushIntegrationTests {

    /// Each model gets its OWN outbox suite.
    ///
    /// Without the explicit outbox store these tests shared one queue and
    /// counts accumulated across them (7, 8, 6…) — the model builds its outbox
    /// on the STANDARD defaults suite even though the pairing store is
    /// injected. That first red run is the reason this helper exists, and the
    /// same global-suite fact is flagged in production as a per-host scoping
    /// follow-up.
    private func makeModel() -> RemoteSessionModel {
        let suite = "TaskWraithUITests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let model = RemoteSessionModel(
            identityStore: FlushStaticIdentitySeedStore(),
            pairingStore: UserDefaultsPairedHostStore(defaults: defaults))
        model.useOfflineOutboxStoreForTesting(
            OfflineComposerQueueStore(suiteName: "\(suite).outbox"))
        return model
    }

    private func seed(_ model: RemoteSessionModel, _ texts: [String], threadId: String = "t1") {
        for text in texts {
            _ = model.enqueueOfflinePrompt(threadId: threadId, text: text)
        }
    }

    @Test("a prompt the host REFUSES is not removed — the defect this file was written for")
    func rejectedPromptSurvivesTheFlush() async {
        // The exact case the Validator named: the send is attempted, the host
        // then says no, and the prompt must still be in the outbox afterwards.
        // The old wiring reported `.delivered` before any ack, so the entry was
        // already gone by the time the refusal arrived.
        let model = makeModel()
        seed(model, ["keep me"])
        model.offlineOutboxSendOverrideForTesting = { _ in .rejected("provider not ready") }

        let report = await model.flushOfflineOutbox()

        #expect(report.delivered.isEmpty)
        #expect(report.rejected.map(\.reason) == ["provider not ready"])
        #expect(
            model.offlineOutboxCount(forThread: "t1") == 1,
            "a refused prompt must survive the flush that refused it")
    }

    @Test("an unreachable host leaves everything queued and stops the drain")
    func unreachableLeavesEverythingQueued() async {
        let model = makeModel()
        seed(model, ["a", "b", "c"])
        var attempts = 0
        model.offlineOutboxSendOverrideForTesting = { _ in
            attempts += 1
            return .unreachable
        }

        let report = await model.flushOfflineOutbox()

        #expect(attempts == 1, "the drain stops rather than failing once per prompt")
        #expect(report.deferred.count == 3, "including the un-attempted tail")
        #expect(model.offlineOutboxCount(forThread: "t1") == 3, "nothing was lost")
    }

    @Test("only an accepted ack removes a prompt")
    func deliveredRemoves() async {
        let model = makeModel()
        seed(model, ["a", "b"])
        model.offlineOutboxSendOverrideForTesting = { _ in .delivered }

        let report = await model.flushOfflineOutbox()

        #expect(report.delivered.count == 2)
        #expect(model.offlineOutboxCount(forThread: "t1") == 0)
    }

    @Test("a mixed drain accounts for every prompt and keeps the non-delivered ones")
    func mixedDrainAccountsForEverything() async {
        let model = makeModel()
        seed(model, ["a", "b", "c", "d"])
        model.offlineOutboxSendOverrideForTesting = { entry in
            switch entry.text {
            case "a": return .delivered
            case "b": return .rejected("thread archived")
            default: return .unreachable
            }
        }

        let report = await model.flushOfflineOutbox()

        #expect(report.handledCount == 4, "no prompt may go unaccounted for")
        #expect(report.delivered.count == 1)
        #expect(report.rejected.count == 1)
        #expect(report.deferred.count == 2)
        #expect(
            model.offlineOutboxCount(forThread: "t1") == 3,
            "everything except the one accepted prompt is still queued")
    }

    @Test("a flush with an empty outbox reports nothing and sends nothing")
    func emptyFlush() async {
        let model = makeModel()
        var called = false
        model.offlineOutboxSendOverrideForTesting = { _ in
            called = true
            return .delivered
        }

        let report = await model.flushOfflineOutbox()

        #expect(called == false)
        #expect(report.isEmpty)
    }

    @Test("a disconnected session never claims delivery")
    func disconnectedNeverDelivers() async {
        // No override: exercises the real closure's own guard. The model starts
        // idle, so the send path must report `.unreachable` rather than
        // optimistically removing the prompt.
        let model = makeModel()
        seed(model, ["a"])

        let report = await model.flushOfflineOutbox()

        #expect(report.delivered.isEmpty, "an idle session cannot have delivered anything")
        #expect(model.offlineOutboxCount(forThread: "t1") == 1)
    }
}
