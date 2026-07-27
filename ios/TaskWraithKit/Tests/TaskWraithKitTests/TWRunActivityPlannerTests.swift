import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Run activity planner")
struct TWRunActivityPlannerTests {
    private let start = Date(timeIntervalSince1970: 1_700_000_000)

    // MARK: - Status mapping

    /// The union is `RemoteTaskStatus` in src/main/RemoteTaskProjection.ts. If
    /// the Mac adds a member and this table is not updated, the new status hits
    /// the default branch and the run simply gets no activity — visibly missing,
    /// which is the failure mode we want over a wrong one.
    @Test("every projected status maps, and idle earns no activity")
    func statusMapping() {
        #expect(TWRunActivityPlanner.phase(forCardStatus: "queued") == .running)
        #expect(TWRunActivityPlanner.phase(forCardStatus: "running") == .running)
        #expect(TWRunActivityPlanner.phase(forCardStatus: "awaitingApproval") == .awaitingApproval)
        #expect(TWRunActivityPlanner.phase(forCardStatus: "awaitingQuestion") == .awaitingQuestion)
        #expect(TWRunActivityPlanner.phase(forCardStatus: "success") == .complete)
        #expect(TWRunActivityPlanner.phase(forCardStatus: "failed") == .failed)
        #expect(TWRunActivityPlanner.phase(forCardStatus: "cancelled") == .cancelled)
        #expect(TWRunActivityPlanner.phase(forCardStatus: "idle") == nil)
    }

    /// A status this build does not understand is NOT evidence that work is
    /// happening. Defaulting it to `.running` would put a permanently-spinning
    /// activity on the lock screen that nothing can ever finish.
    @Test("an unknown status is not treated as running")
    func unknownStatusIsNotRunning() {
        #expect(TWRunActivityPlanner.phase(forCardStatus: "reticulating") == nil)
        #expect(TWRunActivityPlanner.phase(forCardStatus: nil) == nil)
    }

    // MARK: - Plans

    @Test("a solo run carries diff counts and no seats")
    func soloPlan() throws {
        let plan = try #require(
            TWRunActivityPlanner.plan(
                card: card(status: "running", provider: "codex"),
                diff: diff(files: 3, additions: 40, deletions: 5),
                ensemble: nil,
                startedAt: start))
        #expect(plan.provider == "codex")
        #expect(plan.state.filesChanged == 3)
        #expect(plan.state.additions == 40)
        #expect(plan.state.seats.isEmpty)
        #expect(plan.state.progress == nil)
    }

    @Test("seats come from the ensemble state, ordered, and only for ensembles")
    func ensembleSeats() throws {
        let ensemble = try ensembleState([
            ("p-kimi", "kimi", 3, "running"),
            ("p-claude", "claude", 1, "done"),
            ("p-codex", "codex", 2, "failed"),
        ])
        let plan = try #require(
            TWRunActivityPlanner.plan(
                card: card(status: "running", provider: "claude", chatKind: "ensemble"),
                diff: nil, ensemble: ensemble, startedAt: start))
        #expect(plan.state.seats.map(\.provider) == ["claude", "codex", "kimi"])
        #expect(plan.state.seats.map(\.phase) == [.complete, .failed, .running])
        // failed is terminal — the seat is DONE, it just didn't succeed.
        #expect(plan.state.seatsFinished == 2)

        // The same ensemble state attached to a solo chat contributes nothing.
        let solo = try #require(
            TWRunActivityPlanner.plan(
                card: card(status: "running", provider: "claude", chatKind: "single"),
                diff: nil, ensemble: ensemble, startedAt: start))
        #expect(solo.state.seats.isEmpty)
    }

    @Test("drafts and archived chats never get an activity")
    func draftsAndArchivedExcluded() throws {
        let draft = try card(status: "running", provider: "codex", extra: ["isDraft": true])
        let archived = try card(status: "running", provider: "codex", extra: ["archived": true])
        #expect(
            TWRunActivityPlanner.plan(card: draft, diff: nil, ensemble: nil, startedAt: start)
                == nil)
        #expect(
            TWRunActivityPlanner.plan(card: archived, diff: nil, ensemble: nil, startedAt: start)
                == nil)
    }

    // MARK: - Reconciliation

    /// THE RULE THAT KEEPS THE LOCK SCREEN QUIET. Connect the phone to a Mac
    /// that finished three runs an hour ago and every one of those cards is
    /// terminal on the very first snapshot. Starting activities for them would
    /// flash three completed runs onto the lock screen as if they had just
    /// happened — the same reason the completion banner skips the first
    /// snapshot.
    @Test("a run already over when first seen never starts an activity")
    func terminalWithoutOwnershipIsIgnored() throws {
        let plan = try planFor(status: "success")
        #expect(TWRunActivityPlanner.actions(plans: [plan], owned: [:]).isEmpty)
    }

    @Test("a run we own finishing produces exactly one finish")
    func terminalWithOwnershipFinishes() throws {
        let running = try planFor(status: "running")
        let done = try planFor(status: "success")
        let actions = TWRunActivityPlanner.actions(
            plans: [done], owned: ["task-1": running.state])
        #expect(actions == [.finish(done)])
    }

    /// Projection snapshots arrive constantly and mostly change nothing. If an
    /// identical state still spent an ActivityKit update, a busy run would churn
    /// the island several times a second.
    @Test("an unchanged state spends no update")
    func unchangedStateIsSilent() throws {
        let plan = try planFor(status: "running")
        #expect(TWRunActivityPlanner.actions(plans: [plan], owned: ["task-1": plan.state]).isEmpty)
    }

    @Test("a changed state updates rather than restarting")
    func changedStateUpdates() throws {
        let before = try planFor(status: "running")
        let after = try planFor(status: "awaitingApproval")
        #expect(
            TWRunActivityPlanner.actions(plans: [after], owned: ["task-1": before.state])
                == [.update(after)])
    }

    @Test("starts are capped, and the front of the list wins the slots")
    func startsAreCapped() throws {
        let plans = try (1...5).map { try planFor(status: "running", id: "task-\($0)") }
        let actions = TWRunActivityPlanner.actions(plans: plans, owned: [:], limit: 2)
        #expect(actions.count == 2)
        #expect(actions == [.start(plans[0]), .start(plans[1])])
    }

    @Test("an owned activity counts against the cap")
    func ownedCountsAgainstCap() throws {
        let held = try planFor(status: "running", id: "task-held")
        let fresh = try planFor(status: "running", id: "task-new")
        // BOTH are still projected — `held` has to stay in `plans` or it reads
        // as vanished and gets abandoned instead of holding its slot.
        let actions = TWRunActivityPlanner.actions(
            plans: [held, fresh], owned: ["task-held": held.state], limit: 1)
        #expect(actions.isEmpty)
    }

    /// A thread that stops being projected (host switch, chat deleted, run reset
    /// to idle) has no outcome to display, so freezing its last state on the
    /// lock screen would be a lie of omission.
    @Test("a thread that vanishes from the projection is abandoned, deterministically")
    func vanishedThreadsAbandoned() throws {
        let plan = try planFor(status: "running", id: "task-b")
        let actions = TWRunActivityPlanner.actions(
            plans: [plan],
            owned: [
                "task-b": plan.state,
                "task-z": plan.state,
                "task-a": plan.state,
            ])
        // Dictionary key order is not stable, so the planner sorts; without that
        // this assertion would pass or fail by luck.
        #expect(actions == [.abandon(threadId: "task-a"), .abandon(threadId: "task-z")])
    }

    @Test("an idle card abandons the activity it used to own")
    func idleAbandons() throws {
        let running = try planFor(status: "running")
        let idle = try card(status: "idle", provider: "codex")
        let plans = [
            TWRunActivityPlanner.plan(card: idle, diff: nil, ensemble: nil, startedAt: start)
        ].compactMap { $0 }
        #expect(plans.isEmpty)
        #expect(
            TWRunActivityPlanner.actions(plans: plans, owned: ["task-1": running.state])
                == [.abandon(threadId: "task-1")])
    }

    // MARK: - Fixtures

    private func planFor(status: String, id: String = "task-1") throws -> TWActivityPlan {
        try #require(
            TWRunActivityPlanner.plan(
                card: card(status: status, provider: "codex", id: id),
                diff: nil, ensemble: nil, startedAt: start))
    }

    private func card(
        status: String,
        provider: String,
        chatKind: String = "single",
        id: String = "task-1",
        extra: [String: Any] = [:]
    ) throws -> RemoteTaskCard {
        var json: [String: Any] = [
            "id": id,
            "status": status,
            "provider": provider,
            "chatKind": chatKind,
            "runId": "run-1",
        ]
        for (key, value) in extra { json[key] = value }
        return try JSONDecoder().decode(
            RemoteTaskCard.self, from: JSONSerialization.data(withJSONObject: json))
    }

    private func diff(files: Int, additions: Int, deletions: Int) throws -> MobileDiffSummary {
        try JSONDecoder().decode(
            MobileDiffSummary.self,
            from: JSONSerialization.data(withJSONObject: [
                "filesChanged": files, "additions": additions, "deletions": deletions,
            ]))
    }

    private func ensembleState(_ seats: [(String, String, Int, String)]) throws
        -> RemoteEnsembleState
    {
        let participants = seats.map {
            ["participantId": $0.0, "provider": $0.1, "order": $0.2, "status": $0.3] as [String: Any]
        }
        return try JSONDecoder().decode(
            RemoteEnsembleState.self,
            from: JSONSerialization.data(withJSONObject: ["participants": participants]))
    }
}
