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
                    id: "grok-4.5",
                    label: "Grok 4.5 Fast",
                    isDefault: true,
                    supportedReasoningEfforts: [
                        .init(reasoningEffort: "low"),
                        .init(reasoningEffort: "medium"),
                        .init(reasoningEffort: "high"),
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

#Preview("Chip · full label") {
    ProviderModelPickerPreviewHost(mode: .chip)
}

#Preview("Chip · compact (unfocused)") {
    ProviderModelPickerPreviewHost(mode: .compactChip)
}

#endif
