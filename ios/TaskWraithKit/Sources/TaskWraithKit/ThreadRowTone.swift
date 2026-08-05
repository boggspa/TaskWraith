import Foundation

/// Thread-list title ink — the iOS twin of the desktop sidebar's row tones
/// (`src/renderer/src/lib/sidebarTerminalOutcome.ts`).
///
/// Two of the three are settled outcomes the user has not read yet; `waiting`
/// is LIVE state — a thread parked on an approval or an unanswered question,
/// the one case where the row is asking for the user rather than reporting to
/// them.
///
/// Everything here is derived from fields the card already carries, so no
/// change to the Mac-side thread projection was needed.
public enum TWThreadRowTone: String, Sendable, Equatable, CaseIterable {
    case waiting
    case success
    case failure
}

/// A settled result plus the two things the unread/epoch rules need: an
/// identity to remember it by, and when it landed.
public struct TWThreadOutcome: Sendable, Equatable {
    public let fingerprint: String
    /// Always `.success` or `.failure` — `.waiting` is not an outcome.
    public let tone: TWThreadRowTone
    public let settledAt: Date?

    public init(fingerprint: String, tone: TWThreadRowTone, settledAt: Date?) {
        self.fingerprint = fingerprint
        self.tone = tone
        self.settledAt = settledAt
    }
}

public enum TWThreadRowToneResolver {
    /// Statuses that mean the thread finished its work and it went well.
    /// `completed`/`done` are the older projections of the same thing.
    private static let successStatuses: Set<String> = ["success", "completed", "done"]
    private static let failureStatuses: Set<String> = ["failed", "error"]
    /// Terminal but NEUTRAL, matching desktop: the user stopped this on
    /// purpose, so it is neither news nor a problem.
    private static let neutralStatuses: Set<String> = ["cancelled", "canceled"]
    private static let runningStatuses: Set<String> = ["running", "queued"]

    /// Formatters are built per call rather than cached: ISO8601DateFormatter
    /// is not Sendable, so a static one is a strict-concurrency error. Matches
    /// the existing `twParseISO8601` shape in RemoteShellAppearance.
    public static func parseDate(_ value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: value)
    }

    /// Is this thread blocked on the user answering something?
    ///
    /// Both the counted form and the status form are honoured: the counts are
    /// the richer signal, but a Mac build that projects only the status must
    /// still light the row.
    public static func isAwaitingUserResponse(_ card: RemoteTaskCard) -> Bool {
        if (card.pendingApprovalCount ?? 0) > 0 { return true }
        if (card.pendingQuestionCount ?? 0) > 0 { return true }
        return card.status == "awaitingApproval" || card.status == "awaitingQuestion"
    }

    public static func isRunning(_ card: RemoteTaskCard) -> Bool {
        runningStatuses.contains(card.status ?? "")
    }

    /// The latest durable result, or nil while the thread is unsettled or its
    /// ending was neutral.
    ///
    /// A completed goal wins the PRESENTATION tone over the run beneath it,
    /// exactly as on desktop: the goal is what the user asked for, and a
    /// failed step inside a goal that ultimately succeeded is not the headline.
    public static func outcome(for card: RemoteTaskCard) -> TWThreadOutcome? {
        let status = (card.status ?? "").lowercased()
        if let goal = card.activeGoal {
            let goalStatus = goal.status.lowercased()
            if goalStatus == "completed" || goalStatus == "blocked" {
                let stamp = goalStatus == "completed" ? goal.completedAt : goal.blockedAt
                return TWThreadOutcome(
                    fingerprint: "goal:\(goal.id):\(goalStatus):\(stamp ?? goal.updatedAt)",
                    tone: goalStatus == "completed" ? .success : .failure,
                    settledAt: parseDate(stamp) ?? parseDate(goal.updatedAt)
                        ?? parseDate(card.updatedAt))
            }
            // An active or paused goal suppresses ordinary successful-turn
            // green: a provider turn ending is not the goal succeeding.
            // Concrete failure evidence still surfaces.
            if successStatuses.contains(status) { return nil }
        }
        if neutralStatuses.contains(status) || isRunning(card) { return nil }

        let tone: TWThreadRowTone
        if successStatuses.contains(status) {
            tone = .success
        } else if failureStatuses.contains(status) {
            tone = .failure
        } else {
            return nil
        }
        return TWThreadOutcome(
            fingerprint: "run:\(card.runId ?? card.id):\(status):\(card.updatedAt ?? "")",
            tone: tone,
            settledAt: parseDate(card.updatedAt))
    }

    /// Should this success be withheld as pre-existing history?
    ///
    /// SUCCESS only. A failure from before the epoch is still worth flagging —
    /// unfinished business the user may never have seen — while a success from
    /// before it is a result they already lived through. Per-RESULT, not
    /// per-thread: an old thread that runs again and succeeds settles after the
    /// epoch and reads like any other fresh result.
    public static func successInkPredatesEpoch(
        _ outcome: TWThreadOutcome, epoch: Date?
    ) -> Bool {
        guard outcome.tone == .success, let epoch else { return false }
        // An undateable success is treated as history; erring toward quiet is
        // the whole point of the epoch.
        guard let settledAt = outcome.settledAt else { return true }
        return settledAt < epoch
    }

    /// Full resolution, in the desktop's precedence order.
    ///
    /// A thread parked on the user outranks any unread settled outcome, and —
    /// unlike those — survives the running check: the run is blocked, not
    /// finished. It also needs no acknowledgement, clearing itself when the
    /// answer lands.
    public static func tone(
        for card: RemoteTaskCard,
        isSelected: Bool,
        acknowledgements: [String: String],
        successInkEpoch: Date?
    ) -> TWThreadRowTone? {
        // The open thread shows its own modal/card; the row need not shout.
        if isSelected { return nil }
        if isAwaitingUserResponse(card) { return .waiting }
        if isRunning(card) { return nil }
        guard let outcome = outcome(for: card) else { return nil }
        if successInkPredatesEpoch(outcome, epoch: successInkEpoch) { return nil }
        guard acknowledgements[card.id] != outcome.fingerprint else { return nil }
        return outcome.tone
    }
}

/// Minimal storage seam so the store is testable without UserDefaults.
public protocol TWThreadRowToneStorage: AnyObject {
    func twToneString(forKey key: String) -> String?
    func twToneSet(_ value: String, forKey key: String)
}

extension UserDefaults: TWThreadRowToneStorage {
    public func twToneString(forKey key: String) -> String? { string(forKey: key) }
    public func twToneSet(_ value: String, forKey key: String) { set(value, forKey: key) }
}

/// Read/unread fingerprints plus the success-ink epoch, mirroring the
/// desktop's renderer-local store.
public final class TWThreadRowToneStore: @unchecked Sendable {
    public static let acknowledgementsKey = "taskwraith.threadRowTone.acknowledgements.v1"
    public static let successInkEpochKey = "taskwraith.threadRowTone.successInkEpoch.v1"
    /// Same bound as desktop, so a long-lived install cannot grow this without limit.
    private static let maxAcknowledgements = 2_000

    private let storage: TWThreadRowToneStorage
    private var acknowledgements: [String: String]

    public init(storage: TWThreadRowToneStorage = UserDefaults.standard) {
        self.storage = storage
        self.acknowledgements = Self.decode(storage.twToneString(forKey: Self.acknowledgementsKey))
    }

    private static func decode(_ raw: String?) -> [String: String] {
        guard let raw, let data = raw.data(using: .utf8),
            let parsed = try? JSONDecoder().decode([String: String].self, from: data)
        else { return [:] }
        return parsed
    }

    public var currentAcknowledgements: [String: String] { acknowledgements }

    /// The first moment this install could have shown success ink, seeded on
    /// first read and never moved again.
    ///
    /// Without it the first launch after upgrading reads a whole history of
    /// finished work as brand-new and greens the entire list at once.
    @discardableResult
    public func loadOrSeedSuccessInkEpoch(now: Date) -> Date {
        if let raw = storage.twToneString(forKey: Self.successInkEpochKey),
            let seconds = Double(raw), seconds > 0 {
            return Date(timeIntervalSince1970: seconds)
        }
        storage.twToneSet(String(now.timeIntervalSince1970), forKey: Self.successInkEpochKey)
        return now
    }

    /// Mark a thread's current result as seen. Opening the thread is the
    /// acknowledgement, same as desktop.
    public func acknowledge(chatId: String, outcome: TWThreadOutcome) {
        guard acknowledgements[chatId] != outcome.fingerprint else { return }
        acknowledgements[chatId] = outcome.fingerprint
        if acknowledgements.count > Self.maxAcknowledgements {
            // Oldest-first is not knowable from a dictionary; drop arbitrary
            // excess rather than growing forever. A dropped entry re-shows one
            // stale accent at worst.
            let overflow = acknowledgements.count - Self.maxAcknowledgements
            for key in acknowledgements.keys.prefix(overflow) {
                acknowledgements.removeValue(forKey: key)
            }
        }
        persist()
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(acknowledgements),
            let raw = String(data: data, encoding: .utf8)
        else { return }
        storage.twToneSet(raw, forKey: Self.acknowledgementsKey)
    }
}
