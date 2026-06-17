// SwiftUI surface for the TaskWraith companion.
//
// Design direction (see ios/DESIGN.md): borrow the *format* of the Claude /
// Codex iOS apps — workspaces-as-projects home, thread view with collapsed
// history + tool chips, pill composer — but skinned entirely in TaskWraith's
// own theme tokens (TWTheme mirrors the desktop theme.css). iPhone focuses on
// solid thread management; iPad gets the sidebar (NavigationSplitView) where
// advanced affordances will live. Pure SwiftUI so `swift build` compile-checks
// on macOS; QR camera scanning is the one `#if os(iOS)` extra.

import SwiftUI
import TaskWraithKit

#if canImport(UIKit)
    import PhotosUI
    import UIKit
#endif

struct Composer: View {
    @ObservedObject var model: RemoteSessionModel
    let card: RemoteTaskCard
    var runModel: String? = nil
    var runStatus: String? = nil
    /// Shell attachment: a diff header above / telemetry rail below flatten
    /// the touching corners so the three rows read as ONE container
    /// (desktop composer-shell parity).
    var attachedTop: Bool = false
    var attachedBottom: Bool = false
    /// false = sends must not move the shell's selection (side-chat mini
    /// pane: the side chat stays in the inspector column while the parent
    /// stays in the main pane, both active simultaneously).
    var navigateOnSend: Bool = true
    /// Secondary workspace granted to this send (rail picker selection).
    var extraWorkspaceIds: [String]? = nil
    /// When set, send starts a new Mac thread instead of continuing `card`.
    var newTaskWorkspaceId: String? = nil
    /// Mirrors the internal provider selection out to hosts that theme
    /// surrounding chrome by provider (the new-chat canvas hero/chips).
    var providerEcho: Binding<String>? = nil
    /// Existing chats normally keep their provider. Empty transcript welcome
    /// screens may still choose the first-turn provider before dispatch.
    var allowsProviderChange: Bool? = nil
    @Binding var text: String

    @State private var approvalMode = "default"
    /// Scope-global chat — every phone-origin turn is clamped to plan mode
    /// (no file mutation) by the Mac; the composer pins the picker to match.
    private var isGlobalChat: Bool {
        card.isGlobalScope && newTaskWorkspaceId == nil
    }
    @State private var selectedProvider: String = "claude"
    @State private var selectedModelId: String?
    @State private var selectedReasoningEffort: String?
    #if canImport(UIKit)
        @State private var pickedItems: [PhotosPickerItem] = []
        @State private var attachments: [(name: String, image: UIImage)] = []
    #endif

    /// Trailing "@token" under the cursor → mention suggestions.
    private var mentionQuery: String? {
        guard card.isEnsemble else { return nil }
        guard let at = text.lastIndex(of: "@") else { return nil }
        let tail = text[text.index(after: at)...]
        guard !tail.contains(" "), !tail.contains("\n") else { return nil }
        return String(tail)
    }

    private var mentionCandidates: [MentionCandidate] {
        guard let query = mentionQuery,
            let participants = model.ensembleStates[card.id]?.participants
        else { return [] }
        let all = twMentionCandidates(participants: participants)
        guard !query.isEmpty else { return all }
        return all.filter {
            $0.display.lowercased().hasPrefix(query.lowercased())
                || $0.insertText.lowercased().hasPrefix("@" + query.lowercased())
        }
    }

    private var accent: Color {
        card.isEnsemble ? TWTheme.chroma2 : TWTheme.providerAccent(selectedProvider)
    }

    /// The resolved composer shell for the active style (default unless the Mac
    /// projects, or the user overrides, another). Drives per-style body theming.
    private var shell: ResolvedComposerShell { twResolvedComposerShell(model: model) }
    private var providerName: String { TWTheme.providerLabel(selectedProvider) }
    private var canChangeProvider: Bool {
        allowsProviderChange ?? (newTaskWorkspaceId != nil)
    }
    private var cardSelectedModelId: String? {
        guard let selected = nonEmpty(card.selectedModelType), selected != "default" else {
            return nil
        }
        if selected == "custom" {
            return nonEmpty(card.customModel)
        }
        return selected
    }
    private var cardReasoningEffort: String? {
        let provider = (card.provider ?? selectedProvider).lowercased()
        if provider == "claude" {
            return nonEmpty(card.claudeReasoningEffort)
        }
        if provider == "codex" {
            return nonEmpty(card.codexReasoningEffort)
        }
        return nil
    }
    private var isEmpty: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    /// Run id of a live stream for this thread, if one is in flight. The
    /// Mac-pushed `card.runId` is snapshot-throttled and lags the un-throttled
    /// stream, so we fall back to this so Stop is targetable the moment tokens
    /// start arriving.
    private var liveStreamRunId: String? {
        guard let live = model.streamingTexts[card.id], !live.isEmpty else { return nil }
        return model.streamingRunIds[card.id]
    }
    /// The run id to cancel: the throttled card field if present, else the live
    /// stream's run id. Mirrors the gate in `RemoteSessionModel.cancelRun`.
    private var effectiveRunId: String? {
        card.runId ?? liveStreamRunId
    }
    private var isRunActive: Bool {
        let status = runStatus ?? card.status
        // A run parked on an approval/question is still live + cancellable —
        // `deriveTaskStatus` reports those states instead of "running". And a
        // live stream means a run is in flight even before the throttled card
        // projection flips to "running" (and during the ~900ms it lingers after
        // exit, where cancelling an already-finished run is a safe no-op).
        if status == "running" || status == "awaitingApproval" || status == "awaitingQuestion" {
            return true
        }
        return liveStreamRunId != nil
    }
    private var canCancelRun: Bool {
        isRunActive && effectiveRunId != nil && (card.capabilities?.cancel ?? true)
    }
    private var hasImageAttachments: Bool {
        #if canImport(UIKit)
            return !attachments.isEmpty
        #else
            return false
        #endif
    }
    private var canQueueCurrentPrompt: Bool {
        isRunActive && newTaskWorkspaceId == nil && !isEmpty && !hasImageAttachments
    }
    private var catalogs: [ProviderModelCatalog] {
        let live = model.providerModels.map {
            ProviderModelCatalog(provider: $0.key, models: $0.value)
        }
        let liveByProvider = live.reduce(
            into: [String: ProviderModelCatalog]()
        ) { partial, catalog in
            partial[catalog.provider.lowercased()] = catalog
        }
        let keys = Set(
            Self.fallbackProviderIds
                + live.map { $0.provider.lowercased() }
                + [card.provider, selectedProvider]
                    .compactMap { $0?.lowercased() }
                    .filter { !$0.isEmpty })
        return keys
            .map { liveByProvider[$0] ?? ProviderModelCatalog(provider: $0, models: []) }
            .sorted { TWTheme.providerLabel($0.provider) < TWTheme.providerLabel($1.provider) }
    }

    private static let fallbackProviderIds = [
        "codex", "claude", "gemini", "kimi", "grok", "cursor", "ollama",
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if shell.layout.controlsBelowTextarea {
                // CS10: text input first, control row BELOW it (codex/claude/…
                // desktop parity). No hairline — the controls float under the
                // input separated only by the rows' own padding, mirroring the
                // desktop inner-module `gap`.
                composerInputBody
                if !card.isEnsemble {
                    composerControlsRow
                }
            } else {
                // Signed-off native arrangement: controls ABOVE the input with a
                // hairline divider. Unchanged (default parity).
                if !card.isEnsemble {
                    composerControlsRow
                    Rectangle().fill(TWTheme.border).frame(height: 1)
                }
                composerInputBody
            }
        }
        // Re-bind the picker to the LOADED thread on first appear AND on every
        // thread switch. SwiftUI reuses this Composer instance across threads on
        // iPhone (the compact nav destination has no per-thread `.id`), so a
        // one-shot seed would leak thread A's model/reasoning into thread B.
        .onChange(of: card.id, initial: true) {
            resyncPickerToThread()
        }
        .onChange(of: selectedProvider) { _, newValue in
            providerEcho?.wrappedValue = newValue
        }
        .onChange(of: runModel) { _, newValue in
            // The on-demand snapshot usually lands AFTER the composer appears
            // (same thread, so the resync above does not re-fire). Backfill the
            // pill with the thread's actual run model when we don't yet have a
            // selection. User picks are never overwritten.
            if selectedModelId == nil, let newValue {
                selectedModelId = newValue
            }
        }
        .onChange(of: cardReasoningEffort) { _, newValue in
            // Same late-snapshot backfill for reasoning effort, which otherwise
            // has no recovery path once the per-thread resync has run.
            if selectedReasoningEffort == nil, let newValue {
                selectedReasoningEffort = newValue
            }
        }
    }

    @ViewBuilder
    private var composerBodyBackground: some View {
        // Per-style card-in-card fill (e.g. codex #252525). Default keeps the
        // native input-row fill (signed-off). Other shells with no inner module
        // let the shell surface show through (terminal green, satellite/modular
        // transparent, stub cream) rather than painting the theme input fill.
        if let fill = shell.palette.innerModuleFill {
            Rectangle().fill(fill)
        } else if shell.style == .defaultShell {
            Rectangle().fill(composerInputRowFill())
        } else {
            Color.clear
        }
    }

    private var composerControlsRow: some View {
        HStack(spacing: 8) {
            modelPickerControl
            composerControlSeparator
            approvalControl
            if !canChangeProvider, card.parentChatId == nil, newTaskWorkspaceId == nil {
                composerControlSeparator
                // Guest participant: + invites, chip shows/changes,
                // × removes (desktop guest-picker parity).
                GuestParticipantControl(model: model, card: card)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(Rectangle().fill(composerAttachedRowFill()))
    }

    @ViewBuilder
    private var modelPickerControl: some View {
        if !catalogs.isEmpty {
            ProviderModelPicker(
                catalogs: catalogs,
                provider: $selectedProvider,
                modelId: $selectedModelId,
                reasoningEffort: $selectedReasoningEffort,
                allowsProviderChange: canChangeProvider)
        } else {
            Text(providerName)
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(accent.opacity(0.16), in: Capsule())
                .overlay(Capsule().strokeBorder(accent.opacity(0.45)))
                .foregroundStyle(accent)
            if let runModel {
                Text(runModel)
                    .font(.caption2)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(TWTheme.surface3, in: Capsule())
                    .foregroundStyle(TWTheme.textSecondary)
                    .lineLimit(1)
            }
        }
    }

    @ViewBuilder
    private var approvalControl: some View {
        if isGlobalChat {
            // T72 — phone-origin turns in global chats ALWAYS run in
            // plan mode (the Mac forces it server-side; this chip just
            // tells the truth instead of offering a dead picker).
            HStack(spacing: 3) {
                Image(systemName: "list.bullet.clipboard")
                Text("Plan · no file changes")
            }
            .font(twComposerFont(shell.fontDesign, .caption2))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(TWTheme.surface3, in: twControlShape(shell.geometry.controlShape))
            .foregroundStyle(TWTheme.textSecondary)
        } else {
            Menu {
                Picker("Approval", selection: $approvalMode) {
                    Label("Default Approval", systemImage: "checkmark.shield").tag("default")
                    Label("Plan / Read-only", systemImage: "list.bullet.clipboard").tag("plan")
                }
            } label: {
                HStack(spacing: 3) {
                    Image(
                        systemName: approvalMode == "plan"
                            ? "list.bullet.clipboard" : "checkmark.shield")
                    Text(approvalMode == "plan" ? "Plan" : "Default")
                }
                .font(twComposerFont(shell.fontDesign, .caption2))
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(TWTheme.surface3, in: twControlShape(shell.geometry.controlShape))
                .foregroundStyle(TWTheme.textSecondary)
            }
        }
    }

    private var composerControlSeparator: some View {
        Rectangle()
            .fill(TWTheme.border.opacity(0.75))
            .frame(width: 1, height: 18)
    }

    private var composerInputBody: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !mentionCandidates.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(mentionCandidates) { candidate in
                            let chipAccent = TWTheme.providerAccent(candidate.provider)
                            Button {
                                insertMention(candidate)
                            } label: {
                                HStack(spacing: 4) {
                                    Circle().fill(chipAccent).frame(width: 5, height: 5)
                                    Text(candidate.display)
                                        .font(.caption2.weight(.semibold))
                                }
                                .padding(.horizontal, 8).padding(.vertical, 4)
                                .background(chipAccent.opacity(0.14), in: Capsule())
                                .overlay(Capsule().strokeBorder(chipAccent.opacity(0.4)))
                                .foregroundStyle(chipAccent)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            #if canImport(UIKit)
                if !attachments.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(Array(attachments.enumerated()), id: \.offset) {
                                index, attachment in
                                ZStack(alignment: .topTrailing) {
                                    Image(uiImage: attachment.image)
                                        .resizable()
                                        .scaledToFill()
                                        .frame(width: 52, height: 52)
                                        .clipShape(RoundedRectangle(cornerRadius: 8))
                                    Button {
                                        attachments.remove(at: index)
                                    } label: {
                                        Image(systemName: "xmark.circle.fill")
                                            .font(.caption)
                                            .foregroundStyle(.white, .black.opacity(0.6))
                                    }
                                    .offset(x: 5, y: -5)
                                }
                            }
                        }
                        .padding(.top, 4)
                    }
                }
            #endif
            // Input cluster: the composer body supplies the darker fill, so
            // this row stays flat like the desktop central panel.
            HStack(spacing: 8) {
                #if canImport(UIKit)
                    // Ensembles included: steer now carries attachments.
                    photosButton
                #endif
                if shell.effects.contains(.terminalCaret) {
                    Text(">")
                        .font(twComposerFont(.monospaced).weight(.bold))
                        .foregroundStyle(shell.sendButton.tint)
                }
                TextField(placeholder, text: $text, axis: .vertical)
                    .lineLimit(1...2)
                    .font(twComposerFont(shell.fontDesign))
                    .foregroundStyle(shell.palette.textPrimary)
                if canQueueCurrentPrompt {
                    queueButton
                }
                primaryActionButton
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(composerBodyBackground)
    }

    private var queueButton: some View {
        Button {
            queueCurrent()
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "tray.and.arrow.down")
                    .font(.system(size: 11, weight: .semibold))
                Text("Queue")
                    .font(.caption2.weight(.semibold))
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(TWTheme.statusAttention.opacity(0.14), in: Capsule())
            .overlay(Capsule().strokeBorder(TWTheme.statusAttention.opacity(0.35)))
            .foregroundStyle(TWTheme.statusAttention)
        }
        .buttonStyle(.plain)
    }

    private var primaryActionButton: some View {
        let shell = twResolvedComposerShell(model: model)
        return Button {
            if isRunActive {
                model.cancelRun(card)
            } else {
                sendCurrent()
            }
        } label: {
            if shell.style == .defaultShell {
                // Signed-off native button — unchanged (default parity).
                Image(systemName: isRunActive ? "stop.circle.fill" : "arrow.up.circle.fill")
                    .font(.system(size: 34, weight: .semibold))
                    .foregroundStyle(primaryActionColor)
                    .frame(width: 38, height: 38)
                    .contentShape(Circle())
            } else {
                ComposerRecipeSendLabel(
                    shell: shell, isRunActive: isRunActive,
                    enabled: isRunActive ? canCancelRun : !sendDisabled)
            }
        }
        .disabled(isRunActive ? !canCancelRun : sendDisabled)
        .accessibilityLabel(isRunActive ? "Stop run" : "Send message")
    }

    private var primaryActionColor: Color {
        if isRunActive {
            return canCancelRun ? TWTheme.statusFailed : TWTheme.textMuted
        }
        return sendDisabled ? TWTheme.textMuted : accent
    }

    private var sendDisabled: Bool {
        #if canImport(UIKit)
            let emptyContent = isEmpty && attachments.isEmpty
        #else
            let emptyContent = isEmpty
        #endif
        if let workspaceId = newTaskWorkspaceId, workspaceId.isEmpty {
            return true
        }
        return emptyContent
    }

    private func insertMention(_ candidate: MentionCandidate) {
        guard let at = text.lastIndex(of: "@") else { return }
        text = String(text[..<at]) + candidate.insertText + " "
    }

    /// True when `modelId` is a real model for `provider` in the live catalog.
    /// When the catalog hasn't arrived yet we can't disprove validity, so we
    /// treat it as valid rather than dropping a legitimate saved selection
    /// during the catalog-load window.
    private func isModelValidForProvider(_ modelId: String, provider: String) -> Bool {
        let key = provider.lowercased()
        guard let models = model.providerModels[key] ?? model.providerModels[provider],
            !models.isEmpty
        else { return true }
        return models.contains { $0.id == modelId }
    }

    /// The model the picker should show for the loaded thread, mirroring the
    /// desktop precedence (App.tsx `getChatComposerSelection`): the thread's
    /// saved pick only when it's a valid model for this provider (custom models
    /// are always honored), else the thread's actual last-run model, else nil
    /// (→ catalog default). A stale / cross-provider `selectedModelType` no
    /// longer masks the model the thread actually ran with.
    private func resolvedThreadModelId() -> String? {
        let provider = card.provider ?? selectedProvider
        if nonEmpty(card.selectedModelType) == "custom" {
            return nonEmpty(card.customModel) ?? runModel
        }
        if let saved = cardSelectedModelId, isModelValidForProvider(saved, provider: provider) {
            return saved
        }
        return runModel
    }

    /// Re-bind the picker state to the currently loaded thread. Idempotent and
    /// safe to run on first appear and on every thread change.
    private func resyncPickerToThread() {
        selectedProvider = card.provider ?? selectedProvider
        selectedModelId = resolvedThreadModelId()
        selectedReasoningEffort = cardReasoningEffort
        providerEcho?.wrappedValue = selectedProvider
    }

    private func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
            !trimmed.isEmpty
        else { return nil }
        return trimmed
    }

    #if canImport(UIKit)
        /// Photo attach — solo chats only: ensemble sends ride ensembleSteer,
        /// which carries text alone, so showing the picker there silently
        /// dropped images.
        private var photosButton: some View {
            let attachmentLimitReached = attachments.count >= 2
            let iconColor = attachmentLimitReached ? TWTheme.textMuted : TWTheme.textSecondary
            return PhotosPicker(
                selection: $pickedItems, maxSelectionCount: 2, matching: .images
            ) {
                Image(systemName: "photo.badge.plus")
                    .font(.body)
                    .foregroundStyle(iconColor)
            }
            .disabled(attachmentLimitReached)
            .onChange(of: pickedItems) { _, items in
                guard !items.isEmpty else { return }
                Task {
                    for item in items {
                        guard attachments.count < 2,
                            let data = try? await item.loadTransferable(type: Data.self),
                            let image = UIImage(data: data)
                        else { continue }
                        attachments.append((name: "photo.jpg", image: image))
                    }
                    pickedItems = []
                }
            }
        }
    #endif

    private func sendCurrent() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        #if canImport(UIKit)
            let encoded = attachments.compactMap {
                twEncodeImageAttachment($0.image, name: $0.name)
            }
            let hasAttachments = !encoded.isEmpty
        #else
            let hasAttachments = false
        #endif
        guard !trimmed.isEmpty || hasAttachments else { return }

        if let workspaceId = newTaskWorkspaceId, !workspaceId.isEmpty {
            #if canImport(UIKit)
                model.startTask(
                    workspaceId: workspaceId, provider: selectedProvider, prompt: trimmed,
                    model: selectedModelId,
                    reasoningEffort: selectedReasoningEffort,
                    imageAttachments: hasAttachments ? encoded : nil)
                attachments = []
            #else
                model.startTask(
                    workspaceId: workspaceId, provider: selectedProvider, prompt: trimmed,
                    model: selectedModelId,
                    reasoningEffort: selectedReasoningEffort)
            #endif
            text = ""
            return
        }

        #if canImport(UIKit)
            model.continueTask(
                card, prompt: text,
                approvalMode: isGlobalChat ? "plan" : (approvalMode == "default" ? nil : approvalMode),
                model: selectedModelId,
                providerOverride: canChangeProvider ? selectedProvider : nil,
                reasoningEffort: selectedReasoningEffort,
                imageAttachments: encoded.isEmpty ? nil : encoded,
                extraWorkspaceIds: extraWorkspaceIds,
                navigateOnAck: navigateOnSend)
            attachments = []
        #else
            model.continueTask(
                card, prompt: text,
                approvalMode: isGlobalChat ? "plan" : (approvalMode == "default" ? nil : approvalMode),
                model: selectedModelId,
                providerOverride: canChangeProvider ? selectedProvider : nil,
                reasoningEffort: selectedReasoningEffort,
                navigateOnAck: navigateOnSend)
        #endif
        text = ""
    }

    private func queueCurrent() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !hasImageAttachments else { return }
        if card.isEnsemble {
            model.queueEnsemblePrompt(card, prompt: trimmed)
        } else {
            model.queueComposerPrompt(
                card, prompt: trimmed,
                approvalMode: isGlobalChat ? "plan" : (approvalMode == "default" ? nil : approvalMode),
                model: selectedModelId,
                providerOverride: canChangeProvider ? selectedProvider : nil,
                reasoningEffort: selectedReasoningEffort,
                extraWorkspaceIds: extraWorkspaceIds)
        }
        text = ""
    }

    private var placeholder: String {
        if card.isEnsemble {
            return "Ask the ensemble. @ to direct a participant…"
        }
        return "Ask \(providerName) anything…"
    }
}
