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
    @State private var createFailed = false
    @State private var showWorkspaceAccessConsent = false
    @State private var workspaceAccessBusy = false
    @State private var locallyGrantedWorkspaceIds: Set<String> = []

    private var targetWorkspaceId: String? {
        switch mode {
        case .global:
            return "global"
        case .workspace, .workflow:
            if let initialWorkspaceId, !initialWorkspaceId.isEmpty {
                return initialWorkspaceId
            }
            return model.workspaces.first?.id
        }
    }

    private var variant: String {
        switch mode {
        case .workspace: return "workspace"
        case .global: return "global"
        case .workflow: return "workflow"
        }
    }

    private var targetWorkspace: WorkspaceSummary? {
        guard let targetWorkspaceId else { return nil }
        return model.workspaces.first { $0.workspaceId == targetWorkspaceId }
    }

    private var initialProvider: String? {
        let catalogs = twOfferedProviderCatalogs(model.providerModels)
        return catalogs.first { $0.provider.lowercased() == "claude" }?.provider
            ?? catalogs.first?.provider
    }

    private func workspaceCanStartThread(_ workspace: WorkspaceSummary) -> Bool {
        if locallyGrantedWorkspaceIds.contains(workspace.workspaceId) { return true }
        if workspace.remoteAccessGranted == false { return false }
        if let canStart = workspace.capabilities?.startTurn { return canStart }
        // Older hosts projected only already-granted workspaces and omitted the
        // additive access fields, so presence itself remains the compatibility
        // signal for those releases.
        return workspace.remoteAccessGranted != true || workspace.remoteAccessMode != "read-only"
    }

    var body: some View {
        Group {
            if let threadId = createdThreadId {
                detailHost(threadId: threadId)
            } else if createFailed {
                failureView
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
        .sheet(isPresented: $showWorkspaceAccessConsent) {
            WorkspaceAccessConsentSheet(
                workspaceName: targetWorkspace?.displayName ?? "this workspace",
                isBusy: workspaceAccessBusy,
                onDecline: declineWorkspaceAccess,
                onAllow: allowWorkspaceAccess)
            .twSheetLiquidGlass(detents: [.medium, .large])
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
            return targetWorkspaceId == nil || targetWorkspace == nil
                ? "Syncing workspaces from your Mac…" : "Creating chat…"
        case .global:
            return "Creating general chat…"
        case .workflow:
            return targetWorkspaceId == nil || targetWorkspace == nil
                ? "Syncing workspaces from your Mac…" : "Creating workflow…"
        }
    }

    private var failureView: some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 32))
                .foregroundStyle(TWTheme.textMuted)
            Text(failureTitle)
                .font(.headline)
                .foregroundStyle(TWTheme.textPrimary)
                .multilineTextAlignment(.center)
            Text(model.lastActionMessage ?? "Your Mac declined the request.")
                .font(.callout)
                .foregroundStyle(TWTheme.textSecondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                createFailed = false
                createIfReady()
            } label: {
                Text("Try Again").font(.callout.weight(.semibold))
            }
            .buttonStyle(.borderedProminent)
            .tint(TWTheme.chroma1)
            .padding(.top, 2)
        }
        .padding(28)
        .frame(maxWidth: 420)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(TWTheme.appBg)
    }

    private var failureTitle: String {
        switch mode {
        case .workspace: return "Couldn't start this chat"
        case .global: return "Couldn't start a general chat"
        case .workflow: return "Couldn't start this workflow"
        }
    }

    private func createIfReady() {
        guard createdThreadId == nil, let workspaceId = targetWorkspaceId else { return }
        if mode != .global {
            // The summary is the Mac-authored proof that this is a registered
            // workspace. Never fall through to a provider-default create while
            // its grant state is still hydrating.
            guard let workspace = targetWorkspace else { return }
            if !workspaceCanStartThread(workspace) {
                showWorkspaceAccessConsent = true
                return
            }
        }
        let key = "\(variant):\(workspaceId)"
        guard requestedKey != key else { return }
        requestedKey = key
        createFailed = false
        model.createEmptyThread(
            workspaceId: workspaceId,
            variant: variant,
            provider: initialProvider,
            title: mode == .workflow ? "New Workflow" : "New Chat"
        ) { threadId in
            guard let threadId else {
                // Mac declined (or the request failed) — stop spinning, surface
                // the reason, and allow Retry (clear the latched key).
                requestedKey = nil
                createFailed = true
                return
            }
            createdThreadId = threadId
        }
    }

    private func allowWorkspaceAccess() {
        guard let workspaceId = targetWorkspaceId, !workspaceAccessBusy else { return }
        workspaceAccessBusy = true
        model.setRemoteWorkspaceAccess(workspaceId: workspaceId, enabled: true) { granted in
            workspaceAccessBusy = false
            showWorkspaceAccessConsent = false
            guard granted else {
                requestedKey = nil
                createFailed = true
                return
            }
            locallyGrantedWorkspaceIds.insert(workspaceId)
            createIfReady()
        }
    }

    private func declineWorkspaceAccess() {
        guard let workspaceId = targetWorkspaceId, !workspaceAccessBusy else { return }
        workspaceAccessBusy = true
        model.setRemoteWorkspaceAccess(workspaceId: workspaceId, enabled: false) { _ in
            workspaceAccessBusy = false
            showWorkspaceAccessConsent = false
            requestedKey = nil
            createFailed = true
        }
    }
}

private struct WorkspaceAccessConsentSheet: View {
    let workspaceName: String
    let isBusy: Bool
    let onDecline: () -> Void
    let onAllow: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Image(systemName: "folder.badge.gearshape")
                .font(.system(size: 30, weight: .semibold))
                .foregroundStyle(TWTheme.chroma1)
            Text("Allow workspace access?")
                .font(.title3.weight(.semibold))
                .foregroundStyle(TWTheme.textPrimary)
            Text(
                "Creating the first chat in \(workspaceName) lets paired iOS companions use that workspace with every provider currently admitted by your Mac. AntiGravity appears only after its own quota-risk consent and Gemini API setup are active."
            )
            .font(.callout)
            .foregroundStyle(TWTheme.textSecondary)
            Text(
                "The grant persists until you revoke it in Settings → Environments/Workspaces. Thread permissions—Plan, Ask, Accept Edits, Full WS Access, and Full Access—remain separate. External publishing remains separately controlled."
            )
            .font(.footnote)
            .foregroundStyle(TWTheme.textMuted)
            Spacer(minLength: 0)
            HStack {
                Button("Not Now", action: onDecline)
                    .buttonStyle(.bordered)
                    .disabled(isBusy)
                Spacer()
                Button(action: onAllow) {
                    if isBusy {
                        ProgressView()
                    } else {
                        Text("Allow & Create")
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(TWTheme.chroma1)
                .disabled(isBusy)
            }
        }
        .padding(24)
    }
}
