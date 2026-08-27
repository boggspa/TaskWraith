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

/// Pure policy for keeping ConnectedShell mounted across transient drops and
/// cold launches. Extracted so cached-recovery tests can lock the contract
/// without mounting SwiftUI.
public enum SessionShellPolicy {
    public static func showShellDuringDrop(
        wasEverConnected: Bool,
        hasStoredPairing: Bool,
        phase: SessionPhase
    ) -> Bool {
        guard wasEverConnected, hasStoredPairing else { return false }
        switch phase {
        case .connecting, .error, .idle, .awaitingMacConfirm: return true
        case .connected: return false
        }
    }
}

public struct RootView: View {
    @ObservedObject var model: RemoteSessionModel
    @ObservedObject private var themes = TWThemeStore.shared
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("tw.firstLaunchSheet.dismissed.v1") private var firstLaunchSheetDismissed = false
    @State private var openingFirstLaunchFromSettings = false

    public init(model: RemoteSessionModel) { self.model = model }

    /// Transient drops after a successful session must NOT eject the user
    /// to the pairing screen — trusted reconnect runs underneath while the
    /// shell stays put with a status strip.
    ///
    /// EVERY non-connected phase counts, not just `.connecting`/`.error`. A
    /// trusted reconnect walks the full handshake, so it passes through
    /// `.awaitingMacConfirm` on its way back (RemoteSessionModel sets it for any
    /// attempt that reaches the confirm-code stage, re-pair or not) and can rest
    /// briefly at `.idle` between attempts. With those two missing, each
    /// reconnect cycle swapped the root from ConnectedShell to PairingView and
    /// back — the app visibly flapping between the thread and the welcome screen
    /// several times a second, with every view in the tree torn down and rebuilt
    /// each time.
    ///
    /// The guard is what keeps this safe: `wasEverConnected && hasStoredPairing`
    /// means a FIRST pairing still gets the real PairingView and its confirm
    /// code. Only an already-trusted host holds the shell — and the banner below
    /// surfaces the code anyway, so nothing is hidden even if the Mac does ask
    /// again.
    private var showShellDuringDrop: Bool {
        SessionShellPolicy.showShellDuringDrop(
            wasEverConnected: model.wasEverConnected,
            hasStoredPairing: model.hasStoredPairing,
            phase: model.phase)
    }

    private var isConnectedForFirstLaunch: Bool {
        if case .connected = model.phase { return true }
        return false
    }

    private func presentFirstLaunchIfNeeded() {
        guard isConnectedForFirstLaunch else { return }
        guard !firstLaunchSheetDismissed else { return }
        guard !openingFirstLaunchFromSettings else { return }
        guard !model.settingsPresented, !model.firstLaunchSheetPresented else { return }
        DispatchQueue.main.async {
            guard !model.settingsPresented, !model.firstLaunchSheetPresented else { return }
            model.firstLaunchSheetPresented = true
        }
    }

    @ViewBuilder
    private var connectionBanner: some View {
        switch model.phase {
        case .connecting:
            ConnectionBanner(state: .reconnecting(detail: nil)) {}
        case .error(let message):
            ConnectionBanner(state: .offline(detail: twFriendlyMessage(message))) {
                model.requestReconnect(.user)
            }
        // Held-shell reconnects can pass through the confirm stage. Surface the
        // code in the strip so a Mac that DOES re-ask is still answerable
        // without the user being thrown back to the pairing screen to find it.
        case .awaitingMacConfirm(let code):
            ConnectionBanner(state: .reconnecting(detail: "Confirm \(code) on your Mac")) {}
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
                    if model.isDemo {
                        // Banner ABOVE the shell (not a safeAreaInset, which
                        // overlaps the nav bar's back/Exit/title row).
                        VStack(spacing: 0) {
                            DemoModeBanner(model: model)
                            ConnectedShell(model: model)
                        }
                    } else {
                        ConnectedShell(model: model)
                    }
                // `where` binds per-pattern in Swift — both arms need the guard
                // or a fresh pairing's .connecting would show the shell.
                case .connecting where showShellDuringDrop,
                    .error where showShellDuringDrop,
                    .idle where showShellDuringDrop,
                    .awaitingMacConfirm where showShellDuringDrop:
                    // In-flow ABOVE the shell (same treatment as DemoModeBanner),
                    // never an overlay: an overlaid banner sat on top of the
                    // toolbar and swallowed its taps, so during a long outage
                    // Settings — where hosts are managed and re-pairing lives —
                    // was unreachable and the only escape was killing the app.
                    VStack(spacing: 0) {
                        connectionBanner
                        ConnectedShell(model: model)
                    }
                case .idle, .connecting, .awaitingMacConfirm, .error:
                    NavigationStack { PairingView(model: model) }
                }
            }
        }
        .tint(TWTheme.chroma1)
        .twColorScheme()
        .twAppScale(themes.appScalePreference)
        // Theme tokens are computed statics — a revision bump rebuilds the
        // tree so every TWTheme read picks up the new selection.
        .id(themes.revision)
        // Settings sheet lives ABOVE the revision teardown (attached after
        // `.id`) so a theme/composer/font change made inside it keeps the sheet
        // open — AppSettingsSheet re-themes live via its own @ObservedObject
        // themes. Presented here, not from HomeView, which is inside the
        // `.id(revision)` subtree that rebuilds on every settings change.
        .settingsSurfaceCover(isPresented: $model.settingsPresented) {
            AppSettingsSheet(model: model, onOpenFirstLaunchGuide: {
                openingFirstLaunchFromSettings = true
                model.settingsPresented = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                    firstLaunchSheetDismissed = false
                    model.firstLaunchSheetPresented = true
                    openingFirstLaunchFromSettings = false
                }
            })
        }
        .sheet(
            isPresented: $model.firstLaunchSheetPresented,
            onDismiss: { firstLaunchSheetDismissed = true }
        ) {
            FirstLaunchSheetView(
                model: model,
                onOpenSettings: {
                    model.firstLaunchSheetPresented = false
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                        model.settingsPresented = true
                    }
                },
                onDone: {
                    firstLaunchSheetDismissed = true
                    model.firstLaunchSheetPresented = false
                }
            )
            .twSheetLiquidGlass(detents: [.large])
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
        .task {
            model.resumeIfIdle()
            presentFirstLaunchIfNeeded()
        }
        .onChange(of: model.phase) { _, _ in presentFirstLaunchIfNeeded() }
        .onChange(of: model.settingsPresented) { _, isPresented in
            if !isPresented { presentFirstLaunchIfNeeded() }
        }
        .onChange(of: scenePhase) { _, phase in
            // iOS kills sockets in the background — coming back to the
            // foreground silently re-resolves the stored pairing.
            if phase == .active {
                model.requestReconnect(.foreground)
                model.handleScenePhaseWatchAssertion(isActive: true)
            } else {
                // Leaving the foreground: flush any debounced composer draft now, so
                // text typed in the last moment is durable before iOS suspends us.
                TWDraftPersistence.flush()
                model.handleScenePhaseWatchAssertion(isActive: false)
            }
        }
    }
}

/// Full-screen recovery surface for an unreadable/unpersistable device
/// identity. Deliberately NOT a path back into pairing: regenerating the
/// identity is a user decision (it breaks the Mac's pin), so the screen
/// explains the state and offers retry + the deliberate way out.
struct IdentityErrorView: View {
    @ObservedObject var model: RemoteSessionModel

    private var deviceName: String {
        #if canImport(UIKit)
            switch UIDevice.current.userInterfaceIdiom {
            case .pad: return "iPad"
            default: return "iPhone"
            }
        #else
            return "device"
        #endif
    }

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
                        "Unlock your \(deviceName), then tap Try again.",
                        systemImage: "lock.open")
                    Label(
                        "If this keeps happening, restart your \(deviceName).",
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

/// Width budget for the hand-rolled inspector column inside the iPad detail
/// pane.
///
/// The inspector took a FIXED `appScale.scaled(390)`, which quietly assumed the
/// detail pane is always ~800pt wide. On an 11-inch iPad in portrait it is not:
/// an 834pt window minus the ~350pt sidebar leaves ~484pt, the inspector took
/// ~296pt of that, and the transcript was left ~180pt — narrower than its rows
/// compress to, so ThreadDetailView laid out WIDER than its column and clipped
/// on both edges. iPhone never hits this: in compact width the same
/// `inspectorPresented` binding presents as a sheet.
///
/// The transcript's floor is the invariant. The inspector's preferred width is
/// only ever a ceiling, and a pane that cannot seat both columns gets no split
/// at all — the inspector presents OVER the transcript instead, which is what
/// the compact branch already does.
enum ThreadInspectorColumnPolicy {
    /// Below this the transcript's rows stop compressing and start overflowing.
    static let transcriptFloor: CGFloat = 420
    /// An inspector narrower than this cannot carry its tab strip, so taking
    /// width for it buys nothing.
    static let inspectorFloor: CGFloat = 320

    /// Width for the inline inspector column, or nil when the pane cannot
    /// afford two columns and the inspector must be presented over the
    /// transcript.
    static func inlineWidth(paneWidth: CGFloat, preferred: CGFloat) -> CGFloat? {
        let affordable = paneWidth - transcriptFloor
        guard affordable >= inspectorFloor else { return nil }
        return min(preferred, affordable)
    }
}

/// iPhone: NavigationStack. iPad (regular width): NavigationSplitView with the
/// thread list as a persistent sidebar — the home for future iPad-exclusive
/// affordances (sub-thread management, multi-pane).

struct ConnectedShell: View {
    @ObservedObject var model: RemoteSessionModel
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.appScale) private var appScale
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
                    FilesModeCompactView(
                        model: model,
                        state: fileState,
                        onShowSelectedDiff: openFileInDiff
                    ) {
                        compactFilesPresented = false
                        model.inspectorPresented = previousInspectorPresented
                    }
                }
                .background(Color.clear)
                .interactiveDismissDisabled(fileState.isDirty)
            }
            .fileModeCover(isPresented: $compactDiffPresented) {
                NavigationStack {
                    DiffStudioCompactView(
                        model: model,
                        state: diffState,
                        onOpenSelectedFile: openDiffFileInFiles
                    ) {
                        compactDiffPresented = false
                        model.inspectorPresented = previousInspectorPresented
                    }
                }
                .background(Color.clear)
            }
    }

    @ViewBuilder
    private var shellContent: some View {
        if sizeClass == .regular {
            if shellMode == .files {
                FilesModeSplitView(
                    model: model,
                    state: fileState,
                    onBack: {
                        shellMode = .app
                        model.inspectorPresented = previousInspectorPresented
                    },
                    onShowSelectedDiff: openFileInDiff
                )
            } else if shellMode == .diff {
                DiffStudioSplitView(
                    model: model,
                    state: diffState,
                    onBack: {
                        shellMode = .app
                        model.inspectorPresented = previousInspectorPresented
                    },
                    onOpenSelectedFile: openDiffFileInFiles
                )
            } else {
                NavigationSplitView {
                    HomeView(model: model, selection: $model.selectedTaskId, explicitSelection: true)
                        .navigationSplitViewColumnWidth(
                            min: appScale.scaled(300),
                            ideal: appScale.scaled(340)
                        )
                        .iPadSidebarInnerRim(edge: .trailing)
                } detail: {
                    if let taskId = model.selectedTaskId, taskId.hasPrefix("new-") {
                        NavigationStack {
                            NewChatBootstrapView(
                                model: model,
                                mode: taskId.hasPrefix("new-global")
                                    ? .global
                                    : taskId.hasPrefix("new-workflow") ? .workflow : .workspace,
                                initialWorkspaceId: taskId.split(separator: ":").count > 1
                                    ? String(taskId.split(separator: ":")[1]) : nil)
                        }
                        .id(taskId)
                        .tint(TWTheme.chroma1)
                    } else if let taskId = model.selectedTaskId {
                        // Hand-rolled third column: SwiftUI's `.inspector`
                        // presents as an overlay here regardless of attach
                        // level (tried both); an HStack pane DETERMINISTICALLY
                        // resizes the transcript — desktop's three-pane anatomy.
                        //
                        // The width is BUDGETED against the pane, never fixed
                        // (see ThreadInspectorColumnPolicy). A pane too narrow
                        // to seat both columns keeps the transcript above its
                        // floor and takes the OVERLAY presentation instead —
                        // which is the `.inspector` behaviour the note above
                        // rejects for the WIDE case, and the right answer for
                        // the narrow one.
                        //
                        // `pane.size` is read and used inline, never written
                        // back to @State, so this cannot reintroduce a
                        // measurement→state layout oscillation.
                        GeometryReader { pane in
                            let inlineWidth = ThreadInspectorColumnPolicy.inlineWidth(
                                paneWidth: pane.size.width,
                                preferred: appScale.scaled(390))
                            HStack(spacing: 0) {
                                NavigationStack {
                                    ThreadDetailView(model: model, taskId: taskId)
                                }
                                if model.inspectorPresented, let inlineWidth {
                                    ThreadInspector(model: model, threadId: taskId) { childId in
                                        model.inspectorPresented = false
                                        model.selectedTaskId = childId
                                    }
                                    .frame(width: inlineWidth)
                                    .background(TWTheme.appBg)
                                    .iPadSidebarInnerRim(edge: .leading)
                                    .transition(.move(edge: .trailing))
                                }
                            }
                            // Load-bearing: GeometryReader gives its child no
                            // size proposal and pins it top-leading, so without
                            // this the HStack would stop filling the pane.
                            .frame(width: pane.size.width, height: pane.size.height)
                            .animation(
                                .easeInOut(duration: 0.22), value: model.inspectorPresented
                            )
                            .inspector(
                                isPresented: Binding(
                                    get: { model.inspectorPresented && inlineWidth == nil },
                                    set: { model.inspectorPresented = $0 })
                            ) {
                                ThreadInspector(model: model, threadId: taskId) { childId in
                                    model.inspectorPresented = false
                                    model.selectedTaskId = childId
                                }
                            }
                        }
                        .id(taskId)
                        .tint(TWTheme.chroma1)
                    } else {
                        VStack(spacing: 8) {
                            TaskWraithMonolineBrandView(markSize: 58, titleSize: 22)
                            Text("Select a chat").foregroundStyle(TWTheme.textSecondary)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(TWTheme.appBg)
                    }
                }
                // De-blue the system NavigationSplitView sidebar toggle. It is the
                // split's own chrome (a sibling of the columns, not their child), so
                // a tint on the sidebar CONTENT never reached it — the tint has to
                // sit on the split itself. The sidebar is safe under a monochrome
                // tint (it uses explicit chrome, and its pills force their own
                // tint); the detail panes above re-assert chroma1 so the rest of the
                // app keeps its accent.
                .tint(TWTheme.textPrimary)
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

    private func openFileInDiff(_ path: String) {
        guard let workspaceId = fileState.selectedWorkspaceId,
            model.workspaceCanReviewDiffs(workspaceId)
        else { return }
        previousInspectorPresented = model.inspectorPresented
        model.inspectorPresented = false
        diffState.activate(model: model, preferredWorkspaceId: workspaceId, targetPath: path)
        if sizeClass == .regular {
            shellMode = .diff
        } else {
            compactFilesPresented = false
            DispatchQueue.main.async {
                compactDiffPresented = true
            }
        }
    }

    private func openDiffFileInFiles(_ path: String) {
        guard let workspaceId = diffState.selectedWorkspaceId,
            model.workspaceCanEditFiles(workspaceId)
        else { return }
        previousInspectorPresented = model.inspectorPresented
        model.inspectorPresented = false
        fileState.activate(model: model, preferredWorkspaceId: workspaceId)
        fileState.requestPath(path, model: model)
        if sizeClass == .regular {
            shellMode = .files
        } else {
            compactDiffPresented = false
            DispatchQueue.main.async {
                compactFilesPresented = true
            }
        }
    }

    private func openFilesFromRequest() {
        guard let request = model.fileModeRequest else { return }
        previousInspectorPresented = model.inspectorPresented
        model.inspectorPresented = false
        fileState.activate(model: model, preferredWorkspaceId: request.workspaceId)
        if let targetPath = request.targetPath {
            fileState.requestPath(targetPath, model: model)
        }
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
        diffState.activate(
            model: model,
            preferredWorkspaceId: request.workspaceId,
            targetPath: request.targetPath)
        if sizeClass == .regular {
            shellMode = .diff
        } else {
            compactDiffPresented = true
        }
    }
}

private extension View {
    @ViewBuilder
    func settingsSurfaceCover<Content: View>(
        isPresented: Binding<Bool>, @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        #if os(iOS)
            self.sheet(isPresented: isPresented) {
                content()
                    .twSheetLiquidGlass(detents: [.large])
            }
        #else
            self.sheet(isPresented: isPresented, content: content)
        #endif
    }

    @ViewBuilder
    func fileModeCover<Content: View>(
        isPresented: Binding<Bool>, @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        #if os(iOS)
            // Keep full-screen UX, but ride the same liquid-glass presentation
            // backdrop as compact sheets so Diff Studio / Files no longer paint
            // system gray over the glass (content panes already clear when
            // twGlassSheetHosted is set).
            self.fullScreenCover(isPresented: isPresented) {
                content()
                    .twFullScreenLiquidGlass()
            }
        #else
            self.sheet(isPresented: isPresented, content: content)
        #endif
    }
}

// ── Home: workspaces as projects (Codex-app format, TaskWraith skin) ───────────

enum ComposeMode: String, Identifiable {
    case workspace
    case global
    case workflow

    var id: String { rawValue }
}
