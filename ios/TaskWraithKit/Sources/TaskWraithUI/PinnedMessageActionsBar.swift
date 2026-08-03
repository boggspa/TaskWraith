// Extracted pinned-message action chrome — iOS mirror of the Copy / Jump /
// Unpin buttons on desktop `PinnedMessagesPanel`.
//
// CodexBoss wires this into `NotesPanel` (TWSharedViews) later: replace the
// pin-only trailing button with `PinnedMessagePinRow` / `PinnedMessageActionsBar`
// and route:
//   onCopy           → UIPasteboard (preview today; fuller body if available)
//   onJumpToSource   → transcript scroll helper keyed by messageId
//   onUnpin          → existing `toggleMessagePin(..., pinned: false)`
//
// Do not grow ThreadDetailViews or TWSharedViews in this candidate lane.

import Foundation
import SwiftUI

/// Compact Copy / Jump / Unpin strip keyed by `PinnedMessageActionItem.messageId`.
struct PinnedMessageActionsBar: View {
    let item: PinnedMessageActionItem
    var showsUnpin: Bool = true
    let onCopy: (String, String) -> Void
    let onJumpToSource: (String) -> Void
    var onUnpin: ((String) -> Void)? = nil

    var body: some View {
        HStack(spacing: 2) {
            if PinnedMessageActionsModel.canPerform(.copy, on: item) {
                actionButton(for: .copy) {
                    if let payload = PinnedMessageActionsModel.copyPayload(for: item) {
                        onCopy(item.messageId, payload)
                    }
                }
            }
            if PinnedMessageActionsModel.canPerform(.jumpToSource, on: item) {
                actionButton(for: .jumpToSource) {
                    onJumpToSource(item.messageId)
                }
            }
            if showsUnpin, let onUnpin,
                PinnedMessageActionsModel.canPerform(.unpin, on: item)
            {
                actionButton(for: .unpin) {
                    onUnpin(item.messageId)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Pinned message actions")
    }

    private func actionButton(
        for action: PinnedMessageAction,
        run: @escaping () -> Void
    ) -> some View {
        Button(action: run) {
            Image(systemName: PinnedMessageActionsModel.actionSystemImage(action))
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(TWTheme.textMuted)
                .frame(width: 28, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            PinnedMessageActionsModel.accessibilityLabel(for: action, item: item)
        )
        .accessibilityHint(PinnedMessageActionsModel.actionTitle(action))
    }
}

/// Drop-in pin-list row for NotesPanel: speaker, preview, and the action bar.
/// Presentation-only — the integrator supplies pasteboard / scroll / unpin.
struct PinnedMessagePinRow: View {
    let item: PinnedMessageActionItem
    let onCopy: (String, String) -> Void
    let onJumpToSource: (String) -> Void
    var onUnpin: ((String) -> Void)? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 7) {
            Image(systemName: "pin.fill")
                .font(.system(size: 9))
                .foregroundStyle(TWTheme.statusAttention)
                .padding(.top, 3)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                if let speaker = item.speaker {
                    Text(speaker)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(TWTheme.textTertiary)
                } else if let role = item.role {
                    Text(role)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(TWTheme.textTertiary)
                }
                Text(item.copyText)
                    .font(.caption)
                    .foregroundStyle(TWTheme.textPrimary)
                    .lineLimit(4)
                if item.previewTruncated {
                    Text("Preview truncated on device — jump to source for the full row when loaded.")
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textMuted)
                }
                PinnedMessageActionsBar(
                    item: item,
                    showsUnpin: onUnpin != nil,
                    onCopy: onCopy,
                    onJumpToSource: onJumpToSource,
                    onUnpin: onUnpin
                )
            }

            Spacer(minLength: 4)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(rowAccessibilityLabel)
    }

    private var rowAccessibilityLabel: String {
        var parts = ["Pinned message"]
        if let speaker = item.speaker {
            parts.append("from \(speaker)")
        } else if let role = item.role {
            parts.append(role)
        }
        return parts.joined(separator: " ")
    }
}
