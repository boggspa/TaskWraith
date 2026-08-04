// TWRunActivityPlanner — decides WHICH runs deserve a Live Activity and what
// each one should show. Pure: no ActivityKit, no UIKit, no clock of its own.
//
// The split exists so the interesting half is testable. ActivityKit only exists
// on iOS and only inside a real app process, so `swift test` (which runs on
// macOS) can never exercise a driver that talks to it. Everything worth getting
// wrong therefore lives here, and `TWRunActivityController` is a dumb applicator
// of the actions this returns. Same shape as CompletionNotificationPolicy.

import Foundation

/// Local routing identity for an activity. This is deliberately richer than
/// the ActivityKit payload: the phone may remember which local projection owns
/// a card, but neither id is encoded into attributes or content-state.
public enum TWActivitySubject: Hashable, Sendable {
    case thread(String)
    case workspace(String)

    public var key: String {
        switch self {
        case .thread(let id): return "thread:\(id)"
        case .workspace(let id): return "workspace:\(id)"
        }
    }

    public var threadId: String? {
        guard case .thread(let id) = self else { return nil }
        return id
    }

    public var workspaceId: String? {
        guard case .workspace(let id) = self else { return nil }
        return id
    }
}

/// One thread that should own a Live Activity, plus the state to show.
///
/// `provider` / `model` are brand-resolution INPUTS for the driver (it turns
/// them into a palette); they are not additional wire content — `provider`
/// already travels inside the config.
public struct TWActivityPlan: Hashable, Sendable {
    public let subject: TWActivitySubject
    public let provider: String
    public let model: String?
    public let isEnsemble: Bool
    public let state: TWRunActivityState

    public var isWorkspace: Bool { subject.workspaceId != nil }

    public init(
        subject: TWActivitySubject, provider: String, model: String?, isEnsemble: Bool,
        state: TWRunActivityState
    ) {
        self.subject = subject
        self.provider = provider
        self.model = model
        self.isEnsemble = isEnsemble
        self.state = state
    }
}

public enum TWActivityAction: Hashable, Sendable {
    case start(TWActivityPlan)
    case update(TWActivityPlan)
    /// Reached a terminal phase — show the outcome briefly, then dismiss.
    case finish(TWActivityPlan)
    /// The thread stopped being projected at all (host switch, forget, chat
    /// deleted, run reset to idle). There is no outcome to show, so tear it
    /// down immediately rather than leave a frozen run on the lock screen.
    case abandon(subject: TWActivitySubject)
}

public enum TWRunActivityPlanner {
    /// Card status → phase. nil means "this run does not warrant an activity".
    /// Mirrors `RemoteTaskStatus` in src/main/RemoteTaskProjection.ts — the
    /// pending approval/question counts are already folded into the status
    /// there (`deriveTaskStatus`), so this must NOT re-derive them or an
    /// ensemble mid-round would flip phase on a single participant.
    public static func phase(forCardStatus status: String?) -> TWRunPhase? {
        switch status {
        case "queued", "running": return .running
        case "awaitingApproval": return .awaitingApproval
        case "awaitingQuestion": return .awaitingQuestion
        case "success": return .complete
        case "failed": return .failed
        case "cancelled": return .cancelled
        // "idle" and anything a newer Mac invents: no activity. Unknown must
        // fall here rather than default to .running — a status this build does
        // not understand is not evidence that work is happening.
        default: return nil
        }
    }

    /// Ensemble participant status → seat phase.
    ///
    /// A seat that has not started yet maps to `.running`, not to a dedicated
    /// pending case. TWRunPhase is a WIRE enum the widget switches on, so a new
    /// case costs a decode fallback on every older build; that is not worth
    /// buying for a 7-point dot, and `SeatDots` already dims non-terminal seats.
    /// What the bar counts — finished vs total — is correct either way.
    public static func seatPhase(forParticipantStatus status: String?) -> TWRunPhase {
        switch status {
        case "completed", "done": return .complete
        case "failed", "error": return .failed
        case "skipped", "cancelled": return .cancelled
        default: return .running
        }
    }

    public static func seats(from ensemble: RemoteEnsembleState?) -> [TWSeatState] {
        guard let participants = ensemble?.participants else { return [] }
        return
            participants
            .sorted { ($0.order ?? Int.max, $0.participantId) < ($1.order ?? Int.max, $1.participantId) }
            .map {
                TWSeatState(
                    provider: $0.provider ?? "ensemble",
                    phase: seatPhase(forParticipantStatus: $0.status))
            }
    }

    /// `startedAt` is supplied by the caller rather than read from the card:
    /// the card carries no run-start timestamp, so the driver remembers when it
    /// first saw the run and passes that. It is honestly "elapsed since your
    /// phone saw this start", which understates a run already in flight when
    /// the phone connected — better than a fabricated precise-looking figure.
    public static func plan(
        card: RemoteTaskCard,
        diff: MobileDiffSummary?,
        ensemble: RemoteEnsembleState?,
        startedAt: Date
    ) -> TWActivityPlan? {
        guard card.isDraft != true, card.archived != true else { return nil }
        guard let phase = phase(forCardStatus: card.status) else { return nil }
        return TWActivityPlan(
            subject: .thread(card.id),
            provider: card.provider ?? (card.isEnsemble ? "ensemble" : "codex"),
            model: card.customModel,
            isEnsemble: card.isEnsemble,
            state: makeContentState(
                phase: phase,
                startedAt: startedAt,
                filesChanged: diff?.filesChanged ?? diff?.files?.count ?? 0,
                additions: diff?.additions ?? 0,
                deletions: diff?.deletions ?? 0,
                seats: card.isEnsemble ? seats(from: ensemble) : []))
    }

    /// Builds the whole desired projection, collapsing two or more active runs
    /// in the same monitor-authorized workspace into one anonymous summary.
    ///
    /// The aggregate uses ONE workspace Git snapshot. Per-run diffs are never
    /// added together: overlapping work would inflate them and imply
    /// attribution Git cannot prove.
    public static func plans(
        cards: [RemoteTaskCard],
        diffs: [String: MobileDiffSummary],
        ensembles: [String: RemoteEnsembleState],
        gitSnapshots: [String: GitWorkspaceSnapshot],
        startedAt: (RemoteTaskCard) -> Date
    ) -> [TWActivityPlan] {
        let visibleCards = cards.filter { $0.isDraft != true && $0.archived != true }
        let activeCards = visibleCards.filter {
            guard let phase = phase(forCardStatus: $0.status) else { return false }
            return !phase.isTerminal
        }
        let byWorkspace = Dictionary(
            grouping: activeCards.filter { !$0.isGlobalScope },
            by: { $0.workspaceId ?? "" })
        let aggregateWorkspaceIds = Set(
            byWorkspace.compactMap { workspaceId, members -> String? in
                guard !workspaceId.isEmpty, members.count >= 2 else { return nil }
                // Capability is projected from the active allowlist. Requiring
                // every member to carry it fails closed during mixed-version or
                // mid-reconciliation snapshots.
                guard members.allSatisfy({ $0.capabilities?.monitor == true }) else { return nil }
                return workspaceId
            })

        var ranked: [(updatedAt: String, plan: TWActivityPlan)] = []

        for workspaceId in aggregateWorkspaceIds.sorted() {
            guard let members = byWorkspace[workspaceId], !members.isEmpty else { continue }
            let memberPhases = members.compactMap {
                TWRunActivityPlanner.phase(forCardStatus: $0.status)
            }
            let phase: TWRunPhase
            if memberPhases.contains(.awaitingApproval) {
                phase = .awaitingApproval
            } else if memberPhases.contains(.awaitingQuestion) {
                phase = .awaitingQuestion
            } else {
                phase = .running
            }
            let orderedMembers = members.sorted {
                (($0.updatedAt ?? ""), $0.id) > (($1.updatedAt ?? ""), $1.id)
            }
            guard let firstSeen = orderedMembers.map(startedAt).min() else { continue }
            let git = gitSnapshots[workspaceId]
            let seats = orderedMembers.map {
                TWSeatState(
                    provider: $0.provider ?? ($0.isEnsemble ? "ensemble" : "codex"),
                    phase: TWRunActivityPlanner.phase(forCardStatus: $0.status) ?? .running)
            }
            ranked.append(
                (
                    updatedAt: orderedMembers.first?.updatedAt ?? "",
                    plan: TWActivityPlan(
                        subject: .workspace(workspaceId),
                        provider: "taskwraith",
                        model: nil,
                        isEnsemble: false,
                        state: makeContentState(
                            phase: phase,
                            startedAt: firstSeen,
                            filesChanged: git?.counts?.changed ?? git?.files?.count ?? 0,
                            additions: git?.lineStats?.additions ?? 0,
                            deletions: git?.lineStats?.deletions ?? 0,
                            seats: seats,
                            activeRuns: members.count,
                            ahead: git?.ahead ?? 0,
                            behind: git?.behind ?? 0,
                            hasGitSnapshot: git != nil))))
        }

        for card in visibleCards {
            let isAggregatedActiveMember =
                !card.isGlobalScope
                && aggregateWorkspaceIds.contains(card.workspaceId ?? "")
                && TWRunActivityPlanner.phase(forCardStatus: card.status)?.isTerminal == false
            if isAggregatedActiveMember { continue }
            guard
                let plan = plan(
                    card: card,
                    diff: diffs[card.id],
                    ensemble: ensembles[card.id],
                    startedAt: startedAt(card))
            else { continue }
            ranked.append((updatedAt: card.updatedAt ?? "", plan: plan))
        }

        return ranked.sorted {
            if $0.updatedAt != $1.updatedAt { return $0.updatedAt > $1.updatedAt }
            return $0.plan.subject.key < $1.plan.subject.key
        }.map(\.plan)
    }

    /// Reconcile desired plans against what is currently on screen.
    ///
    /// `plans` must arrive most-relevant-first: when more runs are active than
    /// `limit`, the ones at the front get the slots.
    ///
    /// `owned` is subject → the last state actually pushed. Comparing against
    /// it is what keeps a projection snapshot that changed nothing (they arrive
    /// constantly) from spending an ActivityKit update.
    public static func actions(
        plans: [TWActivityPlan],
        owned: [TWActivitySubject: TWRunActivityState],
        limit: Int = TWRunActivityLimits.maxConcurrent
    ) -> [TWActivityAction] {
        var teardown: [TWActivityAction] = []
        var active: [TWActivityAction] = []
        let planned = Set(plans.map(\.subject))
        let retained = plans.filter { !$0.state.phase.isTerminal && owned[$0.subject] != nil }.count
        var slots = max(0, limit - retained)

        for plan in plans {
            let known = owned[plan.subject]

            if plan.state.phase.isTerminal {
                // NEVER start one just to finish it. A run that was already over
                // when the phone first saw it is history, not news — that is the
                // same rule the completion banner follows for the first snapshot.
                if known != nil { teardown.append(.finish(plan)) }
                continue
            }

            if known == nil {
                guard slots > 0 else { continue }
                slots -= 1
                active.append(.start(plan))
            } else if known != plan.state {
                active.append(.update(plan))
            }
        }

        // Sorted so the action list is deterministic — Dictionary key order is
        // not, and a test that asserts on it would pass or fail by luck.
        for subject in owned.keys.sorted(by: { $0.key < $1.key }) where !planned.contains(subject) {
            teardown.append(.abandon(subject: subject))
        }
        // Release obsolete cards before starting replacements. This makes the
        // single→workspace and workspace→single transitions fit ActivityKit's
        // concurrent-card cap in one reconciliation pass.
        return teardown + active
    }
}
