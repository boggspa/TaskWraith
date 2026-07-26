import Foundation

/// One addressable peer thread for a `threadMessage` send.
public struct ThreadMessageTarget: Identifiable, Equatable, Sendable {
    /// Exact thread id. The Mac refuses to resolve a target by title for a remote
    /// caller, so this — not the display name — is what goes on the wire.
    public let threadId: String
    public let title: String
    /// Lives in a different workspace from the sender. The Mac's gate PROMPTS on
    /// the desktop for these rather than auto-allowing, so the row says so.
    public let crossWorkspace: Bool
    public var id: String { threadId }

    public init(threadId: String, title: String, crossWorkspace: Bool) {
        self.threadId = threadId
        self.title = title
        self.crossWorkspace = crossWorkspace
    }
}

/// Which threads this device may address, derived from the projected card list.
///
/// The phone resolves targets locally because the Mac deliberately will not look a
/// thread up by name on a remote caller's behalf. That makes this list a display
/// convenience, not an authority: the Mac re-checks scope, policy and the
/// send-gate on every action regardless of what appears here.
public enum ThreadMessageTargets {
    public static func candidates(
        cards: [RemoteTaskCard],
        fromThreadId: String,
        fromWorkspaceId: String?
    ) -> [ThreadMessageTarget] {
        var seen = Set<String>()
        var targets: [ThreadMessageTarget] = []

        for card in cards {
            let threadId = card.threadId ?? card.id
            guard !threadId.isEmpty else { continue }
            // Self-addressing is refused by the Mac anyway; offering it would be an
            // affordance whose only outcome is an error. Both identities are checked
            // because a card carries `id` and `threadId` and they can differ.
            guard threadId != fromThreadId, card.id != fromThreadId else { continue }
            // A draft has no real chat behind it yet, and an archived one is hidden
            // from the sender's own list — neither can receive.
            guard card.isDraft != true, card.archived != true else { continue }
            guard seen.insert(threadId).inserted else { continue }

            let trimmed = (card.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            targets.append(
                ThreadMessageTarget(
                    threadId: threadId,
                    // Falling back to the id keeps an untitled thread selectable
                    // instead of presenting a blank row.
                    title: trimmed.isEmpty ? threadId : trimmed,
                    crossWorkspace: isCrossWorkspace(
                        target: card.workspaceId, sender: fromWorkspaceId)))
        }

        // Same-workspace first — those are the ones the Mac auto-allows — then by
        // title so the order is stable between refreshes.
        return targets.sorted { lhs, rhs in
            if lhs.crossWorkspace != rhs.crossWorkspace { return !lhs.crossWorkspace }
            return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
        }
    }

    /// Unknown workspace on either side counts as CROSS-workspace: the warning is
    /// cheap and wrong-but-quiet auto-allow is not. Fails toward the caution.
    static func isCrossWorkspace(target: String?, sender: String?) -> Bool {
        guard let target, !target.isEmpty, let sender, !sender.isEmpty else { return true }
        return target != sender
    }
}

/// The inbox count as it appears on the inspector's segmented control.
///
/// A segmented control has nowhere to hang a badge, so the count rides the label —
/// which means an uncapped number would stretch the segment and squeeze the other
/// five. Capped at the same 9 as the desktop badge: past that the exact figure has
/// stopped carrying information.
public enum ThreadMessageBadge {
    public static let maxDisplayCount = 9

    public static func segmentLabel(_ base: String = "Peers", count: Int) -> String {
        guard count > 0 else { return base }
        return count > maxDisplayCount ? "\(base) \(maxDisplayCount)+" : "\(base) \(count)"
    }
}

/// Send-button rules for the peer-message composer, kept out of the view so they
/// are testable without SwiftUI. Mirrors the desktop
/// `threadMessageSendFormState` — the two must agree on what is sendable, or the
/// phone offers sends the Mac then rejects.
public enum ThreadMessageCompose {
    /// Mirrors the shared `MAX_THREAD_MESSAGE_CHARS`. The Mac validator rejects
    /// anything longer, so the phone stops it here rather than round-tripping to
    /// find out.
    public static let maxCharacters = 12_000
    /// Show the counter only near the ceiling; a permanent counter on a field
    /// nobody fills reads as a limit to worry about.
    public static let remainingWarnCharacters = 500

    public struct State: Equatable, Sendable {
        public let canSend: Bool
        /// Empty when sendable. Doubles as the button's accessibility hint, so it
        /// says WHY rather than leaving a dead control unexplained.
        public let blockedReason: String
        public let remaining: Int
        public let overBudget: Bool
        public let showCounter: Bool
        /// Non-nil when the chosen thread is in another workspace: the Mac prompts
        /// for those instead of auto-allowing, and nobody is at the Mac.
        public let crossWorkspaceWarning: String?
    }

    public static func state(
        targetCount: Int, selected: ThreadMessageTarget?, message: String, sending: Bool
    ) -> State {
        let remaining = maxCharacters - message.count
        let overBudget = remaining < 0
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)

        let blocked: String
        if sending {
            blocked = "Sending…"
        } else if targetCount == 0 {
            blocked = "There is no other thread to message."
        } else if selected == nil {
            blocked = "Choose a thread to message."
        } else if trimmed.isEmpty {
            blocked = "Write a message first."
        } else if overBudget {
            blocked = "That message is \(abs(remaining)) characters over the limit."
        } else {
            blocked = ""
        }

        return State(
            canSend: blocked.isEmpty,
            blockedReason: blocked,
            remaining: remaining,
            overBudget: overBudget,
            showCounter: remaining <= remainingWarnCharacters,
            crossWorkspaceWarning: selected?.crossWorkspace == true
                ? "\(selected?.title ?? "That thread") is in another workspace, so your Mac will ask before delivering."
                : nil)
    }
}
