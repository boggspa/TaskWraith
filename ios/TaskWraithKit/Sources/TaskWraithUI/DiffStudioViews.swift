// Diff Studio mode — the phone-sized cut of the desktop Diff Studio.
//
// Compact hosts (composer sheet + phone fullScreenCover) render a Codex-style
// *inline multi-file review*: each changed file is a translucent card with its
// hunks expanded in-place so users never have to drill into a file first.
// iPad split keeps the classic navigator rail + detail viewer.
//
// The Mac computes the diff with the SAME git surface the desktop Diff Studio
// renders (`workspaceDiff` bridge action → DiffService.buildBoundedWorkspaceDiff),
// hard-capped for the relay budget; read-only, gated by `diffReview`.

import SwiftUI
import TaskWraithKit

enum MobileDiffStageFilter: String, CaseIterable, Identifiable {
    case all
    case mixed
    case unstaged
    case staged
    case untracked
    case other

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all: return "All"
        case .mixed: return "Mixed"
        case .unstaged: return "Unstaged"
        case .staged: return "Staged"
        case .untracked: return "Untracked"
        case .other: return "Other"
        }
    }

    var emptyLabel: String {
        switch self {
        case .all: return "changed"
        case .mixed: return "mixed"
        case .unstaged: return "unstaged"
        case .staged: return "staged"
        case .untracked: return "untracked"
        case .other: return "other"
        }
    }

    /// Primary segmented chips for the compact inline sheet (Codex-style).
    static var compactChipFilters: [MobileDiffStageFilter] {
        [.all, .unstaged, .staged, .untracked]
    }

    func matches(_ file: WorkspaceDiffFile) -> Bool {
        switch self {
        case .all:
            return true
        case .mixed:
            return file.staged == true && file.unstaged == true
        case .unstaged:
            return file.unstaged == true && !(file.staged == true)
        case .staged:
            return file.staged == true && !(file.unstaged == true)
        case .untracked:
            return file.kind == "untracked" || file.status == "untracked"
        case .other:
            return file.staged != true
                && file.unstaged != true
                && file.kind != "untracked"
                && file.status != "untracked"
        }
    }
}

@MainActor
final class MobileDiffStudioState: ObservableObject {
    @Published var selectedWorkspaceId: String?
    @Published var diff: WorkspaceDiffResult?
    @Published var selectedPath: String?
    @Published var status = ""
    @Published var isLoading = false
    @Published var fileFilter = ""
    @Published var stageFilter: MobileDiffStageFilter = .all
    /// Paths the user has collapsed in the inline multi-file review.
    /// Files default to expanded so hunks are visible without a drill-in tap.
    @Published var collapsedPaths: Set<String> = []

    private var reloadGeneration = 0

    var files: [WorkspaceDiffFile] { diff?.files ?? [] }

    var stageFilteredFiles: [WorkspaceDiffFile] {
        Self.filterFiles(files, stageFilter: stageFilter)
    }

    var filteredFiles: [WorkspaceDiffFile] {
        Self.filterFiles(stageFilteredFiles, query: fileFilter)
    }

    var fileFilterStatus: String? {
        let query = fileFilter.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return nil }
        let matchCount = filteredFiles.count
        let poolCount = stageFilteredFiles.count
        return "\(matchCount) of \(poolCount) file\(poolCount == 1 ? "" : "s") match \"\(query)\"."
    }

    var stageFilterStatus: String? {
        guard stageFilter != .all else { return nil }
        let count = stageFilteredFiles.count
        return "\(count) of \(files.count) \(stageFilter.emptyLabel) file\(count == 1 ? "" : "s") visible."
    }

    var emptyFilterMessage: String {
        let query = fileFilter.trimmingCharacters(in: .whitespacesAndNewlines)
        if query.isEmpty {
            return "No \(stageFilter.emptyLabel) changed files."
        }
        return "No \(stageFilter.emptyLabel) changed files match \"\(query)\"."
    }

    var totalAdditions: Int {
        Self.sumLineStats(files).additions
    }

    var totalDeletions: Int {
        Self.sumLineStats(files).deletions
    }

    var filteredTotalAdditions: Int {
        Self.sumLineStats(filteredFiles).additions
    }

    var filteredTotalDeletions: Int {
        Self.sumLineStats(filteredFiles).deletions
    }

    static func statusText(visibleFiles: Int, totalFiles: Int?) -> String {
        let count = max(totalFiles ?? visibleFiles, visibleFiles)
        return count == 0
            ? "No changes."
            : "\(count) changed file\(count == 1 ? "" : "s")"
    }

    static func sumLineStats(_ files: [WorkspaceDiffFile]) -> (additions: Int, deletions: Int) {
        var additions = 0
        var deletions = 0
        for file in files {
            additions += file.additions ?? 0
            deletions += file.deletions ?? 0
        }
        return (additions, deletions)
    }

    static func filterFiles(_ files: [WorkspaceDiffFile], query: String) -> [WorkspaceDiffFile] {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalizedQuery.isEmpty else { return files }
        return files.filter { file in
            file.path.lowercased().contains(normalizedQuery)
                || file.name.lowercased().contains(normalizedQuery)
                || file.kind.lowercased().contains(normalizedQuery)
        }
    }

    static func filterFiles(
        _ files: [WorkspaceDiffFile],
        stageFilter: MobileDiffStageFilter
    ) -> [WorkspaceDiffFile] {
        guard stageFilter != .all else { return files }
        return files.filter { stageFilter.matches($0) }
    }

    static let diffColumnLabels = ["Old", "New", "Δ", "Line"]

    func isFileExpanded(_ path: String) -> Bool {
        !collapsedPaths.contains(path)
    }

    func toggleFileExpanded(_ path: String) {
        if collapsedPaths.contains(path) {
            collapsedPaths.remove(path)
        } else {
            collapsedPaths.insert(path)
        }
    }

    func expandAllFilteredFiles() {
        let paths = Set(filteredFiles.map(\.path))
        collapsedPaths.subtract(paths)
    }

    func collapseAllFilteredFiles() {
        collapsedPaths.formUnion(filteredFiles.map(\.path))
    }

    func clearUnavailableWorkspaceStatus() {
        reloadGeneration += 1
        selectedWorkspaceId = nil
        diff = nil
        selectedPath = nil
        fileFilter = ""
        stageFilter = .all
        collapsedPaths = []
        isLoading = false
        status = "No workspace has diff review enabled."
    }

    var selectedFile: WorkspaceDiffFile? {
        guard let selectedPath else { return nil }
        return files.first { $0.path == selectedPath }
    }

    var selectedName: String {
        selectedFile?.name ?? "Diff Studio"
    }

    var selectedFileCanOpenInEditor: Bool {
        guard let selectedFile else { return false }
        return Self.canOpenInEditor(selectedFile)
    }

    static func canOpenInEditor(_ file: WorkspaceDiffFile) -> Bool {
        if let canOpenInEditor = file.canOpenInEditor {
            return canOpenInEditor
        }
        if file.kind == "deleted" { return false }
        if file.status == "deleted" || file.status == "binary" {
            return false
        }
        if file.status == "hidden_sensitive" { return false }
        if file.previewKind == "binary" || file.previewKind == "hidden" {
            return false
        }
        return file.isBinary != true && file.isSensitive != true
    }

    var selectedFileCanStage: Bool {
        selectedFile?.unstaged == true
    }

    var selectedFileCanUnstage: Bool {
        selectedFile?.staged == true
    }

    static func canStage(_ file: WorkspaceDiffFile) -> Bool {
        file.unstaged == true
    }

    static func canUnstage(_ file: WorkspaceDiffFile) -> Bool {
        file.staged == true
    }

    /// "Showing 40 of N" / relay-budget clipping — rendered as the list footer.
    var truncationFootnote: String? {
        guard let diff else { return nil }
        let total = diff.totalFiles ?? diff.files.count
        if total > diff.files.count {
            return "Showing the first \(diff.files.count) of \(total) changed files."
        }
        if diff.truncated == true || diff.files.contains(where: { $0.truncated == true }) {
            return "Some diffs were truncated to fit the phone budget."
        }
        return nil
    }

    func activate(
        model: RemoteSessionModel,
        preferredWorkspaceId: String?,
        targetPath: String? = nil
    ) {
        let eligible = model.diffReviewableWorkspaces
        guard
            let workspaceId = preferredWorkspaceId.flatMap({ id in
                eligible.first { $0.id == id }?.id
            })
                ?? eligible.first?.id
        else {
            clearUnavailableWorkspaceStatus()
            return
        }
        if selectedWorkspaceId != workspaceId {
            selectedWorkspaceId = workspaceId
            diff = nil
            selectedPath = nil
            fileFilter = ""
            stageFilter = .all
            collapsedPaths = []
        }
        if let targetPath = Self.normalizedTargetPath(targetPath) {
            selectedPath = targetPath
            // Ensure the focused file is expanded in the inline review.
            collapsedPaths.remove(targetPath)
        }
        Task { await reload(model: model) }
    }

    func requestWorkspace(_ workspaceId: String, model: RemoteSessionModel) {
        guard workspaceId != selectedWorkspaceId else { return }
        selectedWorkspaceId = workspaceId
        diff = nil
        selectedPath = nil
        fileFilter = ""
        stageFilter = .all
        collapsedPaths = []
        Task { await reload(model: model) }
    }

    func reload(model: RemoteSessionModel) async {
        guard let workspaceId = selectedWorkspaceId else { return }
        reloadGeneration += 1
        let generation = reloadGeneration
        isLoading = true
        status = "Computing diff..."
        func isCurrentRequest() -> Bool {
            selectedWorkspaceId == workspaceId && reloadGeneration == generation
        }
        defer {
            if isCurrentRequest() {
                isLoading = false
            }
        }
        do {
            let result = try await model.fetchWorkspaceDiff(workspaceId: workspaceId)
            guard isCurrentRequest() else { return }
            diff = result
            // Drop collapse state for paths that left the change set.
            let livePaths = Set(result.files.map(\.path))
            collapsedPaths = collapsedPaths.intersection(livePaths)
            // The previously open file may have left the change set.
            if let selectedPath, !result.files.contains(where: { $0.path == selectedPath }) {
                self.selectedPath = nil
            }
            status = Self.statusText(
                visibleFiles: result.files.count,
                totalFiles: result.totalFiles
            )
        } catch {
            guard isCurrentRequest() else { return }
            status = error.localizedDescription
        }
    }

    func stageSelectedFile(model: RemoteSessionModel) async {
        guard let selectedPath else { return }
        await stageFile(path: selectedPath, model: model)
    }

    func unstageSelectedFile(model: RemoteSessionModel) async {
        guard let selectedPath else { return }
        await unstageFile(path: selectedPath, model: model)
    }

    func stageFile(path: String, model: RemoteSessionModel) async {
        guard let workspaceId = selectedWorkspaceId,
              let file = files.first(where: { $0.path == path }),
              Self.canStage(file)
        else { return }
        isLoading = true
        status = "Staging \(path)..."
        do {
            _ = try await model.stagePaths(workspaceId: workspaceId, paths: [path])
            status = "Staged \(path)"
            await reload(model: model)
        } catch {
            status = error.localizedDescription
        }
        isLoading = false
    }

    func unstageFile(path: String, model: RemoteSessionModel) async {
        guard let workspaceId = selectedWorkspaceId,
              let file = files.first(where: { $0.path == path }),
              Self.canUnstage(file)
        else { return }
        isLoading = true
        status = "Unstaging \(path)..."
        do {
            _ = try await model.unstagePaths(workspaceId: workspaceId, paths: [path])
            status = "Unstaged \(path)"
            await reload(model: model)
        } catch {
            status = error.localizedDescription
        }
        isLoading = false
    }

    static func normalizedTargetPath(_ path: String?) -> String? {
        guard let path else { return nil }
        let normalized = path.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return normalized.isEmpty ? nil : normalized
    }
}

// ── Shell layouts (mirror FilesModeSplitView / FilesModeCompactView) ──────────

struct DiffStudioSplitView: View {
    @ObservedObject var model: RemoteSessionModel
    @ObservedObject var state: MobileDiffStudioState
    let onBack: () -> Void
    let onOpenSelectedFile: (String) -> Void

    var body: some View {
        NavigationSplitView {
            DiffFileNavigatorPane(model: model, state: state)
                .navigationTitle("Diff Studio")
                .toolbar {
                    ToolbarItem(placement: .primaryAction) {
                        Button { Task { await state.reload(model: model) } } label: {
                            Label("Refresh", systemImage: "arrow.clockwise")
                        }
                        .disabled(state.selectedWorkspaceId == nil || state.isLoading)
                    }
                }
        } detail: {
            DiffViewerPane(
                model: model,
                state: state,
                onBack: onBack,
                onOpenSelectedFile: onOpenSelectedFile,
                compact: false)
        }
    }
}

struct DiffStudioCompactView: View {
    @ObservedObject var model: RemoteSessionModel
    @ObservedObject var state: MobileDiffStudioState
    let onExpand: (() -> Void)?
    let onOpenSelectedFile: (String) -> Void
    let onClose: () -> Void

    init(
        model: RemoteSessionModel,
        state: MobileDiffStudioState,
        onExpand: (() -> Void)? = nil,
        onOpenSelectedFile: @escaping (String) -> Void,
        onClose: @escaping () -> Void
    ) {
        self.model = model
        self.state = state
        self.onExpand = onExpand
        self.onOpenSelectedFile = onOpenSelectedFile
        self.onClose = onClose
    }

    var body: some View {
        // Compact hosts always present the Codex-style inline multi-file review.
        // Drill-in to a single-file viewer is reserved for the iPad split detail.
        DiffStudioInlineReviewPane(
            model: model,
            state: state,
            onOpenSelectedFile: onOpenSelectedFile)
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 1) {
                        TWPrincipalTitle(
                            title: principalTitle,
                            subtitle: diffStudioWorkspaceSubtitle(model: model, state: state))
                        if state.files.isEmpty == false {
                            DiffStatChips(
                                additions: state.filteredTotalAdditions,
                                deletions: state.filteredTotalDeletions)
                        }
                    }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { onClose() }
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    if let onExpand {
                        Button(action: onExpand) {
                            Label(
                                "Open full Diff Studio",
                                systemImage: "arrow.up.left.and.arrow.down.right")
                        }
                    }
                    Button { Task { await state.reload(model: model) } } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .disabled(state.selectedWorkspaceId == nil || state.isLoading)
                }
            }
    }

    private var principalTitle: String {
        switch state.stageFilter {
        case .all: return "Diff Studio"
        case .unstaged: return "Unstaged"
        case .staged: return "Staged"
        case .mixed: return "Mixed"
        case .untracked: return "Untracked"
        case .other: return "Other"
        }
    }
}

// ── Sheet glass chrome policy ─────────────────────────────────────────────────

/// How the panes paint beneath their content per host. Glass-hosted covers
/// (composer sheet + phone file-mode fullScreenCover via `twFullScreenLiquidGlass`)
/// keep the canvas clear and wash shared surfaces translucent so the liquid-glass
/// backdrop reads through. Non-glass hosts (iPad split view) keep the opaque app canvas.
enum DiffStudioSheetGlassPolicy {
    static func paintsOpaqueCanvas(glassSheetHosted: Bool) -> Bool {
        !glassSheetHosted
    }

    /// Alpha for chrome surfaces (navigator rows, viewer header/status bars)
    /// over the glass backdrop; nil keeps the host's default opaque fill.
    /// Delegates to the shared sheet-wide chrome tier so every glass-hosted
    /// sheet washes surfaces identically.
    static func chromeFillAlpha(glassSheetHosted: Bool, glassEnabled: Bool, isLight: Bool = false) -> Double? {
        TWGlassSheetSurfacePolicy.chromeFillAlpha(
            glassSheetHosted: glassSheetHosted, glassEnabled: glassEnabled, isLight: isLight)
    }

    /// Alpha for the hunk-grid code panel — less transparent than the chrome
    /// wash so monospace diff text keeps contrast over the glass.
    static func codePanelFillAlpha(glassSheetHosted: Bool, glassEnabled: Bool) -> Double? {
        guard glassSheetHosted else { return nil }
        return glassEnabled ? 0.42 : 1.0
    }

    /// Card wash for inline file cards on the glass sheet. Lighter than the
    /// old List row fill so the liquid-glass backdrop reads between cards.
    static func inlineCardFillAlpha(glassSheetHosted: Bool, glassEnabled: Bool, isLight: Bool = false) -> Double? {
        guard glassSheetHosted else { return nil }
        guard glassEnabled else { return 1.0 }
        return isLight ? 0.55 : 0.22
    }
}

// ── Compact inline multi-file review (Codex-style) ────────────────────────────

private struct DiffStudioInlineReviewPane: View {
    @ObservedObject var model: RemoteSessionModel
    @ObservedObject var state: MobileDiffStudioState
    let onOpenSelectedFile: (String) -> Void
    @Environment(\.twGlassSheetHosted) private var glassSheetHosted

    private var canvasFill: Color {
        DiffStudioSheetGlassPolicy.paintsOpaqueCanvas(glassSheetHosted: glassSheetHosted)
            ? TWTheme.sidebarBg : Color.clear
    }

    private var cardFill: Color {
        guard
            let alpha = DiffStudioSheetGlassPolicy.inlineCardFillAlpha(
                glassSheetHosted: glassSheetHosted,
                glassEnabled: TWTheme.composerGlassEnabled,
                isLight: TWThemeStore.shared.systemTheme.isLight)
        else { return TWTheme.surface1 }
        return TWTheme.surface1.opacity(alpha)
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                controlsCard

                if state.files.isEmpty {
                    emptyStatusCard(
                        state.isLoading ? "Computing diff..." : state.status)
                } else if state.filteredFiles.isEmpty {
                    emptyStatusCard(state.emptyFilterMessage)
                } else {
                    ForEach(state.filteredFiles) { file in
                        DiffInlineFileCard(
                            file: file,
                            expanded: state.isFileExpanded(file.path),
                            canEdit: model.workspaceCanEditFiles(state.selectedWorkspaceId),
                            isLoading: state.isLoading,
                            cardFill: cardFill,
                            onToggle: { state.toggleFileExpanded(file.path) },
                            onOpen: { onOpenSelectedFile(file.path) },
                            onStage: {
                                Task { await state.stageFile(path: file.path, model: model) }
                            },
                            onUnstage: {
                                Task { await state.unstageFile(path: file.path, model: model) }
                            })
                    }
                }

                footerNotes
            }
            .padding(.horizontal, 14)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .scrollContentBackground(.hidden)
        .background(canvasFill)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Diff studio inline review")
        .accessibilityValue(state.status)
        .accessibilityAddTraits(state.isLoading ? .updatesFrequently : [])
        .onChange(of: state.status) { _, newStatus in
            if twShouldAnnounceDiffStudioStatus(newStatus) {
                AccessibilityNotification.Announcement(newStatus).post()
            }
        }
    }

    private var controlsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            if model.diffReviewableWorkspaces.count > 1 {
                Picker(
                    "Workspace",
                    selection: Binding(
                        get: {
                            state.selectedWorkspaceId
                                ?? model.diffReviewableWorkspaces.first?.id ?? ""
                        },
                        set: { state.requestWorkspace($0, model: model) }
                    )
                ) {
                    ForEach(model.diffReviewableWorkspaces) { workspace in
                        Text(workspace.displayName).tag(workspace.id)
                    }
                }
                .pickerStyle(.menu)
                .accessibilityLabel("Workspace")
            }

            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(TWTheme.textMuted)
                TextField("Filter files", text: $state.fileFilter)
                    .disableAutocorrection(true)
                    #if os(iOS)
                        .textInputAutocapitalization(.never)
                    #endif
                    .accessibilityLabel("Filter changed files")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(TWTheme.surface2.opacity(glassSheetHosted ? 0.35 : 0.9), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(MobileDiffStageFilter.compactChipFilters) { filter in
                        DiffStageChipButton(
                            title: filter.label,
                            selected: state.stageFilter == filter
                        ) {
                            state.stageFilter = filter
                        }
                    }
                    Menu {
                        ForEach(MobileDiffStageFilter.allCases) { filter in
                            Button {
                                state.stageFilter = filter
                            } label: {
                                if state.stageFilter == filter {
                                    Label(filter.label, systemImage: "checkmark")
                                } else {
                                    Text(filter.label)
                                }
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .font(.body.weight(.medium))
                            .foregroundStyle(TWTheme.textSecondary)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 7)
                    }
                    .accessibilityLabel("More change groups")
                }
            }

            HStack(spacing: 12) {
                Button("Expand all") { state.expandAllFilteredFiles() }
                    .font(.caption.weight(.semibold))
                Button("Collapse all") { state.collapseAllFilteredFiles() }
                    .font(.caption.weight(.semibold))
                Spacer()
                Text(state.status)
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textMuted)
                    .lineLimit(1)
            }
            .foregroundStyle(TWTheme.chroma1)
        }
        .padding(12)
        .background(cardFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(TWTheme.border.opacity(glassSheetHosted ? 0.45 : 0.8), lineWidth: 1)
        )
    }

    private func emptyStatusCard(_ message: String) -> some View {
        Text(message)
            .font(.callout)
            .foregroundStyle(TWTheme.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(cardFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    @ViewBuilder
    private var footerNotes: some View {
        let notes = [state.stageFilterStatus, state.fileFilterStatus, state.truncationFootnote]
            .compactMap { $0 }
        if !notes.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(notes, id: \.self) { note in
                    Text(note)
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textMuted)
                }
            }
            .padding(.horizontal, 4)
            .padding(.top, 4)
        }
    }
}

private struct DiffStageChipButton: View {
    let title: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(
                    Capsule().fill(
                        selected
                            ? TWTheme.surface2.opacity(0.95)
                            : TWTheme.surface2.opacity(0.28))
                )
                .foregroundStyle(selected ? TWTheme.textPrimary : TWTheme.textSecondary)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityLabel("\(title) change group")
    }
}

private struct DiffInlineFileCard: View {
    let file: WorkspaceDiffFile
    let expanded: Bool
    let canEdit: Bool
    let isLoading: Bool
    let cardFill: Color
    let onToggle: () -> Void
    let onOpen: () -> Void
    let onStage: () -> Void
    let onUnstage: () -> Void
    @Environment(\.twGlassSheetHosted) private var glassSheetHosted

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if expanded {
                Divider().overlay(TWTheme.border.opacity(0.55))
                DiffHunksView(file: file, layout: .inlineCard)
                    .clipShape(
                        UnevenRoundedRectangle(
                            bottomLeadingRadius: 16,
                            bottomTrailingRadius: 16,
                            style: .continuous)
                    )
            }
        }
        .background(cardFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(TWTheme.border.opacity(glassSheetHosted ? 0.4 : 0.75), lineWidth: 1)
        )
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                Button(action: onToggle) {
                    HStack(spacing: 8) {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(TWTheme.textMuted)
                            .frame(width: 12)
                        Text(file.name)
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(TWTheme.textPrimary)
                            .lineLimit(1)
                        Spacer(minLength: 6)
                        DiffStatChips(additions: file.additions, deletions: file.deletions)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(expanded ? "Collapse \(file.name)" : "Expand \(file.name)")

                if MobileDiffStudioState.canOpenInEditor(file) {
                    Button(action: onOpen) {
                        Image(systemName: "arrow.up.right.square")
                            .font(.body.weight(.medium))
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Open \(file.name) in Files")
                }
            }

            HStack(spacing: 6) {
                DiffKindChip(kind: file.kind)
                DiffStageChip(file: file)
                Text(file.path)
                    .font(.caption2.monospaced())
                    .foregroundStyle(TWTheme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.head)
                Spacer(minLength: 0)
                if canEdit {
                    if MobileDiffStudioState.canStage(file) {
                        Button(action: onStage) {
                            Image(systemName: "plus.circle")
                        }
                        .buttonStyle(.borderless)
                        .disabled(isLoading)
                        .accessibilityLabel("Stage \(file.name)")
                    }
                    if MobileDiffStudioState.canUnstage(file) {
                        Button(action: onUnstage) {
                            Image(systemName: "minus.circle")
                        }
                        .buttonStyle(.borderless)
                        .disabled(isLoading)
                        .accessibilityLabel("Unstage \(file.name)")
                    }
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }
}

// ── Changed-file rail (iPad split navigator) ───────────────────────────────────

private struct DiffFileNavigatorPane: View {
    @ObservedObject var model: RemoteSessionModel
    @ObservedObject var state: MobileDiffStudioState
    @Environment(\.twGlassSheetHosted) private var glassSheetHosted

    /// Translucent row cards over the sheet's glass backdrop; nil keeps the
    /// system grouped-row fill in the full-screen hosts.
    private var glassRowFill: Color? {
        guard
            let alpha = DiffStudioSheetGlassPolicy.chromeFillAlpha(
                glassSheetHosted: glassSheetHosted,
                glassEnabled: TWTheme.composerGlassEnabled,
                isLight: TWThemeStore.shared.systemTheme.isLight)
        else { return nil }
        return TWTheme.surface1.opacity(alpha)
    }

    private var canvasFill: Color {
        DiffStudioSheetGlassPolicy.paintsOpaqueCanvas(glassSheetHosted: glassSheetHosted)
            ? TWTheme.sidebarBg : Color.clear
    }

    var body: some View {
        List {
            if !model.diffReviewableWorkspaces.isEmpty {
                Section {
                    Picker(
                        "Workspace",
                        selection: Binding(
                            get: {
                                state.selectedWorkspaceId
                                    ?? model.diffReviewableWorkspaces.first?.id ?? ""
                            },
                            set: { state.requestWorkspace($0, model: model) }
                        )
                    ) {
                        ForEach(model.diffReviewableWorkspaces) { workspace in
                            Text(workspace.displayName).tag(workspace.id)
                        }
                    }
                }
                .listRowBackground(glassRowFill)
            }

            Section {
                TextField("Filter files", text: $state.fileFilter)
                    .disableAutocorrection(true)
                    .accessibilityLabel("Filter changed files")
            }
            .listRowBackground(glassRowFill)

            Section {
                Picker("Change Group", selection: $state.stageFilter) {
                    ForEach(MobileDiffStageFilter.allCases) { filter in
                        Text(filter.label).tag(filter)
                    }
                }
                .pickerStyle(.menu)
                .accessibilityLabel("Filter by change group")
            }
            .listRowBackground(glassRowFill)

            Section {
                if state.files.isEmpty {
                    Text(state.isLoading ? "Computing diff..." : state.status)
                        .foregroundStyle(TWTheme.textMuted)
                        .accessibilityLabel("Diff studio status")
                        .accessibilityValue(
                            state.isLoading ? "Computing diff" : state.status)
                        .accessibilityAddTraits(state.isLoading ? .updatesFrequently : [])
                } else if state.filteredFiles.isEmpty {
                    Text(state.emptyFilterMessage)
                        .foregroundStyle(TWTheme.textMuted)
                } else {
                    ForEach(state.filteredFiles) { file in
                        Button {
                            state.selectedPath = file.path
                        } label: {
                            DiffFileRow(file: file, selected: state.selectedPath == file.path)
                        }
                        .disabled(state.isLoading)
                    }
                }
            } footer: {
                VStack(alignment: .leading, spacing: 4) {
                    if let stageFilterStatus = state.stageFilterStatus {
                        Text(stageFilterStatus)
                    }
                    if let filterStatus = state.fileFilterStatus {
                        Text(filterStatus)
                    }
                    if let footnote = state.truncationFootnote {
                        Text(footnote)
                    }
                }
            }
            .listRowBackground(glassRowFill)
        }
        .scrollContentBackground(.hidden)
        .background(canvasFill)
    }
}

private struct DiffFileRow: View {
    let file: WorkspaceDiffFile
    let selected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(file.name)
                    .font(.callout)
                    .lineLimit(1)
                    .foregroundStyle(selected ? TWTheme.textPrimary : TWTheme.textSecondary)
                Spacer(minLength: 6)
                DiffStatChips(additions: file.additions, deletions: file.deletions)
            }
            HStack(spacing: 6) {
                DiffKindChip(kind: file.kind)
                DiffStageChip(file: file)
                Text(file.path)
                    .font(.caption2.monospaced())
                    .foregroundStyle(TWTheme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilitySummary)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var accessibilitySummary: String {
        var parts: [String] = []
        switch file.kind {
        case "created": parts.append("created")
        case "deleted": parts.append("deleted")
        default: parts.append("modified")
        }
        if let stage = DiffStageChip.label(for: file) {
            parts.append(stage.lowercased())
        }
        if let additions = file.additions, additions > 0 {
            parts.append("+\(additions)")
        }
        if let deletions = file.deletions, deletions > 0 {
            parts.append("−\(deletions)")
        }
        parts.append(file.path)
        return parts.joined(separator: ", ")
    }
}

/// Created / Modified / Deleted capsule — desktop Diff Studio rail parity.
struct DiffKindChip: View {
    let kind: String

    private var label: String {
        switch kind {
        case "created": return "Created"
        case "deleted": return "Deleted"
        default: return "Modified"
        }
    }

    private var color: Color {
        switch kind {
        case "created": return TWTheme.diffStatAdd
        case "deleted": return TWTheme.diffStatDel
        default: return TWTheme.statusAttention
        }
    }

    var body: some View {
        Text(label)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.14), in: Capsule())
            .foregroundStyle(color)
    }
}

/// Staged / Unstaged capsule — mirrors the desktop Diff Studio rail grouping.
struct DiffStageChip: View {
    let file: WorkspaceDiffFile

    static func label(for file: WorkspaceDiffFile) -> String? {
        if file.staged == true && file.unstaged == true { return "Mixed" }
        if file.staged == true { return "Staged" }
        if file.unstaged == true { return "Unstaged" }
        return nil
    }

    private var label: String? { Self.label(for: file) }

    private var color: Color {
        if file.staged == true && file.unstaged == true { return TWTheme.statusAttention }
        if file.staged == true { return TWTheme.statusSuccess }
        return TWTheme.textMuted
    }

    var body: some View {
        if let label {
            Text(label)
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(color.opacity(0.12), in: Capsule())
                .foregroundStyle(color)
        }
    }
}

/// +N (green) / −M (red) pair, shared by the rail rows and the viewer header.
struct DiffStatChips: View {
    let additions: Int?
    let deletions: Int?

    var body: some View {
        HStack(spacing: 4) {
            if let additions, additions > 0 {
                Text("+\(additions)")
                    .font(.caption2.weight(.semibold).monospacedDigit())
                    .foregroundStyle(TWTheme.diffStatAdd)
            }
            if let deletions, deletions > 0 {
                Text("−\(deletions)")
                    .font(.caption2.weight(.semibold).monospacedDigit())
                    .foregroundStyle(TWTheme.diffStatDel)
            }
        }
    }
}

// ── Unified diff viewer ────────────────────────────────────────────────────────

private struct DiffViewerPane: View {
    @ObservedObject var model: RemoteSessionModel
    @ObservedObject var state: MobileDiffStudioState
    let onBack: () -> Void
    var onExpand: (() -> Void)? = nil
    var onOpenSelectedFile: ((String) -> Void)? = nil
    let compact: Bool
    @Environment(\.twGlassSheetHosted) private var glassSheetHosted
    @Environment(\.appScale) private var appScale
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var canvasFill: Color {
        DiffStudioSheetGlassPolicy.paintsOpaqueCanvas(glassSheetHosted: glassSheetHosted)
            ? TWTheme.appBg : Color.clear
    }

    private var chromeBarFill: Color {
        guard
            let alpha = DiffStudioSheetGlassPolicy.chromeFillAlpha(
                glassSheetHosted: glassSheetHosted,
                glassEnabled: TWTheme.composerGlassEnabled,
                isLight: TWThemeStore.shared.systemTheme.isLight)
        else { return TWTheme.surface1 }
        return TWTheme.surface1.opacity(alpha)
    }

    var body: some View {
        // Budgeted against the PANE, not the size class — see
        // WorkspaceHeaderChrome.swift and DESIGN.md v0.13. Read inline, never
        // written back to @State.
        GeometryReader { pane in
            paneBody(
                TWWorkspaceHeaderPolicy.layout(
                    paneWidth: pane.size.width,
                    backTitle: backTitle,
                    actionTitles: actionTitles,
                    trailingReserved: trailingReserved,
                    scale: appScale,
                    typeSize: dynamicTypeSize)
            )
            // Load-bearing: GeometryReader gives its child no size proposal
            // and pins it top-leading.
            .frame(width: pane.size.width, height: pane.size.height)
        }
    }

    private func paneBody(_ layout: TWWorkspaceHeaderLayout) -> some View {
        VStack(spacing: 0) {
            header(layout)
            Divider().overlay(TWTheme.border)
            if let file = state.selectedFile {
                DiffHunksView(file: file, layout: .pane)
            } else {
                VStack(spacing: 10) {
                    Image(systemName: "plus.forwardslash.minus")
                        .font(.system(size: 34))
                        .foregroundStyle(TWTheme.textMuted)
                    Text(state.files.isEmpty ? "No changes to review" : "Select a changed file")
                        .foregroundStyle(TWTheme.textSecondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(canvasFill)
            }
            Divider().overlay(TWTheme.border)
            HStack {
                Text(state.status)
                    .font(.caption)
                    .foregroundStyle(TWTheme.textMuted)
                    .lineLimit(1)
                Spacer()
                if let selectedPath = state.selectedPath {
                    Text(selectedPath)
                        .font(.caption2.monospaced())
                        .foregroundStyle(TWTheme.textMuted)
                        .lineLimit(1)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Diff viewer status")
            .accessibilityValue(state.status)
            .accessibilityAddTraits(state.isLoading ? .updatesFrequently : [])
            .onChange(of: state.status) { _, newStatus in
                if twShouldAnnounceDiffStudioStatus(newStatus) {
                    AccessibilityNotification.Announcement(newStatus).post()
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(chromeBarFill)
        }
        .background(canvasFill)
        .navigationTitle(state.selectedName)
        .diffStudioInlineTitle()
    }

    private var backTitle: String { compact ? "Changes" : "Back to app" }

    private var canEditFiles: Bool {
        model.workspaceCanEditFiles(state.selectedWorkspaceId)
    }

    /// The wording-bearing actions, in bar order. Unlike the file editor's
    /// fixed vocabulary these are capability-GATED — an absent action is not in
    /// the bar at all, so a read-only workspace correctly buys wording for the
    /// two that remain.
    private var actionTitles: [String] {
        var titles: [String] = []
        if onOpenSelectedFile != nil { titles.append("Open in Files") }
        if canEditFiles {
            titles.append("Stage")
            titles.append("Unstage")
        }
        return titles
    }

    /// "+120 −48" at caption2 monospaced digits, plus its inner gap.
    private static let statChipsWidth: CGFloat = 76

    /// Trailing chrome the budget must hold back but that carries no wording of
    /// its own: the expand glyph and the ± chips.
    private var trailingReserved: CGFloat {
        var reserved: CGFloat = 0
        if onExpand != nil { reserved += TWWorkspaceHeaderPolicy.glyphControlWidth }
        if state.selectedFile != nil { reserved += Self.statChipsWidth }
        return reserved
    }

    private func header(_ layout: TWWorkspaceHeaderLayout) -> some View {
        HStack(spacing: 10) {
            TWChromeBackButton(title: backTitle, showsLabel: layout.backShowsLabel) {
                if compact {
                    state.selectedPath = nil
                } else {
                    onBack()
                }
            }

            TWWorkspaceHeaderTitle(
                name: state.selectedName,
                subtitle: state.selectedPath ?? "No file selected"
            ) {
                if let file = state.selectedFile {
                    DiffKindChip(kind: file.kind)
                }
            }

            // Fixed-size: the run holds its intrinsic width or drops to
            // glyphs. It must never be the thing that compresses.
            HStack(spacing: 0) {
                if let onExpand {
                    Button(action: onExpand) {
                        TWChromeActionLabel(
                            title: "Open full Diff Studio",
                            systemImage: "arrow.up.left.and.arrow.down.right",
                            showsLabel: false)
                    }
                    .buttonStyle(TWChromeActionButtonStyle(tone: .standard))
                }
                if let onOpenSelectedFile {
                    Button {
                        if let selectedPath = state.selectedPath {
                            onOpenSelectedFile(selectedPath)
                        }
                    } label: {
                        TWChromeActionLabel(
                            title: "Open in Files",
                            systemImage: "doc.text.magnifyingglass",
                            showsLabel: layout.actionsShowLabels)
                    }
                    .buttonStyle(TWChromeActionButtonStyle(tone: .standard))
                    .disabled(!state.selectedFileCanOpenInEditor || !canEditFiles)
                }
                if canEditFiles {
                    Button {
                        Task { await state.stageSelectedFile(model: model) }
                    } label: {
                        TWChromeActionLabel(
                            title: "Stage",
                            systemImage: "plus.circle",
                            showsLabel: layout.actionsShowLabels)
                    }
                    .buttonStyle(TWChromeActionButtonStyle(tone: .prominent))
                    .disabled(!state.selectedFileCanStage || state.isLoading)

                    Button {
                        Task { await state.unstageSelectedFile(model: model) }
                    } label: {
                        TWChromeActionLabel(
                            title: "Unstage",
                            systemImage: "minus.circle",
                            showsLabel: layout.actionsShowLabels)
                    }
                    .buttonStyle(TWChromeActionButtonStyle(tone: .standard))
                    .disabled(!state.selectedFileCanUnstage || state.isLoading)
                }
                if let file = state.selectedFile {
                    DiffStatChips(additions: file.additions, deletions: file.deletions)
                        .padding(.leading, 6)
                }
            }
            .fixedSize(horizontal: true, vertical: false)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(chromeBarFill)
    }
}

enum DiffHunksLayout {
    /// Full detail pane: dual-axis scroll with fixed content width.
    case pane
    /// Inline file card: vertical-only, fits card width (no nested vertical scroll).
    case inlineCard
}

private struct DiffHunksView: View {
    let file: WorkspaceDiffFile
    var layout: DiffHunksLayout = .pane
    @Environment(\.twGlassSheetHosted) private var glassSheetHosted

    private var hunks: [WorkspaceDiffHunk] { file.hunks ?? [] }

    private var codePanelFill: Color {
        guard
            let alpha = DiffStudioSheetGlassPolicy.codePanelFillAlpha(
                glassSheetHosted: glassSheetHosted,
                glassEnabled: TWTheme.composerGlassEnabled)
        else { return TWTheme.appBg }
        // Inline cards keep the code panel more transparent so glass shows through.
        let adjusted: Double = layout == .inlineCard ? min(alpha, 0.28) : alpha
        return TWTheme.appBg.opacity(adjusted)
    }

    /// Widest clipped line (≤400 chars) sets the scrollable width — fixed
    /// row widths keep the add/del tints uniform inside the two-axis scroll.
    /// SF Mono at size 12 advances ~7.25pt/char; 96pt covers the gutters.
    private var contentWidth: CGFloat {
        let maxChars = hunks.flatMap(\.lines).map(\.text.count).max() ?? 0
        return max(360, CGFloat(maxChars) * 7.3 + 110)
    }

    var body: some View {
        if hunks.isEmpty {
            VStack(spacing: 8) {
                Image(systemName: "eye.slash")
                    .font(.system(size: layout == .inlineCard ? 22 : 30))
                    .foregroundStyle(TWTheme.textMuted)
                Text("No line preview for this file")
                    .font(layout == .inlineCard ? .footnote : .body)
                    .foregroundStyle(TWTheme.textSecondary)
                if layout == .pane {
                    Text("Binary, oversized, or sensitive files keep their counts but ship no hunks.")
                        .font(.caption)
                        .foregroundStyle(TWTheme.textMuted)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, layout == .inlineCard ? 16 : 0)
            .frame(maxHeight: layout == .pane ? .infinity : nil)
            .background(codePanelFill)
        } else if layout == .inlineCard {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(hunks.enumerated()), id: \.offset) { _, hunk in
                    DiffInlineHunkHeader(hunk: hunk, file: file)
                    ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                        DiffLineRow(line: line, width: nil)
                    }
                }
                if file.truncated == true {
                    Text("Diff truncated — open Diff Studio on your Mac for the full file.")
                        .font(.footnote)
                        .foregroundStyle(TWTheme.textMuted)
                        .padding(10)
                }
            }
            .background(codePanelFill)
        } else {
            ScrollView([.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    DiffColumnHeaderRow(width: contentWidth)
                    ForEach(Array(hunks.enumerated()), id: \.offset) { _, hunk in
                        DiffHunkHeaderRow(header: hunk.header, width: contentWidth)
                        ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                            DiffLineRow(line: line, width: contentWidth)
                        }
                    }
                    if file.truncated == true {
                        Text("Diff truncated — open Diff Studio on your Mac for the full file.")
                            .font(.footnote)
                            .foregroundStyle(TWTheme.textMuted)
                            .padding(10)
                    }
                }
                .padding(.vertical, 6)
            }
            .background(codePanelFill)
        }
    }
}

private struct DiffInlineHunkHeader: View {
    let hunk: WorkspaceDiffHunk
    let file: WorkspaceDiffFile

    private var rangeLabel: String {
        let lines = hunk.lines
        let olds = lines.compactMap(\.oldLine)
        let news = lines.compactMap(\.newLine)
        if let lo = olds.min(), let hi = olds.max(), lo != hi {
            return "Lines \(lo)–\(hi)"
        }
        if let lo = news.min(), let hi = news.max(), lo != hi {
            return "Lines \(lo)–\(hi)"
        }
        if let single = olds.first ?? news.first {
            return "Line \(single)"
        }
        // Fall back to the raw @@ header when line numbers are missing.
        let trimmed = hunk.header.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Hunk" : trimmed
    }

    private var hunkAdditions: Int {
        hunk.lines.filter { $0.type == "add" }.count
    }

    private var hunkDeletions: Int {
        hunk.lines.filter { $0.type == "del" }.count
    }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "chevron.down")
                .font(.caption2.weight(.bold))
                .foregroundStyle(TWTheme.textMuted)
            Text(rangeLabel)
                .font(.caption.weight(.semibold))
                .foregroundStyle(TWTheme.textSecondary)
                .lineLimit(1)
            Spacer(minLength: 6)
            DiffStatChips(
                additions: hunkAdditions > 0 ? hunkAdditions : nil,
                deletions: hunkDeletions > 0 ? hunkDeletions : nil)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TWTheme.surface2.opacity(0.35))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(rangeLabel), \(file.name)")
    }
}

private struct DiffColumnHeaderRow: View {
    let width: CGFloat

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(MobileDiffStudioState.diffColumnLabels.enumerated()), id: \.offset) { index, label in
                Text(label)
                    .frame(width: widthForColumn(at: index), alignment: alignmentForColumn(at: index))
                    .foregroundStyle(TWTheme.textMuted)
            }
            Spacer(minLength: 0)
        }
        .font(.caption2.weight(.semibold).monospaced())
        .textCase(.uppercase)
        .padding(.vertical, 4)
        .frame(width: width, alignment: .leading)
        .background(TWTheme.surface1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Diff columns: old line, new line, change marker, line text")
    }

    private func widthForColumn(at index: Int) -> CGFloat? {
        switch index {
        case 0, 1: return 36
        case 2: return 18
        default: return nil
        }
    }

    private func alignmentForColumn(at index: Int) -> Alignment {
        switch index {
        case 0, 1: return .trailing
        case 2: return .center
        default: return .leading
        }
    }
}

private struct DiffHunkHeaderRow: View {
    let header: String
    let width: CGFloat

    var body: some View {
        Text(header)
            .font(.caption.monospaced())
            .foregroundStyle(TWTheme.textTertiary)
            .lineLimit(1)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .frame(width: width, alignment: .leading)
            .background(TWTheme.surface2.opacity(0.6))
    }
}

private struct DiffLineRow: View {
    let line: WorkspaceDiffLine
    /// Fixed width for dual-axis pane scroll; nil fills the available card width.
    let width: CGFloat?

    private var isInline: Bool { width == nil }

    private var rowBackground: Color {
        switch line.type {
        case "add": return TWTheme.diffAddBg
        case "del": return TWTheme.diffDelBg
        default: return .clear
        }
    }

    private var textColor: Color {
        switch line.type {
        case "add": return TWTheme.diffAddText
        case "del": return TWTheme.diffDelText
        case "ctx": return TWTheme.textSecondary
        default: return TWTheme.textPrimary
        }
    }

    private var marker: String {
        switch line.type {
        case "add": return "+"
        case "del": return "-"
        default: return " "
        }
    }

    private var markerColor: Color {
        switch line.type {
        case "add": return TWTheme.diffStatAdd
        case "del": return TWTheme.diffStatDel
        default: return TWTheme.textMuted
        }
    }

    /// Codex-style single gutter: prefer old line, else new line.
    private var inlineGutter: String {
        if let old = line.oldLine { return String(old) }
        if let new = line.newLine { return String(new) }
        return ""
    }

    var body: some View {
        HStack(spacing: 0) {
            if isInline {
                Text(inlineGutter)
                    .frame(width: 28, alignment: .trailing)
                    .foregroundStyle(TWTheme.textMuted)
            } else {
                Text(line.oldLine.map(String.init) ?? "")
                    .frame(width: 36, alignment: .trailing)
                    .foregroundStyle(TWTheme.textMuted)
                Text(line.newLine.map(String.init) ?? "")
                    .frame(width: 36, alignment: .trailing)
                    .foregroundStyle(TWTheme.textMuted)
            }
            Text(marker)
                .frame(width: isInline ? 16 : 18, alignment: .center)
                .foregroundStyle(markerColor)
            Text(line.text.isEmpty ? " " : line.text)
                .foregroundStyle(textColor)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
        }
        .font(.system(size: isInline ? 11.5 : 12, design: .monospaced))
        .padding(.vertical, 1)
        .padding(.trailing, isInline ? 8 : 0)
        .frame(width: width, alignment: .leading)
        .frame(maxWidth: isInline ? .infinity : nil, alignment: .leading)
        .background(rowBackground)
    }
}

private extension View {
    @ViewBuilder
    func diffStudioInlineTitle() -> some View {
        #if os(iOS)
            self.navigationBarTitleDisplayMode(.inline)
        #else
            self
        #endif
    }
}

@MainActor
private func diffStudioWorkspaceSubtitle(
    model: RemoteSessionModel, state: MobileDiffStudioState
) -> String? {
    guard let workspaceId = state.selectedWorkspaceId else { return nil }
    return model.workspaces.first(where: { $0.id == workspaceId })?.displayName
}

private func twShouldAnnounceDiffStudioStatus(_ status: String) -> Bool {
    let trimmed = status.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return false }
    let lower = trimmed.lowercased()
    let inProgressPrefixes = ["computing", "staging", "unstaging"]
    if inProgressPrefixes.contains(where: { lower.hasPrefix($0) }) { return false }
    if lower.hasPrefix("staged ") || lower.hasPrefix("unstaged ") { return false }
    if lower.contains("changed file") || lower.contains("no workspace") { return false }
    if lower.contains("no changes") { return false }
    return true
}
