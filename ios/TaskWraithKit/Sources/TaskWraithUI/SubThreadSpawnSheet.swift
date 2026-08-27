import SwiftUI
import TaskWraithKit

/// Phone-owned spawn surface for one durable sub-thread. The host remains the
/// authority for provider admission, relationship depth, workspace scope, and
/// the subsequent start-turn posture.
struct SubThreadSpawnSheet: View {
    private static let promptLimit = 20_000

    @ObservedObject var model: RemoteSessionModel
    let card: RemoteTaskCard

    @Environment(\.dismiss) private var dismiss
    @State private var provider: String
    @State private var modelId: String?
    @State private var reasoningEffort: String?
    @State private var fastModeEnabled: Bool
    @State private var kimiThinkingEnabled: Bool
    @State private var prompt = ""
    @State private var returnResult = true
    @State private var isSubmitting = false
    @State private var errorText: String?

    init(model: RemoteSessionModel, card: RemoteTaskCard) {
        self.model = model
        self.card = card
        let initialProvider = card.provider?.lowercased() ?? "claude"
        _provider = State(initialValue: initialProvider)
        _modelId = State(initialValue: Self.initialModel(for: card))
        _reasoningEffort = State(
            initialValue: Self.initialReasoning(for: initialProvider, card: card))
        _fastModeEnabled = State(initialValue: Self.initialFastMode(for: initialProvider, card: card))
        _kimiThinkingEnabled = State(initialValue: card.kimiThinkingEnabled ?? true)
    }

    private var catalogs: [ProviderModelCatalog] {
        twOfferedProviderCatalogs(model.providerModels, including: [provider])
    }

    private var canSubmit: Bool {
        !isSubmitting && !provider.isEmpty
            && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && prompt.count <= Self.promptLimit
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Agent") {
                    ProviderModelPicker(
                        catalogs: catalogs,
                        provider: $provider,
                        modelId: $modelId,
                        reasoningEffort: $reasoningEffort,
                        fastModeEnabled: $fastModeEnabled,
                        kimiThinkingEnabled: $kimiThinkingEnabled
                    )
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                Section {
                    TextEditor(text: $prompt)
                        .frame(minHeight: 150)
                        .accessibilityLabel("Sub-thread brief")
                } header: {
                    Text("Brief")
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("The new agent starts with this brief and no parent transcript context.")
                        Text("\(prompt.count.formatted()) / \(Self.promptLimit.formatted()) characters")
                            .foregroundStyle(
                                prompt.count > Self.promptLimit
                                    ? TWTheme.statusFailed : TWTheme.textTertiary)
                    }
                }

                Section {
                    Toggle("Return the result here", isOn: $returnResult)
                } footer: {
                    Text(
                        returnResult
                            ? "The terminal result returns to this parent as untrusted sub-thread output."
                            : "The child stays available as a separate task."
                    )
                }

                if let errorText {
                    Section {
                        Text(errorText)
                            .foregroundStyle(TWTheme.statusFailed)
                    }
                }
            }
            .navigationTitle("Spawn sub-thread")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSubmitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSubmitting ? "Starting…" : "Spawn") { submit() }
                        .disabled(!canSubmit)
                }
            }
        }
        .onAppear {
            guard !catalogs.contains(where: { $0.provider == provider }) else { return }
            provider = catalogs.first?.provider ?? "claude"
            modelId = nil
            reasoningEffort = nil
            fastModeEnabled = false
        }
    }

    private func submit() {
        guard canSubmit else { return }
        isSubmitting = true
        errorText = nil
        model.createSubThread(
            card,
            provider: provider,
            prompt: prompt,
            returnResult: returnResult,
            model: modelId,
            reasoningEffort: reasoningEffort,
            fastModeEnabled: fastModeEnabled,
            kimiThinkingEnabled: kimiThinkingEnabled
        ) { childThreadId, _ in
            isSubmitting = false
            if childThreadId != nil {
                dismiss()
            } else {
                errorText = model.lastActionMessage ?? "The sub-thread was not created."
            }
        }
    }

    private static func initialModel(for card: RemoteTaskCard) -> String? {
        if card.selectedModelType == "custom" { return card.customModel }
        guard let selected = card.selectedModelType,
            selected != "default", selected != "cli-default"
        else { return nil }
        return selected
    }

    private static func initialReasoning(for provider: String, card: RemoteTaskCard) -> String? {
        switch provider {
        case "codex": return card.codexReasoningEffort
        case "claude": return card.claudeReasoningEffort
        case "kimi": return card.kimiReasoningEffort
        default: return nil
        }
    }

    private static func initialFastMode(for provider: String, card: RemoteTaskCard) -> Bool {
        switch provider {
        case "codex": return card.codexServiceTier == "fast"
        case "claude": return card.claudeFastMode == true
        case "cursor": return card.cursorFastMode == true
        case "kimi": return card.kimiFastMode == true
        default: return false
        }
    }
}
