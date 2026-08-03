import Foundation
import TaskWraithKit

/// Visible lifecycle of a TaskWraith Agent Invocation (desktop
/// `SubThreadDelegationCard` / `resolveDelegationStatus`).
enum AgentInvocationStatus: Equatable, Sendable {
    case created
    case running
    case completed
    case failed(reason: String?)
    case cancelled(reason: String?)
    case returned
    case unknown

    var kind: String {
        switch self {
        case .created: return "created"
        case .running: return "running"
        case .completed: return "completed"
        case .failed: return "failed"
        case .cancelled: return "cancelled"
        case .returned: return "returned"
        case .unknown: return "unknown"
        }
    }

    var glyph: String {
        switch self {
        case .created, .unknown: return "·"
        case .running: return "▶"
        case .completed: return "✓"
        case .failed: return "✗"
        case .cancelled: return "⊘"
        case .returned: return "↩"
        }
    }

    /// Matches desktop card labels (`Created` / `Active` / …).
    var label: String {
        switch self {
        case .created: return "Created"
        case .running: return "Active"
        case .completed: return "Completed"
        case .failed(let reason): return reason?.isEmpty == false ? reason! : "Failed"
        case .cancelled(let reason): return reason?.isEmpty == false ? reason! : "Cancelled"
        case .returned: return "Returned"
        case .unknown: return "Pending"
        }
    }
}

enum AgentInvocationRoute: String, Equatable, Sendable {
    case taskwraithSubthread = "taskwraith-subthread"
    case providerNative = "provider-native"

    var label: String {
        switch self {
        case .taskwraithSubthread: return "Durable sub-thread"
        case .providerNative: return "Provider tool call in this transcript"
        }
    }
}

/// Honest presentation input for the invocation card. The transcript adapter
/// joins immutable delegation wire metadata to the linked child task card
/// without inventing lifecycle or navigation authority.
struct AgentInvocationCardInput: Equatable, Sendable, Identifiable {
    var id: String { subThreadId ?? title }
    let subThreadId: String?
    let parentProvider: String?
    let targetProvider: String?
    let title: String
    let promptPreview: String?
    let returnResultToParent: Bool
    let route: AgentInvocationRoute
    let status: AgentInvocationStatus
    let dispatchErrorMessage: String?
    let agentName: String?
    let agentAccent: String?

    init(
        subThreadId: String?,
        parentProvider: String? = nil,
        targetProvider: String? = nil,
        title: String?,
        promptPreview: String? = nil,
        returnResultToParent: Bool = false,
        route: AgentInvocationRoute = .taskwraithSubthread,
        status: AgentInvocationStatus,
        dispatchErrorMessage: String? = nil,
        agentName: String? = nil,
        agentAccent: String? = nil
    ) {
        self.subThreadId = Self.trimmed(subThreadId)
        self.parentProvider = Self.trimmed(parentProvider)
        self.targetProvider = Self.trimmed(targetProvider)
        let cleanedTitle = Self.trimmed(title) ?? ""
        self.title = cleanedTitle.isEmpty ? "Untitled sub-thread" : cleanedTitle
        self.promptPreview = Self.trimmed(promptPreview)
        self.returnResultToParent = returnResultToParent
        self.route = route
        self.status = status
        self.dispatchErrorMessage = Self.trimmed(dispatchErrorMessage)
        self.agentName = Self.trimmed(agentName)
        self.agentAccent = Self.trimmed(agentAccent)
    }

    var showsResultReturnedFooter: Bool {
        returnResultToParent && status == .returned
    }

    var routeNote: String {
        route.label
    }

    private static func trimmed(_ value: String?) -> String? {
        guard let value else { return nil }
        let cleaned = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? nil : cleaned
    }
}

/// Snapshot of child state available on the phone today (task card + optional
/// live-run membership). Deliberately smaller than desktop `ChatRecord` — no
/// full runs array is projected to iOS yet.
struct AgentInvocationChildSnapshot: Equatable, Sendable {
    let id: String
    /// Task-card status from Mac (`idle|queued|running|…`).
    let status: String?
    /// True when the child id is in the live running set (desktop ticker /
    /// run-queue authority). Prefer this over card status when known.
    let isInLiveRunningSet: Bool
    /// True when at least one run has been observed. Absent wire ⇒ nil.
    let hasRecordedRun: Bool?
    /// Present when the parent mailbox already received a return.
    let resultReturnedAt: Double?
    let dispatchErrorMessage: String?

    init(
        id: String,
        status: String? = nil,
        isInLiveRunningSet: Bool = false,
        hasRecordedRun: Bool? = nil,
        resultReturnedAt: Double? = nil,
        dispatchErrorMessage: String? = nil
    ) {
        self.id = id
        self.status = status
        self.isInLiveRunningSet = isInLiveRunningSet
        self.hasRecordedRun = hasRecordedRun
        self.resultReturnedAt = resultReturnedAt
        self.dispatchErrorMessage = dispatchErrorMessage
    }

    init(card: RemoteTaskCard, isInLiveRunningSet: Bool = false) {
        self.init(
            id: card.id,
            status: card.status,
            isInLiveRunningSet: isInLiveRunningSet,
            hasRecordedRun: nil,
            resultReturnedAt: nil,
            dispatchErrorMessage: nil
        )
    }
}

enum AgentInvocationStatusResolver {
    /// Mirror of desktop `resolveDelegationStatus`, adapted to phone-available
    /// signals. Live-run membership wins; otherwise map projected card status
    /// and optional return/dispatch markers.
    static func resolve(_ child: AgentInvocationChildSnapshot?) -> AgentInvocationStatus {
        guard let child else { return .unknown }

        if child.isInLiveRunningSet {
            return .running
        }

        if let message = child.dispatchErrorMessage?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !message.isEmpty
        {
            return .failed(reason: "Failed to start")
        }

        let normalized = (child.status ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()

        if Self.liveCardStatuses.contains(normalized) {
            return .running
        }

        if child.resultReturnedAt != nil {
            return .returned
        }

        switch normalized {
        case "success", "done", "completed":
            return .completed
        case "failed", "error":
            return .failed(reason: "Run failed")
        case "cancelled":
            return .cancelled(reason: "Run cancelled")
        case "idle", "":
            if child.hasRecordedRun == false {
                return .created
            }
            // Idle with unknown run history — treat as created when we have no
            // stronger terminal signal (just-spawned cards look like this).
            return .created
        default:
            return .unknown
        }
    }

    /// Card statuses that should light the invocation as Active even when the
    /// dedicated running-chat-id set is unavailable (Scout7 fidelity note).
    static let liveCardStatuses: Set<String> = [
        "running",
        "queued",
        "starting",
        "active",
        "paused",
        "awaitingapproval",
        "awaitingquestion",
        "cancelling",
        "steer_promoting"
    ]
}
