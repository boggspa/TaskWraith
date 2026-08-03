import Foundation
import TaskWraithKit

/// One live direct sub-thread row for the above-transcript ticker.
struct SubThreadTickerItem: Equatable, Sendable, Identifiable {
    let id: String
    let provider: String?
    let title: String
    let agentName: String?

    var providerLabel: String {
        let raw = (provider ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { return "Sub-thread" }
        // Keep model-free: Theme labels live on MainActor views; ticker model
        // uses a small shared table matching desktop `providerLabel`.
        switch raw.lowercased() {
        case "codex": return "Codex"
        case "claude": return "Claude"
        case "kimi": return "Kimi"
        case "grok": return "Grok"
        case "cursor": return "Cursor"
        case "gemini": return "Gemini"
        case "ollama": return "Ollama"
        case "pi": return "Pi"
        case "mistral": return "Mistral"
        case "antigravity": return "AntiGravity"
        default:
            return raw.prefix(1).uppercased() + raw.dropFirst()
        }
    }

    var accessibilityLabel: String {
        let name = agentName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let named = (name?.isEmpty == false) ? name! : title
        return "\(providerLabel) sub-thread active: \(named)"
    }
}

struct SubThreadTickerModel: Equatable, Sendable {
    let parentThreadId: String
    let parentProvider: String?
    let items: [SubThreadTickerItem]

    var isEmpty: Bool { items.isEmpty }

    var parentProviderLabel: String {
        SubThreadTickerItem(id: "parent", provider: parentProvider, title: "", agentName: nil)
            .providerLabel
    }

    var accessibilityLabel: String {
        guard !items.isEmpty else { return "No active sub-threads" }
        let names = items.map(\.providerLabel).joined(separator: ", ")
        return "\(parentProviderLabel) orchestrating; active sub-threads: \(names)"
    }
}

enum SubThreadStatusTicker {
    /// Desktop contract: only **direct** sub-threads of the active chat that
    /// are currently live. Side chats are excluded even when they share a
    /// parentChatId.
    ///
    /// Live authority:
    /// 1. If `runningChatIds` is provided, membership in that set wins
    ///    (desktop ticker).
    /// 2. Otherwise fall back to card statuses that mean an active run
    ///    (`running`, `queued`, awaiting approval/question, …) so early
    ///    queued children are not dropped when the phone lacks a dedicated
    ///    running-id projection.
    static func build(
        parentThreadId: String,
        parentProvider: String?,
        taskCards: [RemoteTaskCard],
        runningChatIds: Set<String>? = nil
    ) -> SubThreadTickerModel {
        let parent = parentThreadId.trimmingCharacters(in: .whitespacesAndNewlines)
        let items: [SubThreadTickerItem] = taskCards.compactMap { card in
            guard !parent.isEmpty else { return nil }
            guard card.parentChatId == parent else { return nil }
            guard isDirectSubThread(card) else { return nil }
            guard isLive(card: card, runningChatIds: runningChatIds) else { return nil }

            let title = (card.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return SubThreadTickerItem(
                id: card.id,
                provider: card.provider,
                title: title.isEmpty ? "Untitled sub-thread" : title,
                agentName: card.agentName
            )
        }

        return SubThreadTickerModel(
            parentThreadId: parent,
            parentProvider: parentProvider,
            items: items
        )
    }

    /// `parentChatRelation` missing or `"subThread"` — same rule as desktop
    /// `isSubThreadChat` / `RemoteTaskCard.isSubThread`, excluding side chats.
    static func isDirectSubThread(_ card: RemoteTaskCard) -> Bool {
        if card.parentChatRelation == "sideChat" { return false }
        return card.isSubThread
    }

    static func isLive(card: RemoteTaskCard, runningChatIds: Set<String>?) -> Bool {
        if let runningChatIds {
            return runningChatIds.contains(card.id)
        }
        let status = (card.status ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return AgentInvocationStatusResolver.liveCardStatuses.contains(status)
    }
}
