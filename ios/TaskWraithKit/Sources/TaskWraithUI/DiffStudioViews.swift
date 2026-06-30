// Diff Studio mode — the phone-sized cut of the desktop Diff Studio.
//
// Same layout-swap architecture as Files mode (FileEditorViews.swift): the
// plus.forwardslash.minus toolbar button flips the iPad shell into a
// NavigationSplitView (left = changed files with +N/−M chips, detail = the
// unified diff) and presents a full-screen cover on iPhone. The Mac computes
// the diff with the SAME git surface the desktop Diff Studio renders
// (`workspaceDiff` bridge action → DiffService.buildBoundedWorkspaceDiff),
// hard-capped for the relay budget; read-only, gated by `diffReview`.

import SwiftUI
import TaskWraithKit

@MainActor
final class MobileDiffStudioState: ObservableObject {
    @Published var selectedWorkspaceId: String?
    @Published var diff: WorkspaceDiffResult?
    @Published var selectedPath: String?
    @Published var status = ""
    @Published var isLoading = false
    @Published var fileFilter = ""

    private var reloadGeneration = 0

    var files: [WorkspaceDiffFile] { diff?.files ?? [] }

    var filteredFiles: [WorkspaceDiffFile] {
        Self.filterFiles(files, query: fileFilter)
    }

    var fileFilterStatus: String? {
        let query = fileFilter.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return nil }
        let matchCount = filteredFiles.count
        return "\(matchCount) of \(files.count) file\(files.count == 1 ? "" : "s") match \"\(query)\"."
    }

    static func statusText(visibleFiles: Int, totalFiles: Int?) -> String {
        let count = max(totalFiles ?? visibleFiles, visibleFiles)
        return count == 0
            ? "No changes."
            : "\(count) changed file\(count == 1 ? "" : "s")"
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

    func clearUnavailableWorkspaceStatus() {
        reloadGeneration += 1
        selectedWorkspaceId = nil
        diff = nil
        selectedPath = nil
        fileFilter = ""
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
        if let canOpenInEditor = selectedFile.canOpenInEditor {
            return canOpenInEditor
        }
        if selectedFile.kind == "deleted" { return false }
        if selectedFile.status == "deleted" || selectedFile.status == "binary" {
            return false
        }
        if selectedFile.status == "hidden_sensitive" { return false }
        if selectedFile.previewKind == "binary" || selectedFile.previewKind == "hidden" {
            return false
        }
        return selectedFile.isBinary != true && selectedFile.isSensitive != true
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
        }
        if let targetPath = Self.normalizedTargetPath(targetPath) {
            selectedPath = targetPath
        }
        Task { await reload(model: model) }
    }

    func requestWorkspace(_ workspaceId: String, model: RemoteSessionModel) {
        guard workspaceId != selectedWorkspaceId else { return }
        selectedWorkspaceId = workspaceId
        diff = nil
        selectedPath = nil
        fileFilter = ""
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
        Group {
            if state.selectedPath == nil {
                DiffFileNavigatorPane(model: model, state: state)
                    .navigationTitle("Diff Studio")
                    .toolbar {
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
            } else {
                DiffViewerPane(
                    model: model,
                    state: state,
                    onBack: onClose,
                    onExpand: onExpand,
                    onOpenSelectedFile: onOpenSelectedFile,
                    compact: true)
            }
        }
    }
}

// ── Changed-file rail ──────────────────────────────────────────────────────────

private struct DiffFileNavigatorPane: View {
    @ObservedObject var model: RemoteSessionModel
    @ObservedObject var state: MobileDiffStudioState

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
            }

            Section {
                TextField("Filter files", text: $state.fileFilter)
                    .disableAutocorrection(true)
                    .accessibilityLabel("Filter changed files")
            }

            Section {
                if state.files.isEmpty {
                    Text(state.isLoading ? "Computing diff..." : state.status)
                        .foregroundStyle(TWTheme.textMuted)
                } else if state.filteredFiles.isEmpty {
                    Text("No changed files match \"\(state.fileFilter.trimmingCharacters(in: .whitespacesAndNewlines))\".")
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
                    if let filterStatus = state.fileFilterStatus {
                        Text(filterStatus)
                    }
                    if let footnote = state.truncationFootnote {
                        Text(footnote)
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(TWTheme.sidebarBg)
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
                Text(file.path)
                    .font(.caption2.monospaced())
                    .foregroundStyle(TWTheme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
        }
        .padding(.vertical, 2)
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
        case "created": return TWTheme.statusSuccess
        case "deleted": return TWTheme.statusFailed
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

/// +N (green) / −M (red) pair, shared by the rail rows and the viewer header.
struct DiffStatChips: View {
    let additions: Int?
    let deletions: Int?

    var body: some View {
        if let additions, additions > 0 {
            Text("+\(additions)")
                .font(.caption2.weight(.semibold).monospacedDigit())
                .foregroundStyle(TWTheme.statusSuccess)
        }
        if let deletions, deletions > 0 {
            Text("−\(deletions)")
                .font(.caption2.weight(.semibold).monospacedDigit())
                .foregroundStyle(TWTheme.statusFailed)
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

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(TWTheme.border)
            if let file = state.selectedFile {
                DiffHunksView(file: file)
            } else {
                VStack(spacing: 10) {
                    Image(systemName: "plus.forwardslash.minus")
                        .font(.system(size: 34))
                        .foregroundStyle(TWTheme.textMuted)
                    Text(state.files.isEmpty ? "No changes to review" : "Select a changed file")
                        .foregroundStyle(TWTheme.textSecondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(TWTheme.appBg)
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
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(TWTheme.surface1)
        }
        .background(TWTheme.appBg)
        .navigationTitle(state.selectedName)
        .diffStudioInlineTitle()
    }

    private var header: some View {
        HStack(spacing: 10) {
            Button {
                if compact {
                    state.selectedPath = nil
                } else {
                    onBack()
                }
            } label: {
                Label(
                    compact ? "Changes" : "Back to app",
                    systemImage: compact ? "chevron.left" : "arrow.uturn.backward")
            }
            .buttonStyle(.bordered)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(state.selectedName)
                        .font(.headline)
                        .lineLimit(1)
                    if let file = state.selectedFile {
                        DiffKindChip(kind: file.kind)
                    }
                }
                Text(state.selectedPath ?? "No file selected")
                    .font(.caption)
                    .foregroundStyle(TWTheme.textMuted)
                    .lineLimit(1)
            }
            Spacer()
            if let onExpand {
                Button(action: onExpand) {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("Open full Diff Studio")
            }
            if let onOpenSelectedFile {
                Button {
                    if let selectedPath = state.selectedPath {
                        onOpenSelectedFile(selectedPath)
                    }
                } label: {
                    if compact {
                        Image(systemName: "doc.text.magnifyingglass")
                            .accessibilityLabel("Open in Files")
                    } else {
                        Label("Open in Files", systemImage: "doc.text.magnifyingglass")
                    }
                }
                .buttonStyle(.bordered)
                .disabled(
                    !state.selectedFileCanOpenInEditor
                        || !model.workspaceCanEditFiles(state.selectedWorkspaceId))
            }
            if let file = state.selectedFile {
                DiffStatChips(additions: file.additions, deletions: file.deletions)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(TWTheme.surface1)
    }
}

private struct DiffHunksView: View {
    let file: WorkspaceDiffFile

    private var hunks: [WorkspaceDiffHunk] { file.hunks ?? [] }

    /// Widest clipped line (≤400 chars) sets the scrollable width — fixed
    /// row widths keep the add/del tints uniform inside the two-axis scroll.
    /// SF Mono at size 12 advances ~7.25pt/char; 96pt covers the gutters.
    private var contentWidth: CGFloat {
        let maxChars = hunks.flatMap(\.lines).map(\.text.count).max() ?? 0
        return max(360, CGFloat(maxChars) * 7.3 + 110)
    }

    var body: some View {
        if hunks.isEmpty {
            VStack(spacing: 10) {
                Image(systemName: "eye.slash")
                    .font(.system(size: 30))
                    .foregroundStyle(TWTheme.textMuted)
                Text("No line preview for this file")
                    .foregroundStyle(TWTheme.textSecondary)
                Text("Binary, oversized, or sensitive files keep their counts but ship no hunks.")
                    .font(.caption)
                    .foregroundStyle(TWTheme.textMuted)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(TWTheme.appBg)
        } else {
            ScrollView([.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 0) {
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
            .background(TWTheme.appBg)
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
    let width: CGFloat

    private var rowBackground: Color {
        switch line.type {
        case "add": return TWTheme.statusSuccess.opacity(0.12)
        case "del": return TWTheme.statusFailed.opacity(0.12)
        default: return .clear
        }
    }

    private var textColor: Color {
        line.type == "ctx" ? TWTheme.textSecondary : TWTheme.textPrimary
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
        case "add": return TWTheme.statusSuccess
        case "del": return TWTheme.statusFailed
        default: return TWTheme.textMuted
        }
    }

    var body: some View {
        HStack(spacing: 0) {
            Text(line.oldLine.map(String.init) ?? "")
                .frame(width: 36, alignment: .trailing)
                .foregroundStyle(TWTheme.textMuted)
            Text(line.newLine.map(String.init) ?? "")
                .frame(width: 36, alignment: .trailing)
                .foregroundStyle(TWTheme.textMuted)
            Text(marker)
                .frame(width: 18, alignment: .center)
                .foregroundStyle(markerColor)
            Text(line.text.isEmpty ? " " : line.text)
                .foregroundStyle(textColor)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .font(.system(size: 12, design: .monospaced))
        .padding(.vertical, 1)
        .frame(width: width, alignment: .leading)
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
