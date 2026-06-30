// GitWorkflowPanel — first-class git workflows from the phone.
//
// Lives in the ThreadInspector "Changes" tab beneath the per-run diff
// summary. The Mac's GitService is the single git authority: this panel
// only renders the typed snapshot/readiness results it gets back and
// sends explicit user actions (Stage all & Commit with a user-entered
// message, Push/Publish, Create PR). Mutations are never initiated from
// agent prompt text, and the panel never offers "Create pull request"
// when the Mac's readiness probe says it can't be created — it shows
// the Mac's reason instead. Allowlist denials surface verbatim.

import SwiftUI
import TaskWraithKit

public struct GitWorkflowPanel: View {
    @ObservedObject var model: RemoteSessionModel
    let workspaceId: String

    @State private var snapshot: GitWorkspaceSnapshot?
    @State private var readiness: GitPrReadinessResult?
    @State private var loading = false
    @State private var loadError: String?
    @State private var busy: BusyAction?
    @State private var commitMessage = ""
    @State private var prTitle = ""
    @State private var prDraft = false
    @State private var feedback: Feedback?

    private enum BusyAction { case commit, push, createPr }
    private struct Feedback: Equatable {
        let success: Bool
        let text: String
        var url: String?
    }

    public init(model: RemoteSessionModel, workspaceId: String) {
        self.model = model
        self.workspaceId = workspaceId
    }

    private var canMutate: Bool { model.workspaceCanRunGitMutations(workspaceId) }
    private var existingPr: GitPullRequestSummary? { readiness?.pr }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            if let loadError {
                errorRow(loadError)
            } else if snapshot == nil && loading {
                // Hydration ticker — never an authoritative empty while the
                // first read is in flight.
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Reading repo status…")
                        .font(.footnote)
                        .foregroundStyle(TWTheme.textSecondary)
                }
                .padding(.vertical, 4)
            } else if let snapshot {
                statusSection(snapshot)
                if canMutate {
                    commitSection(snapshot)
                    pushSection(snapshot)
                } else {
                    Text("This device can review but not modify this repo — the workspace hasn't granted file-write access.")
                        .font(.caption)
                        .foregroundStyle(TWTheme.textSecondary)
                }
                prSection(snapshot)
                if let feedback {
                    feedbackRow(feedback)
                }
            }
        }
        .padding(12)
        .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 12))
        .task(id: workspaceId) { await refresh() }
    }

    // ── Sections ────────────────────────────────────────────────────────

    private var header: some View {
        HStack(spacing: 8) {
            Label("Git", systemImage: "arrow.triangle.branch")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TWTheme.textPrimary)
            Spacer()
            if loading {
                ProgressView().controlSize(.small)
            } else {
                Button {
                    Task { await refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(TWTheme.textSecondary)
                .accessibilityLabel("Refresh git status")
                .disabled(busy != nil)
            }
        }
    }

    private func statusSection(_ snapshot: GitWorkspaceSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                if snapshot.detached == true {
                    chip("detached HEAD", TWTheme.statusAttention)
                } else {
                    Text(snapshot.branch ?? "(no branch)")
                        .font(.footnote.weight(.semibold).monospaced())
                        .foregroundStyle(TWTheme.textPrimary)
                        .lineLimit(1)
                }
                if let ahead = snapshot.ahead, ahead > 0 {
                    chip("↑\(ahead)", TWTheme.chroma1)
                }
                if let behind = snapshot.behind, behind > 0 {
                    chip("↓\(behind)", TWTheme.statusAttention)
                }
                if snapshot.upstream == nil && snapshot.detached != true {
                    chip("no upstream", TWTheme.textSecondary)
                }
                Spacer()
            }
            if let mergeState = snapshot.mergeState {
                Label(
                    "\(mergeState) in progress\(conflictSuffix(snapshot))",
                    systemImage: "exclamationmark.triangle"
                )
                .font(.caption)
                .foregroundStyle(TWTheme.statusAttention)
            }
            if snapshot.clean == true {
                Text("Working tree clean")
                    .font(.caption)
                    .foregroundStyle(TWTheme.textSecondary)
            } else {
                HStack(spacing: 8) {
                    if let staged = snapshot.counts?.staged, staged > 0 {
                        chip("\(staged) staged", TWTheme.statusSuccess)
                    }
                    if let unstaged = snapshot.counts?.unstaged, unstaged > 0 {
                        chip("\(unstaged) unstaged", TWTheme.statusAttention)
                    }
                    if let untracked = snapshot.counts?.untracked, untracked > 0 {
                        chip("\(untracked) new", TWTheme.chroma1)
                    }
                    if let additions = snapshot.lineStats?.additions, additions > 0 {
                        Text("+\(additions)")
                            .font(.caption.weight(.semibold).monospacedDigit())
                            .foregroundStyle(TWTheme.statusSuccess)
                    }
                    if let deletions = snapshot.lineStats?.deletions, deletions > 0 {
                        Text("−\(deletions)")
                            .font(.caption.weight(.semibold).monospacedDigit())
                            .foregroundStyle(TWTheme.statusFailed)
                    }
                    Spacer()
                }
            }
            changedFilesList(snapshot)
            if model.workspaceCanReviewDiffs(workspaceId), snapshot.clean != true {
                Button {
                    model.requestDiffMode(workspaceId: workspaceId)
                } label: {
                    Label("Review changes", systemImage: "plus.forwardslash.minus")
                        .font(.footnote.weight(.semibold))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
    }

    @ViewBuilder
    private func changedFilesList(_ snapshot: GitWorkspaceSnapshot) -> some View {
        let files = snapshot.files ?? []
        if !files.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                ForEach(files.prefix(8)) { file in
                    HStack(spacing: 6) {
                        Circle()
                            .fill(fileKindColor(file.kind))
                            .frame(width: 6, height: 6)
                        Text(file.path)
                            .font(.caption.monospaced())
                            .foregroundStyle(TWTheme.textPrimary)
                            .lineLimit(1)
                            .truncationMode(.head)
                        Spacer()
                        if file.staged == true {
                            Text("staged")
                                .font(.caption2)
                                .foregroundStyle(TWTheme.textSecondary)
                        }
                    }
                }
                if files.count > 8 || snapshot.filesTruncated == true {
                    Text("…and \(max(files.count - 8, 0)) more")
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textSecondary)
                }
            }
            .padding(.vertical, 2)
        }
    }

    private func commitSection(_ snapshot: GitWorkspaceSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider()
            TextField("Commit message", text: $commitMessage, axis: .vertical)
                .lineLimit(2...4)
                .font(.footnote)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled(false)
                .accessibilityLabel("Commit message")
            Button {
                runAction(.commit) {
                    let updated = try await model.commitChanges(
                        workspaceId: workspaceId,
                        message: commitMessage.trimmingCharacters(in: .whitespacesAndNewlines),
                        stageAll: true)
                    self.snapshot = updated
                    self.commitMessage = ""
                    self.feedback = Feedback(
                        success: true,
                        text: "Committed on \(updated.branch ?? "branch").")
                    await self.refreshReadiness()
                }
            } label: {
                if busy == .commit {
                    ProgressView().controlSize(.small)
                } else {
                    Label("Stage all & Commit", systemImage: "checkmark.seal")
                        .font(.footnote.weight(.semibold))
                }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(
                busy != nil
                    || commitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || snapshot.clean == true)
            if snapshot.clean == true {
                Text("Nothing to commit.")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textSecondary)
            }
        }
    }

    private func pushSection(_ snapshot: GitWorkspaceSnapshot) -> some View {
        let needsPublish = snapshot.upstream == nil
        let ahead = snapshot.ahead ?? 0
        let canPush = needsPublish || ahead > 0
        return VStack(alignment: .leading, spacing: 6) {
            Divider()
            Button {
                runAction(.push) {
                    let updated = try await model.pushBranch(
                        workspaceId: workspaceId, setUpstream: needsPublish)
                    self.snapshot = updated
                    self.feedback = Feedback(
                        success: true,
                        text: needsPublish
                            ? "Published \(updated.branch ?? "branch")."
                            : "Pushed \(updated.branch ?? "branch").")
                    await self.refreshReadiness()
                }
            } label: {
                if busy == .push {
                    ProgressView().controlSize(.small)
                } else {
                    Label(
                        needsPublish
                            ? "Publish branch"
                            : (ahead > 0 ? "Push \(ahead) commit\(ahead == 1 ? "" : "s")" : "Push"),
                        systemImage: "arrow.up.circle")
                        .font(.footnote.weight(.semibold))
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(busy != nil || !canPush || snapshot.detached == true)
            if !canPush && snapshot.detached != true {
                Text("Nothing to push — the remote is up to date.")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textSecondary)
            }
        }
    }

    @ViewBuilder
    private func prSection(_ snapshot: GitWorkspaceSnapshot) -> some View {
        Divider()
        if let pr = existingPr, pr.url != nil || pr.number != nil {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.triangle.pull")
                        .font(.caption)
                        .foregroundStyle(TWTheme.chroma1)
                    Text(prLabel(pr))
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(TWTheme.textPrimary)
                    if let state = pr.state {
                        chip(state.lowercased(), TWTheme.chroma1)
                    }
                    if pr.isDraft == true {
                        chip("draft", TWTheme.textSecondary)
                    }
                    Spacer()
                }
                if let urlString = pr.url, let url = URL(string: urlString) {
                    Link(destination: url) {
                        Text(urlString)
                            .font(.caption2.monospaced())
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                checksSummary(pr)
            }
        } else if canMutate {
            VStack(alignment: .leading, spacing: 6) {
                TextField("PR title (optional — defaults to the commit)", text: $prTitle)
                    .font(.footnote)
                    .textFieldStyle(.roundedBorder)
                Toggle("Draft", isOn: $prDraft)
                    .font(.footnote)
                    .toggleStyle(.switch)
                    .controlSize(.mini)
                Button {
                    runAction(.createPr) {
                        let title = prTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                        let pr = try await model.createGithubPr(
                            workspaceId: workspaceId,
                            title: title.isEmpty ? nil : title,
                            body: nil,
                            draft: prDraft)
                        self.feedback = Feedback(
                            success: true, text: "Pull request created.", url: pr.url)
                        self.prTitle = ""
                        await self.refreshReadiness()
                    }
                } label: {
                    if busy == .createPr {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Create pull request", systemImage: "arrow.triangle.pull")
                            .font(.footnote.weight(.semibold))
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(busy != nil || readiness?.canCreatePullRequest != true)
                // Never offer a dead Create PR silently — show the Mac's
                // reason whenever readiness says no.
                if let readiness, !readiness.canCreatePullRequest {
                    Text(readiness.reason ?? "A pull request can't be created right now.")
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textSecondary)
                } else if readiness == nil && !loading {
                    Text("Checking pull request readiness…")
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textSecondary)
                }
                if let warnings = readiness?.warnings, !warnings.isEmpty {
                    ForEach(warnings, id: \.self) { warning in
                        Label(warning, systemImage: "exclamationmark.triangle")
                            .font(.caption2)
                            .foregroundStyle(TWTheme.statusAttention)
                    }
                }
            }
        }
    }

    private func checksSummary(_ pr: GitPullRequestSummary) -> some View {
        let checks = pr.checks ?? []
        let failed = checks.filter { ($0.conclusion ?? "").lowercased() == "failure" }.count
        let pending = checks.filter { ($0.status ?? "").lowercased() != "completed" }.count
        return Group {
            if !checks.isEmpty {
                HStack(spacing: 8) {
                    if failed > 0 {
                        chip("\(failed) failing", TWTheme.statusFailed)
                    }
                    if pending > 0 {
                        chip("\(pending) running", TWTheme.statusAttention)
                    }
                    if failed == 0 && pending == 0 {
                        chip("checks green", TWTheme.statusSuccess)
                    }
                    Spacer()
                }
            }
        }
    }

    private func feedbackRow(_ feedback: Feedback) -> some View {
        HStack(spacing: 6) {
            Image(systemName: feedback.success ? "checkmark.circle.fill" : "xmark.octagon.fill")
                .font(.caption)
                .foregroundStyle(feedback.success ? TWTheme.statusSuccess : TWTheme.statusFailed)
            if let urlString = feedback.url, let url = URL(string: urlString) {
                Link(feedback.text + " Open ↗", destination: url)
                    .font(.caption)
            } else {
                Text(feedback.text)
                    .font(.caption)
                    .foregroundStyle(TWTheme.textSecondary)
            }
            Spacer()
        }
    }

    private func errorRow(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(message, systemImage: "exclamationmark.triangle")
                .font(.caption)
                .foregroundStyle(TWTheme.statusFailed)
            Button("Retry") { Task { await refresh() } }
                .font(.caption.weight(.semibold))
                .buttonStyle(.bordered)
                .controlSize(.mini)
        }
    }

    // ── Actions ─────────────────────────────────────────────────────────

    private func refresh() async {
        loading = true
        loadError = nil
        defer { loading = false }
        do {
            snapshot = try await model.fetchGitSnapshot(workspaceId: workspaceId)
        } catch {
            loadError = error.localizedDescription
            return
        }
        await refreshReadiness()
    }

    /// Readiness rides a slower `gh` round-trip — refreshed separately so
    /// the snapshot renders immediately and after every mutation.
    private func refreshReadiness() async {
        do {
            readiness = try await model.fetchPrReadiness(workspaceId: workspaceId)
        } catch {
            // A readiness failure shouldn't blank the whole panel — the
            // Create-PR section reports its absence in place.
            readiness = nil
        }
    }

    private func runAction(_ action: BusyAction, _ work: @escaping () async throws -> Void) {
        guard busy == nil else { return }
        busy = action
        feedback = nil
        Task {
            do {
                try await work()
            } catch {
                feedback = Feedback(success: false, text: error.localizedDescription)
            }
            busy = nil
        }
    }

    // ── Small helpers ───────────────────────────────────────────────────

    private func chip(_ text: String, _ color: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.14), in: Capsule())
            .foregroundStyle(color)
    }

    private func conflictSuffix(_ snapshot: GitWorkspaceSnapshot) -> String {
        guard let conflicts = snapshot.conflicts, conflicts > 0 else { return "" }
        return " — \(conflicts) conflict\(conflicts == 1 ? "" : "s")"
    }

    private func fileKindColor(_ kind: String?) -> Color {
        switch kind {
        case "created", "untracked": return TWTheme.statusSuccess
        case "deleted": return TWTheme.statusFailed
        case "conflicted": return TWTheme.statusAttention
        default: return TWTheme.chroma1
        }
    }

    private func prLabel(_ pr: GitPullRequestSummary) -> String {
        if let number = pr.number { return "PR #\(number)" }
        return "Pull request"
    }
}
