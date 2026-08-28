// Sub-thread spawn sheet — phone proposes, Mac decides.
//
// The Create-PR pattern (GitWorkflowViews) is the bar: never offer a control
// that looks ready and then calls a `notWired` executor. `canCreate` is false
// until the Mac projects `capabilities.createSubThread == true`.

import SwiftUI
import TaskWraithKit

/// Host-authoritative readiness for phone-initiated sub-thread spawn.
/// Fail-closed: missing/false host wiring disables the confirm control and
/// names the reason, matching `GitPrReadinessResult.canCreatePullRequest`.
public struct SubThreadSpawnReadiness: Equatable, Sendable {
    public let canCreate: Bool
    public let reason: String?

    public struct Input: Equatable, Sendable {
        public var isDemo: Bool
        public var hostCreateSubThreadWired: Bool
        public var parentIsSubThread: Bool
        public var workspaceId: String?
        public var parentThreadId: String?
        public var proposedProvider: String
        public var prompt: String

        public init(
            isDemo: Bool,
            hostCreateSubThreadWired: Bool,
            parentIsSubThread: Bool,
            workspaceId: String?,
            parentThreadId: String?,
            proposedProvider: String,
            prompt: String
        ) {
            self.isDemo = isDemo
            self.hostCreateSubThreadWired = hostCreateSubThreadWired
            self.parentIsSubThread = parentIsSubThread
            self.workspaceId = workspaceId
            self.parentThreadId = parentThreadId
            self.proposedProvider = proposedProvider
            self.prompt = prompt
        }
    }

    public static let notWiredReason = "The Mac hasn't enabled sub-thread spawn yet."
    public static let demoReason = "Pair with a Mac to spawn a sub-thread."
    public static let nestedParentReason = "A sub-thread can't spawn another sub-thread."
    public static let missingThreadReason = "This chat isn't a thread the Mac can spawn from."
    public static let missingWorkspaceReason = "This chat has no workspace to spawn into."
    public static let missingProviderReason = "Pick a provider to propose. The Mac still decides."
    public static let missingPromptReason = "Write a prompt for the sub-thread."
    public static let promptTooLongReason = "That prompt is too long for the Mac to accept."

    public static func evaluate(_ input: Input) -> SubThreadSpawnReadiness {
        if input.parentIsSubThread {
            return SubThreadSpawnReadiness(canCreate: false, reason: nestedParentReason)
        }
        let threadId = trimmed(input.parentThreadId)
        if threadId.isEmpty {
            return SubThreadSpawnReadiness(canCreate: false, reason: missingThreadReason)
        }
        let workspaceId = trimmed(input.workspaceId)
        if workspaceId.isEmpty || workspaceId == "global" {
            return SubThreadSpawnReadiness(canCreate: false, reason: missingWorkspaceReason)
        }
        if input.isDemo {
            return SubThreadSpawnReadiness(canCreate: false, reason: demoReason)
        }
        if !input.hostCreateSubThreadWired {
            return SubThreadSpawnReadiness(canCreate: false, reason: notWiredReason)
        }
        let provider = trimmed(input.proposedProvider).lowercased()
        if provider.isEmpty || !isAdmittedProposal(provider) {
            return SubThreadSpawnReadiness(canCreate: false, reason: missingProviderReason)
        }
        let prompt = trimmed(input.prompt)
        if prompt.isEmpty {
            return SubThreadSpawnReadiness(canCreate: false, reason: missingPromptReason)
        }
        if prompt.utf16.count > BridgeAction.createSubThreadPromptMaxChars {
            return SubThreadSpawnReadiness(canCreate: false, reason: promptTooLongReason)
        }
        return SubThreadSpawnReadiness(canCreate: true, reason: nil)
    }

    /// Seat-provider gate matching host `isEnsembleSeatProvider`: static live
    /// set plus catalog-backed AntiGravity. The Mac still revalidates.
    public static func isAdmittedProposal(_ provider: String) -> Bool {
        let id = trimmed(provider).lowercased()
        return TWTheme.isLiveSelectableProvider(id) || id == "antigravity"
    }

    fileprivate static func trimmed(_ value: String?) -> String {
        (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// Builds a createSubThread wire payload only when readiness says the host
/// will actually execute it. Nil means the caller must not send.
public enum SubThreadSpawnProposal {
    public static func bridgeParams(
        _ input: SubThreadSpawnReadiness.Input,
        returnResult: Bool = true,
        actionId: String = UUID().uuidString
    ) -> [String: Any]? {
        let readiness = SubThreadSpawnReadiness.evaluate(input)
        guard readiness.canCreate else { return nil }
        let workspaceId = SubThreadSpawnReadiness.trimmed(input.workspaceId)
        let threadId = SubThreadSpawnReadiness.trimmed(input.parentThreadId)
        let provider = SubThreadSpawnReadiness.trimmed(input.proposedProvider).lowercased()
        let prompt = SubThreadSpawnReadiness.trimmed(input.prompt)
        return BridgeAction.createSubThread(
            workspaceId: workspaceId,
            parentThreadId: threadId,
            provider: provider,
            prompt: prompt,
            returnResult: returnResult,
            actionId: actionId
        )
    }
}

/// Phone-owned spawn surface for one durable sub-thread. The host remains the
/// authority for provider admission, relationship depth, workspace scope, and
/// the subsequent start-turn posture. Confirm stays disabled until readiness
/// says the host executor is wired.
struct SubThreadSpawnSheet: View {
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

    private var input: SubThreadSpawnReadiness.Input {
        SubThreadSpawnReadiness.Input(
            isDemo: model.isDemo,
            hostCreateSubThreadWired: model.isCreateSubThreadHostWired(for: card),
            parentIsSubThread: card.isSubThread,
            workspaceId: card.workspaceId,
            parentThreadId: card.threadId,
            proposedProvider: provider,
            prompt: prompt
        )
    }

    private var readiness: SubThreadSpawnReadiness {
        SubThreadSpawnReadiness.evaluate(input)
    }

    private var canSubmit: Bool {
        !isSubmitting && readiness.canCreate
    }

    private var promptLength: Int {
        SubThreadSpawnReadiness.trimmed(prompt).utf16.count
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
                    .accessibilityHint(
                        "A proposal only. The Mac validates the provider before creating the sub-thread.")
                }
                .twGlassSheetRowBackground()

                Section {
                    TextEditor(text: $prompt)
                        .frame(minHeight: 150)
                        .accessibilityLabel("Sub-thread brief")
                } header: {
                    Text("Brief")
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("The new agent starts with this brief and no parent transcript context.")
                        Text(
                            "\(promptLength.formatted()) / \(BridgeAction.createSubThreadPromptMaxChars.formatted()) UTF-16 units"
                        )
                        .foregroundStyle(
                            promptLength > BridgeAction.createSubThreadPromptMaxChars
                                ? TWTheme.statusFailed : TWTheme.textTertiary)
                    }
                }
                .twGlassSheetRowBackground()

                Section {
                    Toggle("Return the result here", isOn: $returnResult)
                } footer: {
                    Text(
                        returnResult
                            ? "The terminal result returns to this parent as untrusted sub-thread output."
                            : "The child stays available as a separate task."
                    )
                }
                .twGlassSheetRowBackground()

                if let reason = readiness.reason {
                    Section {
                        Text(reason)
                            .foregroundStyle(TWTheme.textSecondary)
                    }
                    .twGlassSheetRowBackground()
                }

                if let errorText {
                    Section {
                        Text(errorText)
                            .foregroundStyle(TWTheme.statusFailed)
                    }
                    .twGlassSheetRowBackground()
                }
            }
            .twGlassSheetListCanvas()
            .background(Color.clear)
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
