// Extracted assistant thumbs feedback chrome — iOS mirror of desktop
// MessageActionsChip thumbs + context-menu reason options.
//
// Presentation-only. The integrator supplies:
//   onFeedback → host applies toggle/clear and durable receipt write
// Optional note is local-only free text (capped 1000); no delete affordance.

import Foundation
import SwiftUI

/// Compact thumbs-up / thumbs-down strip with optional poor-reason sheet.
/// `leadingContent` lets the transcript place its ordinary message actions in
/// the SAME row while this view keeps ownership of the expandable reason UI.
struct AssistantMessageFeedbackBar<LeadingContent: View>: View {
    let item: AssistantMessageFeedbackItem
    /// When true, tapping thumbs-down expands the six desktop reason codes.
    let showsReasonPicker: Bool
    let onFeedback: (AssistantMessageFeedbackRequest) -> Void
    let leadingContent: LeadingContent

    @State private var showsReasons = false
    @State private var noteDraft = ""

    init(
        item: AssistantMessageFeedbackItem,
        showsReasonPicker: Bool = true,
        onFeedback: @escaping (AssistantMessageFeedbackRequest) -> Void,
        @ViewBuilder leadingContent: () -> LeadingContent
    ) {
        self.item = item
        self.showsReasonPicker = showsReasonPicker
        self.onFeedback = onFeedback
        self.leadingContent = leadingContent()
    }

    var body: some View {
        if AssistantMessageFeedbackModel.canRate(item) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 2) {
                    leadingContent
                    HStack(spacing: 2) {
                        voteButton(for: .up)
                        voteButton(for: .down)
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel("Assistant message feedback")
                    Spacer(minLength: 0)
                }

                if showsReasonPicker, showsReasons || item.current?.vote == .down {
                    reasonPicker
                }
            }
        }
    }

    private func voteButton(for vote: AssistantMessageFeedbackVote) -> some View {
        let selected = AssistantMessageFeedbackModel.isSelected(vote, current: item.current)
        return Button {
            handleVote(vote)
        } label: {
            Image(
                systemName: AssistantMessageFeedbackModel.systemImage(
                    for: vote,
                    selected: selected
                )
            )
            .font(.system(size: 11.5, weight: .medium))
            .foregroundStyle(selected ? selectedColor(for: vote) : TWTheme.textMuted)
            .frame(width: 26, height: 24)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            AssistantMessageFeedbackModel.accessibilityLabel(for: vote, item: item)
        )
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var reasonPicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(AssistantMessageFeedbackCopy.reasonSectionTitle)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(TWTheme.textTertiary)

            FlowReasonChips(
                reasons: AssistantMessageFeedbackModel.reasonOptions,
                selectedReason: item.current?.reason,
                onSelect: { reason in
                    if let request = AssistantMessageFeedbackModel.makeReasonRequest(
                        item: item,
                        reason: reason,
                        note: noteDraft.isEmpty ? nil : noteDraft
                    ) {
                        onFeedback(request)
                    }
                }
            )

            VStack(alignment: .leading, spacing: 3) {
                TextField(
                    AssistantMessageFeedbackCopy.notePlaceholder,
                    text: $noteDraft,
                    axis: .vertical
                )
                .font(.caption)
                .lineLimit(2...4)
                .textFieldStyle(.plain)
                .padding(8)
                .background(TWTheme.surface2, in: RoundedRectangle(cornerRadius: 8))
                .onChange(of: noteDraft) { _, newValue in
                    if newValue.count > AssistantMessageFeedbackModel.maxNoteChars {
                        noteDraft = String(
                            newValue.prefix(AssistantMessageFeedbackModel.maxNoteChars)
                        )
                    }
                }
                .accessibilityLabel(AssistantMessageFeedbackCopy.notePlaceholder)
                .accessibilityHint(AssistantMessageFeedbackCopy.noteCharLimitHint)

                Text(
                    "\(min(noteDraft.count, AssistantMessageFeedbackModel.maxNoteChars))/\(AssistantMessageFeedbackModel.maxNoteChars)"
                )
                .font(.caption2)
                .foregroundStyle(TWTheme.textMuted)
            }

            if let note = item.current?.note, !note.isEmpty, noteDraft.isEmpty {
                Text("Saved note: \(note)")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textSecondary)
                    .lineLimit(2)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(AssistantMessageFeedbackCopy.reasonSectionTitle)
    }

    private func handleVote(_ vote: AssistantMessageFeedbackVote) {
        if vote == .down, showsReasonPicker, item.current?.vote != .down {
            // First poor-rating tap opens the reason chrome; host still gets the
            // plain down vote so toggle state matches desktop chip behavior.
            showsReasons = true
        } else if vote == .up {
            showsReasons = false
        }

        let details: AssistantMessageFeedbackDetails?
        if vote == .down, !noteDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            details = AssistantMessageFeedbackDetails(note: noteDraft)
        } else {
            details = nil
        }

        if let request = AssistantMessageFeedbackModel.makeRequest(
            item: item,
            vote: vote,
            details: details
        ) {
            onFeedback(request)
        }
    }

    private func selectedColor(for vote: AssistantMessageFeedbackVote) -> Color {
        switch vote {
        case .up: return TWTheme.statusSuccess
        case .down: return TWTheme.statusFailed
        }
    }
}

extension AssistantMessageFeedbackBar where LeadingContent == EmptyView {
    init(
        item: AssistantMessageFeedbackItem,
        showsReasonPicker: Bool = true,
        onFeedback: @escaping (AssistantMessageFeedbackRequest) -> Void
    ) {
        self.init(
            item: item,
            showsReasonPicker: showsReasonPicker,
            onFeedback: onFeedback,
            leadingContent: { EmptyView() }
        )
    }
}

/// Simple wrapping chip row for the six desktop reason codes.
private struct FlowReasonChips: View {
    let reasons: [AssistantMessageFeedbackReasonCode]
    let selectedReason: String?
    let onSelect: (AssistantMessageFeedbackReasonCode) -> Void

    var body: some View {
        // Fixed two-column grid keeps the chrome compact without a custom layout.
        LazyVGrid(
            columns: [
                GridItem(.flexible(), spacing: 6),
                GridItem(.flexible(), spacing: 6),
            ],
            alignment: .leading,
            spacing: 6
        ) {
            ForEach(reasons, id: \.rawValue) { reason in
                let selected = selectedReason == reason.rawValue
                Button {
                    onSelect(reason)
                } label: {
                    Text(reason.label)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(selected ? TWTheme.textPrimary : TWTheme.textSecondary)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 6)
                        .background(
                            selected ? TWTheme.statusFailed.opacity(0.18) : TWTheme.surface2,
                            in: RoundedRectangle(cornerRadius: 8)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 8)
                                .strokeBorder(
                                    selected
                                        ? TWTheme.statusFailed.opacity(0.45) : TWTheme.border,
                                    lineWidth: 1
                                )
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(
                    AssistantMessageFeedbackModel.reasonAccessibilityLabel(reason)
                )
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
    }
}

#if DEBUG
    #Preview("Assistant feedback — idle") {
        AssistantMessageFeedbackBar(
            item: AssistantMessageFeedbackItem(
                messageId: "msg-preview-1",
                role: "assistant"
            ),
            onFeedback: { _ in }
        )
        .padding()
        .background(TWTheme.surface2)
    }

    #Preview("Assistant feedback — thumbs down") {
        AssistantMessageFeedbackBar(
            item: AssistantMessageFeedbackItem(
                messageId: "msg-preview-2",
                role: "assistant",
                current: AssistantMessageFeedbackState(
                    vote: .down,
                    at: 1,
                    reason: AssistantMessageFeedbackReasonCode.incomplete.rawValue,
                    note: "Missed the edge case"
                )
            ),
            onFeedback: { _ in }
        )
        .padding()
        .background(TWTheme.surface2)
    }
#endif
