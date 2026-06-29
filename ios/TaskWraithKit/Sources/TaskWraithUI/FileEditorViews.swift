import SwiftUI
import TaskWraithKit

#if canImport(Runestone) && canImport(UIKit)
    import Runestone
    import UIKit
    #if canImport(TreeSitterBashRunestone)
        import TreeSitterBashRunestone
    #endif
    #if canImport(TreeSitterCRunestone)
        import TreeSitterCRunestone
    #endif
    #if canImport(TreeSitterCPPRunestone)
        import TreeSitterCPPRunestone
    #endif
    #if canImport(TreeSitterCSSRunestone)
        import TreeSitterCSSRunestone
    #endif
    #if canImport(TreeSitterHTMLRunestone)
        import TreeSitterHTMLRunestone
    #endif
    #if canImport(TreeSitterJavaScriptRunestone)
        import TreeSitterJavaScriptRunestone
    #endif
    #if canImport(TreeSitterJSONRunestone)
        import TreeSitterJSONRunestone
    #endif
    #if canImport(TreeSitterMarkdownRunestone)
        import TreeSitterMarkdownRunestone
    #endif
    #if canImport(TreeSitterPythonRunestone)
        import TreeSitterPythonRunestone
    #endif
    #if canImport(TreeSitterSwiftRunestone)
        import TreeSitterSwiftRunestone
    #endif
    #if canImport(TreeSitterTOMLRunestone)
        import TreeSitterTOMLRunestone
    #endif
    #if canImport(TreeSitterTSXRunestone)
        import TreeSitterTSXRunestone
    #endif
    #if canImport(TreeSitterTypeScriptRunestone)
        import TreeSitterTypeScriptRunestone
    #endif
    #if canImport(TreeSitterYAMLRunestone)
        import TreeSitterYAMLRunestone
    #endif
#endif

@MainActor
final class MobileFileEditorState: ObservableObject {
    enum PendingAction {
        case select(WorkspaceFileEntry)
        case workspace(String)
        case close
        case clearSelection
    }

    struct DirectoryListing {
        var entries: [WorkspaceFileEntry] = []
        var isLoaded = false
        var isLoading = false
        var truncated = false
        var error: String?
    }

    struct VisibleEntry: Identifiable {
        let entry: WorkspaceFileEntry
        let depth: Int
        var id: String { entry.path }
    }

    @Published var selectedWorkspaceId: String?
    @Published var directoriesByPath: [String: DirectoryListing] = [:]
    @Published var expandedDirectories: Set<String> = []
    @Published var filter = ""
    @Published var searchResults: [WorkspaceFileEntry] = []
    @Published var searchLoading = false
    @Published var searchTruncated = false
    @Published var searchError: String?
    @Published var selectedPath: String?
    @Published var content = ""
    @Published var savedContent = ""
    @Published var baseEtag: String?
    @Published var status = ""
    @Published var isLoading = false
    @Published var truncated = false
    @Published var pendingAction: PendingAction?
    @Published var showDirtyDialog = false
    @Published var showDeleteConfirm = false
    @Published var showCommitDialog = false
    @Published var commitMessage = ""

    private var searchTask: Task<Void, Never>?
    private var searchGeneration = 0

    var isDirty: Bool { content != savedContent }

    var selectedName: String {
        selectedPath?.split(separator: "/").last.map(String.init) ?? "Editor"
    }

    var searchIsActive: Bool {
        !filter.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var navigatorIsLoading: Bool {
        searchLoading || directoriesByPath.values.contains(where: \.isLoading)
    }

    var visibleEntries: [VisibleEntry] {
        var rows: [VisibleEntry] = []
        appendVisibleRows(parentPath: "", depth: 0, rows: &rows)
        return rows
    }

    var hasTruncatedDirectory: Bool {
        directoriesByPath.values.contains(where: \.truncated)
    }

    func activate(model: RemoteSessionModel, preferredWorkspaceId: String?) {
        let eligible = model.fileEditableWorkspaces
        guard let workspaceId = preferredWorkspaceId.flatMap({ id in eligible.first { $0.id == id }?.id })
            ?? eligible.first?.id
        else {
            status = "No read-write workspace has file editing enabled."
            return
        }
        if selectedWorkspaceId != workspaceId {
            selectedWorkspaceId = workspaceId
            clearEditor()
            clearNavigator()
        }
        Task { await reload(model: model) }
    }

    func reload(model: RemoteSessionModel) async {
        guard let workspaceId = selectedWorkspaceId else { return }
        clearNavigator()
        status = "Loading files..."
        await loadDirectory("", model: model, force: true)
        let rootCount = directoriesByPath[""]?.entries.count ?? 0
        if directoriesByPath[""]?.error == nil {
            status = "\(rootCount) \(rootCount == 1 ? "item" : "items")"
        }
        truncated = directoriesByPath[""]?.truncated ?? false
        _ = workspaceId
    }

    func loadDirectory(_ path: String, model: RemoteSessionModel, force: Bool = false) async {
        guard let workspaceId = selectedWorkspaceId else { return }
        let key = Self.normalizedDirectoryPath(path)
        if !force, directoriesByPath[key]?.isLoaded == true { return }
        var listing = directoriesByPath[key] ?? DirectoryListing()
        listing.isLoading = true
        listing.error = nil
        directoriesByPath[key] = listing
        do {
            let result = try await model.listWorkspaceFiles(
                workspaceId: workspaceId, path: key, limit: 240)
            let entries = Self.immediateChildren(from: result.entries, of: key)
            directoriesByPath[key] = DirectoryListing(
                entries: entries, isLoaded: true, isLoading: false,
                truncated: result.truncated, error: nil)
            if key.isEmpty {
                truncated = result.truncated
                status = "\(entries.count) \(entries.count == 1 ? "item" : "items")"
            }
        } catch {
            directoriesByPath[key] = DirectoryListing(
                entries: [], isLoaded: true, isLoading: false, truncated: false,
                error: error.localizedDescription)
            status = error.localizedDescription
        }
    }

    func requestWorkspace(_ workspaceId: String, model: RemoteSessionModel) {
        guard workspaceId != selectedWorkspaceId else { return }
        if isDirty {
            pendingAction = .workspace(workspaceId)
            showDirtyDialog = true
            return
        }
        selectedWorkspaceId = workspaceId
        clearEditor()
        clearNavigator()
        Task { await reload(model: model) }
    }

    func requestEntry(_ entry: WorkspaceFileEntry, model: RemoteSessionModel) {
        if entry.isDirectory {
            toggleDirectory(entry, model: model)
            return
        }
        if isDirty {
            pendingAction = .select(entry)
            showDirtyDialog = true
            return
        }
        Task { await open(entry, model: model) }
    }

    func toggleDirectory(_ entry: WorkspaceFileEntry, model: RemoteSessionModel) {
        let wasSearching = searchIsActive
        if wasSearching {
            filter = ""
            clearSearch()
        }
        expandAncestors(for: entry.path)
        if expandedDirectories.contains(entry.path), !wasSearching {
            expandedDirectories.remove(entry.path)
            return
        }
        expandedDirectories.insert(entry.path)
        Task { await loadDirectory(entry.path, model: model) }
    }

    func scheduleSearch(model: RemoteSessionModel) {
        let query = filter.trimmingCharacters(in: .whitespacesAndNewlines)
        searchTask?.cancel()
        guard !query.isEmpty else {
            clearSearch()
            return
        }
        searchTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 280_000_000)
            guard !Task.isCancelled else { return }
            await runSearch(query, model: model)
        }
    }

    func requestClose() -> Bool {
        if isDirty {
            pendingAction = .close
            showDirtyDialog = true
            return false
        }
        return true
    }

    func requestClearSelection() -> Bool {
        if isDirty {
            pendingAction = .clearSelection
            showDirtyDialog = true
            return false
        }
        clearEditor()
        return true
    }

    func open(_ entry: WorkspaceFileEntry, model: RemoteSessionModel) async {
        guard let workspaceId = selectedWorkspaceId, !entry.isDirectory else { return }
        isLoading = true
        status = "Opening \(entry.path)"
        do {
            let file = try await model.readWorkspaceFile(workspaceId: workspaceId, path: entry.path)
            selectedPath = file.path
            content = file.content
            savedContent = file.content
            baseEtag = file.etag
            status = "\(file.path) · \(Self.formatBytes(file.sizeBytes))"
        } catch {
            status = error.localizedDescription
        }
        isLoading = false
    }

    @discardableResult
    func save(model: RemoteSessionModel) async -> Bool {
        guard let workspaceId = selectedWorkspaceId, let selectedPath, isDirty else { return true }
        guard let baseEtag, !baseEtag.isEmpty else {
            status = "Reload before saving."
            return false
        }
        isLoading = true
        status = "Saving \(selectedPath)"
        do {
            let file = try await model.writeWorkspaceFile(
                workspaceId: workspaceId, path: selectedPath, content: content, baseEtag: baseEtag)
            self.selectedPath = file.path
            content = file.content
            savedContent = file.content
            self.baseEtag = file.etag
            status = "Saved \(file.path) · \(Self.formatBytes(file.sizeBytes))"
            await refreshParentDirectory(for: file.path, model: model)
            if searchIsActive {
                await runSearch(filter.trimmingCharacters(in: .whitespacesAndNewlines), model: model)
            }
            isLoading = false
            return true
        } catch {
            status = error.localizedDescription
            isLoading = false
            return false
        }
    }

    func saveThenContinue(model: RemoteSessionModel, onClose: @escaping () -> Void) {
        Task {
            if await save(model: model) {
                performPending(model: model, onClose: onClose, discard: false)
            }
        }
    }

    func discardThenContinue(model: RemoteSessionModel, onClose: () -> Void) {
        content = savedContent
        performPending(model: model, onClose: onClose, discard: true)
    }

    func cancelPending() {
        pendingAction = nil
        showDirtyDialog = false
    }

    func deleteSelected(model: RemoteSessionModel) async {
        guard let workspaceId = selectedWorkspaceId, let selectedPath, let baseEtag, !isDirty else { return }
        isLoading = true
        status = "Deleting \(selectedPath)"
        do {
            let deletedPath = try await model.deleteWorkspaceFile(
                workspaceId: workspaceId, path: selectedPath, baseEtag: baseEtag)
            clearEditor()
            status = "Deleted \(deletedPath)"
            await refreshParentDirectory(for: deletedPath, model: model)
            if searchIsActive {
                await runSearch(filter.trimmingCharacters(in: .whitespacesAndNewlines), model: model)
            }
            await model.refreshGitSnapshotCache(workspaceId: workspaceId)
        } catch {
            status = error.localizedDescription
        }
        isLoading = false
    }

    func stageSelected(model: RemoteSessionModel) async {
        guard let workspaceId = selectedWorkspaceId, let selectedPath, !isDirty else { return }
        isLoading = true
        status = "Staging \(selectedPath)"
        do {
            _ = try await model.stagePaths(workspaceId: workspaceId, paths: [selectedPath])
            status = "Staged \(selectedPath)"
        } catch {
            status = error.localizedDescription
        }
        isLoading = false
    }

    func unstageSelected(model: RemoteSessionModel) async {
        guard let workspaceId = selectedWorkspaceId, let selectedPath else { return }
        isLoading = true
        status = "Unstaging \(selectedPath)"
        do {
            _ = try await model.unstagePaths(workspaceId: workspaceId, paths: [selectedPath])
            status = "Unstaged \(selectedPath)"
        } catch {
            status = error.localizedDescription
        }
        isLoading = false
    }

    func commitStaged(model: RemoteSessionModel) async {
        guard let workspaceId = selectedWorkspaceId else { return }
        let message = commitMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { return }
        isLoading = true
        status = "Committing staged changes"
        do {
            _ = try await model.commitChanges(workspaceId: workspaceId, message: message, stageAll: false)
            commitMessage = ""
            status = "Committed staged changes"
        } catch {
            status = error.localizedDescription
        }
        isLoading = false
    }

    private func performPending(
        model: RemoteSessionModel, onClose: () -> Void, discard _: Bool
    ) {
        let pending = pendingAction
        pendingAction = nil
        showDirtyDialog = false
        switch pending {
        case .select(let entry):
            Task { await open(entry, model: model) }
        case .workspace(let workspaceId):
            selectedWorkspaceId = workspaceId
            clearEditor()
            clearNavigator()
            Task { await reload(model: model) }
        case .close:
            onClose()
        case .clearSelection:
            clearEditor()
        case .none:
            break
        }
    }

    private func clearEditor() {
        selectedPath = nil
        content = ""
        savedContent = ""
        baseEtag = nil
        pendingAction = nil
        showDirtyDialog = false
        showDeleteConfirm = false
    }

    private func clearNavigator() {
        searchTask?.cancel()
        searchTask = nil
        searchGeneration += 1
        directoriesByPath = [:]
        expandedDirectories = []
        filter = ""
        searchResults = []
        searchLoading = false
        searchTruncated = false
        searchError = nil
        truncated = false
    }

    private func clearSearch() {
        searchTask?.cancel()
        searchTask = nil
        searchGeneration += 1
        searchResults = []
        searchLoading = false
        searchTruncated = false
        searchError = nil
    }

    private func runSearch(_ query: String, model: RemoteSessionModel) async {
        guard let workspaceId = selectedWorkspaceId, !query.isEmpty else { return }
        searchGeneration += 1
        let generation = searchGeneration
        searchLoading = true
        searchError = nil
        do {
            let result = try await model.listWorkspaceFiles(
                workspaceId: workspaceId, query: query, limit: 160)
            guard generation == searchGeneration,
                filter.trimmingCharacters(in: .whitespacesAndNewlines) == query
            else { return }
            let entries = Self.searchMatches(from: result.entries, query: query)
            searchResults = entries
            searchTruncated = result.truncated
            status = "\(entries.count) \(entries.count == 1 ? "match" : "matches")"
        } catch {
            guard generation == searchGeneration else { return }
            searchResults = []
            searchTruncated = false
            searchError = error.localizedDescription
            status = error.localizedDescription
        }
        if generation == searchGeneration {
            searchLoading = false
        }
    }

    private func appendVisibleRows(parentPath: String, depth: Int, rows: inout [VisibleEntry]) {
        var visited: Set<String> = []
        appendVisibleRows(parentPath: parentPath, depth: depth, rows: &rows, visited: &visited)
    }

    private func appendVisibleRows(
        parentPath: String, depth: Int, rows: inout [VisibleEntry], visited: inout Set<String>
    ) {
        guard !visited.contains(parentPath) else { return }
        visited.insert(parentPath)
        defer { visited.remove(parentPath) }
        guard let listing = directoriesByPath[parentPath] else { return }
        for entry in listing.entries {
            guard entry.path != parentPath else { continue }
            rows.append(VisibleEntry(entry: entry, depth: depth))
            if entry.isDirectory, expandedDirectories.contains(entry.path) {
                appendVisibleRows(
                    parentPath: entry.path, depth: depth + 1, rows: &rows, visited: &visited)
            }
        }
    }

    private func expandAncestors(for path: String) {
        let parts = path.split(separator: "/").map(String.init)
        guard parts.count > 1 else { return }
        for index in 1..<parts.count {
            expandedDirectories.insert(parts.prefix(index).joined(separator: "/"))
        }
    }

    private func refreshParentDirectory(for path: String, model: RemoteSessionModel) async {
        await loadDirectory(Self.parentDirectory(of: path), model: model, force: true)
    }

    private static func parentDirectory(of path: String) -> String {
        let parts = path.split(separator: "/").map(String.init)
        guard parts.count > 1 else { return "" }
        return parts.dropLast().joined(separator: "/")
    }

    private static func normalizedDirectoryPath(_ path: String) -> String {
        path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    private static func immediateChildren(
        from entries: [WorkspaceFileEntry], of directoryPath: String
    ) -> [WorkspaceFileEntry] {
        let directory = normalizedDirectoryPath(directoryPath)
        return entries.filter { entry in
            let entryPath = normalizedDirectoryPath(entry.path)
            guard !entryPath.isEmpty, entryPath != directory else { return false }
            return parentDirectory(of: entryPath) == directory
        }
    }

    private static func searchMatches(
        from entries: [WorkspaceFileEntry], query: String
    ) -> [WorkspaceFileEntry] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return [] }
        return entries.filter { entry in
            entry.path.lowercased().contains(needle) || entry.name.lowercased().contains(needle)
        }
    }

    static func formatBytes(_ value: Int?) -> String {
        guard let value else { return "" }
        if value < 1024 { return "\(value) B" }
        if value < 1024 * 1024 { return "\(value / 1024) KB" }
        return String(format: "%.1f MB", Double(value) / Double(1024 * 1024))
    }
}

struct FilesModeSplitView: View {
    @ObservedObject var model: RemoteSessionModel
    @ObservedObject var state: MobileFileEditorState
    let onBack: () -> Void

    var body: some View {
        NavigationSplitView {
            FileNavigatorPane(model: model, state: state)
                .navigationTitle("Files")
                .toolbar {
                    ToolbarItem(placement: .primaryAction) {
                        Button { Task { await state.reload(model: model) } } label: {
                            Label("Refresh", systemImage: "arrow.clockwise")
                        }
                        .disabled(state.selectedWorkspaceId == nil || state.navigatorIsLoading)
                    }
                }
        } detail: {
            FileEditorPane(model: model, state: state, onBack: onBack, compact: false)
        }
        .confirmationDialog("Unsaved changes", isPresented: $state.showDirtyDialog) {
            Button("Save") { state.saveThenContinue(model: model, onClose: onBack) }
            Button("Discard", role: .destructive) {
                state.discardThenContinue(model: model, onClose: onBack)
            }
            Button("Cancel", role: .cancel) { state.cancelPending() }
        }
    }
}

struct FilesModeCompactView: View {
    @ObservedObject var model: RemoteSessionModel
    @ObservedObject var state: MobileFileEditorState
    let onClose: () -> Void

    var body: some View {
        Group {
            if state.selectedPath == nil {
                FileNavigatorPane(model: model, state: state)
                    .navigationTitle("Files")
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Close") {
                                if state.requestClose() { onClose() }
                            }
                        }
                        ToolbarItem(placement: .primaryAction) {
                            Button { Task { await state.reload(model: model) } } label: {
                                Label("Refresh", systemImage: "arrow.clockwise")
                            }
                            .disabled(state.selectedWorkspaceId == nil || state.navigatorIsLoading)
                        }
                    }
            } else {
                FileEditorPane(model: model, state: state, onBack: onClose, compact: true)
            }
        }
        .confirmationDialog("Unsaved changes", isPresented: $state.showDirtyDialog) {
            Button("Save") { state.saveThenContinue(model: model, onClose: onClose) }
            Button("Discard", role: .destructive) {
                state.discardThenContinue(model: model, onClose: onClose)
            }
            Button("Cancel", role: .cancel) { state.cancelPending() }
        }
    }
}

private struct FileNavigatorPane: View {
    @ObservedObject var model: RemoteSessionModel
    @ObservedObject var state: MobileFileEditorState

    var body: some View {
        List {
            if !model.fileEditableWorkspaces.isEmpty {
                Section {
                    Picker("Workspace", selection: Binding(
                        get: { state.selectedWorkspaceId ?? model.fileEditableWorkspaces.first?.id ?? "" },
                        set: { state.requestWorkspace($0, model: model) }
                    )) {
                        ForEach(model.fileEditableWorkspaces) { workspace in
                            Text(workspace.displayName).tag(workspace.id)
                        }
                    }
                }
            }

            Section {
                TextField("Search files", text: $state.filter)
                    .disableAutocorrection(true)
                    .onChange(of: state.filter) { _, _ in
                        state.scheduleSearch(model: model)
                    }
            }

            Section {
                if state.searchIsActive {
                    if state.searchResults.isEmpty {
                        Text(state.searchLoading ? "Searching files..." : state.searchError ?? "No matches")
                            .foregroundStyle(TWTheme.textMuted)
                    } else {
                        ForEach(state.searchResults) { entry in
                            Button {
                                state.requestEntry(entry, model: model)
                            } label: {
                                FileEntryRow(
                                    entry: entry, selected: state.selectedPath == entry.path,
                                    depth: entry.depth,
                                    isExpanded: entry.isDirectory
                                        && state.expandedDirectories.contains(entry.path),
                                    isLoading: false)
                            }
                        }
                    }
                } else if state.visibleEntries.isEmpty {
                    Text(state.navigatorIsLoading ? "Loading files..." : state.status)
                        .foregroundStyle(TWTheme.textMuted)
                } else {
                    ForEach(state.visibleEntries) { row in
                        let entry = row.entry
                        Button {
                            state.requestEntry(entry, model: model)
                        } label: {
                            FileEntryRow(
                                entry: entry, selected: state.selectedPath == entry.path,
                                depth: row.depth,
                                isExpanded: entry.isDirectory
                                    && state.expandedDirectories.contains(entry.path),
                                isLoading: state.directoriesByPath[entry.path]?.isLoading == true)
                        }
                        .disabled(state.isLoading)
                    }
                }
            } footer: {
                if state.searchIsActive, state.searchTruncated {
                    Text("Search truncated. Refine the query to narrow results.")
                } else if state.hasTruncatedDirectory || state.truncated {
                    Text("Folder listing truncated. Use search or expand a narrower folder.")
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(TWTheme.sidebarBg)
    }
}

private struct FileEntryRow: View {
    let entry: WorkspaceFileEntry
    let selected: Bool
    let depth: Int
    let isExpanded: Bool
    let isLoading: Bool

    var body: some View {
        HStack(spacing: 8) {
            if entry.isDirectory {
                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(TWTheme.textMuted)
                    .frame(width: 10)
            } else {
                Color.clear.frame(width: 10)
            }
            Image(systemName: entry.isDirectory ? "folder" : iconName(for: entry.path))
                .foregroundStyle(entry.isDirectory ? TWTheme.chroma2 : TWTheme.chroma1)
                .frame(width: 18)
            Text(entry.name)
                .lineLimit(1)
                .font(.callout)
                .foregroundStyle(selected ? TWTheme.textPrimary : TWTheme.textSecondary)
            Spacer(minLength: 8)
            if isLoading {
                ProgressView()
                    .scaleEffect(0.7)
                    .frame(width: 14, height: 14)
            } else if !entry.isDirectory {
                Text(MobileFileEditorState.formatBytes(entry.sizeBytes))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(TWTheme.textMuted)
            } else if entry.hasChildren == false {
                Text("empty")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textMuted)
            }
        }
        .padding(.leading, CGFloat(depth) * 12)
    }

    private func iconName(for path: String) -> String {
        let lower = path.lowercased()
        if lower.hasSuffix(".swift") { return "swift" }
        if lower.hasSuffix(".json") { return "curlybraces" }
        if lower.hasSuffix(".md") || lower.hasSuffix(".markdown") { return "doc.richtext" }
        if lower.hasSuffix(".css") || lower.hasSuffix(".html") || lower.hasSuffix(".ts")
            || lower.hasSuffix(".tsx") || lower.hasSuffix(".js")
        { return "chevron.left.forwardslash.chevron.right" }
        return "doc.text"
    }
}

private struct FileEditorPane: View {
    @ObservedObject var model: RemoteSessionModel
    @ObservedObject var state: MobileFileEditorState
    let onBack: () -> Void
    let compact: Bool

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(TWTheme.border)
            if state.selectedPath == nil {
                VStack(spacing: 10) {
                    Image(systemName: "doc.text.magnifyingglass")
                        .font(.system(size: 34))
                        .foregroundStyle(TWTheme.textMuted)
                    Text("Select a text file")
                        .foregroundStyle(TWTheme.textSecondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(TWTheme.appBg)
            } else {
                TaskWraithCodeEditor(
                    text: $state.content,
                    filePath: state.selectedPath ?? "",
                    isEditable: !state.isLoading)
                    .background(TWTheme.appBg)
            }
            Divider().overlay(TWTheme.border)
            HStack {
                Text(state.isDirty ? "Unsaved changes" : state.status)
                    .font(.caption)
                    .foregroundStyle(state.isDirty ? TWTheme.statusAttention : TWTheme.textMuted)
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
        .fileEditorInlineTitle()
        .alert("Delete file?", isPresented: $state.showDeleteConfirm) {
            Button("Delete", role: .destructive) {
                Task { await state.deleteSelected(model: model) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\(state.selectedPath ?? "This file") will be removed from this workspace.")
        }
        .alert("Commit staged changes", isPresented: $state.showCommitDialog) {
            TextField("Commit message", text: $state.commitMessage)
            Button("Commit") {
                Task { await state.commitStaged(model: model) }
            }
            Button("Cancel", role: .cancel) {
                state.commitMessage = ""
            }
        } message: {
            Text("\(stagedCount) staged file\(stagedCount == 1 ? "" : "s") will be committed.")
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Button {
                if compact {
                    _ = state.requestClearSelection()
                } else if state.requestClose() {
                    onBack()
                }
            } label: {
                Label(compact ? "Files" : "Back to app", systemImage: compact ? "chevron.left" : "arrow.uturn.backward")
            }
            .buttonStyle(.bordered)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(state.selectedName)
                        .font(.headline)
                        .lineLimit(1)
                    if state.isDirty {
                        Circle()
                            .fill(TWTheme.statusAttention)
                            .frame(width: 7, height: 7)
                    }
                }
                Text(state.selectedPath ?? "No file selected")
                    .font(.caption)
                    .foregroundStyle(TWTheme.textMuted)
                    .lineLimit(1)
            }
            Spacer()
            HStack(spacing: 8) {
                Button {
                    state.showDeleteConfirm = true
                } label: {
                    actionLabel("Delete", systemImage: "trash")
                }
                .buttonStyle(.bordered)
                .tint(.red)
                .disabled(state.selectedPath == nil || state.isDirty || state.isLoading)

                Button {
                    Task { await state.stageSelected(model: model) }
                } label: {
                    actionLabel("Stage", systemImage: "plus.circle")
                }
                .buttonStyle(.bordered)
                .disabled(
                    state.selectedPath == nil || state.isDirty || state.isLoading
                        || !selectedHasUnstagedChanges)

                Button {
                    Task { await state.unstageSelected(model: model) }
                } label: {
                    actionLabel("Unstage", systemImage: "minus.circle")
                }
                .buttonStyle(.bordered)
                .disabled(state.selectedPath == nil || state.isLoading || !selectedHasStagedChanges)

                Button {
                    state.showCommitDialog = true
                } label: {
                    actionLabel("Commit", systemImage: "checkmark.circle")
                }
                .buttonStyle(.bordered)
                .disabled(stagedCount == 0 || state.isLoading)

                Button {
                    Task { await state.save(model: model) }
                } label: {
                    actionLabel("Save", systemImage: "square.and.arrow.down")
                }
                .buttonStyle(.borderedProminent)
                .disabled(!state.isDirty || state.selectedPath == nil || state.isLoading)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(TWTheme.surface1)
    }

    @ViewBuilder
    private func actionLabel(_ title: String, systemImage: String) -> some View {
        if compact {
            Image(systemName: systemImage)
                .accessibilityLabel(title)
        } else {
            Label(title, systemImage: systemImage)
        }
    }

    private var gitSnapshot: GitWorkspaceSnapshot? {
        guard let workspaceId = state.selectedWorkspaceId else { return nil }
        return model.gitSnapshots[workspaceId]
    }

    private var selectedGitFile: GitFileChange? {
        guard let selectedGitPath else { return nil }
        return gitSnapshot?.files?.first { $0.path == selectedGitPath }
    }

    private var selectedHasUnstagedChanges: Bool {
        selectedGitFile?.unstaged == true
    }

    private var selectedHasStagedChanges: Bool {
        selectedGitFile?.staged == true
    }

    private var stagedCount: Int {
        gitSnapshot?.counts?.staged ?? 0
    }

    private var selectedGitPath: String? {
        guard let selectedPath = state.selectedPath else { return nil }
        guard let workspaceId = state.selectedWorkspaceId,
            let workspace = model.workspaces.first(where: { $0.id == workspaceId }),
            let repoRoot = gitSnapshot?.repoRoot
        else { return selectedPath }
        let workspacePath = Self.normalizedAbsolutePath(workspace.path)
        let repoPath = Self.normalizedAbsolutePath(repoRoot)
        if workspacePath == repoPath { return selectedPath }
        if workspacePath.hasPrefix(repoPath + "/") {
            let prefix = String(workspacePath.dropFirst(repoPath.count + 1))
            return prefix.isEmpty ? selectedPath : "\(prefix)/\(selectedPath)"
        }
        return selectedPath
    }

    private static func normalizedAbsolutePath(_ path: String) -> String {
        var normalized = path.replacingOccurrences(of: "\\", with: "/")
        while normalized.hasSuffix("/") {
            normalized.removeLast()
        }
        return normalized
    }
}

private struct TaskWraithCodeEditor: View {
    @Binding var text: String
    let filePath: String
    let isEditable: Bool

    var body: some View {
        #if canImport(Runestone) && canImport(UIKit)
            RunestoneEditorView(text: $text, filePath: filePath, isEditable: isEditable)
        #else
            TextEditor(text: $text)
                .font(.system(.body, design: .monospaced))
                .scrollContentBackground(.hidden)
                .padding(8)
                .disabled(!isEditable)
        #endif
    }
}

#if canImport(Runestone) && canImport(UIKit)
private struct RunestoneEditorView: UIViewRepresentable {
    @Binding var text: String
    let filePath: String
    let isEditable: Bool

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text)
    }

    func makeUIView(context: Context) -> TextView {
        let textView = TextView()
        textView.editorDelegate = context.coordinator
        textView.showLineNumbers = true
        textView.lineSelectionDisplayType = .line
        textView.textContainerInset = UIEdgeInsets(top: 12, left: 8, bottom: 12, right: 12)
        textView.lineHeightMultiplier = 1.25
        textView.backgroundColor = .clear
        textView.isEditable = isEditable
        context.coordinator.filePath = filePath
        textView.setState(Self.state(text: text, filePath: filePath))
        return textView
    }

    func updateUIView(_ textView: TextView, context: Context) {
        textView.isEditable = isEditable
        let languageChanged = context.coordinator.filePath != filePath
        if languageChanged || (textView.text != text && !context.coordinator.isUpdatingFromEditor) {
            context.coordinator.isUpdatingProgrammatically = true
            context.coordinator.filePath = filePath
            textView.setState(Self.state(text: text, filePath: filePath))
            context.coordinator.isUpdatingProgrammatically = false
        }
    }

    private static func state(text: String, filePath: String) -> TextViewState {
        let theme = TaskWraithRunestoneTheme()
        if let language = TaskWraithRunestoneLanguage.language(for: filePath) {
            return TextViewState(text: text, theme: theme, language: language)
        }
        return TextViewState(text: text, theme: theme)
    }

    final class Coordinator: @MainActor TextViewDelegate {
        @Binding var text: String
        var isUpdatingProgrammatically = false
        var isUpdatingFromEditor = false
        var filePath = ""

        init(text: Binding<String>) {
            _text = text
        }

        @MainActor
        func textViewDidChange(_ textView: TextView) {
            guard !isUpdatingProgrammatically else { return }
            isUpdatingFromEditor = true
            text = textView.text
            isUpdatingFromEditor = false
        }
    }
}

private enum TaskWraithRunestoneLanguage {
    static func language(for path: String) -> TreeSitterLanguage? {
        let lower = path.lowercased()
        let ext = URL(fileURLWithPath: lower).pathExtension
        switch ext {
        case "swift":
            #if canImport(TreeSitterSwiftRunestone)
                return .swift
            #else
                return nil
            #endif
        case "ts":
            #if canImport(TreeSitterTypeScriptRunestone)
                return .typeScript
            #else
                return nil
            #endif
        case "tsx":
            #if canImport(TreeSitterTSXRunestone)
                return .tsx
            #else
                return nil
            #endif
        case "js", "mjs", "cjs":
            #if canImport(TreeSitterJavaScriptRunestone)
                return .javaScript
            #else
                return nil
            #endif
        case "jsx":
            #if canImport(TreeSitterJavaScriptRunestone)
                return .jsx
            #else
                return nil
            #endif
        case "py":
            #if canImport(TreeSitterPythonRunestone)
                return .python
            #else
                return nil
            #endif
        case "json", "jsonc":
            #if canImport(TreeSitterJSONRunestone)
                return .json
            #else
                return nil
            #endif
        case "md", "markdown":
            #if canImport(TreeSitterMarkdownRunestone)
                return .markdown
            #else
                return nil
            #endif
        case "css":
            #if canImport(TreeSitterCSSRunestone)
                return .css
            #else
                return nil
            #endif
        case "html", "htm":
            #if canImport(TreeSitterHTMLRunestone)
                return .html
            #else
                return nil
            #endif
        case "sh", "bash", "zsh", "env":
            #if canImport(TreeSitterBashRunestone)
                return .bash
            #else
                return nil
            #endif
        case "c":
            #if canImport(TreeSitterCRunestone)
                return .c
            #else
                return nil
            #endif
        case "cc", "cpp", "cxx", "h", "hh", "hpp", "hxx", "metal", "mm":
            #if canImport(TreeSitterCPPRunestone)
                return .cpp
            #else
                return nil
            #endif
        case "toml":
            #if canImport(TreeSitterTOMLRunestone)
                return .toml
            #else
                return nil
            #endif
        case "yaml", "yml":
            #if canImport(TreeSitterYAMLRunestone)
                return .yaml
            #else
                return nil
            #endif
        default:
            return nil
        }
    }
}

private final class TaskWraithRunestoneTheme: Theme {
    let font = UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)
    let textColor = UIColor.label
    let gutterBackgroundColor = UIColor.secondarySystemBackground.withAlphaComponent(0.68)
    let gutterHairlineColor = UIColor.separator
    let lineNumberColor = UIColor.secondaryLabel
    let lineNumberFont = UIFont.monospacedSystemFont(ofSize: 11, weight: .regular)
    let selectedLineBackgroundColor = UIColor.systemBlue.withAlphaComponent(0.10)
    let selectedLinesLineNumberColor = UIColor.label
    let selectedLinesGutterBackgroundColor = UIColor.systemBlue.withAlphaComponent(0.14)
    let invisibleCharactersColor = UIColor.tertiaryLabel
    let pageGuideHairlineColor = UIColor.separator
    let pageGuideBackgroundColor = UIColor.clear
    let markedTextBackgroundColor = UIColor.systemYellow.withAlphaComponent(0.2)

    func textColor(for highlightName: String) -> UIColor? {
        let name = highlightName.lowercased()
        if name.contains("comment") { return UIColor(red: 0.50, green: 0.54, blue: 0.59, alpha: 1) }
        if name.contains("string") { return UIColor(red: 0.62, green: 0.86, blue: 0.54, alpha: 1) }
        if name.contains("keyword") || name.contains("operator") {
            return UIColor(red: 0.78, green: 0.55, blue: 1.00, alpha: 1)
        }
        if name.contains("number") || name.contains("constant") || name.contains("boolean") {
            return UIColor(red: 0.95, green: 0.67, blue: 0.42, alpha: 1)
        }
        if name.contains("function") || name.contains("method") {
            return UIColor(red: 0.43, green: 0.72, blue: 1.00, alpha: 1)
        }
        if name.contains("type") || name.contains("class") || name.contains("struct")
            || name.contains("enum") || name.contains("interface")
        {
            return UIColor(red: 0.39, green: 0.84, blue: 0.78, alpha: 1)
        }
        if name.contains("property") || name.contains("field") || name.contains("member")
            || name.contains("attribute")
        {
            return UIColor(red: 0.58, green: 0.78, blue: 1.00, alpha: 1)
        }
        if name.contains("tag") { return UIColor(red: 1.00, green: 0.55, blue: 0.55, alpha: 1) }
        if name.contains("variable.parameter") { return UIColor(red: 0.88, green: 0.78, blue: 0.48, alpha: 1) }
        return nil
    }
}
#endif

private extension View {
    @ViewBuilder
    func fileEditorInlineTitle() -> some View {
        #if os(iOS)
            self.navigationBarTitleDisplayMode(.inline)
        #else
            self
        #endif
    }
}
