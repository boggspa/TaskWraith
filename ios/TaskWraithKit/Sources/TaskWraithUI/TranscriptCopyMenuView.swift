// Extracted Copy transcript menu — iOS mirror of desktop `CopyTranscriptButton`.
//
// ThreadDetail supplies callbacks:
//   onCopyMessages        → Mac `chatMessageTranscript` / raw prose export
//   onCopyHandoffMarkdown → Mac `chatMarkdownTranscript` / scrubbed handoff
//
// This view never serializes rows or invents pasteboard content.

import SwiftUI

/// Presentation state for the two-format copy menu (idle / open / busy / result).
public struct TranscriptCopyMenuState: Equatable, Sendable {
    public var isOpen: Bool
    public var isBusy: Bool
    public var copiedFormat: TranscriptCopyFormat?
    public var lastSuccess: TranscriptCopySuccessSummary?
    public var lastError: String?

    public init(
        isOpen: Bool = false,
        isBusy: Bool = false,
        copiedFormat: TranscriptCopyFormat? = nil,
        lastSuccess: TranscriptCopySuccessSummary? = nil,
        lastError: String? = nil
    ) {
        self.isOpen = isOpen
        self.isBusy = isBusy
        self.copiedFormat = copiedFormat
        self.lastSuccess = lastSuccess
        self.lastError = lastError
    }
}

/// Two-format copy menu. Host owns clipboard + Mac bridge; this view only
/// presents labels and routes the chosen format through callbacks.
public struct TranscriptCopyMenuView: View {
    public var disabled: Bool
    @Binding public var state: TranscriptCopyMenuState
    /// Raw Messages — conversation prose only.
    public var onCopyMessages: () -> Void
    /// Safe handoff Markdown.
    public var onCopyHandoffMarkdown: () -> Void

    public init(
        disabled: Bool = false,
        state: Binding<TranscriptCopyMenuState>,
        onCopyMessages: @escaping () -> Void,
        onCopyHandoffMarkdown: @escaping () -> Void
    ) {
        self.disabled = disabled
        self._state = state
        self.onCopyMessages = onCopyMessages
        self.onCopyHandoffMarkdown = onCopyHandoffMarkdown
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            Text(TranscriptCopyMenuCopy.dialogDescription)
                .font(.caption)
                .foregroundStyle(TWTheme.textTertiary)
                .fixedSize(horizontal: false, vertical: true)

            actionColumn

            Text(TranscriptCopyMenuModel.omissionExplanation(for: .messages))
                .font(.caption2)
                .foregroundStyle(TWTheme.textMuted)
                .fixedSize(horizontal: false, vertical: true)

            Text(TranscriptCopyMenuModel.omissionExplanation(for: .handoff))
                .font(.caption2)
                .foregroundStyle(TWTheme.textMuted)
                .fixedSize(horizontal: false, vertical: true)

            if let success = state.lastSuccess {
                Text(TranscriptCopyMenuModel.successStatus(for: success))
                    .font(.caption)
                    .foregroundStyle(TWTheme.textSecondary)
                    .accessibilityAddTraits(.updatesFrequently)
            }
            if let error = state.lastError, !error.isEmpty {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(TWTheme.statusFailed)
                    .accessibilityAddTraits(.isStaticText)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TWTheme.surface1.opacity(0.92), in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(TWTheme.border.opacity(0.8), lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(TranscriptCopyMenuCopy.dialogAccessibilityLabel)
    }

    private var header: some View {
        HStack {
            Text(TranscriptCopyMenuCopy.dialogTitle)
                .font(.caption.weight(.semibold))
                .foregroundStyle(TWTheme.textPrimary)
            Spacer(minLength: 0)
            Button {
                state.isOpen = false
                state.lastError = nil
                state.lastSuccess = nil
            } label: {
                Text(TranscriptCopyMenuCopy.closeLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textMuted)
            }
            .buttonStyle(.plain)
            .disabled(state.isBusy)
            .accessibilityLabel(TranscriptCopyMenuCopy.closeAccessibilityLabel)
        }
        .accessibilityAddTraits(.isHeader)
    }

    private var actionColumn: some View {
        VStack(spacing: 8) {
            formatButton(for: .messages, primary: false) {
                guard !disabled, !state.isBusy else { return }
                clearFeedback()
                state.isBusy = true
                onCopyMessages()
            }
            formatButton(for: .handoff, primary: true) {
                guard !disabled, !state.isBusy else { return }
                clearFeedback()
                state.isBusy = true
                onCopyHandoffMarkdown()
            }
        }
    }

    private func formatButton(
        for format: TranscriptCopyFormat,
        primary: Bool,
        run: @escaping () -> Void
    ) -> some View {
        Button(action: run) {
            Text(TranscriptCopyMenuModel.actionLabel(for: format, busy: state.isBusy))
                .font(.subheadline.weight(primary ? .semibold : .medium))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .foregroundStyle(primary ? TWTheme.textPrimary : TWTheme.textSecondary)
                .background(
                    (primary ? TWTheme.chroma1.opacity(0.22) : TWTheme.surface2.opacity(0.85)),
                    in: RoundedRectangle(cornerRadius: 10)
                )
        }
        .buttonStyle(.plain)
        .disabled(disabled || state.isBusy)
        .accessibilityLabel(TranscriptCopyMenuModel.actionLabel(for: format, busy: false))
        .accessibilityHint(TranscriptCopyMenuModel.omissionExplanation(for: format))
    }

    private func clearFeedback() {
        state.lastError = nil
        state.lastSuccess = nil
    }
}

/// Compact toolbar trigger matching desktop aria labels. Opens the menu via
/// binding; does not perform a copy itself.
public struct TranscriptCopyMenuTrigger: View {
    public var disabled: Bool
    @Binding public var state: TranscriptCopyMenuState

    public init(disabled: Bool = false, state: Binding<TranscriptCopyMenuState>) {
        self.disabled = disabled
        self._state = state
    }

    public var body: some View {
        Button {
            guard !disabled else { return }
            if state.isOpen {
                state.isOpen = false
            } else {
                state.lastError = nil
                state.lastSuccess = nil
                state.isOpen = true
            }
        } label: {
            Image(systemName: "square.and.arrow.up.on.square")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(TWTheme.textMuted)
                .frame(width: 28, height: 28)
                .overlay(alignment: .topTrailing) {
                    if state.copiedFormat != nil {
                        Text("✓")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(TWTheme.statusSuccess)
                            .accessibilityHidden(true)
                    }
                }
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityLabel(
            TranscriptCopyMenuModel.triggerAccessibilityLabel(copiedFormat: state.copiedFormat)
        )
        .accessibilityHint(TranscriptCopyMenuCopy.dialogDescription)
        .accessibilityAddTraits(.isButton)
    }
}

#if DEBUG
    private struct TranscriptCopyMenuPreviewHost: View {
        @State private var state = TranscriptCopyMenuState(isOpen: true)

        var body: some View {
            TranscriptCopyMenuView(
                state: $state,
                onCopyMessages: {
                    state.isBusy = false
                    state.copiedFormat = .messages
                    state.lastSuccess = TranscriptCopySuccessSummary(
                        messageCount: 2,
                        charCount: 40
                    )
                },
                onCopyHandoffMarkdown: {
                    state.isBusy = false
                    state.copiedFormat = .handoff
                    state.lastSuccess = TranscriptCopySuccessSummary(
                        messageCount: 3,
                        charCount: 120,
                        omissions: ["absolute paths scrubbed"]
                    )
                }
            )
            .padding()
            .background(TWTheme.appBg)
        }
    }

    #Preview("Transcript copy menu") {
        TranscriptCopyMenuPreviewHost()
    }
#endif
