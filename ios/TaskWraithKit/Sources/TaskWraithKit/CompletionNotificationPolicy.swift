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
