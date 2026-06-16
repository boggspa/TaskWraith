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

struct HomeView: View {
    @ObservedObject var model: RemoteSessionModel
    @Binding var selection: String?
    /// Parent chats whose sub-thread/side-chat children are collapsed.
    @State private var collapsedParents: Set<String> = []
    @State private var showSettings = false
    @State private var canvasMode: ComposeMode? = nil

    private func openCanvas(_ mode: ComposeMode) {
        if explicitSelection {
            selection = "new-\(mode == .workspace ? "chat" : mode.rawValue)"
        } else {
            canvasMode = mode
        }
    }
    /// True when hosted in a NavigationSplitView sidebar — rows select
    /// explicitly instead of pushing NavigationLinks. NOT derivable from
    /// the environment: split-view columns report a COMPACT horizontal
    /// size class, which is exactly how the iPad sidebar ended up running
    /// the iPhone code path with destination-less links.
    var explicitSelection: Bool = false
    /// Workspace folders the user has EXPANDED — inverted from the old
    /// collapsed-set so folders start collapsed (a tidy first open; expand
    /// state then sticks for the session).
    @State private var expandedWorkspaces: Set<String> = []
    /// Top-level sections (activeRuns / pinned / recents / workspaces /
    /// globalChats) the user has collapsed — sections start expanded.
    @State private var collapsedSections: Set<String> = []

    /// Top-level threads per workspace; sub-threads/side chats nest under
    /// their parent like the desktop sidebar.
    /// Top-level cards minus unstarted welcome-card drafts. The active draft
    /// stays in `model.taskCards` so its in-progress welcome screen still
    /// resolves, but it must never appear as a real chat row in any list section.
    private var listedCards: [RemoteTaskCard] {
        model.taskCards.filter { !($0.isDraft ?? false) && !($0.archived ?? false) }
    }
    private var cardsByWorkspace: [String: [RemoteTaskCard]] {
        Dictionary(grouping: listedCards.filter { $0.parentChatId == nil }) {
            $0.workspaceId ?? ""
        }
    }
    private var childrenByParent: [String: [RemoteTaskCard]] {
        Dictionary(grouping: model.taskCards.filter { $0.parentChatId != nil && !($0.archived ?? false) }) {
            $0.parentChatId ?? ""
        }
    }
    private var orphanCards: [RemoteTaskCard] {
        let known = Set(model.workspaces.map(\.workspaceId))
        return listedCards.filter {
            $0.parentChatId == nil && !known.contains($0.workspaceId ?? "")
        }
    }

    var body: some View {
        Group {
            // One list for both widths — iPad selection is explicit Buttons
            // (List(selection:) needs edit mode on .plain-style iPadOS lists).
            List { sections }
        }
        #if os(iOS)
            .listStyle(.plain)
            .listSectionSpacing(10)
        #endif
        .scrollContentBackground(.hidden)
        .background(TWTheme.sidebarBg)
        .onChange(of: model.navigationTarget) { _, threadId in
            guard let threadId else { return }
            selection = threadId
            model.navigationTarget = nil
        }
        .navigationTitle("")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    // ALL chat types create an empty Mac thread first, then
                    // render through the normal transcript welcome surface.
                    Button("New chat") { openCanvas(.workspace) }
                    Button("New ensemble") { openCanvas(.ensemble) }
                    Button("New global chat") { openCanvas(.global) }
                } label: {
                    Label("New", systemImage: "square.and.pencil")
                }
                .disabled(model.workspaces.isEmpty)
            }
            ToolbarItem(placement: .cancellationAction) {
                HStack(spacing: 8) {
                    Button {
                        model.refreshConnection()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    Menu {
                        Button("Disconnect", role: .destructive) { model.disconnect() }
                        Button("Forget this Mac", role: .destructive) { model.forgetPairing() }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
        }
        .navigationDestination(item: $canvasMode) { mode in
            NewChatBootstrapView(model: model, mode: mode, initialWorkspaceId: nil)
        }
        .sheet(isPresented: $showSettings) {
            AppSettingsSheet()
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    @ViewBuilder
    private var sections: some View {
        Section {
            MastheadRow()
        }
        // Mac identity header — name + live dot, like the reference apps.
        Section {
            HStack(spacing: 8) {
                Circle().fill(TWTheme.statusSuccess).frame(width: 8, height: 8)
                Image(systemName: "desktopcomputer")
                    .foregroundStyle(TWTheme.textSecondary)
                Text(model.macDisplayName.isEmpty ? "Connected" : model.macDisplayName)
                    .font(.subheadline)
                    .foregroundStyle(TWTheme.textSecondary)
                    .lineLimit(1)
            }
            .listRowBackground(TWTheme.surface1)
        }

        if !model.approvals.isEmpty {
            Section("Needs your approval") {
                ForEach(model.approvals, id: \.toolCallId) { card in
                    ApprovalRow(model: model, card: card)
                        .listRowBackground(TWTheme.surface2)
                }
            }
        }
        if !model.questions.isEmpty {
            Section("Questions") {
	                ForEach(model.questions, id: \.stableId) { card in
                    QuestionRow(model: model, card: card)
                        .listRowBackground(TWTheme.surface2)
                }
            }
        }

        if model.workspaces.isEmpty && model.taskCards.isEmpty {
            Section {
                if model.projectionHydrated {
                    // Confirmed empty — content never arrived within the
                    // hydration window, so the setup instructions are real.
                    VStack(alignment: .leading, spacing: 6) {
                        Text("No workspaces shared with this device yet.")
                            .foregroundStyle(TWTheme.textPrimary)
                        Text(
                            "On your Mac: Settings → Devices → “Add workspace access”. Chats in allowed workspaces appear here."
                        )
                        .font(.footnote).foregroundStyle(TWTheme.textSecondary)
                    }
                    .listRowBackground(TWTheme.surface1)
                } else {
                    // First-connect hydration — claiming "no workspaces"
                    // here sent users to Mac Settings over a state that
                    // wasn't real yet.
                    HydrationTicker("Syncing workspaces from your Mac…")
                        .listRowBackground(Color.clear)
                }
            }
        }

        // ── Active Runs — live work first, desktop-sidebar parity. ────────
        let activeCards = model.taskCards.filter { $0.status == "running" && !($0.archived ?? false) }
        if !activeCards.isEmpty {
            Section {
                if !collapsedSections.contains("activeRuns") {
                    ForEach(activeCards, id: \.id) { card in
                        threadRow(card)
                    }
                }
            } header: {
                GlassPillHeader(
                    title: "Active Runs", systemImage: "bolt.fill",
                    count: activeCards.count,
                    collapsed: collapsedSections.contains("activeRuns")
                ) { toggleSection("activeRuns") }
            }
        }

        let pinnedCards = listedCards.filter { $0.pinned == true }
        if !pinnedCards.isEmpty {
            Section {
                if !collapsedSections.contains("pinned") {
                    ForEach(pinnedCards, id: \.id) { card in
                        threadRow(card)
                    }
                }
            } header: {
                GlassPillHeader(
                    title: "Pinned", systemImage: "pin",
                    count: pinnedCards.count,
                    collapsed: collapsedSections.contains("pinned")
                ) { toggleSection("pinned") }
            }
        }
        let recentCards = listedCards
            .filter { $0.parentChatId == nil }
            .sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }
            .prefix(4)
        if recentCards.count > 1 {
            Section {
                if !collapsedSections.contains("recents") {
                    ForEach(Array(recentCards), id: \.id) { card in
                        threadRow(card)
                    }
                }
            } header: {
                GlassPillHeader(
                    title: "Recents", systemImage: "clock",
                    collapsed: collapsedSections.contains("recents")
                ) { toggleSection("recents") }
            }
        }

        // ── Ensembles — every ensemble in one place (desktop parity).
        //    They ALSO stay listed inside their workspace folders below;
        //    this is the cross-cutting view, like Pinned/Recents. ─────────
        let ensembleCards = listedCards.filter { $0.isEnsemble && $0.parentChatId == nil }
        if !ensembleCards.isEmpty {
            Section {
                if !collapsedSections.contains("ensembles") {
                    ForEach(ensembleCards, id: \.id) { card in
                        threadRow(card)
                    }
                }
            } header: {
                GlassPillHeader(
                    title: "Ensembles", systemImage: "star",
                    count: ensembleCards.count,
                    collapsed: collapsedSections.contains("ensembles")
                ) { toggleSection("ensembles") }
            }
        }

        // ── Workspaces — one glass super-header over the folder hierarchy
        //    (desktop parity); folders start COLLAPSED for a tidy first
        //    open, and expand state sticks for the session. ───────────────
        if !model.workspaces.isEmpty {
            Section {
                EmptyView()
            } header: {
                GlassPillHeader(
                    title: "Workspaces", systemImage: "square.grid.2x2",
                    count: model.workspaces.count,
                    collapsed: collapsedSections.contains("workspaces")
                ) { toggleSection("workspaces") }
            }
        }
        if !collapsedSections.contains("workspaces") {
            ForEach(model.workspaces) { workspace in
                Section {
                    let cards = cardsByWorkspace[workspace.workspaceId] ?? []
                    if !expandedWorkspaces.contains(workspace.workspaceId) {
                        EmptyView()
                    } else if cards.isEmpty {
                        Text("No chats yet").font(.footnote)
                            .foregroundStyle(TWTheme.textTertiary)
                            .listRowBackground(TWTheme.surface1)
                    } else {
                        ForEach(cards, id: \.id) { card in
                            parentRow(card)
                            if !collapsedParents.contains(card.id) {
                                ForEach(childrenByParent[card.id] ?? [], id: \.id) { child in
                                    threadRow(child, nested: true)
                                }
                            }
                        }
                    }
                } header: {
                    let count = (cardsByWorkspace[workspace.workspaceId] ?? []).count
                    Button {
                        toggleWorkspace(workspace.workspaceId)
                    } label: {
                        HStack(spacing: 6) {
                            Image(
                                systemName: expandedWorkspaces.contains(workspace.workspaceId)
                                    ? "chevron.down" : "chevron.right"
                            )
                            .font(.caption2.weight(.bold))
                            PillSectionHeader(
                                title: workspace.displayName,
                                systemImage: "folder",
                                trailing: count > 0 ? "\(count)" : nil)
                        }
                    }
                    .buttonStyle(.plain)
                    .padding(.leading, 8)
                }
            }
        }

        // ── Global Chats — scope-global chats passed through READ-ONLY
        //    (no workspace ⇒ no write capabilities; view-only on iOS). ─────
        let globalCards = listedCards.filter {
            $0.parentChatId == nil && $0.isGlobalScope
        }
        if !globalCards.isEmpty {
            Section {
                if !collapsedSections.contains("globalChats") {
                    ForEach(globalCards, id: \.id) { card in
                        threadRow(card)
                    }
                }
            } header: {
                GlassPillHeader(
                    title: "Global Chats", systemImage: "globe",
                    count: globalCards.count,
                    collapsed: collapsedSections.contains("globalChats")
                ) { toggleSection("globalChats") }
            }
        }

        // Defensive fallback only: cards whose workspace id isn't in the
        // workspace list yet (a mid-hydration race). The Mac hides chats
        // from stale/unknown workspaces, so this should stay empty.
        let strayCards = orphanCards.filter { !($0.workspaceId ?? "").isEmpty }
        if !strayCards.isEmpty {
            Section {
                ForEach(strayCards, id: \.id) { card in
                    parentRow(card)
                    if !collapsedParents.contains(card.id) {
                        ForEach(childrenByParent[card.id] ?? [], id: \.id) { child in
                            threadRow(child, nested: true)
                        }
                    }
                }
            } header: {
                PillSectionHeader(title: "Other chats", systemImage: "bubble.left.and.bubble.right")
            }
        }
        // (The pairID/APNs ack strip that used to render here was debug
        // noise — action feedback lives on the thread screen instead.)
    }

    private func toggleSection(_ key: String) {
        if collapsedSections.contains(key) {
            collapsedSections.remove(key)
        } else {
            collapsedSections.insert(key)
        }
    }

    private func toggleWorkspace(_ id: String) {
        if expandedWorkspaces.contains(id) {
            expandedWorkspaces.remove(id)
        } else {
            expandedWorkspaces.insert(id)
        }
    }

    /// Parent row with a leading disclosure chevron when the chat has
    /// sub-thread / side-chat children — collapses the whole tree to just
    /// the parent (desktop sidebar parity).
    @ViewBuilder
    private func parentRow(_ card: RemoteTaskCard) -> some View {
        let children = childrenByParent[card.id] ?? []
        if children.isEmpty {
            threadRow(card)
        } else {
            threadRow(card)
                .safeAreaInset(edge: .leading, spacing: 0) {
                    Button {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            if collapsedParents.contains(card.id) {
                                collapsedParents.remove(card.id)
                            } else {
                                collapsedParents.insert(card.id)
                            }
                        }
                    } label: {
                        Image(
                            systemName: collapsedParents.contains(card.id)
                                ? "chevron.right" : "chevron.down"
                        )
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(TWTheme.textTertiary)
                        .frame(width: 16)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
        }
    }

    @ViewBuilder
    private func threadRow(_ card: RemoteTaskCard, nested: Bool = false) -> some View {
        let accent = card.isEnsemble
            ? TWTheme.chroma2 : TWTheme.providerAccent(card.provider)
        let rowInsets = EdgeInsets(
            top: 3, leading: nested ? 28 : 16, bottom: 3, trailing: 16)
        // Satellite rows (desktop-sidebar parity): no container chrome unless
        // the thread is ACTIVE — running or waiting on the user — which gets
        // a faint accent wash so live work pops out of the list.
        let isActive =
            card.status == "running"
            || (card.pendingApprovalCount ?? 0) + (card.pendingQuestionCount ?? 0) > 0
        let rowChrome = Group {
            if isActive {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(accent.opacity(0.10))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(accent.opacity(0.35))
                    )
                    .padding(.vertical, 2)
            } else {
                Color.clear
            }
        }
        if explicitSelection {
            // iPad sidebar: EXPLICIT selection. `.tag` + List(selection:)
            // only activates in edit mode for `.plain` lists on iPadOS —
            // tapping silently did nothing once the satellite pass dropped
            // the sidebar list style. A Button always fires; the selected
            // row gets the accent wash (the satellite rule's "unless
            // selected/active" arm).
            let isSelected = selection == card.id
            let selectedChrome = Group {
                if isSelected {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(accent.opacity(0.16))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .strokeBorder(accent.opacity(0.5))
                        )
                        .padding(.vertical, 2)
                } else {
                    rowChrome
                }
            }
            Button {
                if card.isGuestSideChat || card.isIsolatedSideChat,
                    let parentId = card.parentChatId
                {
                    selection = parentId
                    model.inspectorPresented = true
                    model.inspectorSideChatTarget = card.id
                    model.requestThreadSnapshot(card.id)
                } else {
                    selection = card.id
                }
            } label: {
                HStack(spacing: 6) {
                    TaskRow(model: model, card: card, nested: nested)
                    Image(systemName: "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textMuted)
                }
            }
            .buttonStyle(.plain)
            .listRowInsets(rowInsets)
            .listRowSeparator(.hidden)
            .listRowBackground(selectedChrome)
        } else {
            NavigationLink(value: card.id) {
                TaskRow(model: model, card: card, nested: nested)
            }
            .listRowInsets(rowInsets)
            .listRowSeparator(.hidden)
            .listRowBackground(rowChrome)
        }
    }
}

struct TaskRow: View {
    @ObservedObject var model: RemoteSessionModel
    let card: RemoteTaskCard
    var nested: Bool = false

    private var nestIcon: String {
        if card.isGuestSideChat || card.isIsolatedSideChat {
            return "arrow.left.arrow.right"
        }
        return "arrow.turn.down.right"
    }

    private var relationLabel: String? {
        if card.isGuestSideChat { return "Guest" }
        if card.isIsolatedSideChat { return "Side chat" }
        if nested || card.isSubThread { return "Sub-thread" }
        if card.isEnsemble { return "Ensemble" }
        return nil
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if nested || card.parentChatId != nil {
                Image(systemName: nestIcon)
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textTertiary)
                    .padding(.top, 4)
            }
            // Provider glyph — monoline mnemonic tinted with the provider
            // accent, with dot fallback for providers with no baked glyph.
            // Sub-agents with a character identity get their identicon badge
            // instead.
            if let agentName = card.agentName {
                AgentIdentityBadge(
                    name: agentName, accentHex: card.agentAccent,
                    slug: card.agentSlug, size: 18)
                    .padding(.top, 2)
            } else {
                ProviderGlyphIcon(
                    provider: card.provider, isEnsemble: card.isEnsemble, size: 16
                )
                .padding(.top, 2)
            }
            VStack(alignment: .leading, spacing: 4) {
                if let agentName = card.agentName {
                    Text(agentName)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(twAgentAccentColor(card.agentAccent))
                        .lineLimit(1)
                }
                Text(card.title ?? card.id)
                    .font(nested ? .subheadline : .body)
                    .foregroundStyle(TWTheme.textPrimary)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    if card.isEnsemble {
                        Text("Ensemble")
                            .font(.caption2.weight(.medium))
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(TWTheme.chroma2.opacity(0.16), in: Capsule())
                            .foregroundStyle(TWTheme.chroma2)
                    } else if let provider = card.provider {
                        Text(TWTheme.providerLabel(provider))
                            .font(.caption2.weight(.medium))
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(
                                TWTheme.providerAccent(provider).opacity(0.14), in: Capsule()
                            )
                            .foregroundStyle(TWTheme.providerAccent(provider))
                    }
                    if let relationLabel {
                        Text(relationLabel)
                            .font(.caption2)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(TWTheme.surface3, in: Capsule())
                            .foregroundStyle(TWTheme.textTertiary)
                    }
                    if let status = card.status {
                        HStack(spacing: 4) {
                            Circle().fill(TWTheme.statusColor(status)).frame(width: 6, height: 6)
                            Text(status).font(.caption)
                                .foregroundStyle(TWTheme.statusColor(status))
                        }
                    }
                    if (card.pendingApprovalCount ?? 0) + (card.pendingQuestionCount ?? 0) > 0 {
                        Image(systemName: "exclamationmark.bubble.fill")
                            .font(.caption)
                            .foregroundStyle(TWTheme.statusAttention)
                    }
                    Spacer()
                }
            }
        }
        .padding(.vertical, 2)
        .padding(.leading, nested ? 8 : 0)
    }
}

// ── Thread detail: the transcript parity surface ──────────────────────────────
