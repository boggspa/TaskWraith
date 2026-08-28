// GitWorkspaceSurface — the desktop's three git popovers, as one phone surface.
//
// Electron splits this across three anchored popovers hanging off the composer
// above-row: ComposerBranchWorktreePopover (branch & worktree),
// GitCommitControls (status / stage / commit / push / PR), and
// GitHubSatellitePopover (watch this PR). Three floating panels is a desktop
// affordance; on a phone it would be three taps to find one thing.
//
// So they combine into one scroll, in the order the work actually happens:
// WHERE you are (branch) → WHAT changed and what to do about it (the existing
// GitWorkflowPanel) → WHAT happens after you push (PR watch).
//
// Presentation follows the roster (a1815e037): an anchored glass popover on
// iPad where there is width beside the anchor, a sheet on phone where there
// isn't. Same content either way.

import SwiftUI
import TaskWraithKit

public struct GitWorkspaceSurface: View {
    @ObservedObject var model: RemoteSessionModel
    let workspaceId: String
    /// Chat that owns the PR watch. Absent (e.g. a workspace-level entry point)
    /// hides the watch section rather than guessing a chat.
    let chatId: String?
    let onDismiss: () -> Void
    /// Per-device master switch for the workspace terminal: OFF hides the
    /// entry entirely. The Mac holds its own two gates regardless.
    @AppStorage("tw.terminal.enabled") private var terminalEnabled = false
    @State private var terminalPresented = false

    public init(
        model: RemoteSessionModel,
        workspaceId: String,
        chatId: String?,
        onDismiss: @escaping () -> Void
    ) {
        self.model = model
        self.workspaceId = workspaceId
        self.chatId = chatId
        self.onDismiss = onDismiss
    }

    private var repoName: String {
        model.workspaceRepoName(for: workspaceId) ?? "Workspace"
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().overlay(TWTheme.border)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    GitBranchWorktreeSection(model: model, workspaceId: workspaceId)
                    // The Mac gates stage/commit/push/PR itself; this panel
                    // already renders its own permission copy when a tier is
                    // missing, so it is shown unconditionally above the
                    // diffReview floor.
                    if model.workspaceCanReviewDiffs(workspaceId) {
                        Divider().overlay(TWTheme.border)
                        GitWorkflowPanel(model: model, workspaceId: workspaceId)
                    }
                    if let chatId, model.workspaceCanReviewDiffs(workspaceId) {
                        Divider().overlay(TWTheme.border)
                        GitPrWatchSection(model: model, workspaceId: workspaceId, chatId: chatId)
                    }
                    if terminalEnabled {
                        Divider().overlay(TWTheme.border)
                        Button {
                            terminalPresented = true
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: "terminal")
                                    .font(.system(size: 12, weight: .semibold))
                                Text("Terminal")
                                    .font(.caption.weight(.semibold))
                                Spacer(minLength: 4)
                                Text("Elevated")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(TWTheme.statusAttention)
                                Image(systemName: "chevron.right")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(TWTheme.textMuted)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(TWTheme.textPrimary)
                        .sheet(isPresented: $terminalPresented) {
                            TerminalSheet(
                                model: model, workspaceId: workspaceId,
                                workspaceName: repoName)
                                .twSheetLiquidGlass(detents: [.large])
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "folder")
                .font(.caption.weight(.semibold))
                .foregroundStyle(TWTheme.textTertiary)
            Text(repoName)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TWTheme.textPrimary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 8)
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TWTheme.textTertiary)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}

/// Branch & worktree (desktop ComposerBranchWorktreePopover parity).
///
/// Read-first: the list loads on appear, and checkout is offered per row. The
/// dirty-worktree refusal is NOT pre-judged here — the Mac re-derives it from a
/// fresh snapshot at execution time, and a phone deciding from its cached
/// snapshot would be deciding from stale state. The cached snapshot is used
/// only to WARN, so the user isn't surprised by the refusal.
struct GitBranchWorktreeSection: View {
    @ObservedObject var model: RemoteSessionModel
    let workspaceId: String

    @State private var branches: [GitBranchEntry] = []
    @State private var worktrees: [GitWorktreeEntry] = []
    @State private var loading = false
    @State private var loadError: String?
    @State private var checkingOut: String?
    @State private var feedback: String?
    @State private var feedbackIsError = false
    @State private var newName = ""
    @State private var creating = false

    private var snapshot: GitWorkspaceSnapshot? { model.gitSnapshots[workspaceId] }
    private var canCheckout: Bool { model.workspaceCanRunGitMutations(workspaceId) }

    /// Mirrors the desktop's `isWorktreeDirty`. Advisory only — see the type doc.
    private var looksDirty: Bool {
        guard let counts = snapshot?.counts else { return false }
        return (counts.changed ?? 0) > 0 || (counts.unstaged ?? 0) > 0
            || (counts.staged ?? 0) > 0 || (snapshot?.conflicts ?? 0) > 0
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TWTheme.chroma1)
                Text("Branch & worktree")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                Spacer(minLength: 4)
                if loading {
                    ProgressView().controlSize(.mini)
                }
            }

            if looksDirty {
                noticeRow(
                    "Uncommitted changes — the Mac will refuse a branch switch until they're committed or stashed.",
                    icon: "exclamationmark.triangle.fill",
                    color: TWTheme.statusAttention)
            }

            if let loadError {
                noticeRow(loadError, icon: "xmark.octagon.fill", color: TWTheme.statusFailed)
            } else if branches.isEmpty && !loading {
                Text("No local branches found.")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textTertiary)
            } else {
                VStack(spacing: 4) {
                    ForEach(branches) { branch in
                        branchRow(branch)
                    }
                }
            }

            if !worktrees.isEmpty {
                Text("Worktrees")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(TWTheme.textTertiary)
                    .padding(.top, 2)
                ForEach(worktrees) { worktree in
                    HStack(spacing: 6) {
                        Image(systemName: worktree.isCurrent == true ? "checkmark.circle.fill" : "square.stack.3d.up")
                            .font(.caption2)
                            .foregroundStyle(
                                worktree.isCurrent == true ? TWTheme.statusSuccess : TWTheme.textTertiary)
                        Text(worktree.branch ?? (worktree.detached == true ? "detached" : "—"))
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(TWTheme.textSecondary)
                        Text(tailPath(worktree.path))
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(TWTheme.textMuted)
                            .lineLimit(1)
                            .truncationMode(.head)
                        Spacer(minLength: 0)
                    }
                }
            }

            if canCheckout {
                createControls
            }

            if let feedback {
                noticeRow(
                    feedback,
                    icon: feedbackIsError ? "xmark.octagon.fill" : "checkmark.circle.fill",
                    color: feedbackIsError ? TWTheme.statusFailed : TWTheme.statusSuccess)
            }
        }
        .task { await load() }
    }

    /// Create a branch, or a worktree.
    ///
    /// Note what is NOT here: any way to say where a worktree goes. The phone
    /// sends a name and the Mac resolves the destination into its own worktree
    /// root — a remote device choosing a filesystem write target is exactly
    /// what the workspace allowlist exists to prevent. The ack reports where it
    /// landed, which is the only way the user finds out.
    @ViewBuilder
    private var createControls: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                TextField("New branch or worktree name", text: $newName)
                    .textFieldStyle(.plain)
                    .font(.caption)
                    .autocorrectionDisabled()
                    #if canImport(UIKit)
                        .textInputAutocapitalization(.never)
                    #endif
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                    .background(TWTheme.surface2.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
            }
            HStack(spacing: 6) {
                Button {
                    Task { await createBranch() }
                } label: {
                    Label("Branch", systemImage: "arrow.triangle.branch")
                        .font(.caption2.weight(.semibold))
                }
                .buttonStyle(.bordered)
                .disabled(trimmedNewName.isEmpty || creating)

                Button {
                    Task { await createWorktree() }
                } label: {
                    Label("Worktree", systemImage: "square.stack.3d.up")
                        .font(.caption2.weight(.semibold))
                }
                .buttonStyle(.bordered)
                .disabled(trimmedNewName.isEmpty || creating)

                if creating { ProgressView().controlSize(.mini) }
                Spacer(minLength: 0)
            }
        }
        .padding(.top, 2)
    }

    private var trimmedNewName: String {
        newName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func createBranch() async {
        guard !creating else { return }
        creating = true
        defer { creating = false }
        do {
            _ = try await model.createBranch(workspaceId: workspaceId, branch: trimmedNewName)
            feedbackIsError = false
            feedback = "Created \(trimmedNewName)."
            newName = ""
            await load()
        } catch {
            feedbackIsError = true
            feedback = (error as? LocalizedError)?.errorDescription ?? "Couldn't create the branch."
        }
    }

    private func createWorktree() async {
        guard !creating else { return }
        creating = true
        defer { creating = false }
        do {
            let path = try await model.createWorktree(
                workspaceId: workspaceId, name: trimmedNewName)
            feedbackIsError = false
            // Say WHERE. The user didn't choose it and can't browse the Mac.
            feedback = path.map { "Worktree created at \($0)." } ?? "Worktree created."
            newName = ""
            await load()
        } catch {
            feedbackIsError = true
            feedback =
                (error as? LocalizedError)?.errorDescription ?? "Couldn't create the worktree."
        }
    }

    private func branchRow(_ branch: GitBranchEntry) -> some View {
        let isCurrent = branch.isCurrent == true
        // A branch checked out in ANOTHER worktree can't be checked out here —
        // git refuses. Say so instead of offering an action that will fail.
        let heldElsewhere = !isCurrent && (branch.worktreePath?.isEmpty == false)
        let busy = checkingOut == branch.name
        return Button {
            Task { await checkout(branch.name) }
        } label: {
            HStack(spacing: 7) {
                Image(systemName: isCurrent ? "checkmark.circle.fill" : "circle")
                    .font(.caption2)
                    .foregroundStyle(isCurrent ? TWTheme.statusSuccess : TWTheme.textTertiary)
                Text(branch.name)
                    .font(.caption.weight(isCurrent ? .semibold : .regular))
                    .foregroundStyle(isCurrent ? TWTheme.textPrimary : TWTheme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let upstream = branch.upstream, !upstream.isEmpty {
                    Text(upstream)
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(TWTheme.textMuted)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                if busy {
                    ProgressView().controlSize(.mini)
                } else if heldElsewhere {
                    Text("in worktree")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(TWTheme.textMuted)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                isCurrent ? TWTheme.chroma1.opacity(0.10) : Color.clear,
                in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isCurrent || heldElsewhere || !canCheckout || checkingOut != nil)
        .accessibilityLabel(
            isCurrent ? "\(branch.name), current branch" : "Switch to \(branch.name)")
    }

    private func noticeRow(_ text: String, icon: String, color: Color) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: icon)
                .font(.caption2.weight(.bold))
                .foregroundStyle(color)
            Text(text)
                .font(.caption2)
                .foregroundStyle(TWTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(color.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
    }

    private func tailPath(_ path: String) -> String {
        let parts = path.split(separator: "/")
        return parts.suffix(2).joined(separator: "/")
    }

    private func load() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let result = try await model.fetchGitBranches(workspaceId: workspaceId)
            branches = result.branches
            worktrees = result.worktrees
            loadError = nil
        } catch {
            loadError = "Couldn't list branches."
        }
    }

    private func checkout(_ branch: String) async {
        guard checkingOut == nil else { return }
        checkingOut = branch
        defer { checkingOut = nil }
        do {
            _ = try await model.checkoutBranch(workspaceId: workspaceId, branch: branch)
            feedbackIsError = false
            feedback = "Switched to \(branch)."
            await load()
        } catch {
            // Surface the MAC's wording verbatim — a dirty-tree refusal reads
            // as instructions ("commit, stash, or discard…"), which a generic
            // "couldn't switch branch" would throw away.
            feedbackIsError = true
            feedback = (error as? LocalizedError)?.errorDescription ?? "Couldn't switch branch."
        }
    }
}

/// PR watch (desktop GitHubSatellitePopover parity).
///
/// The toggle asks; the MAC decides. It refuses when the branch has no open PR,
/// so the switch reflects the acked state rather than the tap.
struct GitPrWatchSection: View {
    @ObservedObject var model: RemoteSessionModel
    let workspaceId: String
    let chatId: String

    @State private var watching = false
    @State private var busy = false
    @State private var note: String?
    @State private var noteIsError = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "bell")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TWTheme.chroma2)
                Text("Pull request")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                Spacer(minLength: 4)
                if busy { ProgressView().controlSize(.mini) }
            }
            Toggle(isOn: watchBinding) {
                Text(watching ? "Watching this PR" : "Watch this PR")
                    .font(.caption)
                    .foregroundStyle(TWTheme.textSecondary)
            }
            .toggleStyle(.switch)
            .disabled(busy)
            if let note {
                Text(note)
                    .font(.caption2)
                    .foregroundStyle(noteIsError ? TWTheme.statusFailed : TWTheme.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .task { watching = model.isWatchingPr(chatId: chatId) }
    }

    private var watchBinding: Binding<Bool> {
        Binding(
            get: { watching },
            set: { next in Task { await apply(next) } })
    }

    private func apply(_ next: Bool) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let acked = try await model.setPrWatch(
                workspaceId: workspaceId, chatId: chatId, watch: next)
            watching = acked
            noteIsError = false
            note = acked ? nil : "No open pull request to watch."
        } catch {
            // Snap back — the Mac is the authority on whether a watch exists.
            watching = model.isWatchingPr(chatId: chatId)
            noteIsError = true
            note = (error as? LocalizedError)?.errorDescription ?? "Couldn't update the PR watch."
        }
    }
}
