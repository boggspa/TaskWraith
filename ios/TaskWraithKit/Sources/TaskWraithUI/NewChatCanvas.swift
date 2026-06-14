import SwiftUI
import TaskWraithKit

/// Creates a real empty Mac chat, then immediately hands rendering to the
/// normal transcript detail view. This keeps every new-chat entry point on
/// the same welcome card + full composer surface as reopened empty chats.
struct NewChatBootstrapView: View {
    @ObservedObject var model: RemoteSessionModel
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    var mode: ComposeMode = .workspace
    var initialWorkspaceId: String?

    @State private var createdThreadId: String?
    @State private var requestedKey: String?

    private var targetWorkspaceId: String? {
        switch mode {
        case .global:
            return "global"
        case .workspace, .ensemble:
            if let initialWorkspaceId, !initialWorkspaceId.isEmpty {
                return initialWorkspaceId
            }
            return model.workspaces.first?.id
        }
    }

    private var variant: String {
        switch mode {
        case .workspace: return "workspace"
        case .ensemble: return "ensemble"
        case .global: return "global"
        }
    }

    var body: some View {
        Group {
            if let threadId = createdThreadId {
                detailHost(threadId: threadId)
            } else {
                VStack(spacing: 12) {
                    TaskWraithMonolineBrandView(markSize: 44, titleSize: 20)
                    HydrationTicker(statusText)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(TWTheme.appBg)
                .onAppear { createIfReady() }
                .onChange(of: model.workspaces.map(\.id)) { _, _ in createIfReady() }
                .onChange(of: model.navigationTarget) { _, target in
                    guard let target, createdThreadId == nil else { return }
                    createdThreadId = target
                    model.navigationTarget = nil
                }
            }
        }
    }

    @ViewBuilder
    private func detailHost(threadId: String) -> some View {
        HStack(spacing: 0) {
            ThreadDetailView(model: model, taskId: threadId)
            if horizontalSizeClass == .regular, model.inspectorPresented {
                ThreadInspector(model: model, threadId: threadId) { childId in
                    model.inspectorPresented = false
                    createdThreadId = childId
                }
                .frame(width: 390)
                .background(TWTheme.appBg)
                .iPadSidebarInnerRim(edge: .leading)
                .transition(.move(edge: .trailing))
            }
        }
        .animation(.easeInOut(duration: 0.22), value: model.inspectorPresented)
    }

    private var statusText: String {
        switch mode {
        case .workspace:
            return targetWorkspaceId == nil
                ? "Syncing workspaces from your Mac…" : "Creating chat…"
        case .ensemble:
            return targetWorkspaceId == nil
                ? "Syncing workspaces from your Mac…" : "Creating ensemble…"
        case .global:
            return "Creating global chat…"
        }
    }

    private func createIfReady() {
        guard createdThreadId == nil, let workspaceId = targetWorkspaceId else { return }
        let key = "\(variant):\(workspaceId)"
        guard requestedKey != key else { return }
        requestedKey = key
        model.createEmptyThread(
            workspaceId: workspaceId,
            variant: variant,
            title: "New Chat"
        ) { threadId in
            guard let threadId else { return }
            createdThreadId = threadId
        }
    }
}

/// Inline "New chat" — replaces the compose sheet for solo threads. Lives in
/// the MAIN transcript pane (iPad detail column / iPhone push): welcome hero
/// above, composer roughly midway, the rotating heatmap below (where the
/// reference app shows starter prompts). On send, THIS view becomes the
/// transcript — the user continues right where they are.
struct NewChatCanvasView: View {
    @ObservedObject var model: RemoteSessionModel
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    var mode: ComposeMode = .workspace
    var initialWorkspaceId: String?

    @State private var workspaceId: String = ""
    @State private var prompt: String = ""
    @State private var createdThreadId: String? = nil
    /// Echoed from the embedded composer — hero/chip accents follow the
    /// PROVIDER theme color, not the user's settings accent.
    @State private var provider: String = "claude"
    /// Ensemble creation roster (speaking order). Untouched roster sends
    /// nil so the Mac's curated defaults apply.
    @State private var roster: [RemoteSessionModel.RosterDraftEntry] = []
    @State private var rosterEdited = false
    @State private var globalCreated = false

    private var workspace: WorkspaceSummary? {
        model.workspaces.first { $0.id == workspaceId }
    }

    private var draftCard: RemoteTaskCard {
        RemoteTaskCard.newChatDraft(
            workspaceId: workspaceId.isEmpty ? nil : workspaceId)
    }

    var body: some View {
        Group {
            if let threadId = createdThreadId {
                // The canvas BECOMES the transcript once the Mac mints the
                // thread — no navigation hop, exactly "continue from there".
                // Same hand-rolled pane as AppShell (`.inspector` overlays).
                HStack(spacing: 0) {
                    ThreadDetailView(model: model, taskId: threadId)
                    if horizontalSizeClass == .regular, model.inspectorPresented {
                        ThreadInspector(model: model, threadId: threadId) { childId in
                            model.inspectorPresented = false
                            model.navigationTarget = childId
                        }
                        .frame(width: 390)
                        .background(TWTheme.appBg)
                        .iPadSidebarInnerRim(edge: .leading)
                        .transition(.move(edge: .trailing))
                    }
                }
                .animation(.easeInOut(duration: 0.22), value: model.inspectorPresented)
            } else {
                canvas
            }
        }
        .onAppear {
            if workspaceId.isEmpty {
                workspaceId = initialWorkspaceId ?? model.workspaces.first?.id ?? ""
            }
            seedRosterIfNeeded()
        }
        .onChange(of: model.navigationTarget) { _, target in
            guard let target, createdThreadId == nil else { return }
            createdThreadId = target
            model.navigationTarget = nil
        }
    }

    private var activityFooter: some View {
        let workspaceCards = model.taskCards.filter { $0.workspaceId == workspaceId }
        let workspaceEvents = twActivityHeatmapEvents(from: workspaceCards)
        let taskWraithEvents = twActivityHeatmapEvents(from: model.taskCards)
        let externalEvents: [ActivityHeatmapEvent] = []
        return RotatingActivityHeatmap(flavors: [
            .init(
                id: "workspace", title: "Workspace Activity",
                caption: "current workspace", accent: TWTheme.chroma1,
                events: workspaceEvents),
            .init(
                id: "taskwraith", title: "TaskWraith Activity",
                caption: "all TaskWraith runs", accent: TWTheme.chroma3,
                events: taskWraithEvents),
            .init(
                id: "external", title: "External Activity",
                caption: "external usage", accent: TWTheme.providerAccent("cursor"),
                events: externalEvents),
        ], rollup: model.usageRollup)
    }

    private var heroAccent: Color {
        switch mode {
        case .workspace: return TWTheme.providerAccent(provider)
        case .ensemble: return TWTheme.chroma2
        case .global: return TWTheme.chroma3
        }
    }

    private var heroPrefix: String {
        switch mode {
        case .workspace: return "New chat for "
        case .ensemble: return "New ensemble for "
        case .global: return "New global chat"
        }
    }

    private var heroBlurb: String {
        switch mode {
        case .workspace: return "The run starts on your Mac and streams back here."
        case .ensemble: return "Participants take turns on your Mac. Send a prompt to open the first round."
        case .global: return "Creates a global chat on your Mac. Send your first prompt from the desktop app for now."
        }
    }

    private var catalogs: [ProviderModelCatalog] {
        model.providerModels
            .map { ProviderModelCatalog(provider: $0.key, models: $0.value) }
            .sorted { TWTheme.providerLabel($0.provider) < TWTheme.providerLabel($1.provider) }
    }

    private func seedRosterIfNeeded() {
        guard mode == .ensemble, roster.isEmpty else { return }
        roster = catalogs.map { catalog in
            RemoteSessionModel.RosterDraftEntry(
                id: "draft-\(catalog.provider)", provider: catalog.provider,
                model: nil, role: TWTheme.providerLabel(catalog.provider),
                brief: "", enabled: true)
        }
    }

    /// Creation roster editor (speaking order): provider/model menus,
    /// move up/down, remove, add — the compose sheet's editor, canvas-styled.
    @ViewBuilder
    private var rosterEditor: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(roster.enumerated()), id: \.element.id) { index, entry in
                rosterRow(index: index, entry: entry)
            }
            HStack {
                Menu {
                    ForEach(catalogs) { catalog in
                        Button {
                            roster.append(
                                RemoteSessionModel.RosterDraftEntry(
                                    id: "draft-\(UUID().uuidString.prefix(6))",
                                    provider: catalog.provider, model: nil,
                                    role: TWTheme.providerLabel(catalog.provider),
                                    brief: "", enabled: true))
                            rosterEdited = true
                        } label: {
                            Label(
                                TWTheme.providerLabel(catalog.provider),
                                systemImage: "person.badge.plus")
                        }
                    }
                } label: {
                    Label("Add participant", systemImage: "plus.circle.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(
                            roster.count >= 12 ? TWTheme.textMuted : TWTheme.chroma2)
                }
                .disabled(roster.count >= 12)
                Spacer()
                Text("Speaking order · top first")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textTertiary)
            }
        }
        .padding(10)
        .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(TWTheme.border))
    }

    @ViewBuilder
    private func rosterRow(
        index: Int, entry: RemoteSessionModel.RosterDraftEntry
    ) -> some View {
        let accent = TWTheme.providerAccent(entry.provider)
        HStack(spacing: 8) {
            Text("\(index + 1)")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(TWTheme.textMuted)
                .frame(width: 14)
            Menu {
                ForEach(catalogs) { catalog in
                    Button(TWTheme.providerLabel(catalog.provider)) {
                        roster[index].provider = catalog.provider
                        roster[index].model = nil
                        roster[index].role = TWTheme.providerLabel(catalog.provider)
                        rosterEdited = true
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Circle().fill(accent).frame(width: 6, height: 6)
                    Text(TWTheme.providerLabel(entry.provider))
                        .font(.caption.weight(.semibold))
                    Image(systemName: "chevron.up.chevron.down").font(.system(size: 8))
                }
                .foregroundStyle(accent)
            }
            Menu {
                Button("CLI Default") {
                    roster[index].model = nil
                    rosterEdited = true
                }
                ForEach(model.providerModels[entry.provider] ?? []) { option in
                    Button(option.label ?? option.id) {
                        roster[index].model = option.id
                        rosterEdited = true
                    }
                }
            } label: {
                Text(entry.model ?? "Default")
                    .font(.caption)
                    .foregroundStyle(TWTheme.textSecondary)
                    .lineLimit(1)
            }
            Spacer()
            Button {
                guard index > 0 else { return }
                roster.swapAt(index, index - 1)
                rosterEdited = true
            } label: {
                Image(systemName: "chevron.up").font(.caption2)
            }
            .buttonStyle(.plain)
            .foregroundStyle(index > 0 ? TWTheme.textSecondary : TWTheme.textMuted)
            Button {
                guard index < roster.count - 1 else { return }
                roster.swapAt(index, index + 1)
                rosterEdited = true
            } label: {
                Image(systemName: "chevron.down").font(.caption2)
            }
            .buttonStyle(.plain)
            .foregroundStyle(
                index < roster.count - 1 ? TWTheme.textSecondary : TWTheme.textMuted)
            Button {
                guard roster.count > 1 else { return }
                roster.remove(at: index)
                rosterEdited = true
            } label: {
                Image(systemName: "minus.circle").font(.caption2)
            }
            .buttonStyle(.plain)
            .foregroundStyle(roster.count > 1 ? TWTheme.statusFailed : TWTheme.textMuted)
        }
    }

    private var canvas: some View {
        ScrollView {
            VStack(spacing: 18) {
                Spacer(minLength: 30)
                // Hero (welcome-card parity)
                VStack(spacing: 10) {
                    // Provider theme accent for the workspace label/glow —
                    // NOT the user's settings accent (desktop parity).
                    // Ensemble/global use their family accents.
                    MastheadLogoView(size: 46)
                        .shadow(color: heroAccent.opacity(0.45), radius: 18)
                    Group {
                        Text(heroPrefix)
                            .foregroundStyle(TWTheme.textSecondary)
                            + Text(mode == .global ? "" : (workspace?.displayName ?? "…"))
                            .foregroundStyle(heroAccent)
                            .fontWeight(.semibold)
                            + Text(".")
                            .foregroundStyle(TWTheme.textSecondary)
                    }
                    .font(.title3)
                    .multilineTextAlignment(.center)
                    Text(heroBlurb)
                        .font(.footnote)
                        .foregroundStyle(TWTheme.textTertiary)
                }

                // Provider catalogs ride a dedicated broadcast that fires on
                // establish — until they land every provider menu on this
                // canvas would render empty, which reads as broken. One
                // ticker up top covers all of them (roster menus, picker
                // sheet, composer pill).
                if catalogs.isEmpty {
                    HydrationTicker("Loading providers from your Mac…")
                }

                // Workspace chips
                FlowChips(items: model.workspaces.map(\.id)) { id in
                    let name =
                        model.workspaces.first(where: { $0.id == id })?.displayName ?? id
                    Button {
                        workspaceId = id
                    } label: {
                        Text(name)
                            .font(.caption.weight(.medium))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(
                                workspaceId == id
                                    ? TWTheme.providerAccent(provider).opacity(0.18)
                                    : TWTheme.surface2,
                                in: Capsule()
                            )
                            .overlay(
                                Capsule().strokeBorder(
                                    workspaceId == id
                                        ? TWTheme.providerAccent(provider).opacity(0.6)
                                        : TWTheme.border)
                            )
                            .foregroundStyle(
                                workspaceId == id
                                    ? TWTheme.providerAccent(provider)
                                    : TWTheme.textSecondary)
                    }
                    .buttonStyle(.plain)
                }

                if mode == .ensemble {
                    rosterEditor
                }

                // Thread composer (same shell as the detail view) for solo;
                // ensemble/global get canvas-native prompt + action.
                switch mode {
                case .workspace:
                    Composer(
                        model: model,
                        card: draftCard,
                        newTaskWorkspaceId: workspaceId.isEmpty ? nil : workspaceId,
                        providerEcho: $provider,
                        text: $prompt
                    )
                    .composerShellGlass()
                    .padding(.horizontal, 4)
                case .ensemble:
                    VStack(spacing: 10) {
                        TextField(
                            "Ask the ensemble anything…", text: $prompt, axis: .vertical
                        )
                        .lineLimit(3...8)
                        .padding(12)
                        .foregroundStyle(TWTheme.textPrimary)
                        .background(
                            TWTheme.surface2,
                            in: RoundedRectangle(cornerRadius: 12))
                        Button {
                            let text = prompt.trimmingCharacters(
                                in: .whitespacesAndNewlines)
                            guard !text.isEmpty, !workspaceId.isEmpty else { return }
                            model.startEnsemble(
                                workspaceId: workspaceId, prompt: text,
                                participants: rosterEdited
                                    ? roster.map {
                                        RemoteSessionModel.EnsembleDraftParticipant(
                                            provider: $0.provider, model: $0.model)
                                    }
                                    : nil)
                        } label: {
                            HStack(spacing: 7) {
                                Image(systemName: "paperplane.fill")
                                Text("Start").font(.body.weight(.semibold))
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(
                                prompt.trimmingCharacters(in: .whitespacesAndNewlines)
                                    .isEmpty
                                    ? AnyShapeStyle(TWTheme.surface3)
                                    : AnyShapeStyle(TWTheme.chroma2),
                                in: Capsule())
                            .foregroundStyle(
                                prompt.trimmingCharacters(in: .whitespacesAndNewlines)
                                    .isEmpty
                                    ? TWTheme.textMuted : Color.black.opacity(0.85))
                        }
                        .buttonStyle(.plain)
                        .disabled(
                            prompt.trimmingCharacters(in: .whitespacesAndNewlines)
                                .isEmpty)
                    }
                    .padding(10)
                    .composerShellGlass()
                    .padding(.horizontal, 4)
                case .global:
                    VStack(spacing: 10) {
                        if globalCreated {
                            HStack(spacing: 8) {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(TWTheme.statusSuccess)
                                Text("Created on your Mac — find it under Global Chats. Phone turns run in plan mode (no file changes).")
                                    .font(.footnote)
                                    .foregroundStyle(TWTheme.textSecondary)
                            }
                            .padding(.vertical, 14)
                        } else {
                            Button {
                                model.startGlobalChat()
                                globalCreated = true
                            } label: {
                                HStack(spacing: 7) {
                                    Image(systemName: "plus.circle.fill")
                                    Text("Create").font(.body.weight(.semibold))
                                }
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                                .background(TWTheme.chroma3, in: Capsule())
                                .foregroundStyle(Color.black.opacity(0.85))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(10)
                    .composerShellGlass()
                    .padding(.horizontal, 4)
                }

                // Heatmap below (replaces the reference app's starter prompts)
                activityFooter
                    .padding(.top, 8)
                Spacer(minLength: 20)
            }
            .padding(.horizontal, 18)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .background(TWTheme.appBg)
        .navigationTitle("New chat")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}
