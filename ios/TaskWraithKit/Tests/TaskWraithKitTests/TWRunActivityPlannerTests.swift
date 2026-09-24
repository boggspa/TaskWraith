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

    /// The union is `EnsembleParticipantStatus` in src/main/store/types.ts, and
    /// it is NOT the card vocabulary above. The runtime says `answered` /
    /// `yielded` / `sleeping` / `unreachable`; it never says `done`. Recognizing
    /// only the legacy spellings left every successful seat sitting on
    /// `.running`, which is what made a finished eight-seat round read `0/8` on
    /// the lock screen (and `1/8` once a single failed seat was recognized).
    ///
    /// Terminal-ness here matches the Mac's own definition — see
    /// `isDynamicStateReceiptTerminalStatus` and `statusToRunQueueJobStatus` in
    /// EnsembleOrchestrator: a sleeping seat has finished its turn and is
    /// waiting to be woken, so it is not still working.
    @Test("real ensemble participant statuses map to the right seat phase")
    func participantStatusMapping() {
        #expect(TWRunActivityPlanner.seatPhase(forParticipantStatus: "answered") == .complete)
        #expect(TWRunActivityPlanner.seatPhase(forParticipantStatus: "yielded") == .complete)
        #expect(TWRunActivityPlanner.seatPhase(forParticipantStatus: "sleeping") == .complete)
        #expect(TWRunActivityPlanner.seatPhase(forParticipantStatus: "unreachable") == .failed)
        #expect(TWRunActivityPlanner.seatPhase(forParticipantStatus: "failed") == .failed)
        #expect(TWRunActivityPlanner.seatPhase(forParticipantStatus: "error") == .failed)
        #expect(TWRunActivityPlanner.seatPhase(forParticipantStatus: "skipped") == .cancelled)
        #expect(TWRunActivityPlanner.seatPhase(forParticipantStatus: "cancelled") == .cancelled)
        #expect(TWRunActivityPlanner.seatPhase(forParticipantStatus: "idle") == .running)
        #expect(TWRunActivityPlanner.seatPhase(forParticipantStatus: "running") == .running)
    }

    /// Unlike a card status, an unrecognized SEAT status must stay `.running`:
    /// the seat is still part of the denominator, and quietly calling it
    /// finished would overstate progress on a round that is still going.
    @Test("an unknown seat status stays in the denominator")
    func unknownSeatStatusIsNotFinished() {
        #expect(TWRunActivityPlanner.seatPhase(forParticipantStatus: "reticulating") == .running)
        #expect(TWRunActivityPlanner.seatPhase(forParticipantStatus: nil) == .running)
        // Card-only statuses colliding onto a seat stay running. The TS mapper
        // used to delegate to the card table and treat these as complete /
        // awaitingApproval; Swift must not grow that same hole.
        #expect(TWRunActivityPlanner.seatPhase(forParticipantStatus: "success") == .running)
        #expect(TWRunActivityPlanner.seatPhase(forParticipantStatus: "awaitingApproval") == .running)
        // Legacy spellings still count — an older Mac may be driving this phone.
        #expect(TWRunActivityPlanner.seatPhase(forParticipantStatus: "completed") == .complete)
        #expect(TWRunActivityPlanner.seatPhase(forParticipantStatus: "done") == .complete)
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
            ("p-claude", "claude", 1, "answered"),
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

    /// THE REGRESSION THIS SLICE EXISTS FOR. Eight seats that all answered is a
    /// round that is over; it read `0/8` because none of the real statuses were
    /// recognized. The fraction was always computed correctly — it was being fed
    /// the wrong phases.
    @Test("an ensemble whose seats all answered reads full, not 0/N")
    func answeredRoundIsFullyFinished() throws {
        let ensemble = try ensembleState(
            (1...8).map { ("p-\($0)", "claude", $0, "answered") })
        let plan = try #require(
            TWRunActivityPlanner.plan(
                card: card(status: "running", provider: "pi", chatKind: "ensemble"),
                diff: nil, ensemble: ensemble, startedAt: start))
        #expect(plan.state.seats.count == 8)
        #expect(plan.state.seats.allSatisfy { $0.phase == .complete })
        #expect(plan.state.seatsFinished == 8)
        #expect(plan.state.progress == 1.0)
        #expect(plan.state.activeSeats == 0)
        #expect(plan.state.respondedSeats == 8)
        #expect(plan.state.blockedSeats == 0)
    }

    /// One seat of every kind the runtime can emit, so the count cannot be right
    /// by accident: three terminal-good, one terminal-failed, one cancelled, and
    /// two genuinely still working.
    @Test("a mixed real-vocabulary round counts each terminal seat exactly once")
    func mixedParticipantStatusesCount() throws {
        let ensemble = try ensembleState([
            ("p-1", "claude", 1, "answered"),
            ("p-2", "codex", 2, "yielded"),
            ("p-3", "kimi", 3, "sleeping"),
            ("p-4", "grok", 4, "unreachable"),
            ("p-5", "mistral", 5, "skipped"),
            ("p-6", "pi", 6, "running"),
            ("p-7", "ollama", 7, "idle"),
        ])
        let plan = try #require(
            TWRunActivityPlanner.plan(
                card: card(status: "running", provider: "pi", chatKind: "ensemble"),
                diff: nil, ensemble: ensemble, startedAt: start))
        #expect(
            plan.state.seats.map(\.phase) == [
                .complete, .complete, .complete, .failed, .cancelled, .running, .running,
            ])
        #expect(plan.state.seatsFinished == 5)
        #expect(plan.state.progress == 5.0 / 7.0)
        // running/idle → active; answered/yielded/sleeping → responded;
        // unreachable → blocked; skipped is cancelled and excluded.
        #expect(plan.state.activeSeats == 2)
        #expect(plan.state.respondedSeats == 3)
        #expect(plan.state.blockedSeats == 1)
    }

    /// A new ensemble keeps whichever provider was active when it was created —
    /// "pi" here. That seed stays on the wire on purpose (desktop surfaces and
    /// the seat dots both read it), so the Live Activity has to normalize at
    /// presentation instead: the card's identity is its CHAT KIND.
    @Test("an ensemble is branded Ensemble even though the card carries a seed provider")
    func ensembleProviderIsNormalized() throws {
        let ensemble = try ensembleState([
            ("p-claude", "claude", 1, "answered"),
            ("p-codex", "codex", 2, "running"),
        ])
        let plan = try #require(
            TWRunActivityPlanner.plan(
                card: card(status: "running", provider: "pi", chatKind: "ensemble"),
                diff: nil, ensemble: ensemble, startedAt: start))
        #expect(plan.provider == "ensemble")
        #expect(plan.isEnsemble)
        // The dots still show each seat's OWN provider. Normalizing those too
        // would paint eight identical tiles and throw away the only per-seat
        // information the stack carries.
        #expect(plan.state.seats.map(\.provider) == ["claude", "codex"])
    }

    @Test("a solo chat keeps its real provider")
    func soloProviderIsNotNormalized() throws {
        let solo = try #require(
            TWRunActivityPlanner.plan(
                card: card(status: "running", provider: "pi", chatKind: "single"),
                diff: nil, ensemble: nil, startedAt: start))
        #expect(solo.provider == "pi")
        #expect(!solo.isEnsemble)
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

    @Test("one active run keeps the existing per-run activity")
    func oneRunStaysPerRun() throws {
        let only = try card(
            status: "running", provider: "codex", id: "task-a",
            extra: monitorWorkspace("workspace-1", updatedAt: "2026-08-04T02:00:00Z"))
        let plans = TWRunActivityPlanner.plans(
            cards: [only], diffs: [:], ensembles: [:], gitSnapshots: [:],
            startedAt: { _ in self.start })
        #expect(plans.map(\.subject) == [.thread("task-a")])
        #expect(plans[0].state.activeRuns == 1)
    }

    @Test("two monitor-authorized runs collapse into one anonymous workspace summary")
    func workspaceAggregateUsesGitTruthOnce() throws {
        let first = try card(
            status: "running", provider: "codex", id: "task-a",
            extra: monitorWorkspace("workspace-1", updatedAt: "2026-08-04T02:00:00Z"))
        let second = try card(
            status: "awaitingQuestion", provider: "grok", id: "task-b",
            extra: monitorWorkspace("workspace-1", updatedAt: "2026-08-04T02:01:00Z"))
        let plans = TWRunActivityPlanner.plans(
            cards: [first, second],
            // These overlap and deliberately disagree with Git. They must not
            // be summed into the workspace card.
            diffs: [
                "task-a": try diff(files: 8, additions: 500, deletions: 80),
                "task-b": try diff(files: 7, additions: 400, deletions: 70),
            ],
            ensembles: [:],
            gitSnapshots: [
                "workspace-1": try git(
                    files: 9, additions: 536, deletions: 103, ahead: 40, behind: 2)
            ],
            startedAt: { $0.id == "task-a" ? self.start : self.start.addingTimeInterval(30) })

        #expect(plans.count == 1)
        let plan = try #require(plans.first)
        #expect(plan.subject == .workspace("workspace-1"))
        #expect(plan.state.phase == .awaitingQuestion)
        #expect(plan.state.startedAt == start)
        #expect(plan.state.activeRuns == 2)
        #expect(plan.state.filesChanged == 9)
        #expect(plan.state.additions == 536)
        #expect(plan.state.deletions == 103)
        #expect(plan.state.ahead == 40)
        #expect(plan.state.behind == 2)
        #expect(plan.state.hasGitSnapshot)
        #expect(plan.state.seats.map(\.provider) == ["grok", "codex"])
        // Workspace seats use card phases: running→active, awaitingQuestion→none.
        #expect(plan.state.activeSeats == 1)
        #expect(plan.state.respondedSeats == 0)
        #expect(plan.state.blockedSeats == 0)
    }

    @Test("workspace aggregation fails closed without monitor capability")
    func workspaceAggregateRequiresMonitor() throws {
        let allowed = try card(
            status: "running", provider: "codex", id: "task-a",
            extra: monitorWorkspace("workspace-1", updatedAt: "1"))
        let notAllowed = try card(
            status: "running", provider: "grok", id: "task-b",
            extra: [
                "workspaceId": "workspace-1", "updatedAt": "2",
                "capabilities": ["monitor": false],
            ])
        let plans = TWRunActivityPlanner.plans(
            cards: [allowed, notAllowed], diffs: [:], ensembles: [:], gitSnapshots: [:],
            startedAt: { _ in self.start })
        #expect(Set(plans.map(\.subject)) == [.thread("task-a"), .thread("task-b")])
    }

    @Test("an approval outranks a question in a workspace summary")
    func workspaceNeedsUserPriority() throws {
        let question = try card(
            status: "awaitingQuestion", provider: "codex", id: "task-a",
            extra: monitorWorkspace("workspace-1", updatedAt: "1"))
        let approval = try card(
            status: "awaitingApproval", provider: "claude", id: "task-b",
            extra: monitorWorkspace("workspace-1", updatedAt: "2"))
        let plans = TWRunActivityPlanner.plans(
            cards: [question, approval], diffs: [:], ensembles: [:], gitSnapshots: [:],
            startedAt: { _ in self.start })
        #expect(plans.count == 1)
        #expect(plans.first?.state.phase == .awaitingApproval)
    }

    /// Matches the Mac workspace-summary path: an ensemble member is branded
    /// Ensemble even when its seed provider is still on the card. This is the
    /// card identity, not a participant seat — those keep their own providers.
    @Test("a workspace summary brands an ensemble member Ensemble, not its seed provider")
    func workspaceAggregateNormalizesEnsembleMemberProvider() throws {
        let ensemble = try card(
            status: "running", provider: "pi", chatKind: "ensemble", id: "task-ens",
            extra: monitorWorkspace("workspace-1", updatedAt: "2026-08-04T02:01:00Z"))
        let solo = try card(
            status: "running", provider: "codex", id: "task-solo",
            extra: monitorWorkspace("workspace-1", updatedAt: "2026-08-04T02:00:00Z"))
        let plans = TWRunActivityPlanner.plans(
            cards: [ensemble, solo], diffs: [:], ensembles: [:], gitSnapshots: [:],
            startedAt: { _ in self.start })
        #expect(plans.count == 1)
        let plan = try #require(plans.first)
        #expect(plan.subject == .workspace("workspace-1"))
        #expect(plan.provider == "taskwraith")
        #expect(plan.state.seats.map(\.provider) == ["ensemble", "codex"])
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
            plans: [done], owned: [.thread("task-1"): running.state])
        #expect(actions == [.finish(done)])
    }

    /// Projection snapshots arrive constantly and mostly change nothing. If an
    /// identical state still spent an ActivityKit update, a busy run would churn
    /// the island several times a second.
    @Test("an unchanged state spends no update")
    func unchangedStateIsSilent() throws {
        let plan = try planFor(status: "running")
        #expect(
            TWRunActivityPlanner.actions(
                plans: [plan], owned: [.thread("task-1"): plan.state]
            ).isEmpty)
    }

    @Test("a changed state updates rather than restarting")
    func changedStateUpdates() throws {
        let before = try planFor(status: "running")
        let after = try planFor(status: "awaitingApproval")
        #expect(
            TWRunActivityPlanner.actions(
                plans: [after], owned: [.thread("task-1"): before.state])
                == [.update(after)])
    }

    @Test("starts are capped, and the front of the list wins the slots")
    func startsAreCapped() throws {
        let plans = try (1...5).map { try planFor(status: "running", id: "task-\($0)") }
        let actions = TWRunActivityPlanner.actions(plans: plans, owned: [:], limit: 2)
        #expect(actions.count == 2)
        #expect(actions == [.start(plans[0]), .start(plans[1])])
    }

    @Test("forming a workspace summary replaces per-run cards in one pass")
    func workspaceTransitionReleasesBeforeStarting() throws {
        let first = try planFor(status: "running", id: "task-a")
        let second = try planFor(status: "running", id: "task-b")
        let workspace = TWActivityPlan(
            subject: .workspace("workspace-1"), provider: "taskwraith", model: nil,
            isEnsemble: false,
            state: makeContentState(
                phase: .running, startedAt: start, activeRuns: 2, hasGitSnapshot: false))
        let actions = TWRunActivityPlanner.actions(
            plans: [workspace],
            owned: [.thread("task-a"): first.state, .thread("task-b"): second.state],
            limit: 1)
        #expect(
            actions == [
                .abandon(subject: .thread("task-a")),
                .abandon(subject: .thread("task-b")),
                .start(workspace),
            ])
    }

    @Test("an owned activity counts against the cap")
    func ownedCountsAgainstCap() throws {
        let held = try planFor(status: "running", id: "task-held")
        let fresh = try planFor(status: "running", id: "task-new")
        // BOTH are still projected — `held` has to stay in `plans` or it reads
        // as vanished and gets abandoned instead of holding its slot.
        let actions = TWRunActivityPlanner.actions(
            plans: [held, fresh], owned: [.thread("task-held"): held.state], limit: 1)
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
                .thread("task-b"): plan.state,
                .thread("task-z"): plan.state,
                .thread("task-a"): plan.state,
            ])
        // Dictionary key order is not stable, so the planner sorts; without that
        // this assertion would pass or fail by luck.
        #expect(
            actions == [
                .abandon(subject: .thread("task-a")),
                .abandon(subject: .thread("task-z")),
            ])
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
            TWRunActivityPlanner.actions(
                plans: plans, owned: [.thread("task-1"): running.state])
                == [.abandon(subject: .thread("task-1"))])
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

    private func monitorWorkspace(_ id: String, updatedAt: String) -> [String: Any] {
        [
            "workspaceId": id,
            "updatedAt": updatedAt,
            "capabilities": ["monitor": true],
        ]
    }

    private func diff(files: Int, additions: Int, deletions: Int) throws -> MobileDiffSummary {
        try JSONDecoder().decode(
            MobileDiffSummary.self,
            from: JSONSerialization.data(withJSONObject: [
                "filesChanged": files, "additions": additions, "deletions": deletions,
            ]))
    }

    private func git(
        files: Int, additions: Int, deletions: Int, ahead: Int, behind: Int
    ) throws -> GitWorkspaceSnapshot {
        try JSONDecoder().decode(
            GitWorkspaceSnapshot.self,
            from: JSONSerialization.data(withJSONObject: [
                "counts": ["changed": files],
                "lineStats": ["additions": additions, "deletions": deletions],
                "ahead": ahead,
                "behind": behind,
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
