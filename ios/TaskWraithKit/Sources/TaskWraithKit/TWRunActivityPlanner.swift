// TWRunActivityPlanner — decides WHICH runs deserve a Live Activity and what
// each one should show. Pure: no ActivityKit, no UIKit, no clock of its own.
//
// The split exists so the interesting half is testable. ActivityKit only exists
// on iOS and only inside a real app process, so `swift test` (which runs on
// macOS) can never exercise a driver that talks to it. Everything worth getting
// wrong therefore lives here, and `TWRunActivityController` is a dumb applicator
// of the actions this returns. Same shape as CompletionNotificationPolicy.

import Foundation

/// One thread that should own a Live Activity, plus the state to show.
///
/// `provider` / `model` are brand-resolution INPUTS for the driver (it turns
/// them into a palette); they are not additional wire content — `provider`
/// already travels inside the config.
public struct TWActivityPlan: Hashable, Sendable {
    public let threadId: String
    public let provider: String
    public let model: String?
    public let isEnsemble: Bool
    public let state: TWRunActivityState

    public init(
        threadId: String, provider: String, model: String?, isEnsemble: Bool,
        state: TWRunActivityState
    ) {
        self.threadId = threadId
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
    case abandon(threadId: String)
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
            threadId: card.id,
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

    /// Reconcile desired plans against what is currently on screen.
    ///
    /// `plans` must arrive most-relevant-first: when more runs are active than
    /// `limit`, the ones at the front get the slots.
    ///
    /// `owned` is threadId → the last state actually pushed. Comparing against
    /// it is what keeps a projection snapshot that changed nothing (they arrive
    /// constantly) from spending an ActivityKit update.
    public static func actions(
        plans: [TWActivityPlan],
        owned: [String: TWRunActivityState],
        limit: Int = TWRunActivityLimits.maxConcurrent
    ) -> [TWActivityAction] {
        var out: [TWActivityAction] = []
        var planned: Set<String> = []
        var slots = max(0, limit - owned.count)

        for plan in plans {
            planned.insert(plan.threadId)
            let known = owned[plan.threadId]

            if plan.state.phase.isTerminal {
                // NEVER start one just to finish it. A run that was already over
                // when the phone first saw it is history, not news — that is the
                // same rule the completion banner follows for the first snapshot.
                if known != nil { out.append(.finish(plan)) }
                continue
            }

            if known == nil {
                guard slots > 0 else { continue }
                slots -= 1
                out.append(.start(plan))
            } else if known != plan.state {
                out.append(.update(plan))
            }
        }

        // Sorted so the action list is deterministic — Dictionary key order is
        // not, and a test that asserts on it would pass or fail by luck.
        for threadId in owned.keys.sorted() where !planned.contains(threadId) {
            out.append(.abandon(threadId: threadId))
        }
        return out
    }
}
