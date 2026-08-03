import Foundation
import TaskWraithKit

/// Navigation contract for opening an *existing* linked child thread.
///
/// Desktop `SubThreadReturnCard` / `SubThreadDelegationCard` prefer
/// `onOpenSubThread(subThreadId)` over creating a new side chat. iOS already
/// has Agents-panel / home-list routes that open by child id; this helper is
/// the pure decision layer workers and Boss wiring share so return/invocation
/// cards never silently call `createSideChat`.
enum ExistingChildOpenDestination: Equatable, Sendable {
    /// Open the known child in the main thread surface.
    case openInMain
    /// Open the known child as an inspector mini-thread / side panel.
    case openInSidePanel
}

enum ExistingChildNavigationIntent: Equatable, Sendable {
    case openExistingChild(subThreadId: String, destination: ExistingChildOpenDestination)
    /// Missing id, or id that is not a direct child of the current parent.
    case unavailable(reason: String)

    var subThreadId: String? {
        switch self {
        case .openExistingChild(let id, _): return id
        case .unavailable: return nil
        }
    }

    var isAvailable: Bool {
        if case .openExistingChild = self { return true }
        return false
    }

    /// Desktop button historically says "Side chat" while opening the linked
    /// child. iOS labels must not imply *creating* a new side chat.
    var actionLabel: String {
        switch self {
        case .openExistingChild(_, .openInMain):
            return "Open sub-thread"
        case .openExistingChild(_, .openInSidePanel):
            return "Open in Side Chat"
        case .unavailable:
            return "Sub-thread unavailable"
        }
    }

    var accessibilityLabel: String {
        switch self {
        case .openExistingChild(let id, .openInMain):
            return "Open existing sub-thread \(id) in main"
        case .openExistingChild(let id, .openInSidePanel):
            return "Open existing sub-thread \(id) in side chat"
        case .unavailable(let reason):
            return "Sub-thread unavailable: \(reason)"
        }
    }
}

enum ExistingChildNavigation {
    /// Resolve open intent for a projected `subThreadId`.
    ///
    /// - Parameters:
    ///   - subThreadId: Id from return/delegation metadata (may be nil/stale).
    ///   - parentThreadId: The transcript currently on screen.
    ///   - childCards: Task cards visible to the phone (Agents list source).
    ///   - preferredDestination: Main vs inspector; default matches Agents
    ///     "Open in Side Chat" for invocation/ticker affordances.
    static func resolve(
        subThreadId: String?,
        parentThreadId: String,
        childCards: [RemoteTaskCard],
        preferredDestination: ExistingChildOpenDestination = .openInSidePanel
    ) -> ExistingChildNavigationIntent {
        let trimmedId = subThreadId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmedId.isEmpty else {
            return .unavailable(reason: "missing sub-thread id")
        }

        let trimmedParent = parentThreadId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedParent.isEmpty else {
            return .unavailable(reason: "missing parent thread id")
        }

        guard let child = childCards.first(where: { $0.id == trimmedId }) else {
            return .unavailable(reason: "child thread not found")
        }

        guard child.parentChatId == trimmedParent else {
            return .unavailable(reason: "not a child of this thread")
        }

        // Side chats are a different relation; do not treat them as
        // durable TaskWraith sub-threads for this open path.
        if child.parentChatRelation == "sideChat" {
            return .unavailable(reason: "target is a side chat, not a sub-thread")
        }

        guard child.isSubThread else {
            return .unavailable(reason: "target is not a direct sub-thread")
        }

        return .openExistingChild(
            subThreadId: trimmedId,
            destination: preferredDestination
        )
    }
}
