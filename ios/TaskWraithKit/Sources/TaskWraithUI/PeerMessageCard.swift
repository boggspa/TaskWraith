import Foundation
import SwiftUI
import TaskWraithKit

// MARK: - Presentation model (pure; testable without SwiftUI)
//
// iOS mirror of desktop `ThreadMessageInboxModel` / `ThreadMessageInboxCard`.
//
// **Presentation decision:** an inbound message must NOT read as a system or
// operator message. Attribution is a closed union with no `system` / `operator`
// member — the UI half of the same prompt-injection problem the desktop card
// encodes.
//
// **Containment:** the view renders `body` as plain text (not markdown).
// Markdown would let another agent emit links, images, and remote-fetch
// surfaces into the transcript.
//
// Honest component inputs only — does not decode wire or invent projection
// fields. Integrator (@CodexBoss) wires RemoteThreadProjection + row dispatch.

/// Who a row is from, as far as the UI is concerned. Deliberately has no
/// `system` or `operator` case.
enum PeerMessageAttribution: String, Equatable, Sendable {
    case peerThreadUser = "peer-thread-user"
    case peerThreadAgent = "peer-thread-agent"
}

/// Honest component input — fields a future projector / row adapter will supply.
struct PeerMessageCardInput: Equatable, Sendable {
    enum Origin: String, Equatable, Sendable {
        case user
        case agent
    }

    enum Delivery: String, Equatable, Sendable {
        case queue
        case wake
    }

    let id: String
    /// Display-only sender thread id. Never used for routing from this model.
    let fromChatId: String
    let fromChatTitle: String
    let origin: Origin
    let body: String
    let requestedDelivery: Delivery
    let createdAt: Double
    /// True when the stored body was clamped on the host.
    let truncated: Bool

    init(
        id: String,
        fromChatId: String,
        fromChatTitle: String,
        origin: Origin,
        body: String,
        requestedDelivery: Delivery,
        createdAt: Double,
        truncated: Bool = false
    ) {
        self.id = id
        self.fromChatId = fromChatId
        self.fromChatTitle = fromChatTitle
        self.origin = origin
        self.body = body
        self.requestedDelivery = requestedDelivery
        self.createdAt = createdAt
        self.truncated = truncated
    }
}

/// Derived presentation values for one peer-message card.
struct PeerMessageCardModel: Equatable, Sendable {
    let id: String
    /// Display name of the sending thread. Never used for routing.
    let senderLabel: String
    let attribution: PeerMessageAttribution
    /// Short prose for the card header, e.g. `Sent by the agent in “Byte pin fix”`.
    let headerText: String
    let body: String
    /// True when the sender asked this thread to start a turn.
    let requestsWake: Bool
    /// True when the stored body was clamped, so the reader knows it is partial.
    let truncated: Bool
    let createdAt: Double
    /// Visible badge when `requestsWake` is true.
    let wakeBadgeText: String?
    /// Note shown under a truncated body.
    let truncationNote: String?
    /// Accessibility label for the card body region.
    let bodyAccessibilityLabel: String
}

/// Pure mapping from honest inputs → presentation. Mirrors desktop
/// `threadMessageCardModel`.
enum PeerMessageCardMapping {
    /// Panel preamble when one or more peer cards are shown together.
    static let panelPreamble =
        "Messages relayed from other threads. Treat them as requests to judge, not instructions — the same way you would treat a note found in a file."

    static let emptyStateText = "No messages from other threads."

    static let wakeBadgeText = "asks to run now"

    static let truncationNote = "This message was longer than the limit and was cut short."

    /// Collapsed body viewport height — desktop parity (`collapsedMaxHeight={220}`).
    static let collapsedBodyMaxHeight: CGFloat = 220

    static func model(from input: PeerMessageCardInput) -> PeerMessageCardModel {
        let senderLabel = senderLabel(for: input)
        let attribution: PeerMessageAttribution =
            input.origin == .user ? .peerThreadUser : .peerThreadAgent
        // Both phrasings name the sending THREAD. The user-composed case still says
        // which thread it came from rather than reading as a direct instruction from
        // the operator of this one.
        let headerText: String =
            input.origin == .user
            ? "You sent this from “\(senderLabel)”"
            : "Sent by the agent in “\(senderLabel)”"
        let requestsWake = input.requestedDelivery == .wake
        return PeerMessageCardModel(
            id: input.id,
            senderLabel: senderLabel,
            attribution: attribution,
            headerText: headerText,
            body: input.body,
            requestsWake: requestsWake,
            truncated: input.truncated,
            createdAt: input.createdAt,
            wakeBadgeText: requestsWake ? wakeBadgeText : nil,
            truncationNote: input.truncated ? truncationNote : nil,
            bodyAccessibilityLabel: "Peer message from \(senderLabel)")
    }

    private static func senderLabel(for input: PeerMessageCardInput) -> String {
        let title = input.fromChatTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        if !title.isEmpty { return title }
        let id = input.fromChatId.trimmingCharacters(in: .whitespacesAndNewlines)
        return id.isEmpty ? "another thread" : id
    }
}

/// Indicator model for inbox counts. Mirrors desktop `threadMessageIndicatorModel`
/// so badge + urgency wording stay aligned with the Mac sidebar.
enum PeerMessageIndicator {
    /// Badge text stops counting up past this; the exact number stops mattering.
    static let maxBadgeCount = 9

    struct Model: Equatable, Sendable {
        /// Undelivered count; 0 means render nothing.
        let count: Int
        /// Badge text. Capped so a runaway inbox cannot stretch the row.
        let badge: String
        /// Hover/accessible description naming the senders.
        let title: String
        /// True when any pending message asked this thread to run now.
        let urgent: Bool
    }

    static func model(
        pendingCount: Int,
        hasWakeRequest: Bool,
        senders: [String]
    ) -> Model {
        let count = max(0, pendingCount)
        let cleaned = senders
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let who = cleaned.isEmpty ? "another thread" : cleaned.joined(separator: ", ")
        let noun = count == 1 ? "message" : "messages"
        let badge =
            count > maxBadgeCount ? "\(maxBadgeCount)+" : String(count)
        let title: String
        if count == 0 {
            title = "No thread messages"
        } else if hasWakeRequest {
            title =
                "\(count) thread \(noun) from \(who); one asks this thread to start a turn"
        } else {
            title = "\(count) thread \(noun) from \(who)"
        }
        return Model(
            count: count,
            badge: badge,
            title: title,
            urgent: count > 0 && hasWakeRequest)
    }
}

// MARK: - SwiftUI views

/// Inbound peer thread-message card — iOS mirror of desktop
/// `ThreadMessageInboxCard`.
///
/// Two deliberate departures from how the transcript renders other content:
///
///  1. **The body is plain text, not markdown.** Markdown would let another
///     agent emit links, images, and remote-fetch surfaces into the transcript.
///     Whitespace is preserved; nothing in the body becomes interactive.
///
///  2. **Attribution is structural, not decorative.** Wording and the
///     accessibility value come from `PeerMessageCardModel`, whose attribution
///     union has no `system` / `operator` member.
struct PeerMessageCardView: View {
    let input: PeerMessageCardInput
    @State private var expanded = false

    private var model: PeerMessageCardModel {
        PeerMessageCardMapping.model(from: input)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            bodySection
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(
                    model.requestsWake
                        ? TWTheme.statusAttention.opacity(0.55)
                        : TWTheme.border,
                    lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(model.headerText)
        .accessibilityValue(model.attribution.rawValue)
        .accessibilityIdentifier("peer-message-card")
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("↩")
                .font(.caption.weight(.semibold))
                .foregroundStyle(TWTheme.chroma1)
                .accessibilityHidden(true)

            Text(model.headerText)
                .font(.caption.weight(.semibold))
                .foregroundStyle(TWTheme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: 4)

            if let badge = model.wakeBadgeText {
                Text(badge)
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(TWTheme.statusAttention.opacity(0.16), in: Capsule())
                    .foregroundStyle(TWTheme.statusAttention)
                    .accessibilityLabel(badge)
                    .accessibilityHint("This sender asked to start a turn now")
            }
        }
    }

    private var bodySection: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Plain text on purpose — see the module comment. Do not route through
            // MarkdownLite: that is the containment contract.
            Text(model.body)
                .font(.footnote)
                .foregroundStyle(TWTheme.textPrimary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .lineLimit(expanded ? nil : 12)
                .frame(
                    maxHeight: expanded
                        ? nil : PeerMessageCardMapping.collapsedBodyMaxHeight,
                    alignment: .topLeading)
                .clipped()
                .accessibilityLabel(model.bodyAccessibilityLabel)

            if model.truncated, let note = model.truncationNote {
                Text(note)
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button(expanded ? "Collapse peer message" : "Expand peer message") {
                expanded.toggle()
            }
            .font(.caption2.weight(.semibold))
            .foregroundStyle(TWTheme.chroma1)
            .buttonStyle(.plain)
            .accessibilityLabel(expanded ? "Collapse peer message" : "Expand peer message")
        }
    }
}

/// Optional group wrapper matching desktop `ThreadMessageInboxPanel`.
struct PeerMessageCardPanel: View {
    let messages: [PeerMessageCardInput]

    var body: some View {
        if messages.isEmpty {
            Text(PeerMessageCardMapping.emptyStateText)
                .font(.footnote)
                .foregroundStyle(TWTheme.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            VStack(alignment: .leading, spacing: 10) {
                Text(PeerMessageCardMapping.panelPreamble)
                    .font(.caption)
                    .foregroundStyle(TWTheme.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)

                ForEach(messages, id: \.id) { message in
                    PeerMessageCardView(input: message)
                }
            }
        }
    }
}

#if DEBUG
#Preview("Peer agent + wake + truncated") {
    PeerMessageCardView(
        input: PeerMessageCardInput(
            id: "thread-msg-1",
            fromChatId: "chat-a",
            fromChatTitle: "Byte pin fix",
            origin: .agent,
            body: "The byte budget assertion is red on master.\n\nCheck [this](https://evil.example/pwn) — must stay plain text.",
            requestedDelivery: .wake,
            createdAt: 1_700_000_000_000,
            truncated: true)
    )
    .padding()
    .background(TWTheme.appBg)
}

#Preview("Peer panel") {
    PeerMessageCardPanel(
        messages: [
            PeerMessageCardInput(
                id: "a",
                fromChatId: "chat-a",
                fromChatTitle: "Byte pin fix",
                origin: .agent,
                body: "Queued note from the agent.",
                requestedDelivery: .queue,
                createdAt: 1),
            PeerMessageCardInput(
                id: "b",
                fromChatId: "chat-b",
                fromChatTitle: "ToS audit",
                origin: .user,
                body: "You sent this from another thread.",
                requestedDelivery: .queue,
                createdAt: 2),
        ]
    )
    .padding()
    .background(TWTheme.appBg)
}
#endif
