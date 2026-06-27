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
    @Environment(\.appScale) private var appScale
    /// Parent chats whose sub-thread/side-chat children are collapsed. Backed by
    /// the model so it survives the theme-revision teardown (see selectedTaskId).
    private var collapsedParents: Set<String> {
        get { model.collapsedParents }
        nonmutating set { model.collapsedParents = newValue }
    }
    @State private var canvasMode: ComposeMode? = nil
    /// One-time flag: the iPad sidebar collapses its sections to headers on first
    /// launch (then the user's own choices stick — persisted on the model).
    @AppStorage("tw.sidebar.ipadCollapseSeeded") private var ipadCollapseSeeded = false
    @State private var showDemoConfirm = false
    /// QR-optional discovery sheet (find other TaskWraith hosts on the tailnet
    /// via the connected host as the "oracle").
    @State private var showDiscoverySheet = false
    @State private var renameSheetPresented = false
    @State private var renameTargetCard: RemoteTaskCard?

    private func openCanvas(_ mode: ComposeMode) {
        if explicitSelection {
            selection = "new-\(mode == .workspace ? "chat" : mode.rawValue)"
        } else {
            canvasMode = mode
        }
    }

    /// Tidy first open on iPad: collapse every top-level section to its header.
    /// Gated on `explicitSelection` (the iPad NavigationSplitView sidebar —
    /// horizontalSizeClass is unreliable here, see above) + a persisted flag, so
    /// it runs once; afterwards the user's collapse/expand choices stick.
    private func seedSidebarCollapseIfNeeded() {
        guard explicitSelection, !ipadCollapseSeeded else { return }
        ipadCollapseSeeded = true
        collapsedSections = ["activeRuns", "pinned", "recents", "ensembles", "workflows", "workspaces", "shared", "globalChats"]
    }

    private var renameSheetCard: RemoteTaskCard? {
        guard let target = renameTargetCard else { return nil }
        return model.taskCards.first { $0.id == target.id } ?? target
    }

    private func presentRenameSheet(for card: RemoteTaskCard) {
        renameTargetCard = card
        renameSheetPresented = true
    }

    private func renameDisplayTitle(for card: RemoteTaskCard) -> String {
        let title = (card.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? "Chat" : title
    }

    private func renameSubtitle(for card: RemoteTaskCard) -> String? {
        var parts: [String] = []
        if let workspaceName = model.workspaceName(for: card.workspaceId)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !workspaceName.isEmpty
        {
            parts.append(workspaceName)
        }
        let hostName = model.macDisplayName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !hostName.isEmpty {
            parts.append(hostName)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " • ")
    }

    @ViewBuilder
    private func renameContextMenu(for card: RemoteTaskCard) -> some View {
        Button {
            presentRenameSheet(for: card)
        } label: {
            Label("Rename", systemImage: "pencil")
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
    private var expandedWorkspaces: Set<String> {
        get { model.expandedWorkspaces }
        nonmutating set { model.expandedWorkspaces = newValue }
    }
    /// Top-level sections (activeRuns / pinned / recents / workspaces /
    /// globalChats) the user has collapsed — sections start expanded.
    private var collapsedSections: Set<String> {
        get { model.collapsedSections }
        nonmutating set { model.collapsedSections = newValue }
    }

    /// Top-level threads per workspace; sub-threads/side chats nest under
    /// their parent like the desktop sidebar.
    /// Top-level cards minus unstarted welcome-card drafts. The active draft
    /// stays in `model.taskCards` so its in-progress welcome screen still
    /// resolves, but it must never appear as a real chat row in any list section.
    private var listedCards: [RemoteTaskCard] {
        let workflowThreadIds = Set(model.workflows.compactMap(\.threadId))
        return model.taskCards.filter {
            !($0.isDraft ?? false) && !($0.archived ?? false) && !workflowThreadIds.contains($0.id)
        }
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
    /// Workflows scoped to workspaces the phone already knows (allowlisted) —
    /// mirrors the workspace-folder gating so a workflow never references a
    /// workspace the user can't see.
    private var listedWorkflows: [RemoteWorkflow] {
        let known = Set(model.workspaces.map(\.workspaceId))
        return model.workflows.filter {
            guard let ws = $0.workspaceId else { return false }
            return known.contains(ws)
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
            .listSectionSpacing(appScale.scaled(10))
        #endif
        .scrollContentBackground(.hidden)
        .background(TWTheme.sidebarBg)
        .sheet(isPresented: $renameSheetPresented, onDismiss: { renameTargetCard = nil }) {
            if let card = renameSheetCard {
                ThreadRenameSheet(
                    currentTitle: renameDisplayTitle(for: card),
                    subtitle: renameSubtitle(for: card)
                ) { title in
                    model.renameThread(card, title: title)
                }
            }
        }
        .onAppear { seedSidebarCollapseIfNeeded() }
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
                    // "New chat" is a General (scope:'global') chat — the
                    // friendly default; the Mac clamps phone-origin global
                    // turns to plan mode. "New workspace chat" is the
                    // write-capable, workspace-scoped variant (the phone's
                    // only chat-creation surface, so it's kept here).
                    Button("New chat") { openCanvas(.global) }
                    // Workspace-scoped + ensemble creation need a workspace;
                    // a General chat ("New chat") does not, so it stays
                    // enabled even on a fresh phone with no workspaces synced.
                    Button("New workspace chat") { openCanvas(.workspace) }
                        .disabled(model.workspaces.isEmpty)
                    Button("New workflow") { openCanvas(.workflow) }
                        .disabled(model.workspaces.isEmpty)
                    Button("New ensemble") { openCanvas(.ensemble) }
                        .disabled(model.workspaces.isEmpty)
                } label: {
                    ToolbarIconPillLabel("New", systemImage: "square.and.pencil")
                }
                .buttonStyle(.plain)
                // A Menu label inherits the accent tint (blue) over the pill
                // chrome's black/white foreground; force the monochrome tint so the
                // New + More menu pills match the Button pills (Refresh / Settings)
                // and the inspector toolbar's black/white style.
                .tint(TWTheme.textPrimary)
            }
            // Each control is its OWN ToolbarItem (individual circular pill) so the
            // system lays them out independently and overflows gracefully. A single
            // shared ToolbarIconPillGroup does NOT fit the narrow iPad sidebar nav
            // slot — it clips the trailing segments (Settings + More dropped on
            // TestFlight) at BOTH .cancellationAction and .primaryAction. So every
            // toolbar here uses the individual-pill look. New Chat is its own pill
            // at .primaryAction above.
            ToolbarItem(placement: .cancellationAction) {
                Button {
                    model.refreshConnection()
                } label: {
                    ToolbarIconPillLabel("Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.plain)
            }
            ToolbarItem(placement: .cancellationAction) {
                Button {
                    model.settingsPresented = true
                } label: {
                    ToolbarIconPillLabel("Settings", systemImage: "gearshape")
                }
                .buttonStyle(.plain)
            }
            ToolbarItem(placement: .cancellationAction) {
                Menu {
                    Button("First-launch guide", systemImage: "questionmark.circle") {
                        model.firstLaunchSheetPresented = true
                    }
                    Divider()
                    if model.isDemo {
                        Button("Exit demo", systemImage: "xmark.circle") {
                            model.exitDemoMode()
                        }
                    } else {
                        Button(
                            "Find hosts on your tailnet",
                            systemImage: "antenna.radiowaves.left.and.right"
                        ) {
                            showDiscoverySheet = true
                        }
                        Divider()
                        Button("Disconnect", role: .destructive) { model.disconnect() }
                        Button("Forget this host", role: .destructive) { model.forgetPairing() }
                        Divider()
                        Button("Enter demo mode", systemImage: "play.circle") {
                            showDemoConfirm = true
                        }
                    }
                } label: {
                    ToolbarIconPillLabel("More", systemImage: "ellipsis.circle")
                }
                .buttonStyle(.plain)
                .tint(TWTheme.textPrimary)
            }
        }
        .navigationDestination(item: $canvasMode) { mode in
            NewChatBootstrapView(model: model, mode: mode, initialWorkspaceId: nil)
        }
        .confirmationDialog(
            "Enter demo mode?", isPresented: $showDemoConfirm, titleVisibility: .visible
        ) {
            Button("Enter demo") { model.enterDemoMode() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "This disconnects \(model.macDisplayName.isEmpty ? "your computer" : model.macDisplayName) and shows sample data only. Your chats stay private and won't appear in the demo."
            )
        }
        .sheet(isPresented: $showDiscoverySheet) {
            TailnetDiscoverySheet(model: model)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    /// The connected-host identity row (live dot + glyph + name). Shown plain
    /// for a single host; wrapped in a Menu switcher when several are paired.
    /// The chevron signals the row is tappable in the multi-host case.
    private func hostIdentityRow(showChevron: Bool) -> some View {
        let activePlatform = model.pairedHosts
            .first { $0.macIdentityPubKey == model.selectedHostId }?.hostPlatform
        return HStack(spacing: 8) {
            Circle().fill(model.isDemo ? TWTheme.textMuted : TWTheme.statusSuccess)
                .frame(width: 8, height: 8)
            Image(systemName: twHostGlyph(activePlatform))
                .foregroundStyle(TWTheme.textSecondary)
            Text(model.macDisplayName.isEmpty ? "Connected" : model.macDisplayName)
                .font(.subheadline)
                .foregroundStyle(TWTheme.textSecondary)
                .lineLimit(1)
            if showChevron {
                Spacer(minLength: 4)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textMuted)
            }
        }
    }

    @ViewBuilder
    private var sections: some View {
        Section {
            MastheadRow()
        }
        // Host identity header — name + live dot, doubling as a SWITCHER when
        // more than one host is paired (tap to jump between Macs/PCs/Linux).
        Section {
            if !model.isDemo && model.pairedHosts.count > 1 {
                Menu {
                    ForEach(model.pairedHosts) { host in
                        Button {
                            model.switchHost(to: host.macIdentityPubKey)
                        } label: {
                            Label(
                                host.macDisplayName.isEmpty ? "Host" : host.macDisplayName,
                                systemImage: host.macIdentityPubKey == model.selectedHostId
                                    ? "checkmark.circle.fill" : twHostGlyph(host.hostPlatform))
                        }
                    }
                } label: {
                    hostIdentityRow(showChevron: true)
                }
                .listRowBackground(TWTheme.surface1)
            } else {
                hostIdentityRow(showChevron: false)
                    .listRowBackground(TWTheme.surface1)
            }
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

        // ── Workflows — scheduled / recurring runs (desktop parity). Like
        //    Ensembles, a cross-cutting view; read-only on the phone for now
        //    (tapping a row opens the workflow's chat). ────────────────────
        let workflowRows = listedWorkflows
        if !workflowRows.isEmpty {
            Section {
                if !collapsedSections.contains("workflows") {
                    ForEach(workflowRows, id: \.id) { workflow in
                        workflowRow(workflow)
                    }
                }
            } header: {
                GlassPillHeader(
                    title: "Workflows", systemImage: "arrow.triangle.branch",
                    count: workflowRows.count,
                    collapsed: collapsedSections.contains("workflows")
                ) { toggleSection("workflows") }
            }
        }

        // ── Shared — existing People/collaboration chats only. iOS does not
        //    create invites; it simply continues already-visible shared chats
        //    projected by the Mac under the normal workspace allowlist. ─────
        let sharedCards = listedCards.filter { ($0.isShared ?? false) && $0.parentChatId == nil }
        if !sharedCards.isEmpty {
            Section {
                if !collapsedSections.contains("shared") {
                    ForEach(sharedCards, id: \.id) { card in
                        threadRow(card)
                    }
                }
            } header: {
                GlassPillHeader(
                    title: "Shared", systemImage: "person.2",
                    count: sharedCards.count,
                    collapsed: collapsedSections.contains("shared")
                ) { toggleSection("shared") }
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

        // ── General Chats — scope-global chats. They keep the full composer
        //    on the phone (T72); the Mac clamps phone-origin turns to plan
        //    mode (no file mutation) since there's no workspace bound. ─────
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
                    title: "General Chats", systemImage: "globe",
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
            top: appScale.scaled(2),
            leading: appScale.scaled(nested ? 28 : 16),
            bottom: appScale.scaled(2),
            trailing: appScale.scaled(16)
        )
        // Satellite rows (desktop-sidebar parity): no container chrome unless
        // the thread is ACTIVE — running or waiting on the user — which gets
        // a faint accent wash so live work pops out of the list.
        let pendingAttentionCount = model.pendingAttentionCount(for: card)
        let isActive =
            card.status == "running"
            || pendingAttentionCount > 0
        let rowChrome = Group {
            if isActive {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(accent.opacity(0.10))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(accent.opacity(0.35))
                    )
                    .padding(.vertical, appScale.scaled(2))
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
                        .padding(.vertical, appScale.scaled(2))
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
            .contextMenu { renameContextMenu(for: card) }
            .listRowInsets(rowInsets)
            .listRowSeparator(.hidden)
            .listRowBackground(selectedChrome)
        } else {
            // Compact: selection-driven push via `navigationDestination(item:)`
            // (not NavigationLink) so the open chat is restorable from the
            // model after the theme-revision teardown.
            Button {
                selection = card.id
            } label: {
                HStack(spacing: 6) {
                    TaskRow(model: model, card: card, nested: nested)
                    Image(systemName: "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textMuted)
                }
            }
            .buttonStyle(.plain)
            .contextMenu { renameContextMenu(for: card) }
            .listRowInsets(rowInsets)
            .listRowSeparator(.hidden)
            .listRowBackground(rowChrome)
        }
    }

    /// A scheduled-workflow row (read-only). Tapping opens the workflow's chat
    /// via the same `selection` binding the thread rows use; a workflow with no
    /// threadId is inert (nothing to open). Mirrors the satellite-row chrome:
    /// faint accent wash only when running or (on iPad) selected.
    @ViewBuilder
    private func workflowRow(_ workflow: RemoteWorkflow) -> some View {
        let accent = TWTheme.providerAccent(workflow.provider)
        let rowInsets = EdgeInsets(
            top: appScale.scaled(3),
            leading: appScale.scaled(16),
            bottom: appScale.scaled(3),
            trailing: appScale.scaled(16)
        )
        let isSelected = explicitSelection && selection == workflow.threadId
        let chrome = Group {
            if isSelected {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(accent.opacity(0.16))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(accent.opacity(0.5))
                    )
                    .padding(.vertical, appScale.scaled(2))
            } else if workflow.isRunning {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(accent.opacity(0.10))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(accent.opacity(0.35))
                    )
                    .padding(.vertical, appScale.scaled(2))
            } else {
                Color.clear
            }
        }
        Button {
            // Read-only slice: tap opens the workflow's chat. No-op if there's
            // no thread yet (run-now / pause actions land in a later slice).
            guard let threadId = workflow.threadId else { return }
            selection = threadId
        } label: {
            HStack(spacing: 6) {
                WorkflowRowContent(workflow: workflow)
                if workflow.threadId != nil {
                    Image(systemName: "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textMuted)
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(workflow.threadId == nil)
        .listRowInsets(rowInsets)
        .listRowSeparator(.hidden)
        .listRowBackground(chrome)
    }
}

/// The visual content of a Workflows sidebar row: provider glyph + name, then a
/// subtitle line "provider · schedule · status". A paused (disabled) workflow is
/// dimmed and tagged so it reads as inactive at a glance.
struct WorkflowRowContent: View {
    let workflow: RemoteWorkflow

    private var subtitleParts: [String] {
        var parts: [String] = [TWTheme.providerLabel(workflow.provider)]
        if let schedule = workflow.schedule, !schedule.isEmpty {
            parts.append(schedule)
        }
        if let status = workflow.status, !status.isEmpty {
            parts.append(status.capitalized)
        }
        return parts
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            ProviderGlyphIcon(provider: workflow.provider, size: 16)
                .padding(.top, 2)
                .opacity(workflow.isPaused ? 0.5 : 1)
            VStack(alignment: .leading, spacing: 4) {
                Text(workflow.name ?? workflow.id)
                    .font(.body)
                    .foregroundStyle(
                        workflow.isPaused ? TWTheme.textSecondary : TWTheme.textPrimary)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    Text(subtitleParts.joined(separator: " · "))
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textTertiary)
                        .lineLimit(1)
                    if workflow.isPaused {
                        Text("Paused")
                            .font(.caption2.weight(.medium))
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(TWTheme.surface3, in: Capsule())
                            .foregroundStyle(TWTheme.textTertiary)
                    } else if workflow.isRunning {
                        HStack(spacing: 4) {
                            Circle()
                                .fill(TWTheme.statusColor("running"))
                                .frame(width: 6, height: 6)
                            Text("Running")
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(TWTheme.statusColor("running"))
                        }
                    }
                    // Slice 7b — loop-progress badge: iteration count + why it stopped
                    // (from the latest loop execution the Mac projected). Mirrors the
                    // "Paused" capsule style. Absent for non-loop / never-run workflows.
                    if let count = workflow.loopIterationCount, count > 0 {
                        Text(workflow.loopStopReason.map { "\(count)× · \($0)" } ?? "\(count)×")
                            .font(.caption2.weight(.medium))
                            .lineLimit(1)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(TWTheme.surface3, in: Capsule())
                            .foregroundStyle(TWTheme.textSecondary)
                    }
                }
            }
            Spacer(minLength: 0)
        }
    }
}

struct TaskRow: View {
    @ObservedObject var model: RemoteSessionModel
    let card: RemoteTaskCard
    var nested: Bool = false
    @Environment(\.appScale) private var appScale

    private var nestIcon: String {
        if card.isGuestSideChat || card.isIsolatedSideChat {
            return "arrow.left.arrow.right"
        }
        return "arrow.turn.down.right"
    }

    private var pendingAttentionCount: Int {
        model.pendingAttentionCount(for: card)
    }

    var body: some View {
        HStack(alignment: .top, spacing: appScale.scaled(8)) {
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
                    slug: card.agentSlug, size: appScale.scaled(18))
                    .padding(.top, 2)
            } else {
                ProviderGlyphIcon(
                    provider: card.provider, isEnsemble: card.isEnsemble, size: appScale.scaled(16)
                )
                .padding(.top, 2)
            }
            VStack(alignment: .leading, spacing: appScale.scaled(4)) {
                if let agentName = card.agentName {
                    Text(agentName)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(twAgentAccentColor(card.agentAccent))
                        .lineLimit(1)
                }
                // One tidy row: provider/ensemble glyph + a single-line title.
                // The metadata chip row (provider · type · status) is dropped and
                // the title truncates rather than wrapping to a second line. It's
                // one Dynamic Type step smaller but still a text style, so it keeps
                // scaling for accessibility.
                HStack(spacing: appScale.scaled(6)) {
                    Text(card.title ?? card.id)
                        .font(nested ? .footnote : .callout)
                        .foregroundStyle(TWTheme.textPrimary)
                        .lineLimit(1)
                    // Pending-attention is an actionable "needs you" signal (not a
                    // status chip) — keep it, inline so the row stays one line.
                    if pendingAttentionCount > 0 {
                        Image(systemName: "exclamationmark.bubble.fill")
                            .font(.caption)
                            .foregroundStyle(TWTheme.statusAttention)
                    }
                    if card.isShared ?? false {
                        Image(systemName: "person.2.fill")
                            .font(.caption2)
                            .foregroundStyle(TWTheme.chroma2)
                            .accessibilityLabel("Shared")
                    }
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(.vertical, appScale.scaled(2))
        .padding(.leading, nested ? appScale.scaled(8) : 0)
    }
}

// ── QR-optional discovery: find other TaskWraith hosts on the tailnet ──────────
/// Presented from the connected shell's overflow menu. Asks the connected host
/// (the "oracle") to enumerate the tailnet, lists the OTHER TaskWraith machines
/// it finds, and pairs with one on tap — POST /v1/beginpair on the target mints
/// a fresh session and the 6-digit SAS confirm still happens on that host.
struct TailnetDiscoverySheet: View {
    @ObservedObject var model: RemoteSessionModel
    @Environment(\.dismiss) private var dismiss
    /// macIdentityPubKey of the host currently being paired (POST /v1/beginpair
    /// in flight), so its row shows a spinner and the others disable.
    @State private var pairingHostId: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(
                        "TaskWraith asks \(model.macDisplayName.isEmpty ? "this host" : model.macDisplayName) to look for your other computers on the same Tailscale network. You still confirm a 6-digit code on each new host."
                    )
                    .font(.footnote)
                    .foregroundStyle(TWTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                    if model.isDiscoveringHosts {
                        HStack(spacing: 10) {
                            ProgressView().controlSize(.small).tint(TWTheme.chroma1)
                            Text("Searching your tailnet…")
                                .font(.subheadline).foregroundStyle(TWTheme.textPrimary)
                            Spacer(minLength: 0)
                        }
                        .padding(14)
                        .background(
                            TWTheme.surface1, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    } else if let error = model.discoveryError {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack(alignment: .top, spacing: 9) {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .foregroundStyle(TWTheme.statusFailed)
                                Text(error)
                                    .font(.footnote).foregroundStyle(TWTheme.textPrimary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            searchButton(title: "Try again")
                        }
                        .padding(14)
                        .background(
                            TWTheme.surface1, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    } else if model.discoveredHosts.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("No other TaskWraith hosts found on your tailnet.")
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(TWTheme.textPrimary)
                            Text(
                                "Make sure TaskWraith is running on the other computer with remote access enabled, then search again."
                            )
                            .font(.footnote).foregroundStyle(TWTheme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                            searchButton(title: "Search again")
                        }
                        .padding(14)
                        .background(
                            TWTheme.surface1, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    } else {
                        VStack(spacing: 0) {
                            ForEach(Array(model.discoveredHosts.enumerated()), id: \.element.id) {
                                index, host in
                                if index > 0 {
                                    Rectangle().fill(TWTheme.border).frame(height: 1)
                                }
                                discoveredRow(host)
                            }
                        }
                        .background(
                            TWTheme.surface1, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        searchButton(title: "Search again")
                    }
                }
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity)
                .padding(18)
            }
            .background(TWTheme.appBg)
            .navigationTitle("Find hosts")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        // Kick off discovery as soon as the sheet appears.
        .task { await model.discoverHosts() }
    }

    private func discoveredRow(_ host: DiscoveredHostInfo) -> some View {
        let pairing = pairingHostId == host.id
        return Button {
            // Begin on-demand pairing on the target. Only leave the sheet once
            // the connect kicked off (the SAS confirm then surfaces in the main
            // pairing flow); on failure stay put and show discoveryError.
            pairingHostId = host.id
            Task {
                let ok = await model.pairDiscoveredHost(host)
                pairingHostId = nil
                if ok { dismiss() }
            }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: twHostGlyph(host.hostPlatform))
                    .font(.title3)
                    .foregroundStyle(TWTheme.chroma1)
                VStack(alignment: .leading, spacing: 2) {
                    Text(host.macDisplayName ?? "TaskWraith host")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TWTheme.textPrimary)
                        .lineLimit(1)
                    Text(pairing ? "Starting pairing…" : "Tap to pair")
                        .font(.caption).foregroundStyle(TWTheme.textSecondary)
                }
                Spacer(minLength: 0)
                if pairing {
                    ProgressView().controlSize(.small).tint(TWTheme.chroma1)
                } else {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TWTheme.textMuted)
                }
            }
            .contentShape(Rectangle())
            .padding(.vertical, 11)
            .padding(.horizontal, 14)
        }
        .buttonStyle(.plain)
        .disabled(pairingHostId != nil)
    }

    private func searchButton(title: String) -> some View {
        Button {
            Task { await model.discoverHosts() }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "arrow.clockwise").font(.subheadline.weight(.semibold))
                Text(title).font(.subheadline.weight(.semibold))
            }
            .foregroundStyle(TWTheme.chroma1)
        }
        .buttonStyle(.plain)
        .disabled(model.isDiscoveringHosts)
    }
}

// ── Thread detail: the transcript parity surface ──────────────────────────────
