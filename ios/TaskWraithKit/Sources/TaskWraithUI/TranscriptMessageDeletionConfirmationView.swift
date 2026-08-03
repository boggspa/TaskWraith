// Extracted SwiftUI confirmation / blocked surface for single-message
// transcript deletion. Hosts present this after evaluating
// `TranscriptMessageDeletionPolicyModel`; delete execution stays a callback
// (Boss owns bridge / store wiring later).

import Foundation
import SwiftUI

/// Presentation state derived from a policy decision. Hosts can bind this
/// to `.sheet` / `.alert` without re-running policy in the view.
public enum TranscriptMessageDeletionPresentation: Equatable, Sendable, Identifiable {
    case blocked(TranscriptMessageDeletionBlocked)
    case confirmation(TranscriptMessageDeletionConfirmation)

    public var id: String {
        switch self {
        case .blocked(let blocked): return "blocked:\(blocked.messageId)"
        case .confirmation(let confirmation): return "confirm:\(confirmation.messageId)"
        }
    }

    public var messageId: String {
        switch self {
        case .blocked(let blocked): return blocked.messageId
        case .confirmation(let confirmation): return confirmation.messageId
        }
    }

    public static func from(_ decision: TranscriptMessageDeletionDecision)
        -> TranscriptMessageDeletionPresentation?
    {
        switch decision {
        case .unavailable:
            return nil
        case .blocked(let blocked):
            return .blocked(blocked)
        case .requiresConfirmation(let confirmation):
            return .confirmation(confirmation)
        }
    }
}

/// Self-contained confirmation / blocked card. Destructive confirm only fires
/// `onConfirmDelete` after the user taps Delete on a `.confirmation` state.
struct TranscriptMessageDeletionConfirmationView: View {
    let presentation: TranscriptMessageDeletionPresentation
    /// Called with the stable message id only after explicit confirm.
    var onConfirmDelete: ((String) -> Void)?
    var onCancel: (() -> Void)?
    var onDismissBlocked: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            bodyCopy
            actions
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(borderColor.opacity(0.55), lineWidth: 1.1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: headerSymbol)
                .font(.body.weight(.semibold))
                .foregroundStyle(borderColor)
                .accessibilityHidden(true)
            Text(headerTitle)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TWTheme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .accessibilityAddTraits(.isHeader)
    }

    @ViewBuilder
    private var bodyCopy: some View {
        switch presentation {
        case .blocked(let blocked):
            Text(blocked.reason)
                .font(.footnote)
                .foregroundStyle(TWTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        case .confirmation(let confirmation):
            Text(confirmation.preview)
                .font(.footnote)
                .foregroundStyle(TWTheme.textSecondary)
                .lineLimit(6)
                .fixedSize(horizontal: false, vertical: true)
            Text("This cannot be undone from the phone.")
                .font(.caption2)
                .foregroundStyle(TWTheme.textMuted)
        }
    }

    private var actions: some View {
        HStack(spacing: 8) {
            switch presentation {
            case .blocked(let blocked):
                Spacer(minLength: 0)
                Button(blocked.dismissActionLabel) {
                    onDismissBlocked?()
                }
                .buttonStyle(.bordered)
                .accessibilityLabel(blocked.dismissActionLabel)
            case .confirmation(let confirmation):
                Button(confirmation.cancelActionLabel) {
                    onCancel?()
                }
                .buttonStyle(.bordered)
                .accessibilityLabel(confirmation.cancelActionLabel)
                Spacer(minLength: 0)
                Button(role: .destructive) {
                    if let intent = TranscriptMessageDeletionPolicyModel.confirmedIntent(
                        from: confirmation
                    ) {
                        onConfirmDelete?(intent.messageId)
                    }
                } label: {
                    Text(confirmation.confirmActionLabel)
                }
                .buttonStyle(.borderedProminent)
                .tint(TWTheme.statusFailed)
                .accessibilityLabel(confirmation.confirmActionLabel)
                .accessibilityHint("Permanently removes this message from the transcript")
            }
        }
    }

    private var headerTitle: String {
        switch presentation {
        case .blocked:
            return "Cannot delete message"
        case .confirmation(let confirmation):
            return confirmation.title
        }
    }

    private var headerSymbol: String {
        switch presentation {
        case .blocked: return "exclamationmark.triangle.fill"
        case .confirmation: return "trash"
        }
    }

    private var borderColor: Color {
        switch presentation {
        case .blocked: return TWTheme.statusAttention
        case .confirmation: return TWTheme.statusFailed
        }
    }

    private var accessibilityLabel: String {
        switch presentation {
        case .blocked(let blocked):
            return blocked.accessibilityLabel
        case .confirmation(let confirmation):
            return confirmation.accessibilityLabel
        }
    }
}

/// Optional drop-in Delete control that opens the policy surface via callback.
/// Does not delete on tap — host must evaluate policy and present confirmation.
struct TranscriptMessageDeletionAffordanceButton: View {
    let messageId: String
    var onRequestDelete: (String) -> Void

    var body: some View {
        Button {
            guard TranscriptMessageDeletionPolicyModel.showsDeleteAffordance(messageId: messageId)
            else { return }
            onRequestDelete(messageId)
        } label: {
            Image(systemName: "trash")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(TWTheme.textMuted)
                .frame(width: 28, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!TranscriptMessageDeletionPolicyModel.showsDeleteAffordance(messageId: messageId))
        .accessibilityLabel(
            TranscriptMessageDeletionPolicyModel.deleteAffordanceAccessibilityLabel()
        )
        .accessibilityHint(TranscriptMessageDeletionPolicyModel.deleteAffordanceTitle())
    }
}

#if DEBUG
    #Preview("Confirmation") {
        let decision = TranscriptMessageDeletionPolicyModel.evaluate(
            messageId: "msg-1",
            role: "assistant",
            content: "Hello from the agent — about to be deleted."
        )
        if let presentation = TranscriptMessageDeletionPresentation.from(decision) {
            TranscriptMessageDeletionConfirmationView(presentation: presentation)
                .padding()
                .background(TWTheme.appBg)
        }
    }

    #Preview("Blocked") {
        let decision = TranscriptMessageDeletionPolicyModel.evaluate(
            messageId: "agent-question-42",
            role: "assistant",
            content: "Which option?",
            pendingAgentQuestionMessageId: "agent-question-42"
        )
        if let presentation = TranscriptMessageDeletionPresentation.from(decision) {
            TranscriptMessageDeletionConfirmationView(presentation: presentation)
                .padding()
                .background(TWTheme.appBg)
        }
    }
#endif
