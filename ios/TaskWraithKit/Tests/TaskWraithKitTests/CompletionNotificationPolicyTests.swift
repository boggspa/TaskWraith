import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Completion notification policy")
struct CompletionNotificationPolicyTests {
    @Test("settled success notifies once at the running boundary")
    func settledSuccess() throws {
        let running = try card(status: "running", eligible: false)
        let completed = try card(status: "success", eligible: true)

        #expect(
            CompletionNotificationPolicy.shouldNotify(previous: running, current: completed))
        #expect(
            !CompletionNotificationPolicy.shouldNotify(previous: completed, current: completed))
    }

    @Test("transient participant success stays quiet until the round settles")
    func transientParticipantSuccess() throws {
        let running = try card(status: "running", eligible: false)
        let transient = try card(status: "success", eligible: false)
        let settled = try card(status: "success", eligible: true)

        #expect(
            !CompletionNotificationPolicy.shouldNotify(previous: running, current: transient))
        #expect(
            CompletionNotificationPolicy.shouldNotify(previous: transient, current: settled))
    }

    @Test("failure and cancellation never become Task Complete notifications")
    func unsuccessfulTerminalStates() throws {
        let running = try card(status: "running", eligible: false)

        #expect(
            !CompletionNotificationPolicy.shouldNotify(
                previous: running, current: try card(status: "failed", eligible: true)))
        #expect(
            !CompletionNotificationPolicy.shouldNotify(
                previous: running, current: try card(status: "cancelled", eligible: true)))
    }

    @Test("legacy hosts retain solo completion alerts but keep ensemble cards quiet")
    func legacyFallback() throws {
        let soloRunning = try card(status: "running", eligible: nil, chatKind: "single")
        let soloSuccess = try card(status: "success", eligible: nil, chatKind: "single")
        let ensembleRunning = try card(status: "running", eligible: nil, chatKind: "ensemble")
        let ensembleSuccess = try card(status: "success", eligible: nil, chatKind: "ensemble")

        #expect(
            CompletionNotificationPolicy.shouldNotify(
                previous: soloRunning, current: soloSuccess))
        #expect(
            !CompletionNotificationPolicy.shouldNotify(
                previous: ensembleRunning, current: ensembleSuccess))
    }

    private func card(
        status: String,
        eligible: Bool?,
        chatKind: String = "ensemble",
        runId: String = "run-1"
    ) throws -> RemoteTaskCard {
        var json: [String: Any] = [
            "id": "task-1",
            "status": status,
            "chatKind": chatKind,
            "runId": runId,
        ]
        if let eligible {
            json["completionNotificationEligible"] = eligible
        }
        let data = try JSONSerialization.data(withJSONObject: json)
        return try JSONDecoder().decode(RemoteTaskCard.self, from: data)
    }
}

@Suite("Completion banner presentation ledger")
struct CompletionBannerPresentationLedgerTests {
    @Test func presentsEachBannerIdentityExactlyOnce() {
        var ledger = CompletionBannerPresentationLedger()
        let first = ledger.claimPresentation(threadId: "chat-1", runId: "run-1")
        // The reconnect-churn replay: same thread+run must never sound again.
        let replay = ledger.claimPresentation(threadId: "chat-1", runId: "run-1")
        let replayAgain = ledger.claimPresentation(threadId: "chat-1", runId: "run-1")
        #expect(first)
        #expect(!replay)
        #expect(!replayAgain)
    }

    @Test func aRerunOfTheSameThreadBannersNormally() {
        var ledger = CompletionBannerPresentationLedger()
        let firstRun = ledger.claimPresentation(threadId: "chat-1", runId: "run-1")
        let rerun = ledger.claimPresentation(threadId: "chat-1", runId: "run-2")
        let otherThread = ledger.claimPresentation(threadId: "chat-2", runId: "run-1")
        #expect(firstRun)
        #expect(rerun)
        #expect(otherThread)
    }

    @Test func nilRunIdIsItsOwnIdentity() {
        var ledger = CompletionBannerPresentationLedger()
        let runless = ledger.claimPresentation(threadId: "chat-1", runId: nil)
        let runlessReplay = ledger.claimPresentation(threadId: "chat-1", runId: nil)
        let realRun = ledger.claimPresentation(threadId: "chat-1", runId: "run-1")
        #expect(runless)
        #expect(!runlessReplay)
        #expect(realRun)
    }

    @Test func bannerIdKeepsTheHistoricalRequestIdentifierShape() {
        // The dedupe key IS the UNNotificationRequest identifier — same string
        // the pre-ledger code built inline, so delivered-banner replacement
        // behavior is unchanged.
        #expect(
            CompletionBannerPresentationLedger.bannerId(threadId: "t", runId: "r")
                == "tw-complete-t-r")
        #expect(
            CompletionBannerPresentationLedger.bannerId(threadId: "t", runId: nil)
                == "tw-complete-t-")
    }
}
