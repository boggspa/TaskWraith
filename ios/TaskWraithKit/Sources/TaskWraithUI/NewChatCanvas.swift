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
        case .ensemble: return "Couldn't start this ensemble"
        case .global: return "Couldn't start a global chat"
        }
    }

    private func createIfReady() {
        guard createdThreadId == nil, let workspaceId = targetWorkspaceId else { return }
        let key = "\(variant):\(workspaceId)"
        guard requestedKey != key else { return }
        requestedKey = key
        createFailed = false
        model.createEmptyThread(
            workspaceId: workspaceId,
            variant: variant,
            title: "New Chat"
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
}
