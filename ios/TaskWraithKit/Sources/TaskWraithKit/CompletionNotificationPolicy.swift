import Foundation

/// Pure foreground-notification eligibility shared by the iOS UI and tests.
///
/// The Mac is authoritative for the real terminal boundary. Older Mac builds
/// do not project that bit: retain solo completion alerts for compatibility,
/// but keep legacy ensemble cards quiet rather than reviving per-participant
/// notification spam.
public enum CompletionNotificationPolicy {
    public static func shouldNotify(previous: RemoteTaskCard, current: RemoteTaskCard) -> Bool {
        guard current.status == "success", isEligible(current) else { return false }

        switch previous.status {
        case "queued", "running", "awaitingApproval", "awaitingQuestion":
            return true
        case "success":
            return !isEligible(previous) && previous.runId == current.runId
        default:
            return false
        }
    }

    public static func isEligible(_ card: RemoteTaskCard) -> Bool {
        card.completionNotificationEligible ?? !card.isEnsemble
    }
}

/// Present-once ledger for foreground completion banners.
///
/// `shouldNotify` above is a TRANSITION predicate, and reconnect/rehydrate
/// churn can replay the same transition: a stale snapshot restates the card
/// as 'running', the next fresh delta restores 'success', and the banner
/// posts again. UNUserNotificationCenter treats a re-add of the SAME
/// identifier as a silent visual replace — but it REPLAYS THE SOUND every
/// time, so one completed run under a flapping connection turned into a ding
/// per rehydrate while a single innocent-looking banner sat on screen.
///
/// One banner identity (thread + run) therefore presents exactly once per
/// app session, no matter how many times the transition replays. A re-run of
/// the same thread mints a new runId and banners normally.
public struct CompletionBannerPresentationLedger {
    private var presented: Set<String> = []

    public init() {}

    /// The UNNotificationRequest identifier — single source for both the
    /// dedupe key and the request so they can never drift apart.
    public static func bannerId(threadId: String, runId: String?) -> String {
        "tw-complete-\(threadId)-\(runId ?? "")"
    }

    /// True exactly once per banner identity.
    public mutating func claimPresentation(threadId: String, runId: String?) -> Bool {
        presented.insert(Self.bannerId(threadId: threadId, runId: runId)).inserted
    }
}
