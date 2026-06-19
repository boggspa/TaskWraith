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

/// Slim banner shown atop the shell while in offline demo mode, with an exit.
private struct DemoModeBanner: View {
    @ObservedObject var model: RemoteSessionModel
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "play.circle.fill")
            Text("Demo mode · sample data").font(.footnote.weight(.semibold))
            Spacer()
            Button("Exit") { model.exitDemoMode() }
                .font(.footnote.weight(.semibold))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity)
        .background(TWTheme.chroma1.opacity(0.16))
        .foregroundStyle(TWTheme.chroma1)
    }
}

public struct RootView: View {
    @ObservedObject var model: RemoteSessionModel
    @ObservedObject private var themes = TWThemeStore.shared
    @Environment(\.scenePhase) private var scenePhase

    public init(model: RemoteSessionModel) { self.model = model }

    /// Transient drops after a successful session must NOT eject the user
    /// to the pairing screen — trusted reconnect runs underneath while the
    /// shell stays put with a status strip.
    private var showShellDuringDrop: Bool {
        guard model.wasEverConnected, model.hasStoredPairing else { return false }
        switch model.phase {
        case .connecting, .error: return true
        default: return false
        }
    }

    @ViewBuilder
    private var connectionBanner: some View {
        switch model.phase {
        case .connecting:
            ConnectionBanner(state: .reconnecting(detail: nil)) {}
        case .error(let message):
            ConnectionBanner(state: .offline(detail: twFriendlyMessage(message))) {
                model.reconnectIfStale()
            }
        default:
            EmptyView()
        }
    }

    public var body: some View {
        Group {
            if model.identityError != nil {
                // The device identity couldn't be loaded — nothing else can
                // work (the Mac pins this key), so the recovery screen
                // outranks every phase. Never silently regenerated.
                IdentityErrorView(model: model)
            } else {
                switch model.phase {
                case .connected:
                    ConnectedShell(model: model)
                        .safeAreaInset(edge: .top) {
                            if model.isDemo { DemoModeBanner(model: model) }
                        }
                // `where` binds per-pattern in Swift — both arms need the guard
                // or a fresh pairing's .connecting would show the shell.
                case .connecting where showShellDuringDrop,
                    .error where showShellDuringDrop:
                    ConnectedShell(model: model)
                        .overlay(alignment: .top) {
                            connectionBanner
                        }
                case .idle, .connecting, .awaitingMacConfirm, .error:
                    NavigationStack { PairingView(model: model) }
                }
            }
        }
        .tint(TWTheme.chroma1)
        .twColorScheme()
        // Theme tokens are computed statics — a revision bump rebuilds the
        // tree so every TWTheme read picks up the new selection.
        .id(themes.revision)
        // Settings sheet lives ABOVE the revision teardown (attached after
        // `.id`) so a theme/composer/font change made inside it keeps the sheet
        // open — AppSettingsSheet re-themes live via its own @ObservedObject
        // themes. Presented here, not from HomeView, which is inside the
        // `.id(revision)` subtree that rebuilds on every settings change.
        .sheet(isPresented: $model.settingsPresented) {
            AppSettingsSheet()
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .animation(.easeInOut(duration: 0.25), value: showShellDuringDrop)
        // Privacy shield: iOS snapshots the UI for the app switcher —
        // transcripts and file contents must not be readable there.
        .overlay {
            if scenePhase != .active {
                ZStack {
                    TWTheme.appBg.ignoresSafeArea()
                    TaskWraithMonolineBrandView(markSize: 64, titleSize: 24)
                }
                .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.15), value: scenePhase)
        .task { model.resumeIfIdle() }
        .onChange(of: scenePhase) { _, phase in
            // iOS kills sockets in the background — coming back to the
            // foreground silently re-resolves the stored pairing.
            if phase == .active { model.reconnectIfStale() }
        }
    }
}

/// Full-screen recovery surface for an unreadable/unpersistable device
/// identity. Deliberately NOT a path back into pairing: regenerating the
/// identity is a user decision (it breaks the Mac's pin), so the screen
/// explains the state and offers retry + the deliberate way out.
struct IdentityErrorView: View {
    @ObservedObject var model: RemoteSessionModel

    var body: some View {
        ZStack {
            TWTheme.appBg.ignoresSafeArea()
            VStack(spacing: 16) {
                Image(systemName: "key.slash")
                    .font(.system(size: 40, weight: .semibold))
                    .foregroundStyle(TWTheme.statusAttention)
                Text("Device identity unavailable")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                Text(model.identityError ?? "")
                    .font(.footnote)
                    .foregroundStyle(TWTheme.textSecondary)
                    .multilineTextAlignment(.center)
                VStack(alignment: .leading, spacing: 8) {
                    Label(
                        "Unlock your iPhone, then tap Try again.",
                        systemImage: "lock.open")
                    Label(
                        "If this keeps happening, restart your iPhone.",
                        systemImage: "arrow.counterclockwise")
                    Label(
                        "Last resort: reinstall TaskWraith — that creates a new identity, so you'll re-pair with your Mac.",
                        systemImage: "qrcode")
                }
                .font(.caption)
                .foregroundStyle(TWTheme.textTertiary)
                .padding(14)
                .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 12))
                Button {
                    model.retryIdentityLoad()
                } label: {
                    Text("Try again")
                        .font(.body.weight(.semibold))
                        .padding(.horizontal, 26)
                        .padding(.vertical, 10)
                        .background(TWTheme.chroma1, in: Capsule())
                        .foregroundStyle(Color.black.opacity(0.85))
                }
                .buttonStyle(.plain)
            }
            .padding(28)
        }
        .twColorScheme()
    }
}

/// Ghost + wordmark, mirroring the desktop sidebar masthead.

struct MastheadRow: View {
    var body: some View {
        HStack(spacing: 10) {
            GhostMonolineMarkView(size: 38)
            Text("TaskWraith")
                .font(.largeTitle.bold())
                .foregroundStyle(TWTheme.textPrimary)
            Spacer()
        }
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }
}

/// iPhone: NavigationStack. iPad (regular width): NavigationSplitView with the
/// thread list as a persistent sidebar — the home for future iPad-exclusive
/// affordances (sub-thread management, multi-pane).

struct ConnectedShell: View {
    @ObservedObject var model: RemoteSessionModel
    @Environment(\.horizontalSizeClass) private var sizeClass
    @StateObject private var fileState = MobileFileEditorState()
    @StateObject private var diffState = MobileDiffStudioState()
    @State private var shellMode: ShellMode = .app
    @State private var compactFilesPresented = false
    @State private var compactDiffPresented = false
    @State private var previousInspectorPresented = false

    private enum ShellMode {
        case app
        case files
        case diff
    }

    var body: some View {
        shellContent
            .onChange(of: model.fileModeRequest?.id) { _, _ in
                openFilesFromRequest()
            }
            .onChange(of: model.diffModeRequest?.id) { _, _ in
                openDiffFromRequest()
            }
            .fileModeCover(isPresented: $compactFilesPresented) {
                NavigationStack {
                    FilesModeCompactView(model: model, state: fileState) {
                        compactFilesPresented = false
                        model.inspectorPresented = previousInspectorPresented
                    }
                }
                .interactiveDismissDisabled(fileState.isDirty)
            }
            .fileModeCover(isPresented: $compactDiffPresented) {
                NavigationStack {
                    DiffStudioCompactView(model: model, state: diffState) {
                        compactDiffPresented = false
                        model.inspectorPresented = previousInspectorPresented
                    }
                }
            }
    }

    @ViewBuilder
    private var shellContent: some View {
        if sizeClass == .regular {
            if shellMode == .files {
                FilesModeSplitView(model: model, state: fileState) {
                    shellMode = .app
                    model.inspectorPresented = previousInspectorPresented
                }
            } else if shellMode == .diff {
                DiffStudioSplitView(model: model, state: diffState) {
                    shellMode = .app
                    model.inspectorPresented = previousInspectorPresented
                }
            } else {
                NavigationSplitView {
                    HomeView(model: model, selection: $model.selectedTaskId, explicitSelection: true)
                        .navigationSplitViewColumnWidth(min: 300, ideal: 340)
                        .iPadSidebarInnerRim(edge: .trailing)
                } detail: {
                    if let taskId = model.selectedTaskId, taskId.hasPrefix("new-") {
                        NavigationStack {
                            NewChatBootstrapView(
                                model: model,
                                mode: taskId.hasPrefix("new-ensemble")
                                    ? .ensemble
                                    : taskId.hasPrefix("new-global") ? .global : .workspace,
                                initialWorkspaceId: taskId.split(separator: ":").count > 1
                                    ? String(taskId.split(separator: ":")[1]) : nil)
                        }
                        .id(taskId)
                    } else if let taskId = model.selectedTaskId {
                        // Hand-rolled third column: SwiftUI's `.inspector`
                        // presents as an overlay here regardless of attach
                        // level (tried both); an HStack pane DETERMINISTICALLY
                        // resizes the transcript — desktop's three-pane anatomy.
                        HStack(spacing: 0) {
                            NavigationStack {
                                ThreadDetailView(model: model, taskId: taskId)
                            }
                            if model.inspectorPresented {
                                ThreadInspector(model: model, threadId: taskId) { childId in
                                    model.inspectorPresented = false
                                    model.selectedTaskId = childId
                                }
                                .frame(width: 390)
                                .background(TWTheme.appBg)
                                .iPadSidebarInnerRim(edge: .leading)
                                .transition(.move(edge: .trailing))
                            }
                        }
                        .animation(.easeInOut(duration: 0.22), value: model.inspectorPresented)
                        .id(taskId)
                    } else {
                        VStack(spacing: 8) {
                            TaskWraithMonolineBrandView(markSize: 58, titleSize: 22)
                            Text("Select a chat").foregroundStyle(TWTheme.textSecondary)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(TWTheme.appBg)
                    }
                }
            }
        } else {
            NavigationStack {
                HomeView(model: model, selection: $model.selectedTaskId)
                    .navigationDestination(item: $model.selectedTaskId) { taskId in
                        ThreadDetailView(model: model, taskId: taskId)
                            // Compact: the same binding presents as a sheet.
                            .inspector(isPresented: $model.inspectorPresented) {
                                ThreadInspector(model: model, threadId: taskId) { childId in
                                    model.inspectorPresented = false
                                    model.navigationTarget = childId
                                }
                            }
                    }
            }
        }
    }

    private func openFilesFromRequest() {
        guard let request = model.fileModeRequest else { return }
        previousInspectorPresented = model.inspectorPresented
        model.inspectorPresented = false
        fileState.activate(model: model, preferredWorkspaceId: request.workspaceId)
        if sizeClass == .regular {
            shellMode = .files
        } else {
            compactFilesPresented = true
        }
    }

    private func openDiffFromRequest() {
        guard let request = model.diffModeRequest else { return }
        previousInspectorPresented = model.inspectorPresented
        model.inspectorPresented = false
        diffState.activate(model: model, preferredWorkspaceId: request.workspaceId)
        if sizeClass == .regular {
            shellMode = .diff
        } else {
            compactDiffPresented = true
        }
    }
}

private extension View {
    @ViewBuilder
    func fileModeCover<Content: View>(
        isPresented: Binding<Bool>, @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        #if os(iOS)
            self.fullScreenCover(isPresented: isPresented, content: content)
        #else
            self.sheet(isPresented: isPresented, content: content)
        #endif
    }
}

// ── Home: workspaces as projects (Codex-app format, TaskWraith skin) ───────────

enum ComposeMode: String, Identifiable {
    case workspace
    case ensemble
    case global

    var id: String { rawValue }
}
