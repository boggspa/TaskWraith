import Foundation
import Testing

@testable import TaskWraithKit

private func card(
    id: String = "chat-1",
    status: String? = nil,
    runId: String? = "run-1",
    updatedAt: String? = "2026-08-05T12:00:00Z",
    pendingApprovalCount: Int? = nil,
    pendingQuestionCount: Int? = nil,
    activeGoal: RemoteActiveGoal? = nil
) -> RemoteTaskCard {
    let json: [String: Any?] = [
        "id": id,
        "title": "Thread",
        "status": status,
        "provider": "codex",
        "runId": runId,
        "updatedAt": updatedAt,
        "pendingApprovalCount": pendingApprovalCount,
        "pendingQuestionCount": pendingQuestionCount,
        "activeGoal": activeGoal.map {
            [
                "id": $0.id, "objective": $0.objective, "status": $0.status, "mode": $0.mode,
                "provider": $0.provider, "createdAt": $0.createdAt, "updatedAt": $0.updatedAt,
                "blockedAt": $0.blockedAt, "completedAt": $0.completedAt
            ] as [String: Any?]
        }
    ]
    let cleaned = json.compactMapValues { $0 }
    let data = try! JSONSerialization.data(withJSONObject: cleaned)
    return try! JSONDecoder().decode(RemoteTaskCard.self, from: data)
}

private func goal(status: String, completedAt: String? = nil, blockedAt: String? = nil)
    -> RemoteActiveGoal
{
    RemoteActiveGoal(
        id: "goal-1", objective: "Ship it", status: status, mode: "codex_native",
        provider: "codex", createdAt: "2026-08-01T00:00:00Z",
        updatedAt: "2026-08-05T12:00:00Z", pausedAt: nil, blockedAt: blockedAt,
        blockedReason: nil, completedAt: completedAt, completedSummary: nil,
        lastStatusReason: nil)
}

private let epoch = TWThreadRowToneResolver.parseDate("2026-08-05T00:00:00Z")!
private let beforeEpoch = "2026-08-04T12:00:00Z"
private let afterEpoch = "2026-08-05T12:00:00Z"

@Suite("Thread row tone — waiting")
struct ThreadRowToneWaitingTests {
    @Test("a parked thread reads as waiting from either counted signal")
    func waitingFromCounts() {
        #expect(TWThreadRowToneResolver.isAwaitingUserResponse(card(pendingApprovalCount: 1)))
        #expect(TWThreadRowToneResolver.isAwaitingUserResponse(card(pendingQuestionCount: 2)))
        #expect(!TWThreadRowToneResolver.isAwaitingUserResponse(card(pendingApprovalCount: 0)))
        #expect(!TWThreadRowToneResolver.isAwaitingUserResponse(card()))
    }

    @Test("an older Mac build that projects only the status still lights the row")
    func waitingFromStatus() {
        #expect(TWThreadRowToneResolver.isAwaitingUserResponse(card(status: "awaitingApproval")))
        #expect(TWThreadRowToneResolver.isAwaitingUserResponse(card(status: "awaitingQuestion")))
    }

    @Test("waiting survives the running gate — the run is blocked, not finished")
    func waitingSurvivesRunning() {
        let tone = TWThreadRowToneResolver.tone(
            for: card(status: "running", pendingApprovalCount: 1), isSelected: false,
            acknowledgements: [:], successInkEpoch: epoch)
        #expect(tone == .waiting)
    }

    @Test("waiting outranks an unread settled outcome")
    func waitingOutranksOutcome() {
        let tone = TWThreadRowToneResolver.tone(
            for: card(status: "success", updatedAt: afterEpoch, pendingQuestionCount: 1),
            isSelected: false, acknowledgements: [:], successInkEpoch: epoch)
        #expect(tone == .waiting)
    }

    @Test("the open thread stays quiet — its modal is already on screen")
    func selectedStaysQuiet() {
        let tone = TWThreadRowToneResolver.tone(
            for: card(pendingApprovalCount: 1), isSelected: true, acknowledgements: [:],
            successInkEpoch: epoch)
        #expect(tone == nil)
    }

    @Test("it clears itself when the answer lands — no acknowledgement involved")
    func waitingClearsItself() {
        let tone = TWThreadRowToneResolver.tone(
            for: card(status: "running", pendingApprovalCount: 0), isSelected: false,
            acknowledgements: [:], successInkEpoch: epoch)
        #expect(tone == nil)
    }
}

@Suite("Thread row tone — settled outcomes")
struct ThreadRowToneOutcomeTests {
    @Test("success and failure statuses project their tones")
    func basicOutcomes() {
        #expect(TWThreadRowToneResolver.outcome(for: card(status: "success"))?.tone == .success)
        #expect(TWThreadRowToneResolver.outcome(for: card(status: "completed"))?.tone == .success)
        #expect(TWThreadRowToneResolver.outcome(for: card(status: "failed"))?.tone == .failure)
        #expect(TWThreadRowToneResolver.outcome(for: card(status: "error"))?.tone == .failure)
    }

    @Test("cancelled and running are not outcomes")
    func neutralAndUnsettled() {
        #expect(TWThreadRowToneResolver.outcome(for: card(status: "cancelled")) == nil)
        #expect(TWThreadRowToneResolver.outcome(for: card(status: "running")) == nil)
        #expect(TWThreadRowToneResolver.outcome(for: card(status: "queued")) == nil)
        #expect(TWThreadRowToneResolver.outcome(for: card(status: nil)) == nil)
    }

    @Test("a completed goal wins the tone over the run beneath it")
    func goalWins() {
        let outcome = TWThreadRowToneResolver.outcome(
            for: card(status: "failed", activeGoal: goal(status: "completed", completedAt: afterEpoch))
        )
        #expect(outcome?.tone == .success)
        #expect(outcome?.fingerprint.hasPrefix("goal:") == true)
    }

    @Test("an active goal suppresses ordinary green but not concrete failure")
    func activeGoalSuppressesGreen() {
        #expect(
            TWThreadRowToneResolver.outcome(for: card(status: "success", activeGoal: goal(status: "active")))
                == nil)
        #expect(
            TWThreadRowToneResolver.outcome(
                for: card(status: "failed", activeGoal: goal(status: "active")))?.tone == .failure)
    }

    @Test("an unread outcome shows, an acknowledged one does not")
    func unreadGate() {
        let settled = card(status: "success", updatedAt: afterEpoch)
        let outcome = TWThreadRowToneResolver.outcome(for: settled)!
        #expect(
            TWThreadRowToneResolver.tone(
                for: settled, isSelected: false, acknowledgements: [:], successInkEpoch: epoch)
                == .success)
        #expect(
            TWThreadRowToneResolver.tone(
                for: settled, isSelected: false,
                acknowledgements: ["chat-1": outcome.fingerprint], successInkEpoch: epoch) == nil)
    }
}

@Suite("Thread row tone — success ink epoch")
struct ThreadRowToneEpochTests {
    @Test("green is withheld from work that finished before the upgrade")
    func oldSuccessIsQuiet() {
        let tone = TWThreadRowToneResolver.tone(
            for: card(status: "success", updatedAt: beforeEpoch), isSelected: false,
            acknowledgements: [:], successInkEpoch: epoch)
        #expect(tone == nil)
    }

    @Test("an old FAILURE still flags — unfinished business the user may not have seen")
    func oldFailureStillFlags() {
        let tone = TWThreadRowToneResolver.tone(
            for: card(status: "failed", updatedAt: beforeEpoch), isSelected: false,
            acknowledgements: [:], successInkEpoch: epoch)
        #expect(tone == .failure)
    }

    @Test("the cutoff is per-result: an old thread that succeeds again greens")
    func perResultNotPerThread() {
        let tone = TWThreadRowToneResolver.tone(
            for: card(status: "success", runId: "run-99", updatedAt: afterEpoch),
            isSelected: false, acknowledgements: [:], successInkEpoch: epoch)
        #expect(tone == .success)
    }

    @Test("an undateable success is treated as history; no epoch withholds nothing")
    func edges() {
        let undated = TWThreadOutcome(fingerprint: "f", tone: .success, settledAt: nil)
        #expect(TWThreadRowToneResolver.successInkPredatesEpoch(undated, epoch: epoch))
        #expect(!TWThreadRowToneResolver.successInkPredatesEpoch(undated, epoch: nil))
        let atEpoch = TWThreadOutcome(fingerprint: "f", tone: .success, settledAt: epoch)
        #expect(!TWThreadRowToneResolver.successInkPredatesEpoch(atEpoch, epoch: epoch))
    }
}

private final class MemoryStorage: TWThreadRowToneStorage {
    var values: [String: String] = [:]
    var writes = 0
    func twToneString(forKey key: String) -> String? { values[key] }
    func twToneSet(_ value: String, forKey key: String) {
        writes += 1
        values[key] = value
    }
}

@Suite("Thread row tone — store")
struct ThreadRowToneStoreTests {
    @Test("the epoch seeds once and is read back on every later launch")
    func epochSeedsOnce() {
        let storage = MemoryStorage()
        let first = Date(timeIntervalSince1970: 1_000)
        #expect(TWThreadRowToneStore(storage: storage).loadOrSeedSuccessInkEpoch(now: first) == first)
        #expect(storage.writes == 1)
        // A later launch must not re-stamp "now", or every launch would hide
        // the previous session's results.
        let later = Date(timeIntervalSince1970: 9_999)
        #expect(TWThreadRowToneStore(storage: storage).loadOrSeedSuccessInkEpoch(now: later) == first)
        #expect(storage.writes == 1)
    }

    @Test("acknowledgements round-trip and are idempotent")
    func acknowledgementsPersist() {
        let storage = MemoryStorage()
        let store = TWThreadRowToneStore(storage: storage)
        let outcome = TWThreadOutcome(fingerprint: "run:1:success", tone: .success, settledAt: nil)
        store.acknowledge(chatId: "chat-1", outcome: outcome)
        let writesAfterFirst = storage.writes
        store.acknowledge(chatId: "chat-1", outcome: outcome)
        #expect(storage.writes == writesAfterFirst)

        let reloaded = TWThreadRowToneStore(storage: storage)
        #expect(reloaded.currentAcknowledgements["chat-1"] == "run:1:success")
    }
}
