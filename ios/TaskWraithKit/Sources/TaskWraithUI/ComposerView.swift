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
        (card.workspaceId ?? "").isEmpty && newTaskWorkspaceId == nil
    }
    @State private var selectedProvider: String = "claude"
    @State private var selectedModelId: String?
    @State private var selectedReasoningEffort: String?
    @State private var didSeedProviderSelection = false
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
    private var providerName: String { TWTheme.providerLabel(selectedProvider) }
    private var canChangeProvider: Bool {
        allowsProviderChange ?? (newTaskWorkspaceId != nil)
    }
    private var isEmpty: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                if card.isEnsemble {
                    Text("Ensemble")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(TWTheme.chroma2.opacity(0.16), in: Capsule())
                        .overlay(Capsule().strokeBorder(TWTheme.chroma2.opacity(0.45)))
                        .foregroundStyle(TWTheme.chroma2)
                } else if !catalogs.isEmpty {
                    ProviderModelPicker(
                        catalogs: catalogs,
                        provider: $selectedProvider,
                        modelId: $selectedModelId,
                        reasoningEffort: $selectedReasoningEffort,
                        allowsProviderChange: canChangeProvider)
                    if !canChangeProvider, !card.isEnsemble, card.parentChatId == nil,
                        newTaskWorkspaceId == nil
                    {
                        // Guest participant: + invites, chip shows/changes,
                        // × removes (desktop guest-picker parity).
                        GuestParticipantControl(model: model, card: card)
                    }
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
                if isGlobalChat {
                    // T72 — phone-origin turns in global chats ALWAYS run in
                    // plan mode (the Mac forces it server-side; this chip just
                    // tells the truth instead of offering a dead picker).
                    HStack(spacing: 3) {
                        Image(systemName: "list.bullet.clipboard")
                        Text("Plan · no file changes")
                    }
                    .font(.caption2)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(TWTheme.surface3, in: Capsule())
                    .foregroundStyle(TWTheme.textSecondary)
                } else if !card.isEnsemble {
                    Menu {
                        Picker("Approval", selection: $approvalMode) {
                            Label("Default Approval", systemImage: "checkmark.shield").tag("default")
                            Label("Plan / Read-only", systemImage: "list.bullet.clipboard").tag(
                                "plan")
                        }
                    } label: {
                        HStack(spacing: 3) {
                            Image(systemName: approvalMode == "plan"
                                ? "list.bullet.clipboard" : "checkmark.shield")
                            Text(approvalMode == "plan" ? "Plan" : "Default")
                        }
                        .font(.caption2)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(TWTheme.surface3, in: Capsule())
                        .foregroundStyle(TWTheme.textSecondary)
                    }
                }
                Spacer()
            }
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
            // Input cluster: the composer body supplies the darker material
            // fill, so this row stays flat like the desktop central panel.
            HStack(spacing: 8) {
                #if canImport(UIKit)
                    // Ensembles included: steer now carries attachments.
                    photosButton
                #endif
                TextField(placeholder, text: $text, axis: .vertical)
                    .lineLimit(1...2)
                    .foregroundStyle(TWTheme.textPrimary)
                Button {
                    sendCurrent()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundStyle(sendDisabled ? TWTheme.textMuted : accent)
                }
                .disabled(sendDisabled)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .background(composerBodyBackground)
        .onAppear {
            seedProviderSelectionIfNeeded()
        }
        .onChange(of: selectedProvider) { _, newValue in
            providerEcho?.wrappedValue = newValue
        }
        .onChange(of: runModel) { _, newValue in
            // The on-demand snapshot usually lands AFTER the composer
            // appears — without this the pill stayed on the catalog
            // default for every existing chat (the Mac inherits the
            // chat's model server-side regardless; this keeps the pill
            // honest). User picks are never overwritten.
            if selectedModelId == nil, let newValue {
                selectedModelId = newValue
            }
        }
    }

    @ViewBuilder
    private var composerBodyBackground: some View {
        if TWTheme.composerGlassEnabled {
            Rectangle()
                .fill(.ultraThinMaterial)
                .overlay(Rectangle().fill(TWTheme.surface2.opacity(0.34)))
        } else {
            Rectangle().fill(TWTheme.surface2.opacity(0.72))
        }
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

    private func seedProviderSelectionIfNeeded() {
        guard !didSeedProviderSelection else { return }
        selectedProvider = card.provider ?? selectedProvider
        selectedModelId = runModel
        providerEcho?.wrappedValue = selectedProvider
        didSeedProviderSelection = true
    }

    #if canImport(UIKit)
        /// Photo attach — solo chats only: ensemble sends ride ensembleSteer,
        /// which carries text alone, so showing the picker there silently
        /// dropped images.
        private var photosButton: some View {
            PhotosPicker(
                selection: $pickedItems, maxSelectionCount: 2, matching: .images
            ) {
                Image(systemName: "photo.badge.plus")
                    .font(.body)
                    .foregroundStyle(
                        attachments.count >= 2 ? TWTheme.textMuted : TWTheme.textSecondary)
            }
            .disabled(attachments.count >= 2)
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

    private var placeholder: String {
        if card.isEnsemble {
            return "Ask the ensemble. @ to direct a participant…"
        }
        return "Ask \(providerName) anything…"
    }
}
