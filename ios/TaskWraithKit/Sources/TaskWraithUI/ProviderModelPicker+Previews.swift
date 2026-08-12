// ProviderModelPicker+Previews.swift — Xcode Canvas hosts for the unified
// provider / model / reasoning glass popover (ProviderModelPicker in
// TWSharedViews.swift). Open this file (or TWSharedViews.swift) in Xcode,
// enable Canvas (Editor → Canvas / ⌥⌘↩), and pick a device in the preview
// toolbar. Prefer the "Open panel · …" previews when tuning the squished
// phone layout vs the roomier iPad presentation.

import SwiftUI
import TaskWraithKit

#if DEBUG

// MARK: - Fixture catalog (mirrors the Claude+Codex slice from device screenshots)

enum ProviderModelPickerPreviewData {
    static let claudeEfforts: [ReasoningEffortOption] = [
        .init(reasoningEffort: "low"),
        .init(reasoningEffort: "medium"),
        .init(reasoningEffort: "high"),
        .init(reasoningEffort: "xhigh"),
        .init(reasoningEffort: "max"),
    ]

    static let codexEfforts: [ReasoningEffortOption] = [
        .init(reasoningEffort: "low"),
        .init(reasoningEffort: "medium"),
        .init(reasoningEffort: "high"),
        .init(reasoningEffort: "xhigh"),
        .init(reasoningEffort: "max"),
        .init(reasoningEffort: "ultracode"),
    ]

    static let catalogs: [ProviderModelCatalog] = [
        ProviderModelCatalog(
            provider: "claude",
            models: [
                // Labels omit the "Claude " prefix; Legacy cluster below the
                // current models (mirrors CLAUDE_STATIC_MODELS).
                .init(
                    id: "claude-opus-5",
                    label: "Opus 5",
                    supportedReasoningEfforts: claudeEfforts,
                    defaultReasoningEffort: "medium"),
                .init(
                    id: "claude-fable-5",
                    label: "Fable 5",
                    supportedReasoningEfforts: claudeEfforts,
                    defaultReasoningEffort: "high"),
                .init(
                    id: "claude-sonnet-5",
                    label: "Sonnet 5",
                    supportedReasoningEfforts: [
                        .init(reasoningEffort: "low"),
                        .init(reasoningEffort: "medium"),
                        .init(reasoningEffort: "high"),
                        .init(reasoningEffort: "xhigh"),
                    ],
                    defaultReasoningEffort: "medium"),
                .init(
                    id: "claude-sonnet-4-6",
                    label: "Sonnet 4.6 Legacy",
                    supportedReasoningEfforts: [
                        .init(reasoningEffort: "low"),
                        .init(reasoningEffort: "medium"),
                        .init(reasoningEffort: "high"),
                        .init(reasoningEffort: "xhigh"),
                    ],
                    defaultReasoningEffort: "medium"),
                .init(
                    id: "claude-opus-4-8-1m",
                    label: "Opus 4.8 1M Legacy",
                    isDefault: true,
                    supportedReasoningEfforts: claudeEfforts,
                    defaultReasoningEffort: "high"),
                .init(
                    id: "claude-opus-4-7-1m",
                    label: "Opus 4.7 1M Legacy",
                    supportedReasoningEfforts: claudeEfforts,
                    defaultReasoningEffort: "high"),
                .init(
                    id: "claude-haiku-4-5",
                    label: "Haiku 4.5",
                    supportedReasoningEfforts: [
                        .init(reasoningEffort: "low"),
                        .init(reasoningEffort: "medium"),
                        .init(reasoningEffort: "high"),
                    ],
                    defaultReasoningEffort: "medium"),
                .init(id: "custom", label: "Custom model ID"),
            ]),
        ProviderModelCatalog(
            provider: "codex",
            models: [
                .init(
                    id: "gpt-5.6-terra",
                    label: "GPT 5.6 Terra",
                    isDefault: true,
                    supportedReasoningEfforts: codexEfforts,
                    defaultReasoningEffort: "high"),
                .init(
                    id: "gpt-5.5",
                    label: "GPT 5.5",
                    supportedReasoningEfforts: codexEfforts,
                    defaultReasoningEffort: "medium"),
            ]),
        ProviderModelCatalog(
            provider: "grok",
            models: [
                .init(
                    id: "grok-4.6",
                    label: "Grok 4.6 Fast",
                    isDefault: true,
                    supportedReasoningEfforts: [
                        .init(reasoningEffort: "low"),
                        .init(reasoningEffort: "medium"),
                        .init(reasoningEffort: "high"),
                        .init(reasoningEffort: "xhigh"),
                    ],
                    defaultReasoningEffort: "high"),
            ]),
    ]
}

// MARK: - Interactive hosts

/// Chip + optional open panel on a dark composer-like backdrop.
private struct ProviderModelPickerPreviewHost: View {
    enum Mode {
        case chip
        case compactChip
        case openPanel
    }

    let mode: Mode
    var maxContentWidth: CGFloat? = nil

    @State private var provider = "claude"
    @State private var modelId: String? = "claude-opus-4-8-1m"
    @State private var reasoningEffort: String? = "high"
    @State private var fastModeEnabled = false
    @State private var kimiThinkingEnabled = true

    var body: some View {
        ZStack {
            // Approximate thread/composer backdrop so glass reads like device.
            LinearGradient(
                colors: [
                    Color(red: 0.07, green: 0.08, blue: 0.10),
                    Color(red: 0.04, green: 0.04, blue: 0.05),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()

            VStack(spacing: 16) {
                Spacer(minLength: 24)
                content
                Spacer()
                // Fake composer chrome for scale reference while editing.
                HStack(spacing: 8) {
                    ProviderModelPicker(
                        catalogs: ProviderModelPickerPreviewData.catalogs,
                        provider: $provider,
                        modelId: $modelId,
                        reasoningEffort: $reasoningEffort,
                        fastModeEnabled: $fastModeEnabled,
                        kimiThinkingEnabled: $kimiThinkingEnabled,
                        compact: mode == .compactChip
                    )
                    Spacer(minLength: 0)
                    Text("Default")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(TWTheme.textSecondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Capsule().strokeBorder(TWTheme.border, lineWidth: 0.5))
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(Color.white.opacity(0.06))
                        .overlay(
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .strokeBorder(TWTheme.border, lineWidth: 0.5)
                        )
                )
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
        }
        .preferredColorScheme(.dark)
    }

    @ViewBuilder
    private var content: some View {
        let picker = ProviderModelPicker(
            catalogs: ProviderModelPickerPreviewData.catalogs,
            provider: $provider,
            modelId: $modelId,
            reasoningEffort: $reasoningEffort,
            fastModeEnabled: $fastModeEnabled,
            kimiThinkingEnabled: $kimiThinkingEnabled
        )
        switch mode {
        case .chip, .compactChip:
            picker
                .padding()
        case .openPanel:
            Group {
                if let maxContentWidth {
                    picker.twCanvasOpenPanel
                        .frame(maxWidth: maxContentWidth)
                } else {
                    picker.twCanvasOpenPanel
                }
            }
            .padding(.horizontal, 12)
        }
    }
}

// MARK: - Participant editor in a keyboard-raised gap

/// The ensemble participant editor as a phone with the keyboard up actually
/// presents it.
///
/// On a compact width that popover is pinned ABOVE its anchor (`arrowEdge:
/// .bottom`), and the anchor is a roster chip riding the top of a composer that
/// the keyboard has already pushed up the screen — so the panel's entire world
/// is the gap between that chip and the safe-area top. A popover neither
/// scrolls nor shrinks to fit: hand it something taller and the system centres
/// it in the bounds it can give and CLIPS both ends, which the fixed-height
/// `.clipped()` window below reproduces exactly.
///
/// Numbers are a 402x874 phone (59pt top inset, 336pt keyboard) with a focused
/// composer roughly 250pt tall, fed through the same `twPopoverAnchoredHeight`
/// the app uses. Toggle `usesMeasuredBudget` to see the failure and the fix:
/// unmeasured, the panel sizes against the whole safe area and loses its
/// Enabled/authority rows off the top and its sidecar controls off the bottom.
private struct RosterEditorGapPreviewHost: View {
    /// false = the pre-fix behaviour (no host measurement, safe-area estimate).
    let usesMeasuredBudget: Bool

    private static let windowHeight: CGFloat = 874
    private static let safeTopY: CGFloat = 59
    private static let keyboardHeight: CGFloat = 336
    private static let composerHeight: CGFloat = 250
    private static let anchorHeight: CGFloat = 34
    private static var anchorMinY: CGFloat { windowHeight - keyboardHeight - composerHeight }
    /// What the balloon can occupy on screen, before its own chrome allowance.
    private static var gapHeight: CGFloat { anchorMinY - safeTopY }

    private static var budget: CGFloat {
        twPopoverAnchoredHeight(
            anchorMinY: anchorMinY,
            anchorMaxY: anchorMinY + anchorHeight,
            arrowEdge: .bottom,
            safeTopY: safeTopY,
            safeBottomY: windowHeight - keyboardHeight,
            sideAnchoredHeight: 389,
            chromeAllowance: 56)
    }

    @State private var entry = RemoteSessionModel.RosterDraftEntry(
        id: "preview-seat",
        provider: "claude",
        model: "claude-opus-5",
        role: "Reviewer",
        brief: "",
        enabled: true,
        reasoningEffort: "high",
        stageRole: "reviewer")

    var body: some View {
        VStack(spacing: 0) {
            Color.clear.frame(height: Self.safeTopY)
            ZStack {
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(TWTheme.statusFailed.opacity(0.5), style: .init(dash: [4, 3]))
                RosterParticipantEditorPopover(
                    entry: entry,
                    catalogs: ProviderModelPickerPreviewData.catalogs,
                    canRemove: true,
                    onApply: { entry = $0 },
                    onRemove: {},
                    spaceBudget: usesMeasuredBudget ? Self.budget : nil
                )
            }
            // The balloon's world: everything drawn outside is what the system
            // silently cuts off, with no scroll affordance to say so.
            .frame(height: Self.gapHeight)
            .clipped()
            Text(
                usesMeasuredBudget
                    ? "measured budget \(Int(Self.budget))pt in a \(Int(Self.gapHeight))pt gap"
                    : "no budget — panel sizes against the safe area"
            )
            .font(.caption2)
            .foregroundStyle(TWTheme.textSecondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
            // Fake composer + keyboard so the gap reads at true scale.
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color.white.opacity(0.06))
                .frame(height: Self.composerHeight)
                .overlay(alignment: .top) {
                    Text("composer (roster chip anchors here)")
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textMuted)
                        .padding(.top, 8)
                }
                .padding(.horizontal, 10)
            Rectangle()
                .fill(Color.white.opacity(0.10))
                .frame(height: Self.keyboardHeight)
                .overlay(
                    Text("keyboard")
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textMuted))
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .background(Color(red: 0.05, green: 0.05, blue: 0.06).ignoresSafeArea())
        .preferredColorScheme(.dark)
    }
}

// MARK: - Previews
// Use the Canvas device menu (iPhone SE / 16 / iPad) to compare squish vs roomy.
// "Open panel · narrow 360" forces a phone-ish content width without changing the
// Canvas device, which is useful when the scheme is on iPad.

#Preview("Open panel · auto") {
    ProviderModelPickerPreviewHost(mode: .openPanel)
}

#Preview("Open panel · narrow 360 (phone-ish)") {
    ProviderModelPickerPreviewHost(mode: .openPanel, maxContentWidth: 360)
}

#Preview("Open panel · roomy 520 (pad-ish)") {
    ProviderModelPickerPreviewHost(mode: .openPanel, maxContentWidth: 520)
}

#Preview("Participant editor · keyboard up (clipped)") {
    RosterEditorGapPreviewHost(usesMeasuredBudget: false)
}

#Preview("Participant editor · keyboard up (budgeted)") {
    RosterEditorGapPreviewHost(usesMeasuredBudget: true)
}

#Preview("Chip · full label") {
    ProviderModelPickerPreviewHost(mode: .chip)
}

#Preview("Chip · compact (unfocused)") {
    ProviderModelPickerPreviewHost(mode: .compactChip)
}

#endif
