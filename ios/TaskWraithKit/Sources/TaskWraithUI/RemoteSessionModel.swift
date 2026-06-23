// RemoteSessionModel — the observable bridge between the SwiftUI views and the
// proven RelayTransportClient. Owns the phone's persisted identity, drives
// pairing (QR/paste → connect → established), decodes the projection snapshot
// into renderable cards, and sends actions. All UI-facing state is @Published on
// the main actor; the transport runs on its own actor and feeds this via its
// AsyncStream of events.

import Foundation
import CryptoKit
import Network
import TaskWraithKit
#if canImport(UIKit)
    import UIKit
    import UserNotifications
#endif

/// Where the phone persists its long-lived Ed25519 identity seed. The iOS app
/// supplies a Keychain-backed implementation; a file-backed default keeps the
/// model usable on macOS for previews + compile-checking.
///
/// Security review (residual MED, fixed): an EXISTING identity that can't be
/// read must surface as an error — silently minting a replacement broke the
/// Mac's pin with no explanation and masked tampering. Implementations only
/// generate when storage reports the identity genuinely absent.
public protocol IdentitySeedStore: Sendable {
    func loadOrCreateSeed() throws -> Data
}

public enum IdentitySeedStoreError: LocalizedError {
    /// The identity exists but can't be read (locked/failed keychain,
    /// corrupt record). Never silently replaced.
    case readFailed(String)
    /// A fresh identity couldn't be durably persisted — proceeding would
    /// break the pairing on the next launch instead of now.
    case persistFailed(String)

    public var errorDescription: String? {
        switch self {
        case .readFailed(let detail):
            return "This device's identity key exists but can't be read (\(detail))."
        case .persistFailed(let detail):
            return "A new identity key couldn't be saved (\(detail))."
        }
    }
}

public struct FileIdentitySeedStore: IdentitySeedStore {
    let url: URL
    public init(url: URL) { self.url = url }
    public func loadOrCreateSeed() throws -> Data {
        if FileManager.default.fileExists(atPath: url.path) {
            let data: Data
            do {
                data = try Data(contentsOf: url)
            } catch {
                throw IdentitySeedStoreError.readFailed(error.localizedDescription)
            }
            guard data.count == 32 else {
                throw IdentitySeedStoreError.readFailed("corrupt seed (\(data.count) bytes)")
            }
            return data
        }
        let seed = Curve25519.Signing.PrivateKey().rawRepresentation
        do {
            try seed.write(to: url, options: [.atomic])
        } catch {
            throw IdentitySeedStoreError.persistFailed(error.localizedDescription)
        }
        return seed
    }
}

public enum SessionPhase: Equatable, Sendable {
    case idle
    case connecting
    /// Handshake reached the confirm code; the user compares it with the Mac and
    /// taps "Pair" ON THE MAC (the phone just waits to become established).
    case awaitingMacConfirm(code: String)
    case connected
    case error(String)
}

// ── Paired-host persistence ─────────────────────────────────────────────────
// After the first pairing the phone remembers WHO it paired with so app
// relaunches and host restarts reconnect silently via the relay's resolve
// directory (each host pins this phone's identity and accepts without a
// prompt). This is PUBLIC material only — each host's identity public key,
// relay URLs, display name; the phone's private identity seed stays in the
// Keychain via IdentitySeedStore and is the SAME single seed for every host.
//
// The phone can pair with MANY hosts. The record/store/migration types live in
// TaskWraithKit (PairedHostStore.swift) — a pure, exhaustively-tested keyed
// collection (PairedHostRecord / PairedHostsDocument / PairedHostStore) that
// mirrors the Mac bridge's v2 RemotePairingStore. `selectedHostId` is the
// active host this model is connected to / showing.

/// Persists the sidebar expand/collapse layout across launches. The sets stay
/// @Published on RemoteSessionModel for live SwiftUI updates; this just mirrors
/// them to UserDefaults so the user's adjustments — and the first-launch iPad
/// collapse-to-headers — survive a relaunch.
enum TWSidebarPersistence {
    enum Key: String {
        case expandedWorkspaces = "tw.sidebar.expandedWorkspaces"
        case collapsedSections = "tw.sidebar.collapsedSections"
        case collapsedParents = "tw.sidebar.collapsedParents"
    }
    static func load(_ key: Key) -> Set<String> {
        Set(UserDefaults.standard.stringArray(forKey: key.rawValue) ?? [])
    }
    static func save(_ value: Set<String>, _ key: Key) {
        UserDefaults.standard.set(Array(value), forKey: key.rawValue)
    }
}

@MainActor
public final class RemoteSessionModel: ObservableObject {
    @Published public private(set) var phase: SessionPhase = .idle
    /// True while the offline DEMO session is showing (App Review / first-look):
    /// no network client, canned data, inert actions. Drives the demo banner.
    @Published public private(set) var isDemo = false
    @Published public private(set) var macDisplayName: String = ""
    @Published public private(set) var taskCards: [RemoteTaskCard] = []
    @Published public private(set) var approvals: [MobileApprovalCard] = []
    @Published public private(set) var questions: [MobileQuestionCard] = []
    /// Ids the user just acted on locally — suppressed from re-display until the
    /// Mac's projection confirms resolution (drops them). Without this the
    /// modal lingered after Accept: the card is only cleared by the next
    /// authoritative snapshot, and a snapshot already in flight when the user
    /// taps would otherwise flash the resolved card straight back.
    private var repliedApprovalToolCallIds: Set<String> = []
    private var repliedQuestionIds: Set<String> = []
    /// Plan messageIds the user just acted on (approve/respond/dismiss), keyed on
    /// the transcript row id (a proposed plan parks NO tool-call, so this can't
    /// reuse repliedApprovalToolCallIds). Unlike approvals/questions — which
    /// re-render by removal from the @Published `approvals`/`questions` arrays —
    /// a plan card stays in the transcript, so this set must be @Published to
    /// drive the action row's disabled state until the Mac's status re-projection
    /// lands. Restored in onAck on `!accepted` so a denied decision re-enables it.
    @Published private var repliedProposedPlanIds: Set<String> = []
    /// Allowlist-visible workspaces (the compose surface). Empty until the Mac
    /// has at least one entry in Settings → Devices → workspace access.
    @Published public private(set) var workspaces: [WorkspaceSummary] = []
    /// Scheduled / recurring workflows projected from the Mac (sidebar
    /// "Workflows" section). Read-only on the phone — tapping opens the
    /// workflow's chat. One `workflows` envelope per workflow, like `taskCard`.
    @Published public private(set) var workflows: [RemoteWorkflow] = []
    /// Saved ensemble roster presets projected from the Mac (iOS Roster page's
    /// "Load preset"). GLOBAL; one `ensemblePresets` envelope per preset.
    @Published public private(set) var ensemblePresets: [RemoteEnsemblePreset] = []
    /// Latest thread snapshot per taskId/threadId (drives the detail view).
    @Published public private(set) var threadSnapshots: [String: RemoteThreadSnapshot] = [:]
    /// Run summaries the phone hid when the user sent a follow-up turn. The Mac
    /// may continue projecting old terminal summaries until the next run
    /// finishes, so filter those exact old summaries out of later snapshots.
    private var hiddenRunSummaryFingerprintsByThread: [String: Set<String>] = [:]
    /// Per-provider model catalogs (same source as the desktop picker) —
    /// arrives shortly after establish; empty until then.
    @Published public private(set) var providerModels: [String: [ModelOption]] = [:]
    /// Token totals for the heatmap chips (24h/7d/90d, per provider).
    @Published public private(set) var usageRollup: UsageRollupMessage.Rollup? = nil
    /// 90-day daily token series for the Inspector bar charts (Issue 4). Ride
    /// the usage-rollup broadcast alongside `usageRollup`.
    @Published public private(set) var taskwraithTokenDaily: DailyTokenSeries? = nil
    @Published public private(set) var externalTokenDaily: DailyTokenSeries? = nil
    /// Per-provider quota windows (Usage tab; desktop sidebar parity).
    @Published public private(set) var modelUsage: ModelUsageMessage.Usage? = nil
    /// The Electron welcome stats dashboard (Statistics / Models / Workspaces /
    /// Providers). Rides the usage-rollup cadence; nil until the first push.
    @Published public private(set) var welcomeDashboard: WelcomeDashboard? = nil
    /// Redacted Mac-authored first-launch orientation state. Cleared on host
    /// switch/demo exit so provider/readiness data never bleeds between Macs.
    @Published public private(set) var firstLaunchState: FirstLaunchState? = nil
    /// Token-level live text per thread, accumulated from bridge.runEvent
    /// content deltas — renders as the growing assistant bubble between
    /// snapshot pushes. Cleared when the run exits (the final snapshot row
    /// supersedes it).
    @Published public private(set) var streamingTexts: [String: String] = [:]
    /// The live text SPLIT at tool boundaries — element k is the text between
    /// tool call k-1 and tool call k, the last element is the growing tail.
    /// The transcript view interleaves these with the run's tool rows so the
    /// streaming order matches the finished transcript (tool cards between
    /// paragraphs, not clumped above one bubble). `streamingTexts` stays the
    /// joined mirror for single-bubble surfaces (side-chat mini window) and
    /// scroll triggers.
    @Published public private(set) var streamingSegments: [String: [String]] = [:]
    /// Live run id per streaming thread — lets the view hide the in-flight
    /// snapshot row the bubble supersedes.
    @Published public private(set) var streamingRunIds: [String: String] = [:]
    /// Provider currently producing each live stream. This comes from the
    /// bridge.runEvent envelope and updates before the next snapshot/ensemble
    /// state pull, so live headers do not briefly show the previous speaker.
    @Published public private(set) var streamingProviders: [String: String] = [:]
    /// Last Codex item id appended to each thread's live bubble — an item
    /// transition gets a paragraph break so bursts don't jam ("…ops.The
    /// first shell…"). Not published: render state derives from the text.
    private var streamingItemIds: [String: String] = [:]
    /// Live ensemble round state per thread (desktop roster-chip parity).
    @Published public private(set) var ensembleStates: [String: RemoteEnsembleState] = [:]
    /// Latest run diff summary per thread (inspector diff tab + changes row).
    @Published public private(set) var diffSummaries: [String: MobileDiffSummary] = [:]
    /// Git status snapshots keyed by workspace id. Composer rows use this for
    /// branch/upstream/worktree parity with the desktop native composer.
    @Published public private(set) var gitSnapshots: [String: GitWorkspaceSnapshot] = [:]
    /// Latest composer shellAppearance projected by the Mac (drives the
    /// "Follow Mac" composer style); stale re-broadcasts ignored via generatedAt.
    @Published public private(set) var projectedShellAppearance: TWRemoteShellAppearance?
    /// generatedAt of the last applied shellAppearance — the staleness gate.
    private var lastShellAppearanceGeneratedAt: String?
    /// The Mac-projected composer style (nil until the first shellAppearance).
    public var projectedComposerStyle: TWComposerStyle? { projectedShellAppearance?.style }
    @Published public private(set) var lastActionMessage: String?
    /// Set after createThread succeeds — HomeView navigates to the new chat.
    @Published public var navigationTarget: String?
    /// The chat the user has open (sidebar selection / pushed thread), plus the
    /// sidebar's expand/collapse layout. Hoisted onto the model so they SURVIVE
    /// the theme-revision view teardown: TWThemeStore bumps `revision` on any
    /// settings change and RootView keys `.id(revision)` (TWTheme tokens are
    /// computed statics, so the rebuild is how they re-read) — which would
    /// otherwise drop the open chat + reset the sidebar. `selectedTaskId` drives
    /// the iPad detail column and the iPhone `navigationDestination(item:)`.
    @Published public var selectedTaskId: String?
    // Sidebar layout — persisted across launches (see TWSidebarPersistence). The
    // paren-wrapped initializer disambiguates the didSet block from a trailing
    // closure on `load(_:)`.
    @Published public var expandedWorkspaces: Set<String> = (TWSidebarPersistence.load(.expandedWorkspaces)) {
        didSet { TWSidebarPersistence.save(expandedWorkspaces, .expandedWorkspaces) }
    }
    @Published public var collapsedSections: Set<String> = (TWSidebarPersistence.load(.collapsedSections)) {
        didSet { TWSidebarPersistence.save(collapsedSections, .collapsedSections) }
    }
    @Published public var collapsedParents: Set<String> = (TWSidebarPersistence.load(.collapsedParents)) {
        didSet { TWSidebarPersistence.save(collapsedParents, .collapsedParents) }
    }
    /// Settings sheet presentation — hoisted so a theme/composer/font change
    /// made inside it doesn't tear the sheet down with the rest of the tree.
    /// Presented from RootView (above the `.id(revision)` boundary); the sheet
    /// re-themes live via its own `@ObservedObject themes`.
    @Published public var settingsPresented = false
    /// Presented from RootView alongside settings, but root-owned so it can open
    /// after pairing/demo without being torn down by theme revision rebuilds.
    @Published public var firstLaunchSheetPresented = false
    /// Deep-link target captured from a notification tap before the session is
    /// established (cold launch); applied to navigationTarget on `.established`.
    private var pendingDeepLinkThreadId: String?
    /// Expanded row bodies keyed by threadId → rowId.
    @Published public private(set) var rowExpansions: [String: [String: RemoteThreadSnapshot.Row]] =
        [:]
    @Published public private(set) var expandingRows: Set<String> = []
    @Published public private(set) var loadingPreviousThreadRows: Set<String> = []

    /// True when an ACTIVE pairing is on disk — drives the "Reconnect" affordance
    /// and launch-time auto-resume. Equivalent to `selectedHostId != nil`.
    @Published public private(set) var hasStoredPairing: Bool
    /// Every paired host (multi-host). The view layer renders this as the host
    /// switcher / paired-hosts list; the active one is `selectedHostId`. Sorted
    /// as persisted (insertion order); `pairedAt` is available for display.
    @Published public private(set) var pairedHosts: [PairedHostRecord] = []
    /// macIdentityPubKey of the host this model is connected to / showing, or
    /// nil when none is paired. Reconnect / resume always target this host.
    @Published public private(set) var selectedHostId: String?
    /// QR-optional discovery (multi-host): OTHER TaskWraith hosts the connected
    /// host ("oracle") found on the tailnet, already deduped against
    /// `pairedHosts`. Populated by `discoverHosts()`; reset on host change.
    @Published public private(set) var discoveredHosts: [DiscoveredHostInfo] = []
    /// True while a `discoverHosts()` enumeration is in flight (drives a spinner).
    @Published public private(set) var isDiscoveringHosts = false
    /// Last discovery failure, surfaced under the search button; nil on success.
    @Published public private(set) var discoveryError: String?
    /// True once a session has established this app launch — drives the
    /// keep-the-shell-during-reconnect behavior (transient drops must NOT
    /// eject the user to the pairing screen).
    @Published public private(set) var wasEverConnected = false
    /// First-connect hydration gate. False until this pairing has either
    /// received real content (workspaces / task cards) or waited out a
    /// short post-establish grace window — views show "Syncing…" tickers
    /// instead of authoritative empty states while it's false. The grace
    /// covers a genuinely empty Mac AND the settling-restart case (the Mac
    /// re-seeds at ~1.5s; 5s leaves margin on a slow relay). Never reset on
    /// transient drops — retained data stays on screen by design.
    @Published public private(set) var projectionHydrated = false
    /// The thread currently open in a detail view (nil on home). Used to
    /// re-request its snapshot after a reconnect — it may be outside the
    /// establish broadcast's recent-N window.
    public var visibleThreadId: String? = nil
    /// Inspector presentation — hoisted here so the SHELL can attach the
    /// `.inspector` at NavigationStack level (true side-by-side column on
    /// iPad instead of an overlay; sheet on iPhone).
    @Published public var inspectorPresented = false
    /// Dedicated ensemble Roster page (transcript icon + chip-tap entry).
    /// Ensemble chats only. Replaces the cramped per-chip editor sheet.
    @Published public var rosterPresented = false
    /// When the Roster page opens from a tapped participant chip, auto-open
    /// that participant's detail editor (consumed once on appear, then cleared).
    @Published public var rosterFocusParticipantId: String? = nil
    /// APNs token waiting for an established session (tokens can arrive
    /// before the transport connects on cold launch).
    private var pendingApnsToken: (hex: String, env: String)? = nil
    private var apnsTokenRegistrationInFlight = false
    private var apnsTokenRetryTask: Task<Void, Never>? = nil

    /// Called by the app delegate when iOS delivers the device token.
    public func handleApnsToken(_ hex: String, env: String) {
        pendingApnsToken = (hex, env)
        sendPendingApnsTokenIfReady()
    }

    private func sendPendingApnsTokenIfReady() {
        guard case .connected = phase, client != nil, let token = pendingApnsToken else { return }
        guard !apnsTokenRegistrationInFlight else { return }
        apnsTokenRetryTask?.cancel()
        apnsTokenRetryTask = nil
        apnsTokenRegistrationInFlight = true
        send(
            BridgeAction.registerApnsToken(deviceToken: token.hex, env: token.env),
            successLabel: "Notifications ready.",
            navigateOnAck: false,
            onAck: { [weak self] accepted in
                guard let self else { return }
                self.apnsTokenRegistrationInFlight = false
                if accepted, self.pendingApnsToken?.hex == token.hex,
                    self.pendingApnsToken?.env == token.env
                {
                    self.pendingApnsToken = nil
                    return
                }
                if self.pendingApnsToken?.hex != token.hex || self.pendingApnsToken?.env != token.env {
                    self.sendPendingApnsTokenIfReady()
                } else {
                    self.scheduleApnsTokenRetry()
                }
            })
    }

    private func scheduleApnsTokenRetry() {
        guard pendingApnsToken != nil else { return }
        apnsTokenRetryTask?.cancel()
        apnsTokenRetryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.sendPendingApnsTokenIfReady() }
        }
    }

    public func handleRemoteWake(reason _: String, timeoutMs: Int = 10_000) async -> Bool {
        guard hasStoredPairing else { return false }
        switch phase {
        case .connected:
            if let client {
                let attempt = connectAttempt
                let alive = await client.checkSocketAlive()
                guard connectAttempt == attempt else {
                    return await waitForRemoteWakeConnection(timeoutMs: timeoutMs)
                }
                if alive { return true }
            }
            autoReconnectAttempt = 0
            reconnectTrusted()
        case .connecting, .awaitingMacConfirm:
            break
        case .idle, .error:
            autoReconnectAttempt = 0
            reconnectTrusted()
        }
        return await waitForRemoteWakeConnection(timeoutMs: timeoutMs)
    }

    private func waitForRemoteWakeConnection(timeoutMs: Int) async -> Bool {
        var waitedMs = 0
        while waitedMs < timeoutMs {
            if case .connected = phase { return true }
            guard !Task.isCancelled else { return false }
            try? await Task.sleep(nanoseconds: 250_000_000)
            waitedMs += 250
        }
        return false
    }

    /// One-time (per authorization state) UNUserNotificationCenter ask —
    /// AFTER pairing, so the permission prompt has context. Registration
    /// re-runs every launch (tokens rotate).
    private func requestPushAuthorizationIfNeeded() {
        // Registration is runtime-gated below by the notification authorization
        // status and is only reached after a successful pairing — so it is safe
        // (and necessary) in Release/TestFlight too. The previous
        // `#if !DEBUG && !TASKWRAITH_ENABLE_APNS_REGISTRATION return` wrapper
        // compiled this out of every shipped build, leaving no device token to
        // push to; the flag was never defined in the Xcode project.
        #if canImport(UIKit)
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                switch settings.authorizationStatus {
                case .notDetermined:
                    UNUserNotificationCenter.current().requestAuthorization(options: [
                        .alert, .badge, .sound,
                    ]) { granted, _ in
                        guard granted else { return }
                        DispatchQueue.main.async {
                            UIApplication.shared.registerForRemoteNotifications()
                        }
                    }
                case .authorized, .provisional, .ephemeral:
                    DispatchQueue.main.async {
                        UIApplication.shared.registerForRemoteNotifications()
                    }
                default:
                    break
                }
            }
        #endif
    }
    /// Side-chat child that should open inside the inspector instead of
    /// replacing the split-view detail pane.
    @Published public var inspectorSideChatTarget: String?
    @Published public var fileModeRequest: FileModeRequest?
    @Published public var diffModeRequest: DiffModeRequest?

    private var identitySeed: Data
    private let identityStore: IdentitySeedStore
    private let pairingStore: PairedHostStore
    private var client: RelayTransportClient?
    private var eventTask: Task<Void, Never>?
    private var pinnedMacIdentityB64: String?
    private var relayUrl: String?

    /// Set when the identity seed couldn't be loaded/persisted — the shell
    /// shows a dedicated recovery screen and every connect path refuses
    /// until `retryIdentityLoad()` succeeds. Never auto-regenerated: the
    /// Mac pins this identity, so a silent replacement just looks like a
    /// mysteriously dead pairing (and would mask tampering).
    @Published public private(set) var identityError: String?

    public init(
        identityStore: IdentitySeedStore,
        pairingStore: PairedHostStore = UserDefaultsPairedHostStore()
    ) {
        self.identityStore = identityStore
        var seed = Data()
        var loadError: String? = nil
        do {
            seed = try identityStore.loadOrCreateSeed()
        } catch {
            loadError = Self.identityErrorMessage(error)
        }
        self.identitySeed = seed
        self.identityError = loadError
        self.pairingStore = pairingStore
        // Loading triggers the one-shot v1→v2 migration on first launch, so an
        // existing single-host user keeps their host (now the active one).
        let doc = pairingStore.load()
        self.pairedHosts = doc.hosts
        self.selectedHostId = doc.selectedHostId
        self.hasStoredPairing = doc.selectedHostId != nil
        if let active = doc.selectedHost {
            self.macDisplayName = Self.sanitizedMacName(active.macDisplayName)
        }
        startPathMonitor()
    }

    // ── Reconnect self-healing ──────────────────────────────────────────────
    // A cold cellular launch races the Tailscale tunnel: the first trusted-
    // reconnect walk usually runs BEFORE the on-demand VPN is up, exhausts
    // its two passes (~35s of dead dials), and parked on the error screen
    // until the user poked the app — field reports of "reconnects after 2-3
    // minutes" were really "reconnects when something finally retried".
    // Two healers: a backoff loop that keeps re-walking while the error
    // screen shows, and a network-path monitor that re-dials the INSTANT a
    // new route (the tunnel, a Wi-Fi join) appears.

    private var autoReconnectTask: Task<Void, Never>?
    private var socketHealthTask: Task<Void, Never>?
    private var autoReconnectAttempt = 0
    private var pathMonitor: NWPathMonitor?
    private var lastPathSignature = ""
    private var trustedReconnectAttempt: Int?

    private func startPathMonitor() {
        guard pathMonitor == nil else { return }
        let monitor = NWPathMonitor()
        pathMonitor = monitor
        monitor.pathUpdateHandler = { [weak self] path in
            // Interface set + reachability as a change signature — utun
            // appearing (tunnel up) or Wi-Fi joining changes it; idle
            // re-notifications don't.
            let signature =
                path.availableInterfaces.map { "\($0.type)\($0.name)" }.joined(separator: ",")
                + (path.status == .satisfied ? "|up" : "|down")
            Task { @MainActor [weak self] in
                guard let self else { return }
                let previous = self.lastPathSignature
                guard signature != previous else { return }
                self.lastPathSignature = signature
                // First callback just seeds the signature; a route change
                // only matters when a reconnect is winnable AND wanted.
                guard !previous.isEmpty, path.status == .satisfied, self.hasStoredPairing
                else { return }
                switch self.phase {
                case .error, .idle:
                    self.autoReconnectAttempt = 0
                    self.reconnectTrusted()
                case .connecting where self.trustedReconnectAttempt == self.connectAttempt:
                    self.autoReconnectAttempt = 0
                    self.reconnectTrusted()
                default:
                    break
                }
            }
        }
        monitor.start(queue: .global(qos: .utility))
    }

    /// Re-walk after a failed trusted reconnect: 1.5s, 3s, 6s, 12s, 24s,
    /// then every 30s while the error screen is up. Cancelled by success,
    /// disconnect/forget, or a newer reconnect of any kind.
    private func scheduleAutoReconnect() {
        guard hasStoredPairing else { return }
        autoReconnectTask?.cancel()
        let attempt = autoReconnectAttempt
        autoReconnectAttempt += 1
        let delaySeconds = min(30.0, 1.5 * pow(2.0, Double(min(attempt, 4))))
        autoReconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delaySeconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard let self, self.hasStoredPairing else { return }
                if case .error = self.phase { self.reconnectTrusted() }
            }
        }
    }

    private func cancelAutoReconnect(resetAttempts: Bool) {
        autoReconnectTask?.cancel()
        autoReconnectTask = nil
        if resetAttempts { autoReconnectAttempt = 0 }
    }

    private func cancelSocketHealthCheck() {
        socketHealthTask?.cancel()
        socketHealthTask = nil
    }

    private func preferRemoteRelayFirst() -> Bool {
        guard let path = pathMonitor?.currentPath, path.status == .satisfied else { return false }
        if path.usesInterfaceType(.cellular) { return true }
        return path.isExpensive && !path.usesInterfaceType(.wifi)
            && !path.usesInterfaceType(.wiredEthernet)
    }

    /// Re-attempt the identity load (e.g. after the user unlocked the
    /// device / freed storage). Clears the error screen on success.
    public func retryIdentityLoad() {
        do {
            identitySeed = try identityStore.loadOrCreateSeed()
            identityError = nil
        } catch {
            identityError = Self.identityErrorMessage(error)
        }
    }

    private static func identityErrorMessage(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? String(describing: error)
    }

    /// Both connect paths refuse while the identity is unavailable — a
    /// 0-byte seed would just fail deeper with an opaque CryptoKit error.
    private func identityReady() -> Bool {
        if let identityError {
            phase = .error(identityError)
            return false
        }
        return identitySeed.count == 32
    }

    /// This phone's identity public key (base64 raw 32B) — shown in pairing UI
    /// so the user can confirm it matches what the Mac pinned.
    public var identityPublicKeyBase64: String {
        (try? Curve25519.Signing.PrivateKey(rawRepresentation: identitySeed))
            .map { Base64.encode($0.publicKey.rawRepresentation) } ?? ""
    }

    public struct FileModeRequest: Identifiable, Sendable {
        public let id = UUID()
        public let workspaceId: String?
    }

    public struct DiffModeRequest: Identifiable, Sendable {
        public let id = UUID()
        public let workspaceId: String?
    }

    // ── Pairing ────────────────────────────────────────────────────────────────

    /// Pair from a scanned/pasted bootstrap JSON string.
    public func pair(fromBootstrapJSON json: String) {
        let sanitized = Self.sanitizeBootstrapJSON(json)
        guard let data = sanitized.data(using: .utf8),
            let bootstrap = try? JSONDecoder().decode(PairingBootstrapPayload.self, from: data)
        else {
            phase = .error(
                "That doesn't look like a valid pairing code. Use the Copy setup payload "
                    + "button on your Mac (don't retype it), then paste the whole thing here."
            )
            return
        }
        connect(bootstrap: bootstrap)
    }

    // ── QR-optional discovery (multi-host) ───────────────────────────────────

    /// Ask the connected host (the "oracle") to enumerate the tailnet and
    /// surface its OTHER TaskWraith machines. The host alone holds the Tailscale
    /// OAuth credential — it never reaches this phone. Results are deduped
    /// against the hosts we've already paired with (the oracle can't see those
    /// pairings) and published to `discoveredHosts`. Read-only and idempotent.
    public func discoverHosts() async {
        guard !isDiscoveringHosts else { return }
        isDiscoveringHosts = true
        discoveryError = nil
        defer { isDiscoveringHosts = false }
        // The enumeration runs on the CURRENT oracle. If the user switches hosts
        // during the await, discard the late result so the old oracle's hosts
        // can't land under the new host (clearCachedProjectionState already reset
        // the list on the switch).
        let oracle = selectedHostId
        do {
            // Enumerate + probe the whole tailnet host-side — give it room.
            let ack = try await requestFileAction(
                BridgeAction.discoverTailnetHosts(), timeoutMs: 20_000)
            guard selectedHostId == oracle else { return }
            let found = ack.data?.hosts ?? []
            let pairedKeys = Set(pairedHosts.map { $0.macIdentityPubKey })
            discoveredHosts = found.filter { !pairedKeys.contains($0.macIdentityPubKey) }
        } catch {
            guard selectedHostId == oracle else { return }
            discoveryError =
                (error as? LocalizedError)?.errorDescription ?? "Couldn't search your tailnet."
            discoveredHosts = []
        }
    }

    /// Pair with a discovered host WITHOUT scanning a QR: POST /v1/beginpair to
    /// its front door, which mints a fresh pairing session and returns the full
    /// bootstrap — then connect with it exactly as if we'd scanned its QR. The
    /// 6-digit SAS confirm still happens on the TARGET host, so an
    /// unauthenticated tailnet POST only opens a window the user must approve;
    /// it can't pair on its own.
    /// Returns true once a pairing connect was kicked off (the SAS flow takes
    /// over); false if every candidate door failed — in which case the live
    /// oracle connection is left untouched and the reason surfaces via
    /// `discoveryError` (shown in the discovery sheet), NOT `phase`.
    @discardableResult
    public func pairDiscoveredHost(_ host: DiscoveredHostInfo) async -> Bool {
        let candidates = RelayCandidates.ordered(
            from: host.relayUrls, fallback: host.relayUrls.first ?? "",
            preferRemoteFirst: preferRemoteRelayFirst())
        let label = host.macDisplayName ?? "that host"
        var lastError = "Couldn't reach \(label) to start pairing."
        for relay in candidates {
            // ATS blocks cleartext to non-local hosts (ws→http alike); skip
            // a LAN-only door when we're off that network, try the next.
            if let problem = Self.cleartextRelayProblem(relay) {
                lastError = problem
                continue
            }
            guard let url = RelayCandidates.beginPairURL(fromRelay: relay) else { continue }
            do {
                var req = URLRequest(url: url)
                req.httpMethod = "POST"
                // Per-candidate budget: LAN doors fail fast, remote doors get
                // room — a dead LAN door can't hang the whole flow.
                req.timeoutInterval = Double(RelayCandidates.dialTimeoutMs(for: relay)) / 1000.0
                let (data, response) = try await URLSession.shared.data(for: req)
                guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                    lastError = "\(label) declined to open a pairing window — try again."
                    continue
                }
                guard
                    let bootstrap = try? JSONDecoder().decode(
                        PairingBootstrapPayload.self, from: data)
                else {
                    lastError = "\(label) returned an unreadable pairing response."
                    continue
                }
                // Defense in depth: the door we reached must be the host the user
                // picked. The SAS still gates pairing, but refuse a silently
                // different identity rather than prompting for an unexpected host.
                guard bootstrap.macIdentityPubKey == host.macIdentityPubKey else {
                    lastError = "\(label) returned a different identity than expected."
                    continue
                }
                connect(bootstrap: bootstrap)
                return true
            } catch {
                lastError =
                    (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                continue
            }
        }
        // Don't clobber `phase` — the oracle connection is still live.
        discoveryError = lastError
        return false
    }

    /// iOS text fields apply smart punctuation: touching the paste field
    /// curls straight quotes (" → “”) and corrupts the JSON — the #1 cause
    /// of "invalid pairing code". Undo that, plus the usual paste debris
    /// (zero-width chars, BOM, surrounding whitespace).
    static func sanitizeBootstrapJSON(_ raw: String) -> String {
        var text = raw
        let replacements: [(String, String)] = [
            ("\u{201C}", "\""), ("\u{201D}", "\""),  // curly double quotes
            ("\u{2018}", "'"), ("\u{2019}", "'"),  // curly single quotes
            ("\u{FEFF}", ""), ("\u{200B}", ""), ("\u{200E}", ""), ("\u{200F}", "")
        ]
        for (from, to) in replacements {
            text = text.replacingOccurrences(of: from, with: to)
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// ATS (NSAllowsLocalNetworking) permits cleartext ws:// only to hosts
    /// on the local network — a remote ws:// relay dies with an opaque ATS
    /// error deep in the socket. Catch it up front with an actionable
    /// message. wss:// is always fine. Conservative: anything we can't
    /// positively identify as local (public DNS names, public IPs, and
    /// Tailscale's 100.64/10 CGNAT range) gets the warning.
    static func cleartextRelayProblem(_ relayUrl: String) -> String? {
        guard let url = URL(string: relayUrl), url.scheme?.lowercased() == "ws" else {
            return nil
        }
        let host = (url.host ?? "").lowercased()
        if isLocalNetworkHost(host) { return nil }
        return "“\(host)” is a cleartext ws:// relay outside your local network — iOS blocks "
            + "that. Use a wss:// relay for remote access (e.g. a Tailscale cert), or connect "
            + "from the Mac's own network. If this address IS local, use its LAN IP instead."
    }

    static func isLocalNetworkHost(_ host: String) -> Bool {
        // Single-sourced in TaskWraithKit so the candidate-ordering logic
        // and the ATS preflight can never disagree about what "local" means.
        RelayCandidates.isLocalNetworkHost(host)
    }

    /// Monotonic stamp for connect attempts so the dial watchdog only fires
    /// against ITS OWN attempt (a newer scan/reconnect invalidates it).
    private var connectAttempt = 0
    /// The bootstrap's full candidate set, persisted into the pairing
    /// record on establish (T70 multi-door reconnects).
    private var lastRelayUrls: [String]?
    /// The active host's OS ("mac"/"windows"/"linux"), captured from the
    /// bootstrap (fresh pair) or the record (reconnect), persisted for the glyph.
    private var lastHostPlatform: String?

    private func connect(bootstrap: PairingBootstrapPayload) {
        guard identityReady() else { return }
        // T70 — walk the bootstrap's candidate doors in order (LAN first:
        // instant at home, a cheap 5s timeout away from it; then the wss
        // front door). Candidates the ATS preflight rejects are skipped,
        // not fatal — a ws:// LAN door is invalid from cellular while the
        // wss door right after it works fine.
        let candidates = RelayCandidates.ordered(
            from: bootstrap.relayUrls, fallback: bootstrap.relayUrl,
            preferRemoteFirst: preferRemoteRelayFirst())
        cancelSocketHealthCheck()
        teardown()
        trustedReconnectAttempt = nil
        // Connecting to a DIFFERENT host than the active one (e.g. adding a
        // second host from the pairing screen): wipe the outgoing host's cached
        // projection so its transcripts/usage/diffs never bleed into the new
        // host's view. Caches are flat today, so clearing on host change is what
        // keeps them effectively per-host. Re-pairing the SAME host keeps them.
        if let current = pinnedMacIdentityB64, current != bootstrap.macIdentityPubKey {
            wipeProjectionCaches()
        }
        macDisplayName = bootstrap.macDisplayName
        pinnedMacIdentityB64 = bootstrap.macIdentityPubKey
        lastRelayUrls = bootstrap.relayUrls
        lastHostPlatform = bootstrap.hostPlatform
        phase = .connecting
        connectAttempt += 1
        let attempt = connectAttempt
        Task {
            var lastFailure: String? = nil
            walk: for candidate in candidates {
                guard self.connectAttempt == attempt else { return }
                if let problem = Self.cleartextRelayProblem(candidate) {
                    lastFailure = problem
                    continue
                }
                // FRESH client per candidate (field bug: a shared client let
                // the abandoned LAN dial's cancellation event — NSURLError
                // -999 — land in the live wss candidate's event stream and
                // stomp its phase mid-handshake). teardown() cancels the
                // previous event consumer before the next client attaches,
                // so a dying door can't touch the live one.
                self.teardown()
                self.phase = .connecting
                self.relayUrl = candidate
                let client: RelayTransportClient
                do {
                    client = try RelayTransportClient(identitySeed: self.identitySeed)
                } catch {
                    lastFailure = TransportErrorCopy.friendlyMessage(
                        for: error, relayUrl: candidate)
                    continue
                }
                self.client = client
                self.consumeEvents(of: client)
                var scoped = bootstrap
                scoped.relayUrl = candidate
                do {
                    try await client.scan(scoped)
                    try await client.connect()
                } catch {
                    lastFailure = TransportErrorCopy.friendlyMessage(
                        for: error, relayUrl: candidate)
                    continue
                }
                // Dial watchdog per candidate — `connect()` is fire-and-
                // forget and an unroutable dial BLACKHOLES instead of
                // erroring. Everything up to the 6-digit confirm code is
                // machine-speed, so still being in .connecting after the
                // candidate's budget means THIS door is dead → try the
                // next. A visible .error from THIS candidate's own events
                // is equally just this door failing — record it and walk
                // on. Only .awaitingMacConfirm/.connected end the walk.
                let budgetMs = RelayCandidates.dialTimeoutMs(for: candidate)
                var waitedMs = 0
                poll: while waitedMs < budgetMs {
                    try? await Task.sleep(nanoseconds: 250_000_000)
                    waitedMs += 250
                    guard self.connectAttempt == attempt else { return }
                    switch self.phase {
                    case .connecting:
                        continue poll
                    case .error(let message):
                        lastFailure = message
                        continue walk
                    default:
                        return  // .awaitingMacConfirm / .connected — done
                    }
                }
                lastFailure = TransportErrorCopy.friendlyMessage(
                    for: NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut),
                    relayUrl: candidate)
            }
            guard self.connectAttempt == attempt else { return }
            self.teardown()
            self.phase = .error(
                lastFailure
                    ?? "Couldn't reach the Mac on any advertised address — refresh the QR and try again."
            )
        }
    }

    /// Trusted reconnect to the persisted Mac — resolves the live session id
    /// from the relay directory, no QR. The Mac pinned this phone's identity
    /// at first pairing, so it accepts silently (and denies anyone else).
    public func reconnectTrusted() {
        guard !isDemo else { return }  // demo is standalone — never auto-redial
        guard let record = pairingStore.load().selectedHost else { return }
        guard identityReady() else { return }
        // A fresh walk supersedes any queued auto-retry (attempt count keeps
        // growing so the backoff curve survives across walks).
        cancelAutoReconnect(resetAttempts: false)
        // T70 — walk every door the pairing record knows. Wi-Fi stays LAN
        // first; cellular/expensive paths try the WSS front door first.
        let candidates = RelayCandidates.ordered(
            from: record.relayUrls, fallback: record.relayUrl,
            preferRemoteFirst: preferRemoteRelayFirst())
        cancelSocketHealthCheck()
        teardown()
        macDisplayName = Self.sanitizedMacName(record.macDisplayName)
        pinnedMacIdentityB64 = record.macIdentityPubKey
        lastRelayUrls = record.relayUrls
        lastHostPlatform = record.hostPlatform
        relayUrl = record.relayUrl
        phase = .connecting
        connectAttempt += 1
        let attempt = connectAttempt
        trustedReconnectAttempt = attempt
        Task {
            var lastFailure: String? = nil
            var sawAtsSkip = false
            for candidate in candidates {
                guard self.connectAttempt == attempt else { return }
                if let problem = Self.cleartextRelayProblem(candidate) {
                    // A LAN ws:// door is simply invalid off-network —
                    // skip it and let the wss door take the dial.
                    sawAtsSkip = true
                    if lastFailure == nil { lastFailure = problem }
                    continue
                }
                // Fresh client per attempt — same cross-talk isolation
                // as the pairing walk (a dead door's late events and
                // stale established-timeout waiters must never touch
                // the live attempt).
                self.teardown()
                self.phase = .connecting
                let client: RelayTransportClient
                do {
                    client = try RelayTransportClient(identitySeed: self.identitySeed)
                } catch {
                    lastFailure = TransportErrorCopy.friendlyMessage(
                        for: error, relayUrl: candidate)
                    continue
                }
                self.client = client
                self.consumeEvents(of: client)
                do {
                    let budgetMs = RelayCandidates.dialTimeoutMs(for: candidate)
                    try await client.resolveAndScan(
                        relayUrl: candidate,
                        macIdentityPubKey: record.macIdentityPubKey,
                        timeoutMs: budgetMs)
                    try await client.connectAndWaitEstablished(timeoutMs: budgetMs)
                    // A newer attempt (e.g. switchHost(to: another host) or a
                    // fresh pairing) superseded us while we awaited establish —
                    // do NOT persist this host's door / clear the self-heal
                    // stamp under the new host's identity. Matches the guard the
                    // rest of the walk already enforces per candidate.
                    guard self.connectAttempt == attempt else { return }
                    self.relayUrl = candidate
                    self.trustedReconnectAttempt = nil
                    // Refresh the record so the v1 field tracks the
                    // door that actually works from here.
                    self.persistCurrentPairing()
                    return
                } catch {
                    lastFailure = TransportErrorCopy.friendlyMessage(
                        for: error, relayUrl: candidate)
                }
            }
            guard self.connectAttempt == attempt else { return }
            self.teardown()
            self.trustedReconnectAttempt = nil
            var detail =
                lastFailure
                ?? "Couldn't reach \(record.macDisplayName) — is TaskWraith running on your Mac?"
            // Old single-door record pinned to a home-network address
            // and we're not on it: re-pairing picks up the multi-door
            // bootstrap (new pairings carry both doors and never hit
            // this).
            if record.relayUrls?.isEmpty != false, sawAtsSkip || candidates.count == 1,
                let host = URL(string: record.relayUrl)?.host,
                Self.isLocalNetworkHost(host)
            {
                detail +=
                    " This pairing only knows a home-network address (\(host)); re-pair "
                    + "once with the Mac's current QR to add its Tailscale door."
            }
            self.phase = .error(detail)
            // Self-heal: cold cellular launches race the VPN tunnel — keep
            // re-walking on a backoff (the path monitor also fires the
            // moment a new route appears, whichever comes first).
            self.scheduleAutoReconnect()
        }
    }

    /// Launch-time resume: silently try the stored pairing once.
    public func resumeIfIdle() {
        guard case .idle = phase, hasStoredPairing else { return }
        autoReconnectAttempt = 0
        reconnectTrusted()
    }

    /// Foreground resume: iOS can leave a killed background socket looking
    /// connected until URLSession times out, so prove connected sockets with
    /// a short WebSocket ping and reconnect quickly on failure.
    public func reconnectIfStale() {
        guard hasStoredPairing else { return }
        switch phase {
        case .connected:
            verifyConnectedSocket()
        case .connecting, .awaitingMacConfirm:
            return
        case .idle, .error:
            autoReconnectAttempt = 0
            reconnectTrusted()
        }
    }

    private func verifyConnectedSocket() {
        guard socketHealthTask == nil else { return }
        guard let client else {
            autoReconnectAttempt = 0
            reconnectTrusted()
            return
        }
        let attempt = connectAttempt
        socketHealthTask = Task { [weak self] in
            let alive = await client.checkSocketAlive()
            await MainActor.run {
                guard let self else { return }
                self.socketHealthTask = nil
                guard self.connectAttempt == attempt else { return }
                guard case .connected = self.phase else { return }
                guard !alive else { return }
                self.autoReconnectAttempt = 0
                self.reconnectTrusted()
            }
        }
    }

    public func disconnect() {
        cancelAutoReconnect(resetAttempts: true)
        cancelSocketHealthCheck()
        trustedReconnectAttempt = nil
        teardown()
        phase = .idle
        taskCards = []
        approvals = []
        questions = []
        repliedApprovalToolCallIds = []
        repliedQuestionIds = []
    }

    /// Drop the stored pairing entirely (the Mac keeps its pin until the user
    /// revokes it there; re-pairing with the same identity reuses it).
    // ── Demo mode (App Review / first-look) ───────────────────────────────────
    /// Enter an OFFLINE demo session populated with canned data so the app can be
    /// explored — and App Review can exercise it — WITHOUT pairing to a Mac. No
    /// network client is connected (so `send(_:)` is inert) and `isDemo` drives a
    /// banner. `exitDemoMode()` restores the pairing screen.
    public func enterDemoMode() {
        // Sever any live session FIRST so the demo is truly standalone — no real
        // projection can bleed in, and the auto-reconnect lifecycle can't redial
        // the Mac under the demo banner (reconnectTrusted + persistCurrentPairing
        // are also guarded on !isDemo).
        disconnect()
        clearCachedProjectionState()
        let workspacesJSON = """
        [{"workspaceId":"demo-ws","displayName":"Demo Project","path":"~/Developer/taskwraith-demo","chatCount":3,"capabilities":{"diffReview":true,"fileBrowse":true,"fileRead":true,"fileWrite":true}}]
        """
        let cardsJSON = """
        [
          {"id":"demo-1","title":"Refactor the auth module","provider":"claude","workspaceId":"demo-ws","threadId":"demo-1","status":"idle","chatKind":"single","updatedAt":"2026-06-19T10:42:00Z","pendingApprovalCount":1},
          {"id":"demo-2","title":"Plan the v2 public API","provider":"claude","workspaceId":"demo-ws","threadId":"demo-2","status":"idle","chatKind":"ensemble","updatedAt":"2026-06-19T09:30:00Z"},
          {"id":"demo-3","title":"Fix the flaky upload test","provider":"codex","workspaceId":"demo-ws","threadId":"demo-3","status":"idle","chatKind":"single","updatedAt":"2026-06-18T17:05:00Z"},
          {"id":"demo-1-sub1","title":"Map the auth call sites","provider":"claude","workspaceId":"demo-ws","threadId":"demo-1-sub1","parentChatId":"demo-1","parentChatRelation":"subThread","agentName":"Dexterman","agentSlug":"dexterman","agentAccent":"#C8DD2C","status":"done","chatKind":"single","updatedAt":"2026-06-19T10:38:00Z"},
          {"id":"demo-1-sub2","title":"Write refresh + expiry tests","provider":"codex","workspaceId":"demo-ws","threadId":"demo-1-sub2","parentChatId":"demo-1","parentChatRelation":"subThread","agentName":"Roboteknik","agentSlug":"roboteknik","agentAccent":"#2C9CDD","status":"done","chatKind":"single","updatedAt":"2026-06-19T10:41:00Z"},
          {"id":"demo-2-sub1","title":"Survey REST pagination patterns","provider":"claude","workspaceId":"demo-ws","threadId":"demo-2-sub1","parentChatId":"demo-2","parentChatRelation":"subThread","agentName":"Imhotep","agentSlug":"imhotep","agentAccent":"#2C5EDD","status":"done","chatKind":"single","updatedAt":"2026-06-19T09:24:00Z"},
          {"id":"demo-3-sub1","title":"Bisect the flaky run","provider":"codex","workspaceId":"demo-ws","threadId":"demo-3-sub1","parentChatId":"demo-3","parentChatRelation":"subThread","agentName":"Jim The Mage","agentSlug":"jim-the-mage","agentAccent":"#2C8DDD","status":"done","chatKind":"single","updatedAt":"2026-06-18T16:58:00Z"},
          {"id":"demo-1-sc1","title":"jose vs jsonwebtoken?","provider":"codex","workspaceId":"demo-ws","threadId":"demo-1-sc1","parentChatId":"demo-1","parentChatRelation":"sideChat","status":"idle","chatKind":"single","updatedAt":"2026-06-19T10:39:00Z"},
          {"id":"demo-2-sc1","title":"Cursor vs offset pagination?","provider":"claude","workspaceId":"demo-ws","threadId":"demo-2-sc1","parentChatId":"demo-2","parentChatRelation":"sideChat","status":"idle","chatKind":"single","updatedAt":"2026-06-19T09:26:00Z"},
          {"id":"demo-3-sc1","title":"Is the flush race in the S3 client?","provider":"claude","workspaceId":"demo-ws","threadId":"demo-3-sc1","parentChatId":"demo-3","parentChatRelation":"sideChat","status":"idle","chatKind":"single","updatedAt":"2026-06-18T17:02:00Z"}
        ]
        """
        let snap1JSON = """
        {"threadId":"demo-1","workspaceId":"demo-ws","provider":"claude","totalRows":4,
         "notes":"## Auth refactor\\n- Migrate call sites to `TokenService`\\n- Cover refresh + expiry with unit tests\\n- Keep the public `login()` signature stable",
         "runSummary":{"runId":"demo-run-1","provider":"claude","model":"cli-default","status":"done","durationMs":84000,"totalTokens":18420,"tokensIn":12010,"tokensOut":6410,"costText":"$0.21","fileChanges":{"filesChanged":3,"additions":178,"deletions":42,"createdFiles":1,"modifiedFiles":2,"deletedFiles":0,"files":[{"path":"auth/TokenService.ts","status":"modified","additions":96,"deletions":12},{"path":"auth/index.ts","status":"modified","additions":18,"deletions":30},{"path":"auth/TokenService.test.ts","status":"added","additions":64,"deletions":0}]}},
         "blackboardEntries":[
           {"id":"bb-1-1","key":"Token strategy","value":"Use the new TokenService for all auth refresh paths.","category":"decision","scope":"thread","createdAt":"2026-06-19T10:41:30Z"},
           {"id":"bb-1-2","key":"Refresh window","value":"Access tokens expire in 15m; refresh tokens in 30d.","category":"fact","scope":"thread","createdAt":"2026-06-19T10:41:40Z"},
           {"id":"bb-1-3","key":"Clock skew","value":"Allow 60s skew when validating exp to avoid false expiries.","category":"risk","scope":"thread","createdAt":"2026-06-19T10:41:50Z"}
         ],
         "pinnedRows":[
           {"id":"r2","role":"assistant","kind":"message","speaker":"Claude","preview":"I'll split auth into a TokenService, migrate the call sites, and add unit tests for refresh + expiry. Starting with the service.","timestamp":"2026-06-19T10:41:00Z"}
         ],
         "rows":[
          {"id":"r1","role":"user","kind":"message","preview":"Refactor the auth module to use the new TokenService and add tests.","timestamp":"2026-06-19T10:40:00Z"},
          {"id":"r2","role":"assistant","kind":"message","speaker":"Claude","preview":"I'll split auth into a TokenService, migrate the call sites, and add unit tests for refresh + expiry. Starting with the service.","timestamp":"2026-06-19T10:41:00Z"},
          {"id":"r2b","role":"assistant","kind":"message","speaker":"Claude","preview":"Added to blackboard — Decision: Use the new TokenService for all auth refresh paths.","timestamp":"2026-06-19T10:41:35Z"},
          {"id":"r3","role":"assistant","kind":"tool","preview":"Edited 2 files (+114 −42)","timestamp":"2026-06-19T10:42:00Z","toolSummary":{"activityCount":2,"status":"done","tools":[{"name":"Edit auth/TokenService.ts","category":"file","status":"done","file":"auth/TokenService.ts","additions":96,"deletions":12},{"name":"Edit auth/index.ts","category":"file","status":"done","file":"auth/index.ts","additions":18,"deletions":30}]}}
        ]}
        """
        let snap2JSON = """
        {"threadId":"demo-2","workspaceId":"demo-ws","provider":"claude","totalRows":4,
         "notes":"## v2 API plan\\n- Resource-oriented endpoints\\n- Cursor pagination across list endpoints\\n- Typed error envelope\\n- Idempotency keys on POST",
         "runSummary":{"runId":"demo-run-2","provider":"claude","model":"cli-default","status":"done","durationMs":146000,"totalTokens":31200,"tokensIn":19800,"tokensOut":11400,"costText":"$0.38","fileChanges":{"filesChanged":2,"additions":286,"deletions":4,"createdFiles":2,"modifiedFiles":0,"deletedFiles":0,"files":[{"path":"docs/api-v2.md","status":"added","additions":132,"deletions":0},{"path":"openapi/v2.yaml","status":"added","additions":154,"deletions":4}]}},
         "blackboardEntries":[
           {"id":"bb-2-1","key":"Versioning","value":"Version in the path: /v2/…","category":"decision","scope":"ensemble","createdAt":"2026-06-19T09:27:10Z"},
           {"id":"bb-2-2","key":"Pagination","value":"Cursor-based pagination across all list endpoints.","category":"decision","scope":"ensemble","createdAt":"2026-06-19T09:27:20Z"},
           {"id":"bb-2-3","key":"Idempotency","value":"Require an Idempotency-Key header on every POST.","category":"decision","scope":"ensemble","participantId":"p-codex","createdAt":"2026-06-19T09:29:10Z"},
           {"id":"bb-2-4","key":"v1 envelope","value":"v1 error shape differs — do not reuse the v1 envelope in v2.","category":"do-not-repeat","scope":"ensemble","createdAt":"2026-06-19T09:29:20Z"}
         ],
         "pinnedRows":[
           {"id":"e2","role":"assistant","kind":"message","speaker":"Claude / Architect","preview":"Resource-oriented endpoints, cursor pagination, and explicit versioning in the path.","timestamp":"2026-06-19T09:27:00Z"}
         ],
         "rows":[
          {"id":"e1","role":"user","kind":"message","preview":"Draft the v2 public API surface — two perspectives, please.","timestamp":"2026-06-19T09:25:00Z"},
          {"id":"e2","role":"assistant","kind":"message","speaker":"Claude / Architect","preview":"Resource-oriented endpoints, cursor pagination, and explicit versioning in the path.","timestamp":"2026-06-19T09:27:00Z"},
          {"id":"e3","role":"assistant","kind":"message","speaker":"Codex / Implementer","preview":"Agreed — add idempotency keys on POST and a typed error envelope so clients can branch safely.","timestamp":"2026-06-19T09:29:00Z"},
          {"id":"e3b","role":"assistant","kind":"message","speaker":"Codex / Implementer","preview":"Added to blackboard — Decision: Require an Idempotency-Key header on every POST.","timestamp":"2026-06-19T09:29:30Z"}
        ]}
        """
        let snap3JSON = """
        {"threadId":"demo-3","workspaceId":"demo-ws","provider":"codex","totalRows":3,
         "notes":"## Flaky upload test\\n- Race between assert and buffer flush\\n- Fix: await flush + deterministic clock\\n- Verified green across 200 runs",
         "runSummary":{"runId":"demo-run-3","provider":"codex","model":"cli-default","status":"done","durationMs":52000,"totalTokens":9600,"tokensIn":6400,"tokensOut":3200,"costText":"$0.09","fileChanges":{"filesChanged":2,"additions":40,"deletions":10,"createdFiles":0,"modifiedFiles":2,"deletedFiles":0,"files":[{"path":"src/upload/uploader.ts","status":"modified","additions":12,"deletions":4},{"path":"test/upload.test.ts","status":"modified","additions":28,"deletions":6}]}},
         "blackboardEntries":[
           {"id":"bb-3-1","key":"Root cause","value":"Test asserted before the upload buffer drained.","category":"fact","scope":"thread","createdAt":"2026-06-18T17:04:30Z"},
           {"id":"bb-3-2","key":"Fix","value":"Await the flush promise; inject a deterministic clock.","category":"decision","scope":"thread","createdAt":"2026-06-18T17:04:40Z"},
           {"id":"bb-3-3","key":"Flake guard","value":"Never assert on wall-clock timing in CI.","category":"do-not-repeat","scope":"thread","createdAt":"2026-06-18T17:04:50Z"}
         ],
         "pinnedRows":[
           {"id":"s2","role":"assistant","kind":"message","speaker":"Codex","preview":"The test asserted before the buffer drained. I awaited the flush promise and used a deterministic clock — green across 200 runs.","timestamp":"2026-06-18T17:05:00Z"}
         ],
         "rows":[
          {"id":"s1","role":"user","kind":"message","preview":"The upload test fails intermittently in CI. Find and fix the race.","timestamp":"2026-06-18T17:00:00Z"},
          {"id":"s2","role":"assistant","kind":"message","speaker":"Codex","preview":"The test asserted before the buffer drained. I awaited the flush promise and used a deterministic clock — green across 200 runs.","timestamp":"2026-06-18T17:05:00Z"},
          {"id":"s2b","role":"assistant","kind":"message","speaker":"Codex","preview":"Added to blackboard — Fact: Test asserted before the upload buffer drained.","timestamp":"2026-06-18T17:05:10Z"}
        ]}
        """
        let providerModelsJSON = """
        {"claude":[{"id":"cli-default","label":"Default"}],"codex":[{"id":"cli-default","label":"Default"}]}
        """
        let workflowsJSON = """
        [
          {"id":"demo-wf-1","name":"Nightly test sweep","workspaceId":"demo-ws","threadId":"demo-3","provider":"codex","enabled":true,"schedule":"Daily 02:00","status":"completed","nextRunAt":"2026-06-20T02:00:00Z","lastRunAt":"2026-06-19T02:00:00Z"},
          {"id":"demo-wf-2","name":"Auth audit on demand","workspaceId":"demo-ws","threadId":"demo-1","provider":"claude","enabled":false,"schedule":"Manual","status":"idle"}
        ]
        """
        if let ws = Self.decodeDemo([WorkspaceSummary].self, workspacesJSON) { workspaces = ws }
        if let cards = Self.decodeDemo([RemoteTaskCard].self, cardsJSON) { taskCards = cards }
        if let wf = Self.decodeDemo([RemoteWorkflow].self, workflowsJSON) { workflows = wf }
        if let s1 = Self.decodeDemo(RemoteThreadSnapshot.self, snap1JSON) { threadSnapshots["demo-1"] = s1 }
        if let s2 = Self.decodeDemo(RemoteThreadSnapshot.self, snap2JSON) { threadSnapshots["demo-2"] = s2 }
        if let s3 = Self.decodeDemo(RemoteThreadSnapshot.self, snap3JSON) { threadSnapshots["demo-3"] = s3 }
        if let pm = Self.decodeDemo([String: [ModelOption]].self, providerModelsJSON) { providerModels = pm }
        let approvalsJSON = """
        [{"toolCallId":"demo-appr-1","title":"Run the auth test suite","body":"npm test -- auth/TokenService","provider":"claude","actions":["accept","decline"],"workspaceId":"demo-ws","threadId":"demo-1","runId":"demo-run-1","requestedAt":"2026-06-19T10:43:00Z"}]
        """
        let ensembleJSON = """
        {"threadId":"demo-2","status":"idle","activeParticipantId":"p-claude","participants":[{"participantId":"p-claude","provider":"claude","role":"Architect","order":1,"status":"done"},{"participantId":"p-codex","provider":"codex","role":"Implementer","order":2,"status":"done"},{"participantId":"p-kimi","provider":"kimi","role":"Reviewer","order":3,"status":"idle"}],"roster":[{"id":"p-claude","provider":"claude","role":"Architect","enabled":true,"order":1,"model":"cli-default"},{"id":"p-codex","provider":"codex","role":"Implementer","enabled":true,"order":2,"model":"cli-default"},{"id":"p-kimi","provider":"kimi","role":"Reviewer","enabled":true,"order":3,"model":"cli-default"}]}
        """
        if let appr = Self.decodeDemo([MobileApprovalCard].self, approvalsJSON) { approvals = appr }
        if let ens = Self.decodeDemo(RemoteEnsembleState.self, ensembleJSON) { ensembleStates["demo-2"] = ens }

        // — Inspector · Changes tab — per-thread diff summaries —
        let diffsJSON = """
        {
         "demo-1":{"threadId":"demo-1","runId":"demo-run-1","filesChanged":3,"additions":178,"deletions":42,"createdFiles":1,"modifiedFiles":2,"deletedFiles":0,"files":[{"path":"auth/TokenService.ts","status":"modified","additions":96,"deletions":12},{"path":"auth/index.ts","status":"modified","additions":18,"deletions":30},{"path":"auth/TokenService.test.ts","status":"added","additions":64,"deletions":0}]},
         "demo-2":{"threadId":"demo-2","runId":"demo-run-2","filesChanged":2,"additions":286,"deletions":4,"createdFiles":2,"modifiedFiles":0,"deletedFiles":0,"files":[{"path":"docs/api-v2.md","status":"added","additions":132,"deletions":0},{"path":"openapi/v2.yaml","status":"added","additions":154,"deletions":4}]},
         "demo-3":{"threadId":"demo-3","runId":"demo-run-3","filesChanged":2,"additions":40,"deletions":10,"createdFiles":0,"modifiedFiles":2,"deletedFiles":0,"files":[{"path":"src/upload/uploader.ts","status":"modified","additions":12,"deletions":4},{"path":"test/upload.test.ts","status":"modified","additions":28,"deletions":6}]}
        }
        """
        if let diffs = Self.decodeDemo([String: MobileDiffSummary].self, diffsJSON) { diffSummaries = diffs }

        // — Inspector · Agents + Side-chats — child thread snapshots so any
        //   sub-agent / side chat opens inline with real content. —
        let childSnapsJSON: [String: String] = [
          "demo-1-sub1": #"{"threadId":"demo-1-sub1","workspaceId":"demo-ws","provider":"claude","totalRows":2,"rows":[{"id":"a11","role":"user","kind":"message","preview":"Map every call site that builds or verifies a JWT."},{"id":"a12","role":"assistant","kind":"message","speaker":"Dexterman","preview":"Found 7 call sites across auth/, api/middleware/ and jobs/ — each listed with a line reference."}]}"#,
          "demo-1-sub2": #"{"threadId":"demo-1-sub2","workspaceId":"demo-ws","provider":"codex","totalRows":2,"rows":[{"id":"a21","role":"user","kind":"message","preview":"Write unit tests for token refresh and expiry."},{"id":"a22","role":"assistant","kind":"message","speaker":"Roboteknik","preview":"Added 9 tests covering refresh rotation, expiry and 60s clock skew. All green locally."}]}"#,
          "demo-2-sub1": #"{"threadId":"demo-2-sub1","workspaceId":"demo-ws","provider":"claude","totalRows":2,"rows":[{"id":"a31","role":"user","kind":"message","preview":"Survey how Stripe, GitHub and Linear paginate their list APIs."},{"id":"a32","role":"assistant","kind":"message","speaker":"Imhotep","preview":"All three use cursor pagination with opaque tokens; GitHub also exposes RFC-5988 Link headers."}]}"#,
          "demo-3-sub1": #"{"threadId":"demo-3-sub1","workspaceId":"demo-ws","provider":"codex","totalRows":2,"rows":[{"id":"a41","role":"user","kind":"message","preview":"Bisect to the commit that introduced the flake."},{"id":"a42","role":"assistant","kind":"message","speaker":"Jim The Mage","preview":"First flaky at a3f9c1 — the change that moved the assert ahead of the awaited flush."}]}"#,
          "demo-1-sc1": #"{"threadId":"demo-1-sc1","workspaceId":"demo-ws","provider":"codex","totalRows":2,"rows":[{"id":"c11","role":"user","kind":"message","preview":"jose vs jsonwebtoken for ES256 — which should we standardize on?"},{"id":"c12","role":"assistant","kind":"message","speaker":"Codex","preview":"Prefer jose: native ES256, actively maintained and tree-shakeable. jsonwebtoken needs extra deps for ECDSA."}]}"#,
          "demo-2-sc1": #"{"threadId":"demo-2-sc1","workspaceId":"demo-ws","provider":"claude","totalRows":2,"rows":[{"id":"c21","role":"user","kind":"message","preview":"Cursor vs offset pagination for the list endpoints?"},{"id":"c22","role":"assistant","kind":"message","speaker":"Claude","preview":"Cursor pagination — stable under inserts and cheap at depth. Encode the cursor as an opaque base64 token."}]}"#,
          "demo-3-sc1": #"{"threadId":"demo-3-sc1","workspaceId":"demo-ws","provider":"claude","totalRows":2,"rows":[{"id":"c31","role":"user","kind":"message","preview":"Could the flush race actually be inside the S3 client, not our code?"},{"id":"c32","role":"assistant","kind":"message","speaker":"Claude","preview":"Unlikely — the SDK resolves upload() only after the body stream ends. The race is the test asserting before awaiting it."}]}"#,
        ]
        for (key, json) in childSnapsJSON {
            if let snap = Self.decodeDemo(RemoteThreadSnapshot.self, json) { threadSnapshots[key] = snap }
        }

        // — Inspector · Usage tab — per-provider quota windows (no gemini) —
        let modelUsageJSON = """
        {"generatedAt":"2026-06-19T10:45:00Z","providers":[
          {"provider":"claude","windows":[
            {"id":"claude-5h","label":"Current session (5h)","usedPercent":42,"limitLabel":"resets 1 PM","resetAt":"2026-06-19T13:00:00Z"},
            {"id":"claude-week","label":"Weekly quota","usedPercent":61,"limitLabel":"of weekly limit","resetAt":"2026-06-23T00:00:00Z"}]},
          {"provider":"codex","windows":[
            {"id":"codex-5h","label":"Current session (5h)","usedPercent":28,"limitLabel":"resets 2 PM","resetAt":"2026-06-19T14:00:00Z"},
            {"id":"codex-week","label":"Weekly quota","usedPercent":47,"limitLabel":"of weekly limit","resetAt":"2026-06-24T00:00:00Z"}]},
          {"provider":"kimi","windows":[{"id":"kimi-day","label":"Daily quota","usedPercent":12,"limitLabel":"of daily limit","resetAt":"2026-06-20T00:00:00Z"}]},
          {"provider":"grok","windows":[{"id":"grok-day","label":"Daily quota","usedPercent":7,"limitLabel":"of daily limit","resetAt":"2026-06-20T00:00:00Z"}]},
          {"provider":"cursor","windows":[{"id":"cursor-month","label":"Monthly requests","usedPercent":34,"limitLabel":"500 / month","resetAt":"2026-07-01T00:00:00Z"}]}
        ]}
        """
        let rollupJSON = """
        {"providers":[
          {"provider":"claude","h24":182000,"d7":1240000,"d90":9800000},
          {"provider":"codex","h24":96000,"d7":610000,"d90":4100000},
          {"provider":"kimi","h24":14000,"d7":120000,"d90":880000},
          {"provider":"grok","h24":8000,"d7":54000,"d90":420000},
          {"provider":"cursor","h24":4000,"d7":31000,"d90":260000}
        ],"totals":{"h24":304000,"d7":2055000,"d90":15460000}}
        """
        if let usage = Self.decodeDemo(ModelUsageMessage.Usage.self, modelUsageJSON) { modelUsage = usage }
        if let rollup = Self.decodeDemo(UsageRollupMessage.Rollup.self, rollupJSON) { usageRollup = rollup }
        let firstLaunchJSON = """
        {"schemaVersion":1,"generatedAt":"2026-06-19T10:45:00Z",
         "notifications":[{"id":"gemini-retired","kind":"provider-retired","title":"Gemini has been retired.","body":"Google ended Gemini CLI sign-in, so Gemini is no longer available for new runs. Existing chats remain visible.","tone":"danger","dismissible":true}],
         "workspace":{"visibleCount":1,"totalCount":1,"runningCount":0,"hasVisibleWorkspaces":true,"capabilities":{"monitor":true,"approve":true,"answer":true,"startTurn":true,"steer":true,"fileRead":true,"fileWrite":false}},
         "providerCards":[
          {"id":"codex","label":"Codex","optional":false,"statusKind":"ready","statusText":"Ready on Mac","detail":"OpenAI Codex CLI is available for fast agentic coding runs from the Mac.","setupHint":"Sign-in happens on the Mac through the Codex CLI.","setupCommands":[{"id":"codex","label":"Codex","command":"npm i -g @openai/codex","source":"OpenAI"}],"usageWindows":[{"id":"codex-5h","label":"Current session (5h)","usedPercent":28,"resetAt":"2026-06-19T14:00:00Z"}],"usageGeneratedAt":"2026-06-19T10:45:00Z"},
          {"id":"claude","label":"Claude","optional":false,"statusKind":"ready","statusText":"Ready on Mac","detail":"Claude Code is signed in on the paired Mac for careful reasoning and edits.","setupHint":"Manage Claude sign-in on the Mac.","setupCommands":[{"id":"claude","label":"Claude","command":"curl -fsSL https://claude.ai/install.sh | bash","source":"Anthropic"}],"usageWindows":[{"id":"claude-5h","label":"Current session (5h)","usedPercent":42,"resetAt":"2026-06-19T13:00:00Z"}],"usageGeneratedAt":"2026-06-19T10:45:00Z"},
          {"id":"kimi","label":"Kimi","optional":true,"statusKind":"needsSignIn","statusText":"Needs sign-in on Mac","detail":"Kimi is installed but needs a Moonshot API key on the Mac before runs can start.","setupHint":"Add the API key in TaskWraith Settings on the Mac.","setupCommands":[{"id":"kimi","label":"Kimi","command":"curl -LsSf https://code.kimi.com/install.sh | bash","source":"Moonshot"}],"usageWindows":[{"id":"kimi-day","label":"Daily quota","usedPercent":12,"resetAt":"2026-06-20T00:00:00Z"}]},
          {"id":"cursor","label":"Cursor","optional":true,"statusKind":"notObservable","statusText":"Not observable","detail":"Cursor CLI is available; it may still ask for sign-in when a run starts on the Mac.","setupHint":"Run cursor-agent login on the Mac if prompted.","setupCommands":[{"id":"cursor","label":"Cursor","command":"curl https://cursor.com/install -fsS | bash","source":"Cursor"}],"usageWindows":[{"id":"cursor-month","label":"Monthly requests","usedPercent":34,"resetAt":"2026-07-01T00:00:00Z"}]},
          {"id":"grok","label":"Grok","optional":true,"statusKind":"notObservable","statusText":"Not observable","detail":"Grok usage is not observable from this demo snapshot.","setupHint":"Finish Grok CLI sign-in on the Mac.","setupCommands":[{"id":"grok","label":"Grok","command":"curl -fsSL https://x.ai/cli/install.sh | bash","source":"xAI"}],"usageWindows":[]},
          {"id":"ollama","label":"Ollama","optional":true,"statusKind":"localReady","statusText":"Local Ollama ready","detail":"Local models are served by the paired Mac; no cloud account is required.","setupHint":"Pull a supported model on the Mac before selecting it.","setupCommands":[{"id":"ollama","label":"Ollama","command":"curl -fsSL https://ollama.com/install.sh | sh","source":"Ollama","platform":"macOS / Linux"}],"usageWindows":[]}
         ],
         "setupCommands":[{"id":"codex","label":"Codex","command":"npm i -g @openai/codex","source":"OpenAI"},{"id":"claude","label":"Claude","command":"curl -fsSL https://claude.ai/install.sh | bash","source":"Anthropic"}],
         "ollamaModelCommands":[{"id":"qwen3:4b-instruct","label":"Qwen 3 (4B Param)","command":"ollama run qwen3:4b-instruct"},{"id":"gpt-oss:20b","label":"GPT OSS (20B Param)","command":"ollama run gpt-oss:20b"}]}
        """
        if let state = Self.decodeDemo(FirstLaunchState.self, firstLaunchJSON) { firstLaunchState = state }

        // 30-day token bar charts — deterministic synthetic series (no gemini).
        let twProviders = ["claude", "codex", "kimi"]
        let twValues = (0..<30).map { i in 26_000 + ((i * 17) % 11) * 5_500 + (i % 4) * 3_200 }
        let twBars = twValues.enumerated().map { (i, v) in
            #"{"tokens":\#(v),"provider":"\#(twProviders[i % twProviders.count])"}"#
        }.joined(separator: ",")
        let twDailyJSON = #"{"totalTokens":\#(twValues.reduce(0, +)),"startLabel":"21 May","endLabel":"19 Jun","buckets":[\#(twBars)]}"#
        if let series = Self.decodeDemo(DailyTokenSeries.self, twDailyJSON) { taskwraithTokenDaily = series }
        let extProviders = ["cursor", "grok"]
        let extValues = (0..<30).map { i in 8_000 + ((i * 13) % 9) * 2_400 + (i % 3) * 1_500 }
        let extBars = extValues.enumerated().map { (i, v) in
            #"{"tokens":\#(v),"provider":"\#(extProviders[i % extProviders.count])"}"#
        }.joined(separator: ",")
        let extDailyJSON = #"{"totalTokens":\#(extValues.reduce(0, +)),"startLabel":"21 May","endLabel":"19 Jun","buckets":[\#(extBars)]}"#
        if let series = Self.decodeDemo(DailyTokenSeries.self, extDailyJSON) { externalTokenDaily = series }

        macDisplayName = "Demo Mac"
        selectedTaskId = "demo-1"
        projectionHydrated = true
        isDemo = true
        phase = .connected
    }

    /// Leave the demo and clear its canned data. Reconnects the trusted Mac if
    /// one is paired; otherwise returns to the pairing screen.
    public func exitDemoMode() {
        isDemo = false  // re-open the reconnect guards before reconnecting
        disconnect()    // clears live lists + cancels timers; phase → .idle
        clearCachedProjectionState()
        selectedTaskId = nil
        macDisplayName = ""
        if hasStoredPairing { reconnectTrusted() }
    }

    private static func decodeDemo<T: Decodable>(_ type: T.Type, _ json: String) -> T? {
        guard let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    /// Clears cached projection/render state (snapshots, streaming buffers, usage
    /// panels, git/diff caches) so real and demo data never bleed together.
    /// Mirrors forgetPairing's cache wipe; used by demo enter/exit.
    // CANONICAL per-host projection reset. This + wipeProjectionCaches() are
    // the ONLY places host-specific render state is cleared on a host switch /
    // forget / demo toggle. When a future slice adds a per-host @Published
    // (transcripts, streaming, usage, nav targets, suppression sets), reset it
    // HERE or it will silently bleed across hosts.
    private func clearCachedProjectionState() {
        threadSnapshots = [:]
        streamingTexts = [:]
        streamingSegments = [:]
        streamingRunIds = [:]
        streamingProviders = [:]
        streamingItemIds = [:]
        providerModels = [:]
        projectionHydrated = false
        usageRollup = nil
        taskwraithTokenDaily = nil
        externalTokenDaily = nil
        modelUsage = nil
        welcomeDashboard = nil
        firstLaunchState = nil
        gitSnapshots = [:]
        ensembleStates = [:]
        diffSummaries = [:]
        workflows = []
        ensemblePresets = []
        threadWorkspaceHints = [:]
        demoFileEdits = [:]
        // Expanded transcript row bodies hold verbatim message/tool content —
        // wiping snapshots without these would leave a host's transcript text
        // readable after switch/forget ("leave NOTHING readable").
        rowExpansions = [:]
        expandingRows = []
        // Per-thread run-summary suppression state is part of the snapshot cache
        // it sits beside — keeping it would let one host's hidden summaries
        // filter another's.
        hiddenRunSummaryFingerprintsByThread = [:]
        navigationTarget = nil
        // QR-optional discovery results belong to the (outgoing) oracle host — a
        // stale list must not linger under the next host (and could offer to
        // re-pair a host the new context already knows).
        discoveredHosts = []
        discoveryError = nil
        visibleThreadId = nil
        // Side-chat inspector target is a host-scoped navigation pointer, same
        // as navigationTarget/visibleThreadId above.
        inspectorSideChatTarget = nil
        lastActionMessage = nil
    }

    /// One-time self-heal: a build-30 bug could persist the synthetic "Demo Mac"
    /// name into the stored pairing. Never surface it for a real Mac.
    private static func sanitizedMacName(_ name: String) -> String {
        name == "Demo Mac" ? "" : name
    }

    /// Demo-only: a mutable mirror of the immutable `RemoteThreadSnapshot` so
    /// local edits (appended turns, saved notes, pinned rows) can rebuild it
    /// while preserving every other field.
    private struct DemoSnapshotDraft {
        var threadId: String?
        var taskId: String?
        var workspaceId: String?
        var provider: String?
        var rows: [RemoteThreadSnapshot.Row]?
        var totalRows: Int?
        var runSummary: RemoteThreadSnapshot.RunSummary?
        var conversationCostUsd: Double?
        var conversationCostText: String?
        var showRunCompleteSummary: Bool?
        var notes: String?
        var pinnedRows: [RemoteThreadSnapshot.Row]?
        var blackboardEntries: [RemoteThreadSnapshot.BlackboardEntry]?
        var runSummaries: [RemoteThreadSnapshot.RunSummary]?
        var windowStartIndex: Int?
        var hasMoreAbove: Bool?
        var hasMoreBelow: Bool?
        init(_ s: RemoteThreadSnapshot) {
            threadId = s.threadId
            taskId = s.taskId
            workspaceId = s.workspaceId
            provider = s.provider
            rows = s.rows
            totalRows = s.totalRows
            runSummary = s.runSummary
            conversationCostUsd = s.conversationCostUsd
            conversationCostText = s.conversationCostText
            showRunCompleteSummary = s.showRunCompleteSummary
            notes = s.notes
            pinnedRows = s.pinnedRows
            blackboardEntries = s.blackboardEntries
            runSummaries = s.runSummaries
            windowStartIndex = s.windowStartIndex
            hasMoreAbove = s.hasMoreAbove
            hasMoreBelow = s.hasMoreBelow
        }
        func build() -> RemoteThreadSnapshot {
            RemoteThreadSnapshot(
                threadId: threadId, taskId: taskId, workspaceId: workspaceId,
                provider: provider, rows: rows, totalRows: totalRows,
                runSummary: runSummary, conversationCostUsd: conversationCostUsd,
                conversationCostText: conversationCostText,
                showRunCompleteSummary: showRunCompleteSummary, notes: notes, pinnedRows: pinnedRows,
                blackboardEntries: blackboardEntries, runSummaries: runSummaries,
                windowStartIndex: windowStartIndex, hasMoreAbove: hasMoreAbove,
                hasMoreBelow: hasMoreBelow)
        }
    }

    /// Demo-only: apply an in-place edit to a thread snapshot (no-op if absent).
    private func editDemoSnapshot(
        _ thread: String, _ edit: (inout DemoSnapshotDraft) -> Void
    ) {
        guard let existing = threadSnapshots[thread] else { return }
        var draft = DemoSnapshotDraft(existing)
        edit(&draft)
        threadSnapshots[thread] = draft.build()
    }

    /// Demo-only: append the user's prompt + a canned assistant reply to a thread
    /// so the composer feels interactive with no network. Rows are built via JSON
    /// so they decode through the same Codable path as real rows.
    private func appendDemoTurn(card: RemoteTaskCard, prompt: String) {
        guard let thread = card.threadId else { return }
        let n = threadSnapshots[thread]?.rows?.count ?? 0
        let speaker = card.provider.map { $0.prefix(1).uppercased() + $0.dropFirst() } ?? "Assistant"
        let reply =
            "Demo reply — connect TaskWraith on your Mac to run this for real. Live, I'd plan the change, edit files behind your approval, and stream the results back here."
        guard
            let userRow = Self.demoRow(id: "demo-u-\(n)", role: "user", speaker: nil, preview: prompt),
            let replyRow = Self.demoRow(
                id: "demo-a-\(n)", role: "assistant", speaker: speaker, preview: reply)
        else { return }
        if threadSnapshots[thread] != nil {
            editDemoSnapshot(thread) { draft in
                let rows = (draft.rows ?? []) + [userRow, replyRow]
                draft.rows = rows
                draft.totalRows = rows.count
            }
        } else {
            let rows = [userRow, replyRow]
            threadSnapshots[thread] = RemoteThreadSnapshot(
                threadId: thread, workspaceId: card.workspaceId, provider: card.provider,
                rows: rows, totalRows: rows.count)
        }
    }

    /// Demo-only: fabricate a brand-new empty chat locally (workspace / ensemble
    /// / global) so the New-Chat canvas resolves to a usable welcome screen
    /// instead of spinning on "Creating…" forever (send() is inert in demo).
    /// Built via JSONSerialization → Codable, the same path as the live wire.
    private func createDemoThread(
        workspaceId: String, variant: String, provider: String?, title: String,
        onCreated: ((String?) -> Void)?
    ) {
        let newId = "demo-new-" + UUID().uuidString.prefix(8).lowercased()
        let isEnsemble = variant == "ensemble"
        let isGlobal = variant == "global"
        let prov = provider ?? "claude"
        let ws = isGlobal ? "global" : workspaceId

        var cardDict: [String: Any] = [
            "id": newId, "title": title, "workspaceId": ws, "threadId": newId,
            "status": "idle", "chatKind": isEnsemble ? "ensemble" : "single",
        ]
        if !isEnsemble { cardDict["provider"] = prov }
        let snapDict: [String: Any] = [
            "threadId": newId, "workspaceId": ws, "provider": prov,
            "totalRows": 0, "rows": [],
        ]
        guard
            let cardData = try? JSONSerialization.data(withJSONObject: cardDict),
            let card = try? JSONDecoder().decode(RemoteTaskCard.self, from: cardData),
            let snapData = try? JSONSerialization.data(withJSONObject: snapDict),
            let snap = try? JSONDecoder().decode(RemoteThreadSnapshot.self, from: snapData)
        else {
            onCreated?(nil)
            return
        }
        taskCards.append(card)
        threadSnapshots[newId] = snap
        if isEnsemble {
            let ensDict: [String: Any] = [
                "threadId": newId, "status": "idle",
                "participants": [
                    ["participantId": "p-claude", "provider": "claude", "role": "Architect",
                        "order": 1, "status": "idle"],
                    ["participantId": "p-codex", "provider": "codex", "role": "Implementer",
                        "order": 2, "status": "idle"],
                ],
                "roster": [
                    ["id": "p-claude", "provider": "claude", "role": "Architect", "enabled": true,
                        "order": 1, "model": "cli-default"],
                    ["id": "p-codex", "provider": "codex", "role": "Implementer", "enabled": true,
                        "order": 2, "model": "cli-default"],
                ],
            ]
            if let ensData = try? JSONSerialization.data(withJSONObject: ensDict),
                let ensState = try? JSONDecoder().decode(RemoteEnsembleState.self, from: ensData)
            {
                ensembleStates[newId] = ensState
            }
        }
        rememberThreadWorkspace(newId, workspaceId: ws)
        lastActionMessage = "Chat created."
        onCreated?(newId)
    }

    private static func demoRow(id: String, role: String, speaker: String?, preview: String)
        -> RemoteThreadSnapshot.Row?
    {
        var dict: [String: Any] = ["id": id, "role": role, "kind": "message", "preview": preview]
        if let speaker { dict["speaker"] = speaker }
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
            let row = try? JSONDecoder().decode(RemoteThreadSnapshot.Row.self, from: data)
        else { return nil }
        return row
    }

    // ── Demo file editor + diff studio ────────────────────────────────────────
    // Offline canned filesystem so the Files browser, editor save, and Diff
    // Studio all work without a Mac. Edits live in `demoFileEdits` (in-memory,
    // wiped on demo exit); reads fall back to the static seed content.

    /// In-session demo file edits (path → content). Cleared on demo exit.
    private var demoFileEdits: [String: String] = [:]

    /// Flat workspace tree for `listWorkspaceFiles` — the view's
    /// `immediateChildren`/`searchMatches` filter this by path/query.
    private static let demoFileTreeJSON = """
    [
     {"path":"auth","name":"auth","isDirectory":true,"depth":0,"hasChildren":true},
     {"path":"src","name":"src","isDirectory":true,"depth":0,"hasChildren":true},
     {"path":"test","name":"test","isDirectory":true,"depth":0,"hasChildren":true},
     {"path":"docs","name":"docs","isDirectory":true,"depth":0,"hasChildren":true},
     {"path":"README.md","name":"README.md","isDirectory":false,"depth":0,"sizeBytes":420},
     {"path":"package.json","name":"package.json","isDirectory":false,"depth":0,"sizeBytes":260},
     {"path":"auth/TokenService.ts","name":"TokenService.ts","isDirectory":false,"depth":1,"sizeBytes":980},
     {"path":"auth/index.ts","name":"index.ts","isDirectory":false,"depth":1,"sizeBytes":360},
     {"path":"auth/TokenService.test.ts","name":"TokenService.test.ts","isDirectory":false,"depth":1,"sizeBytes":760},
     {"path":"src/upload","name":"upload","isDirectory":true,"depth":1,"hasChildren":true},
     {"path":"src/upload/uploader.ts","name":"uploader.ts","isDirectory":false,"depth":2,"sizeBytes":340},
     {"path":"test/upload.test.ts","name":"upload.test.ts","isDirectory":false,"depth":1,"sizeBytes":320},
     {"path":"docs/api-v2.md","name":"api-v2.md","isDirectory":false,"depth":1,"sizeBytes":520}
    ]
    """

    /// Seed file contents (real newlines; JSONSerialization escapes them when
    /// building the read result). Edited copies override these via `demoFileEdits`.
    private static let demoFileContents: [String: String] = [
        "auth/TokenService.ts": """
        import { SignJWT, jwtVerify } from 'jose'
        import type { Clock } from './clock'

        const ACCESS_TTL = 15 * 60          // 15 minutes
        const REFRESH_TTL = 30 * 24 * 3600  // 30 days
        const SKEW = 60                     // tolerate 60s clock skew

        export class TokenService {
          constructor(
            private readonly clock: Clock,
            private readonly secret: Uint8Array,
          ) {}

          async issue(userId: string) {
            const now = this.clock.now()
            const access = await new SignJWT({ sub: userId })
              .setProtectedHeader({ alg: 'ES256' })
              .setIssuedAt(now)
              .setExpirationTime(now + ACCESS_TTL)
              .sign(this.secret)
            return { access }
          }

          async verify(token: string) {
            return jwtVerify(token, this.secret, { clockTolerance: SKEW })
          }
        }
        """,
        "auth/index.ts": """
        export { TokenService } from './TokenService'
        export type { Clock } from './clock'

        import { TokenService } from './TokenService'

        // Keep the public login() signature stable across the refactor.
        export async function login(userId: string, deps: { tokens: TokenService }) {
          return deps.tokens.issue(userId)
        }
        """,
        "auth/TokenService.test.ts": """
        import { describe, it, expect } from 'vitest'
        import { TokenService } from './TokenService'
        import { FakeClock } from '../test/FakeClock'

        describe('TokenService', () => {
          it('issues an access token that verifies', async () => {
            const svc = new TokenService(new FakeClock(0), KEY)
            const { access } = await svc.issue('u_1')
            await expect(svc.verify(access)).resolves.toBeTruthy()
          })

          it('rejects a token expired beyond the skew window', async () => {
            const clock = new FakeClock(0)
            const svc = new TokenService(clock, KEY)
            const { access } = await svc.issue('u_1')
            clock.advance(16 * 60)
            await expect(svc.verify(access)).rejects.toThrow()
          })
        })
        """,
        "src/upload/uploader.ts": """
        export async function upload(stream: ReadableStream, sink: Sink) {
          const writer = sink.writable.getWriter()
          await stream.pipeTo(sink.writable)
          // FIX: await the flush before resolving so callers can assert safely.
          await writer.ready
          return sink.result()
        }
        """,
        "test/upload.test.ts": """
        import { it, expect } from 'vitest'
        import { upload } from '../src/upload/uploader'

        it('resolves only after the buffer has drained', async () => {
          const sink = new MemorySink()
          await upload(fixtureStream(), sink)
          // Previously asserted before the flush — the source of the flake.
          expect(sink.bytes).toBe(FIXTURE_BYTES)
        })
        """,
        "docs/api-v2.md": """
        # Public API v2

        ## Principles
        - Resource-oriented endpoints under `/v2/…`
        - Cursor pagination on every list endpoint
        - Typed error envelope (never reuse the v1 shape)
        - `Idempotency-Key` required on all POST requests

        ## Pagination
        List endpoints accept `?cursor=` and return `{ items, nextCursor }`.
        The cursor is an opaque base64 token — clients must not parse it.
        """,
        "README.md": """
        # TaskWraith Demo Project

        A sandbox workspace bundled with the iOS app's demo mode. Connect
        TaskWraith on your Mac to work with your own repositories.

        - `auth/` — token-service refactor
        - `src/upload/` — flaky-test fix
        - `docs/` — v2 API plan
        """,
        "package.json": """
        {
          "name": "taskwraith-demo",
          "version": "2.0.0",
          "private": true,
          "scripts": {
            "test": "vitest run",
            "build": "tsc -p ."
          },
          "dependencies": {
            "jose": "^5.9.0"
          }
        }
        """,
    ]

    /// The canned `git status` for the demo workspace — powers the composer's
    /// active-changes diff pill (the Git panel itself is hidden in demo).
    private static let demoGitSnapshotJSON = """
    {"repoRoot":"~/Developer/taskwraith-demo","branch":"feat/auth-refactor","commit":"a3f9c1d","detached":false,"upstream":"origin/feat/auth-refactor","remoteName":"origin","ahead":1,"behind":0,"clean":false,"counts":{"changed":3,"staged":0,"unstaged":3,"untracked":0},"lineStats":{"additions":178,"deletions":42},"files":[{"path":"auth/TokenService.ts","kind":"modified","staged":false,"unstaged":true},{"path":"auth/index.ts","kind":"modified","staged":false,"unstaged":true},{"path":"auth/TokenService.test.ts","kind":"created","staged":false,"unstaged":true}],"filesTruncated":false}
    """

    /// The canned Diff Studio payload for the demo workspace.
    private static let demoWorkspaceDiffJSON = """
    {"totalFiles":3,"truncated":false,"files":[
     {"path":"auth/TokenService.ts","kind":"modified","additions":96,"deletions":12,"truncated":false,"hunks":[
       {"header":"@@ -1,8 +1,12 @@","lines":[
         {"type":"ctx","text":"import { SignJWT, jwtVerify } from 'jose'","oldLine":1,"newLine":1},
         {"type":"del","text":"export function makeToken(userId) {","oldLine":2},
         {"type":"del","text":"  return sign({ sub: userId })","oldLine":3},
         {"type":"add","text":"export class TokenService {","newLine":2},
         {"type":"add","text":"  constructor(private readonly clock: Clock) {}","newLine":3},
         {"type":"add","text":"  async issue(userId: string) {","newLine":4},
         {"type":"add","text":"    const now = this.clock.now()","newLine":5},
         {"type":"ctx","text":"}","oldLine":4,"newLine":6}
       ]}
     ]},
     {"path":"auth/index.ts","kind":"modified","additions":18,"deletions":30,"truncated":false,"hunks":[
       {"header":"@@ -1,5 +1,4 @@","lines":[
         {"type":"del","text":"import { makeToken } from './TokenService'","oldLine":1},
         {"type":"add","text":"import { TokenService } from './TokenService'","newLine":1},
         {"type":"ctx","text":"","oldLine":2,"newLine":2},
         {"type":"ctx","text":"export async function login(userId: string) {","oldLine":3,"newLine":3}
       ]}
     ]},
     {"path":"auth/TokenService.test.ts","kind":"created","additions":64,"deletions":0,"truncated":false,"hunks":[
       {"header":"@@ -0,0 +1,6 @@","lines":[
         {"type":"add","text":"import { describe, it, expect } from 'vitest'","newLine":1},
         {"type":"add","text":"import { TokenService } from './TokenService'","newLine":2},
         {"type":"add","text":"","newLine":3},
         {"type":"add","text":"describe('TokenService', () => {","newLine":4},
         {"type":"add","text":"  it('issues a verifiable token', async () => {})","newLine":5},
         {"type":"add","text":"})","newLine":6}
       ]}
     ]}
    ]}
    """

    /// Build a `WorkspaceFileReadResult` for the demo editor via JSONSerialization
    /// (the type has no cross-module init). Etag changes with content length so a
    /// save round-trips to a fresh, non-empty etag (the editor requires one).
    private static func demoFileReadResult(path: String, content: String)
        -> WorkspaceFileReadResult?
    {
        let dict: [String: Any] = [
            "path": path, "content": content,
            "sizeBytes": content.utf8.count,
            "etag": "demo-etag-\(content.utf8.count)",
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
            let result = try? JSONDecoder().decode(WorkspaceFileReadResult.self, from: data)
        else { return nil }
        return result
    }

    /// Forget the ACTIVE host. Kept zero-arg so existing "Forget this host"
    /// affordances (sidebar overflow, pairing screen) keep working; with no
    /// active host it falls back to a full reset so a stuck state can still be
    /// cleared.
    public func forgetPairing() {
        guard let active = selectedHostId else {
            forgetAllHosts()
            return
        }
        forgetHost(macIdentityPubKey: active)
    }

    /// Forget one host by identity. If it's the active host, tear down the live
    /// session and wipe its projection first; OTHER paired hosts are untouched.
    /// (Caches are flat today and only ever hold the active host's data — they
    /// were already cleared when the user switched away from a background host —
    /// so a non-active forget needs no cache wipe.) The host keeps its own pin
    /// until the user revokes this phone there.
    public func forgetHost(macIdentityPubKey id: String) {
        let wasActive = (id == selectedHostId)
        pairingStore.remove(macIdentityPubKey: id)
        refreshPairedHostsPublished()
        guard wasActive else { return }
        pinnedMacIdentityB64 = nil
        relayUrl = nil
        lastRelayUrls = nil
        lastHostPlatform = nil
        disconnect()
        // Security review: forgetting the active host must leave NOTHING
        // readable — disconnect() clears the live lists, but cached snapshots,
        // streaming buffers, and usage panels survive it.
        wipeProjectionCaches()
        // The store auto-selects the next remaining host (or none); reflect its
        // name so the reconnect affordance is labeled. Reconnecting to it is
        // left to the user (no surprise auto-jump on a forget).
        macDisplayName = pairingStore.load().selectedHost.map {
            Self.sanitizedMacName($0.macDisplayName)
        } ?? ""
    }

    /// Forget EVERY paired host (full reset). Durable: clearAll() persists an
    /// empty v2 document so the legacy single-host blob can't resurrect a host.
    public func forgetAllHosts() {
        pairingStore.clearAll()
        refreshPairedHostsPublished()
        pinnedMacIdentityB64 = nil
        relayUrl = nil
        lastRelayUrls = nil
        lastHostPlatform = nil
        macDisplayName = ""
        disconnect()
        wipeProjectionCaches()
    }

    /// Switch the active host: tear down the current session, wipe the outgoing
    /// host's live + cached projection (no cross-host bleed), select the new
    /// host, and reconnect to it. No-op for the already-active host except to
    /// re-drive a stalled connection.
    public func switchHost(to id: String) {
        guard !isDemo else { return }
        guard pairingStore.find(macIdentityPubKey: id) != nil else { return }
        if id == selectedHostId {
            switch phase {
            case .connected, .connecting, .awaitingMacConfirm: return
            default: reconnectTrusted()
            }
            return
        }
        cancelAutoReconnect(resetAttempts: true)
        cancelSocketHealthCheck()
        pinnedMacIdentityB64 = nil
        relayUrl = nil
        lastRelayUrls = nil
        lastHostPlatform = nil
        disconnect()  // teardown + .idle + clear live lists
        wipeProjectionCaches()  // clear the outgoing host's cached projection
        pairingStore.setSelectedHostId(id)
        refreshPairedHostsPublished()
        reconnectTrusted()
    }

    /// Clear cached + APNs projection state belonging to the (outgoing/forgotten)
    /// active host. `clearCachedProjectionState()` covers snapshots, streaming
    /// buffers, usage/model panels, git/diff/ensemble/workflow caches and
    /// navigation; the APNs fields are wiped here too.
    private func wipeProjectionCaches() {
        clearCachedProjectionState()
        // The allowlist-visible workspace list isn't part of the demo cache
        // reset (clearCachedProjectionState), but it IS per-host material — a
        // forgotten/outgoing host's workspaces must not linger under the next.
        workspaces = []
        // In-flight per-thread snapshot debounce timers belong to the outgoing
        // host's thread ids — cancel them so none fires requestThreadSnapshot()
        // against the next host (same hygiene as apnsTokenRetryTask below).
        pendingThreadRefresh.values.forEach { $0.cancel() }
        pendingThreadRefresh = [:]
        // A queued notification deep-link is a host-specific navigation target;
        // don't let a stale one fire against a different host on establish.
        pendingDeepLinkThreadId = nil
        pendingApnsToken = nil
        apnsTokenRegistrationInFlight = false
        apnsTokenRetryTask?.cancel()
        apnsTokenRetryTask = nil
    }

    /// The transport socket died underneath us (background kill, relay
    /// reap, network change). Without this the phase stayed .connected
    /// forever — a zombie state where every send times out and
    /// reconnectIfStale refuses to act because it looks healthy.
    private func handleSocketClosed() {
        // Intentional teardown nils the client BEFORE closing — ignore.
        guard client != nil else { return }
        guard case .connected = phase else { return }
        if hasStoredPairing {
            phase = .error("Connection lost — reconnecting…")
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 1_200_000_000)
                await MainActor.run { self?.reconnectIfStale() }
            }
        } else {
            phase = .error("Connection lost.")
        }
    }

    private func teardown() {
        eventTask?.cancel()
        eventTask = nil
        let client = self.client
        self.client = nil
        Task { await client?.close() }
    }

    private func persistCurrentPairing() {
        guard !isDemo else { return }  // never persist the demo's synthetic name
        guard let relayUrl, let macId = pinnedMacIdentityB64 else { return }
        // UPSERT (not overwrite): pairing/reconnecting one host must never drop
        // the others. Preserve the original pairedAt across reconnects so the
        // host list ordering doesn't churn; stamp it on first pairing only.
        let existing = pairingStore.find(macIdentityPubKey: macId)
        let pairedAt = existing?.pairedAt ?? Self.iso8601Now()
        // sanitizedMacName() maps a host literally named "Demo Mac" to "" on
        // every reconnect read; never let that (or any transient empty) clobber
        // a good persisted name — fall back to what we already stored.
        let name = macDisplayName.isEmpty ? (existing?.macDisplayName ?? "") : macDisplayName
        // Prefer the freshly-observed platform; fall back to whatever we stored
        // (reconnect carries none, and an old host may not advertise one).
        let hostPlatform = lastHostPlatform ?? existing?.hostPlatform
        pairingStore.upsert(
            PairedHostRecord(
                relayUrl: relayUrl, macIdentityPubKey: macId, macDisplayName: name,
                // The full candidate set from the bootstrap (LAN + wss) —
                // ONE pairing then reconnects from home Wi-Fi or cellular
                // alike; `relayUrl` holds the door that last worked.
                relayUrls: lastRelayUrls, hostPlatform: hostPlatform, pairedAt: pairedAt))
        // The host we just connected to is the active one.
        pairingStore.setSelectedHostId(macId)
        refreshPairedHostsPublished()
    }

    /// Mirror the persisted multi-host document into the @Published surface the
    /// view layer renders. Call after every store mutation.
    private func refreshPairedHostsPublished() {
        let doc = pairingStore.load()
        pairedHosts = doc.hosts
        selectedHostId = doc.selectedHostId
        hasStoredPairing = doc.selectedHostId != nil
    }

    private static func iso8601Now() -> String {
        ISO8601DateFormatter().string(from: Date())
    }

    private func consumeEvents(of client: RelayTransportClient) {
        eventTask = Task { [weak self] in
            for await event in client.events {
                guard let self else { return }
                // Each handler re-checks that THIS client is still the live one:
                // teardown() (switch/forget/disconnect/next candidate) nils or
                // replaces self.client, so a late event from a superseded client
                // can't resurrect .connected or re-persist the outgoing host.
                // The check sits INSIDE each MainActor.run so it is atomic with
                // the mutations (no await gap a teardown could slip through).
                switch event {
                case .confirmCode(let code):
                    await MainActor.run {
                        guard self.client === client else { return }
                        self.phase = .awaitingMacConfirm(code: code)
                    }
                case .established:
                    await MainActor.run {
                        guard self.client === client else { return }
                        self.cancelAutoReconnect(resetAttempts: true)
                        self.phase = .connected
                        self.wasEverConnected = true
                        self.persistCurrentPairing()
                        // Cold-launch deep link: a notification tap set a target
                        // before the session existed — apply it now that
                        // ConnectedShell will render.
                        if let pending = self.pendingDeepLinkThreadId {
                            self.navigationTarget = pending
                            self.pendingDeepLinkThreadId = nil
                        }
                        // Grace fallback for the hydration gate: a Mac with
                        // genuinely nothing shared must eventually show the
                        // true empty state (with its setup instructions)
                        // rather than ticking forever. Idempotent — content
                        // arriving first flips the flag and this no-ops.
                        if !self.projectionHydrated {
                            Task { [weak self] in
                                try? await Task.sleep(nanoseconds: 5_000_000_000)
                                await MainActor.run { self?.projectionHydrated = true }
                            }
                        }
                        // The establish snapshot covers recent-N threads; the
                        // one the user is LOOKING AT may be older — refresh it
                        // explicitly so the transcript catches up after a
                        // backgrounded run finished.
                        if let visible = self.visibleThreadId {
                            self.requestThreadSnapshot(visible)
                        }
                        // APNs: ask AFTER a successful session (never at cold
                        // launch), then register; the token callback ships it
                        // up via handleApnsToken.
                        self.requestPushAuthorizationIfNeeded()
                        self.sendPendingApnsTokenIfReady()
                    }
                case .message(let method, let params):
                    await self.handle(method: method, params: params)
                case .error(let message):
                    await MainActor.run {
                        guard self.client === client else { return }
                        if case .connected = self.phase { self.lastActionMessage = message }
                        else { self.phase = .error(message) }
                    }
                case .closed:
                    await MainActor.run {
                        guard self.client === client else { return }
                        self.handleSocketClosed()
                    }
                }
            }
        }
    }

    // ── Inbound projections ───────────────────────────────────────────────────

    private func handle(method: String, params: Data?) async {
        guard let params else { return }
        switch method {
        case "bridge.broadcastRemoteProjectionSnapshot":
            guard
                let snapshot = try? JSONDecoder().decode(
                    RemoteProjectionSnapshot.self, from: params)
            else {
                print("[tw] DECODE FAILED: projection snapshot — state not rehydrated")
                return
            }
            applySnapshot(snapshot)
        case "bridge.broadcastWorkspaceList":
            guard let message = try? JSONDecoder().decode(WorkspaceListMessage.self, from: params)
            else {
                print("[tw] DECODE FAILED: workspace list")
                return
            }
            // Non-destructive: an empty list while we HOLD workspaces is
            // far more likely a settling-Mac snapshot than a real
            // revocation — keep state, the rehydrate re-seed corrects it.
            if message.workspaces.isEmpty, !workspaces.isEmpty {
                print("[tw] ignoring empty workspace list (have \(workspaces.count))")
            } else {
                workspaces = message.workspaces
            }
            if !message.workspaces.isEmpty { projectionHydrated = true }
        case "bridge.broadcastModelUsage":
            guard let message = try? JSONDecoder().decode(ModelUsageMessage.self, from: params)
            else {
                print("[tw] DECODE FAILED: model usage")
                return
            }
            modelUsage = message.usage
        case "bridge.broadcastUsageRollup":
            guard let message = try? JSONDecoder().decode(UsageRollupMessage.self, from: params)
            else {
                print("[tw] DECODE FAILED: usage rollup")
                return
            }
            usageRollup = message.rollup
            taskwraithTokenDaily = message.taskwraithDaily
            externalTokenDaily = message.externalDaily
        case "bridge.broadcastWelcomeDashboard":
            guard
                let message = try? JSONDecoder().decode(WelcomeDashboardMessage.self, from: params)
            else {
                print("[tw] DECODE FAILED: welcome dashboard")
                return
            }
            welcomeDashboard = message.dashboard
        case "bridge.broadcastFirstLaunchState":
            guard
                let message = try? JSONDecoder().decode(FirstLaunchStateMessage.self, from: params)
            else {
                print("[tw] DECODE FAILED: first launch state")
                return
            }
            firstLaunchState = message.state
        case "bridge.broadcastProviderModels":
            guard let message = try? JSONDecoder().decode(ProviderModelsMessage.self, from: params)
            else { return }
            providerModels = Dictionary(
                uniqueKeysWithValues: message.providers.map { ($0.provider, $0.models) })
        case "bridge.broadcastRemoteProjection":
            // Single-envelope push — on-demand thread snapshots + low-latency
            // approval/question card changes.
            struct One: Codable { let envelope: RemoteProjectionEnvelope }
            guard let one = try? JSONDecoder().decode(One.self, from: params) else { return }
            merge(envelope: one.envelope)
        case "bridge.runEvent":
            struct WirePayload: Codable {
                let data: String?
                let appRunId: String?
            }
            struct Wire: Codable {
                let threadId: String?
                let channel: String?
                let provider: String?
                let payload: WirePayload?
            }
            guard let wire = try? JSONDecoder().decode(Wire.self, from: params),
                let threadId = wire.threadId
            else { return }
            // Token-level progressive streaming: agent-output lines carry the
            // routed provider events; append content deltas as they arrive so
            // text grows per-token instead of per-snapshot hunk.
            if wire.channel == "agent-output", let data = wire.payload?.data {
                appendStreamingDeltas(
                    threadId: threadId, runId: wire.payload?.appRunId,
                    provider: wire.provider, data: data)
            }
            if wire.channel == "agent-exit" || wire.channel == "gemini-exit" {
                // Final snapshot supersedes the live bubble; clear shortly
                // after the refresh lands so the handoff doesn't flash empty.
                let captured = streamingTexts[threadId]
                let capturedRunId = streamingRunIds[threadId]
                Task { [weak self] in
                    try? await Task.sleep(nanoseconds: 900_000_000)
                    await MainActor.run {
                        guard let self,
                            self.streamingTexts[threadId] == captured,
                            self.streamingRunIds[threadId] == capturedRunId
                        else { return }
                        self.streamingTexts[threadId] = nil
                        self.streamingSegments[threadId] = nil
                        self.streamingRunIds[threadId] = nil
                        self.streamingProviders[threadId] = nil
                        self.streamingItemIds[threadId] = nil
                    }
                }
            }
            // Snapshot re-pull is the consistency backstop. During text
            // streaming the live buffer (appendStreamingDeltas above) already
            // drives the transcript, so a fast full re-pull per token only
            // rebuilds the whole snapshot object ~5x/sec and flickers the
            // settled List rows (every Row becomes a fresh, non-Equatable
            // instance). Keep the agent-exit handoff prompt, but slow
            // agent-output so the re-pull mainly catches tool rows / dedup
            // instead of fighting the stream.
            let isExit = wire.channel == "agent-exit" || wire.channel == "gemini-exit"
            let debounceNanos: UInt64 =
                isExit
                ? 200_000_000
                : (wire.channel == "agent-output" ? 700_000_000 : 450_000_000)
            scheduleThreadRefresh(threadId, debounceMs: debounceNanos)
        default:
            break
        }
    }

    /// Parse routed provider JSONL line(s) and append content deltas. The
    /// line is `JSON.stringify(routed)` — provider events flat-merged with
    /// routing fields; raw Gemini CLI chunks arrive as multi-line fragments,
    /// so split + tolerate partial lines.
    private func appendStreamingDeltas(
        threadId: String, runId: String?, provider: String?, data: String
    ) {
        if let provider, !provider.isEmpty {
            streamingProviders[threadId] = provider
        }
        // A new run on the same thread starts a fresh bubble — without this
        // a follow-up turn would append to the previous answer's text.
        if let runId, let current = streamingRunIds[threadId], current != runId {
            streamingSegments[threadId] = [""]
            streamingTexts[threadId] = ""
            streamingRunIds[threadId] = runId
            if let provider, !provider.isEmpty {
                streamingProviders[threadId] = provider
            }
            streamingItemIds[threadId] = nil
        }
        var segments = streamingSegments[threadId] ?? [streamingTexts[threadId] ?? ""]
        var appended = false
        var changed = false
        for line in data.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let lineData = line.data(using: .utf8),
                let parsed = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any]
            else { continue }
            let kind = parsed["type"] as? String
            if kind == "tool_use" || kind == "tool_call" {
                // A tool boundary SEALS the current segment — the transcript
                // view slots the run's tool rows between sealed segments, so
                // the live order matches the finished transcript. Empty
                // segments are kept: they hold the position of back-to-back
                // tool calls for the interleave count.
                segments.append("")
                changed = true
                continue
            }
            guard kind == "content" || kind == "token" else { continue }
            // Cumulative restatements REPLACE on the desktop; the live
            // bubble already holds the streamed deltas — skip them.
            if (parsed["cumulative"] as? Bool) == true,
                segments.contains(where: { !$0.isEmpty })
            {
                continue
            }
            let text =
                (parsed["text"] as? String) ?? (parsed["content"] as? String) ?? ""
            guard !text.isEmpty else { continue }
            // UNTAGGED cumulative snapshot (Cursor — cursor-agent stream-json,
            // no --stream-partial-output): every `assistant` frame re-states
            // the WHOLE turn so far, forwarded with no `cumulative` flag. A
            // blind append would re-add the pre-tool prose below each tool
            // (text -> tool -> WHOLE-TURN-again), clumping/duplicating the
            // bubble. Desktop parity: resolveAssistantDeltaMerge detects the
            // (equal/growing) superset and resolveAssistantDeltaTarget keeps
            // only the post-last-tool TAIL. Mirror both here on the segment
            // list — a stale shorter snapshot is dropped, never a genuine
            // increment (a true delta never restarts from the full prose).
            switch StreamingSnapshotFold.plan(segments: segments, incoming: text) {
            case .skip:
                // Stale/older snapshot we've already surpassed — drop it,
                // but the seal above (if any) still changed the segments.
                continue
            case .replaceLastSegment(let newTail):
                segments[segments.count - 1] = newTail
                appended = true
                changed = true
                continue
            case .append:
                break  // genuine increment — fall through to the append path
            }
            // Desktop merge-with-separator parity: a NEW Codex agentMessage
            // item (itemId transition) is a paragraph boundary. Within an
            // item, token deltas append seamlessly as before.
            let itemId = parsed["itemId"] as? String
            if let itemId, !itemId.isEmpty {
                if let last = streamingItemIds[threadId], last != itemId,
                    let tail = segments.last, !tail.isEmpty, !tail.hasSuffix("\n\n")
                {
                    segments[segments.count - 1] = tail + "\n\n"
                }
                streamingItemIds[threadId] = itemId
            }
            segments[segments.count - 1] += text
            appended = true
            changed = true
        }
        guard changed else { return }
        streamingSegments[threadId] = segments
        streamingTexts[threadId] = Self.joinedStreamText(segments)
        if appended, let runId, streamingRunIds[threadId] != runId {
            streamingRunIds[threadId] = runId
        }
    }

    /// The single-bubble mirror of the segment list — what `streamingTexts`
    /// held before tool-boundary segmentation (paragraph break per boundary).
    static func joinedStreamText(_ segments: [String]) -> String {
        segments
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n\n")
    }

    /// Merge one pushed envelope into the published state.
    private func merge(envelope: RemoteProjectionEnvelope) {
        switch envelope.kind {
        case "threadSnapshot":
            if let thread = envelope.decodePayload(RemoteThreadSnapshot.self),
                let key = thread.taskId ?? thread.threadId
            {
                mergeThreadSnapshot(thread, key: key)
            }
        case "ensembleState":
            if let state = envelope.decodePayload(RemoteEnsembleState.self),
                let key = state.taskId ?? state.threadId ?? envelope.threadId
            {
                ensembleStates[key] = state
            }
        case "diffSummary":
            if let diff = envelope.decodePayload(MobileDiffSummary.self),
                let key = diff.taskId ?? diff.threadId ?? envelope.threadId
            {
                diffSummaries[key] = diff
            }
        case "gitSnapshot":
            if let git = envelope.decodePayload(GitWorkspaceSnapshot.self),
                let workspaceId = envelope.workspaceId
            {
                gitSnapshots[workspaceId] = git
            }
        case "approvalCard":
            if let card = envelope.decodePayload(MobileApprovalCard.self) {
                mergeApprovalCard(card)
            }
        case "questionCard":
            if let card = envelope.decodePayload(MobileQuestionCard.self) {
                mergeQuestionCard(card)
            }
        case "taskCard":
            if let card = envelope.decodePayload(RemoteTaskCard.self) {
                if let index = taskCards.firstIndex(where: { $0.id == card.id }) {
                    taskCards[index] = card
                } else {
                    taskCards.insert(card, at: 0)
                }
            }
        case "workflows":
            if let workflow = envelope.decodePayload(RemoteWorkflow.self) {
                if let index = workflows.firstIndex(where: { $0.id == workflow.id }) {
                    workflows[index] = workflow
                } else {
                    workflows.append(workflow)
                }
            }
        case "ensemblePresets":
            if let preset = envelope.decodePayload(RemoteEnsemblePreset.self) {
                if let index = ensemblePresets.firstIndex(where: { $0.id == preset.id }) {
                    ensemblePresets[index] = preset
                } else {
                    ensemblePresets.append(preset)
                }
            }
        case "shellAppearance":
            if let appearance = envelope.decodePayload(TWRemoteShellAppearance.self) {
                applyShellAppearance(appearance)
            }
        default:
            break
        }
    }

    /// Apply a projected composer shellAppearance, ignoring stale re-broadcasts.
    /// The Mac re-sends the same `remote-shell-appearance:global` envelope in
    /// every snapshot; only a strictly-newer generatedAt updates published
    /// state. See ios/COMPOSER-SHELL-PARITY.md (E.1/E.4).
    private func applyShellAppearance(_ appearance: TWRemoteShellAppearance) {
        guard twShouldApplyShellAppearance(
            incoming: appearance.generatedAt, last: lastShellAppearanceGeneratedAt)
        else { return }
        lastShellAppearanceGeneratedAt = appearance.generatedAt
        // The Mac re-stamps generatedAt on every snapshot, so the timestamp gate
        // alone would republish constantly. Only composerStyle is consumed on iOS
        // (projectedComposerStyle), so republish only when it actually changes.
        guard appearance.composerStyle != projectedShellAppearance?.composerStyle else { return }
        projectedShellAppearance = appearance
    }

    private func mergeThreadSnapshot(_ incoming: RemoteThreadSnapshot, key: String) {
        let filteredIncoming = snapshotFilteringHiddenRunSummaries(incoming, key: key)
        let incomingRows = filteredIncoming.rows ?? []
        // Recover a backgrounded-missed completion: if this snapshot shows the
        // run our live buffer is streaming has ENDED, the live `agent-exit` that
        // normally clears the buffers never arrived (the WS was suspended while
        // backgrounded), so clear them here. Otherwise `liveStreamRunId` stays
        // non-nil → the thread is stuck "running" and the partial live bubble
        // masks the finalized message. ONLY when this snapshot carries rows, so
        // the finalized rows replace the bubble in the same pass (no empty
        // flash); and against the UNFILTERED `incoming` so a user-dismissed run
        // summary still counts as ended. Mirrors the agent-exit clear path.
        if !incomingRows.isEmpty {
            reconcileStreamingState(against: incoming, key: key)
        }
        guard let current = threadSnapshots[key] else {
            threadSnapshots[key] = filteredIncoming
            return
        }
        let filteredCurrent = snapshotFilteringHiddenRunSummaries(current, key: key)

        let currentRows = filteredCurrent.rows ?? []
        if incomingRows.isEmpty {
            return
        }
        guard !currentRows.isEmpty else {
            threadSnapshots[key] = mergedSnapshot(
                base: filteredIncoming, fallback: filteredCurrent, rows: incomingRows,
                windowStartIndex: windowStart(for: filteredIncoming),
                totalRows: bestTotalRows(filteredIncoming, filteredCurrent))
            return
        }

        let incomingStart = windowStart(for: filteredIncoming)
        let currentStart = windowStart(for: filteredCurrent)
        var rowsById: [String: (index: Int, row: RemoteThreadSnapshot.Row)] = [:]

        for (offset, row) in currentRows.enumerated() {
            rowsById[row.id] = (currentStart + offset, row)
        }
        for (offset, row) in incomingRows.enumerated() {
            rowsById[row.id] = (incomingStart + offset, row)
        }

        let orderedPairs = rowsById.values.sorted { lhs, rhs in
            if lhs.index == rhs.index { return lhs.row.id < rhs.row.id }
            return lhs.index < rhs.index
        }
        let rows = orderedPairs.map(\.row)
        let start = orderedPairs.map(\.index).min() ?? min(incomingStart, currentStart)
        let totalRows = bestTotalRows(filteredIncoming, filteredCurrent)
        threadSnapshots[key] = mergedSnapshot(
            base: filteredIncoming, fallback: filteredCurrent, rows: rows, windowStartIndex: start,
            totalRows: totalRows)
    }

    /// Clear orphaned live-stream buffers when a freshly-merged snapshot shows
    /// the run they were streaming has terminated. The reconnect/foreground
    /// recovery for a run that finished while the app was backgrounded (its live
    /// `agent-exit` was never delivered, so the buffers were never cleared and
    /// `liveStreamRunId` is stuck non-nil). Matched by the LIVE run id so a NEW
    /// run streaming on the same thread is never cleared by an OLD run's
    /// terminal summary. Clears the same buffer set as the agent-exit path.
    private func reconcileStreamingState(against snapshot: RemoteThreadSnapshot, key: String) {
        guard let liveRunId = streamingRunIds[key] else { return }
        var summaries = snapshot.runSummaries ?? []
        if let latest = snapshot.runSummary { summaries.append(latest) }
        guard let match = summaries.first(where: { $0.runId == liveRunId }),
            match.endedAt != nil || Self.isFinishedRunStatus(match.status)
        else { return }
        streamingTexts[key] = nil
        streamingSegments[key] = nil
        streamingRunIds[key] = nil
        streamingProviders[key] = nil
        streamingItemIds[key] = nil
    }

    /// Terminal run-status vocabulary the Mac projects (bridge runs flip
    /// ChatRun.status to success/failed on finalize; the broader set is defensive
    /// against other providers). `endedAt` is the primary terminal signal; this
    /// is the fallback when a summary carries a status but no end timestamp.
    private static func isFinishedRunStatus(_ status: String?) -> Bool {
        guard let status else { return false }
        switch status {
        case "success", "failed", "completed", "complete", "cancelled", "canceled", "error", "done":
            return true
        default:
            return false
        }
    }

    private func currentRunSummaryFingerprints(
        threadId: String, fallbackRunId: String? = nil,
        fallbackEnsembleRoundId: String? = nil
    ) -> Set<String> {
        var fingerprints: Set<String> = []
        if let fallback = Self.runSummaryFingerprint(runId: fallbackRunId) {
            fingerprints.insert(fallback)
        }
        if let fallback = Self.runSummaryFingerprint(ensembleRoundId: fallbackEnsembleRoundId) {
            fingerprints.insert(fallback)
        }
        guard let snapshot = threadSnapshots[threadId] else { return fingerprints }
        if let runSummary = snapshot.runSummary {
            fingerprints.formUnion(Self.runSummaryFingerprints(runSummary))
        }
        for summary in snapshot.runSummaries ?? [] {
            fingerprints.formUnion(Self.runSummaryFingerprints(summary))
        }
        return fingerprints
    }

    private func hideRunSummaryFingerprintsForNextTurn(
        _ fingerprints: Set<String>, threadId: String
    ) {
        guard !fingerprints.isEmpty else { return }
        hiddenRunSummaryFingerprintsByThread[threadId, default: []].formUnion(fingerprints)
        guard let snapshot = threadSnapshots[threadId] else { return }
        threadSnapshots[threadId] = snapshotFilteringHiddenRunSummaries(snapshot, key: threadId)
    }

    private func snapshotFilteringHiddenRunSummaries(
        _ snapshot: RemoteThreadSnapshot, key: String
    ) -> RemoteThreadSnapshot {
        guard let hidden = hiddenRunSummaryFingerprintsByThread[key], !hidden.isEmpty else {
            return snapshot
        }
        let runSummary = snapshot.runSummary.flatMap { summary in
            Self.runSummaryIsHidden(summary, hidden: hidden) ? nil : summary
        }
        let runSummaries = snapshot.runSummaries.flatMap { summaries in
            let visible = summaries.filter { !Self.runSummaryIsHidden($0, hidden: hidden) }
            return visible.isEmpty && !summaries.isEmpty ? nil : visible
        }
        return RemoteThreadSnapshot(
            threadId: snapshot.threadId,
            taskId: snapshot.taskId,
            workspaceId: snapshot.workspaceId,
            provider: snapshot.provider,
            rows: snapshot.rows,
            totalRows: snapshot.totalRows,
            runSummary: runSummary,
            conversationCostUsd: snapshot.conversationCostUsd,
            conversationCostText: snapshot.conversationCostText,
            showRunCompleteSummary: snapshot.showRunCompleteSummary,
            notes: snapshot.notes,
            pinnedRows: snapshot.pinnedRows,
            blackboardEntries: snapshot.blackboardEntries,
            runSummaries: runSummaries,
            windowStartIndex: snapshot.windowStartIndex,
            hasMoreAbove: snapshot.hasMoreAbove,
            hasMoreBelow: snapshot.hasMoreBelow)
    }

    private static func runSummaryIsHidden(
        _ summary: RemoteThreadSnapshot.RunSummary, hidden: Set<String>
    ) -> Bool {
        !hidden.isDisjoint(with: runSummaryFingerprints(summary))
    }

    private static func runSummaryFingerprints(
        _ summary: RemoteThreadSnapshot.RunSummary
    ) -> Set<String> {
        var fingerprints: Set<String> = []
        if let runFingerprint = runSummaryFingerprint(runId: summary.runId) {
            fingerprints.insert(runFingerprint)
        }
        if let roundFingerprint = runSummaryFingerprint(ensembleRoundId: summary.ensembleRoundId) {
            fingerprints.insert(roundFingerprint)
        }
        if !fingerprints.isEmpty {
            return fingerprints
        }
        var parts: [String] = []
        parts.append(summary.ensembleRoundId ?? "")
        parts.append(summary.provider ?? "")
        parts.append(summary.model ?? "")
        parts.append(summary.status ?? "")
        parts.append(summary.startedAt ?? "")
        parts.append(summary.endedAt ?? "")
        parts.append(summary.durationMs.map(String.init) ?? "")
        parts.append(summary.totalTokens.map(String.init) ?? "")
        parts.append(summary.tokensIn.map(String.init) ?? "")
        parts.append(summary.tokensOut.map(String.init) ?? "")
        parts.append(summary.costText ?? "")
        fingerprints.insert("summary:\(parts.joined(separator: "|"))")
        return fingerprints
    }

    private static func runSummaryFingerprint(runId: String?) -> String? {
        guard let runId = runId?.trimmingCharacters(in: .whitespacesAndNewlines),
            !runId.isEmpty
        else { return nil }
        return "run:\(runId)"
    }

    private static func runSummaryFingerprint(ensembleRoundId: String?) -> String? {
        guard let ensembleRoundId = ensembleRoundId?.trimmingCharacters(in: .whitespacesAndNewlines),
            !ensembleRoundId.isEmpty
        else { return nil }
        return "round:\(ensembleRoundId)"
    }

    private func mergedSnapshot(
        base: RemoteThreadSnapshot,
        fallback: RemoteThreadSnapshot,
        rows: [RemoteThreadSnapshot.Row],
        windowStartIndex: Int,
        totalRows: Int?
    ) -> RemoteThreadSnapshot {
        let end = windowStartIndex + rows.count
        let hasMoreBelow: Bool?
        if let totalRows {
            hasMoreBelow = end < totalRows
        } else {
            hasMoreBelow = base.hasMoreBelow ?? fallback.hasMoreBelow
        }
        return RemoteThreadSnapshot(
            threadId: base.threadId ?? fallback.threadId,
            taskId: base.taskId ?? fallback.taskId,
            workspaceId: base.workspaceId ?? fallback.workspaceId,
            provider: base.provider ?? fallback.provider,
            rows: rows,
            totalRows: totalRows ?? base.totalRows ?? fallback.totalRows,
            runSummary: mergedRunSummary(base: base.runSummary, fallback: fallback.runSummary),
            conversationCostUsd: base.conversationCostUsd ?? fallback.conversationCostUsd,
            conversationCostText: base.conversationCostText ?? fallback.conversationCostText,
            showRunCompleteSummary: base.showRunCompleteSummary ?? fallback.showRunCompleteSummary,
            notes: base.notes ?? fallback.notes,
            pinnedRows: base.pinnedRows ?? fallback.pinnedRows,
            blackboardEntries: base.blackboardEntries ?? fallback.blackboardEntries,
            runSummaries: mergedRunSummaries(base: base, fallback: fallback),
            windowStartIndex: windowStartIndex,
            hasMoreAbove: windowStartIndex > 0,
            hasMoreBelow: hasMoreBelow)
    }

    private func mergedRunSummary(
        base: RemoteThreadSnapshot.RunSummary?,
        fallback: RemoteThreadSnapshot.RunSummary?
    ) -> RemoteThreadSnapshot.RunSummary? {
        guard let base else { return fallback }
        guard let fallback else { return base }
        guard Self.runSummaryMergeKey(base) == Self.runSummaryMergeKey(fallback) else {
            return base
        }
        return Self.preferredRunSummary(base, fallback)
    }

    private func mergedRunSummaries(
        base: RemoteThreadSnapshot,
        fallback: RemoteThreadSnapshot
    ) -> [RemoteThreadSnapshot.RunSummary]? {
        guard base.runSummaries != nil || fallback.runSummaries != nil else { return nil }
        let fallbackSummaries = fallback.runSummaries ?? [fallback.runSummary].compactMap { $0 }
        let baseSummaries = base.runSummaries ?? [base.runSummary].compactMap { $0 }
        var order: [String] = []
        var summariesByKey: [String: RemoteThreadSnapshot.RunSummary] = [:]
        for summary in fallbackSummaries + baseSummaries {
            let key = Self.runSummaryMergeKey(summary)
            if let existing = summariesByKey[key] {
                summariesByKey[key] = Self.preferredRunSummary(summary, existing)
            } else {
                order.append(key)
                summariesByKey[key] = summary
            }
        }
        return order.compactMap { summariesByKey[$0] }
    }

    private static func runSummaryMergeKey(_ summary: RemoteThreadSnapshot.RunSummary) -> String {
        if let runFingerprint = runSummaryFingerprint(runId: summary.runId) {
            return runFingerprint
        }
        if let roundFingerprint = runSummaryFingerprint(ensembleRoundId: summary.ensembleRoundId) {
            return roundFingerprint
        }
        return runSummaryFingerprints(summary).sorted().joined(separator: "\n")
    }

    private static func preferredRunSummary(
        _ candidate: RemoteThreadSnapshot.RunSummary,
        _ existing: RemoteThreadSnapshot.RunSummary
    ) -> RemoteThreadSnapshot.RunSummary {
        let candidateTerminal = isTerminalRunSummary(candidate)
        let existingTerminal = isTerminalRunSummary(existing)
        if candidateTerminal != existingTerminal {
            return candidateTerminal ? candidate : existing
        }
        let candidateScore = runSummaryCompletenessScore(candidate)
        let existingScore = runSummaryCompletenessScore(existing)
        if candidateScore != existingScore {
            return candidateScore > existingScore ? candidate : existing
        }
        return existing
    }

    private static func runSummaryCompletenessScore(
        _ summary: RemoteThreadSnapshot.RunSummary
    ) -> Int {
        var score = 0
        if summary.status != nil { score += 1 }
        if summary.startedAt != nil { score += 1 }
        if summary.endedAt != nil { score += 1 }
        if summary.durationMs != nil { score += 1 }
        if summary.totalTokens != nil { score += 1 }
        if summary.tokensIn != nil { score += 1 }
        if summary.tokensOut != nil { score += 1 }
        if summary.costText != nil { score += 1 }
        if let fileChanges = summary.fileChanges {
            score += 2
            if fileChanges.filesChanged != nil { score += 1 }
            if fileChanges.additions != nil { score += 1 }
            if fileChanges.deletions != nil { score += 1 }
            if fileChanges.createdFiles != nil { score += 1 }
            if fileChanges.modifiedFiles != nil { score += 1 }
            if fileChanges.deletedFiles != nil { score += 1 }
            score += min(fileChanges.files?.count ?? 0, 12)
        }
        return score
    }

    private static func isTerminalRunSummary(_ summary: RemoteThreadSnapshot.RunSummary) -> Bool {
        guard let status = summary.status, !status.isEmpty else { return false }
        return status != "running"
    }

    private func windowStart(for snapshot: RemoteThreadSnapshot) -> Int {
        if let value = snapshot.windowStartIndex { return max(0, value) }
        let total = snapshot.totalRows ?? 0
        let count = snapshot.rows?.count ?? 0
        return max(0, total - count)
    }

    private func bestTotalRows(_ lhs: RemoteThreadSnapshot, _ rhs: RemoteThreadSnapshot) -> Int? {
        switch (lhs.totalRows, rhs.totalRows) {
        case (.some(let a), .some(let b)): return max(a, b)
        case (.some(let a), .none): return a
        case (.none, .some(let b)): return b
        case (.none, .none): return nil
        }
    }

    private func mergeApprovalCard(_ card: MobileApprovalCard) {
        guard let id = card.toolCallId else { return }
        if let status = card.status, status != "pending" {
            approvals.removeAll { $0.toolCallId == id }
            repliedApprovalToolCallIds.remove(id)
            return
        }
        // Honor an optimistic dismissal: a pending delta for an approval the
        // user just answered must not flash it back while the ack is in flight.
        if repliedApprovalToolCallIds.contains(id) { return }
        if let index = approvals.firstIndex(where: { $0.toolCallId == id }) {
            approvals[index] = card
        } else {
            approvals.insert(card, at: 0)
        }
    }

    private func mergeQuestionCard(_ card: MobileQuestionCard) {
        guard let id = card.resolvedId else { return }
        if let status = card.status, status != "pending" {
            questions.removeAll { $0.resolvedId == id }
            repliedQuestionIds.remove(id)
            return
        }
        // Honor an optimistic dismissal: a pending delta for a question the user
        // just answered (reply still in flight) must not flash it back.
        if repliedQuestionIds.contains(id) { return }
        if let index = questions.firstIndex(where: { $0.resolvedId == id }) {
            questions[index] = card
        } else {
            questions.insert(card, at: 0)
        }
    }

    private func cardThreadIds(_ card: RemoteTaskCard) -> Set<String> {
        Set([card.id, card.threadId].compactMap { $0 })
    }

    public func pendingApprovalCount(for card: RemoteTaskCard) -> Int {
        let ids = cardThreadIds(card)
        guard !ids.isEmpty else { return 0 }
        return approvals.filter { approval in
            guard let threadId = approval.threadId else { return false }
            return ids.contains(threadId)
        }.count
    }

    public func pendingQuestionCount(for card: RemoteTaskCard) -> Int {
        let ids = cardThreadIds(card)
        guard !ids.isEmpty else { return 0 }
        return questions.filter { question in
            guard let threadId = question.threadId else { return false }
            return ids.contains(threadId)
        }.count
    }

    public func pendingAttentionCount(for card: RemoteTaskCard) -> Int {
        pendingApprovalCount(for: card) + pendingQuestionCount(for: card)
    }

    private var pendingThreadRefresh: [String: Task<Void, Never>] = [:]

    private func scheduleThreadRefresh(_ threadId: String, debounceMs: UInt64 = 450_000_000) {
        pendingThreadRefresh[threadId]?.cancel()
        pendingThreadRefresh[threadId] = Task { [weak self] in
            try? await Task.sleep(nanoseconds: debounceMs)
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.requestThreadSnapshot(threadId) }
        }
    }

    /// The workspace scope an action presents for this thread: the chat's
    /// workspace id, or the reserved read-only "global" scope for
    /// scope-global chats (no workspace — the Mac's allowlist grants the
    /// sentinel `monitor` only, so these stay view-only).
    public func remoteScopeForThread(_ threadId: String) -> String? {
        if let card = taskCards.first(where: { $0.id == threadId }) {
            if let workspaceId = card.workspaceId, !workspaceId.isEmpty { return workspaceId }
            return "global"
        }
        return threadWorkspaceHints[threadId]
    }

    /// True for scope-global chats — passed through read-only (transcript
    /// viewing only; no composer, no actions).
    public func isGlobalThread(_ threadId: String) -> Bool {
        remoteScopeForThread(threadId) == "global"
    }

    /// Pull the full body for a clipped row from the Mac.
    public func expandRow(threadId: String, rowId: String) {
        guard let client else { return }
        guard let workspaceId = remoteScopeForThread(threadId)
        else { return }
        expandingRows.insert(rowId)
        let params = BridgeAction.threadRowExpand(
            workspaceId: workspaceId, threadId: threadId, rowId: rowId)
        Task {
            do {
                let ack = try await client.request(
                    "bridge.requestActionAck", params: params, timeoutMs: 12_000)
                guard ack.ok, let data = ack.result else {
                    await MainActor.run { _ = self.expandingRows.remove(rowId) }
                    return
                }
                guard let actionAck = try? JSONDecoder().decode(BridgeActionAck.self, from: data),
                    let row = actionAck.data?.row
                else {
                    await MainActor.run { _ = self.expandingRows.remove(rowId) }
                    return
                }
                await MainActor.run {
                    var perThread = self.rowExpansions[threadId] ?? [:]
                    perThread[rowId] = row
                    self.rowExpansions[threadId] = perThread
                    self.expandingRows.remove(rowId)
                }
            } catch {
                await MainActor.run {
                    self.lastActionMessage = String(describing: error)
                    self.expandingRows.remove(rowId)
                }
            }
        }
    }

    public func resolvedRow(_ row: RemoteThreadSnapshot.Row, threadId: String)
        -> RemoteThreadSnapshot.Row
    {
        rowExpansions[threadId]?[row.id] ?? row
    }

    public func fetchThreadMedia(
        threadId: String, rowId: String, mediaId: String, variant: String = "full",
        maxBytes: Int = 8 * 1024 * 1024
    ) async throws -> TranscriptMediaFetchResult {
        guard !isDemo else { throw RemoteFileActionError.denied("Demo mode has no Mac media store.") }
        guard let workspaceId = remoteScopeForThread(threadId)
        else { throw RemoteFileActionError.denied("Thread is not in an allowlisted workspace.") }
        let params = BridgeAction.threadMediaFetch(
            workspaceId: workspaceId, threadId: threadId, rowId: rowId, mediaId: mediaId,
            variant: variant, maxBytes: maxBytes)
        do {
            let ack = try await requestFileAction(params, timeoutMs: 30_000)
            guard let media = ack.data?.media else { throw RemoteFileActionError.malformedAck }
            return media
        } catch {
            await MainActor.run {
                self.lastActionMessage = String(describing: error)
            }
            throw error
        }
    }

    /// Display name for a workspace id (telemetry rail / headers).
    public func workspaceName(for workspaceId: String?) -> String? {
        guard let workspaceId else { return nil }
        return workspaces.first(where: { $0.id == workspaceId })?.displayName
    }

    public func workspaceId(forPath path: String?) -> String? {
        guard let path, !path.isEmpty else { return nil }
        return workspaces.first(where: { $0.path == path })?.id
    }

    public var fileEditableWorkspaces: [WorkspaceSummary] {
        workspaces.filter { workspaceCanEditFiles($0.id) }
    }

    public func workspaceCanEditFiles(_ workspaceId: String?) -> Bool {
        guard let workspaceId,
            let capabilities = workspaces.first(where: { $0.id == workspaceId })?.capabilities
        else { return false }
        return capabilities.fileBrowse == true
            && capabilities.fileRead == true
            && capabilities.fileWrite == true
    }

    public func requestFilesMode(workspaceId: String? = nil) {
        fileModeRequest = FileModeRequest(workspaceId: workspaceId)
    }

    public var diffReviewableWorkspaces: [WorkspaceSummary] {
        workspaces.filter { workspaceCanReviewDiffs($0.id) }
    }

    public func workspaceCanReviewDiffs(_ workspaceId: String?) -> Bool {
        guard let workspaceId,
            let capabilities = workspaces.first(where: { $0.id == workspaceId })?.capabilities
        else { return false }
        return capabilities.diffReview == true
    }

    /// Git mutations (stage/commit/push/create-PR) ride the fileWrite
    /// capability — the strongest existing write tier (mirrors the Mac
    /// router's gating; git reads ride diffReview).
    public func workspaceCanRunGitMutations(_ workspaceId: String?) -> Bool {
        guard let workspaceId,
            let capabilities = workspaces.first(where: { $0.id == workspaceId })?.capabilities
        else { return false }
        return capabilities.fileWrite == true
    }

    public func requestDiffMode(workspaceId: String? = nil) {
        diffModeRequest = DiffModeRequest(workspaceId: workspaceId)
    }

    public func refreshGitSnapshotCache(workspaceId: String?) async {
        guard let workspaceId, !workspaceId.isEmpty, workspaceCanReviewDiffs(workspaceId)
        else { return }
        do {
            let snapshot = try await fetchGitSnapshot(workspaceId: workspaceId)
            gitSnapshots[workspaceId] = snapshot
        } catch {
            gitSnapshots.removeValue(forKey: workspaceId)
        }
    }

    public enum RemoteFileActionError: LocalizedError {
        case notConnected
        case denied(String)
        case malformedAck

        public var errorDescription: String? {
            switch self {
            case .notConnected:
                return "Not connected to your Mac."
            case .denied(let message):
                return message
            case .malformedAck:
                return "The Mac returned an unreadable file response."
            }
        }
    }

    public func listWorkspaceFiles(
        workspaceId: String, path: String? = nil, query: String? = nil, limit: Int? = nil
    ) async throws -> (
        entries: [WorkspaceFileEntry], truncated: Bool
    ) {
        if isDemo {
            // Return the whole flat tree; the view's immediateChildren/searchMatches
            // filter by path/query.
            return (Self.decodeDemo([WorkspaceFileEntry].self, Self.demoFileTreeJSON) ?? [], false)
        }
        let ack = try await requestFileAction(
            BridgeAction.workspaceFileList(
                workspaceId: workspaceId, path: path, query: query, limit: limit))
        return (ack.data?.entries ?? [], ack.data?.truncated ?? false)
    }

    public func readWorkspaceFile(
        workspaceId: String, path: String
    ) async throws -> WorkspaceFileReadResult {
        if isDemo {
            let content =
                demoFileEdits[path] ?? Self.demoFileContents[path]
                ?? "// \(path)\n// Demo file — connect TaskWraith on your Mac to read the real contents.\n"
            guard let result = Self.demoFileReadResult(path: path, content: content) else {
                throw RemoteFileActionError.malformedAck
            }
            return result
        }
        let ack = try await requestFileAction(
            BridgeAction.workspaceFileRead(workspaceId: workspaceId, path: path))
        guard let file = ack.data?.file else { throw RemoteFileActionError.malformedAck }
        return file
    }

    public func writeWorkspaceFile(
        workspaceId: String, path: String, content: String, baseEtag: String
    ) async throws -> WorkspaceFileReadResult {
        if isDemo {
            demoFileEdits[path] = content  // local, in-memory; wiped on demo exit
            guard let result = Self.demoFileReadResult(path: path, content: content) else {
                throw RemoteFileActionError.malformedAck
            }
            lastActionMessage = "Saved (demo)."
            return result
        }
        let ack = try await requestFileAction(
            BridgeAction.workspaceFileWrite(
                workspaceId: workspaceId, path: path, content: content, baseEtag: baseEtag),
            timeoutMs: 16_000)
        guard let file = ack.data?.file else { throw RemoteFileActionError.malformedAck }
        return file
    }

    public func deleteWorkspaceFile(workspaceId: String, path: String) async throws -> String {
        if isDemo {
            demoFileEdits.removeValue(forKey: path)
            lastActionMessage = "Deleted (demo)."
            return path
        }
        let ack = try await requestFileAction(
            BridgeAction.workspaceFileDelete(workspaceId: workspaceId, path: path),
            timeoutMs: 16_000)
        return ack.data?.path ?? path
    }

    /// Bounded workspace diff for the Diff Studio — the Mac runs the same
    /// git surface the desktop Diff Studio uses and returns it in the ack.
    public func fetchWorkspaceDiff(workspaceId: String) async throws -> WorkspaceDiffResult {
        if isDemo {
            guard let result = Self.decodeDemo(WorkspaceDiffResult.self, Self.demoWorkspaceDiffJSON)
            else { throw RemoteFileActionError.malformedAck }
            return result
        }
        let ack = try await requestFileAction(
            BridgeAction.workspaceDiff(workspaceId: workspaceId), timeoutMs: 16_000)
        guard let diff = ack.data?.diff else { throw RemoteFileActionError.malformedAck }
        return diff
    }

    // ── Git workflows — the Mac's GitService is the single authority; every
    //    mutation is an explicit phone UI action, never agent-initiated. ────

    public func fetchGitSnapshot(workspaceId: String) async throws -> GitWorkspaceSnapshot {
        if isDemo {
            guard let snap = Self.decodeDemo(GitWorkspaceSnapshot.self, Self.demoGitSnapshotJSON)
            else { throw RemoteFileActionError.malformedAck }
            gitSnapshots[workspaceId] = snap
            return snap
        }
        let ack = try await requestFileAction(
            BridgeAction.gitSnapshot(workspaceId: workspaceId), timeoutMs: 16_000)
        guard let git = ack.data?.git else { throw RemoteFileActionError.malformedAck }
        gitSnapshots[workspaceId] = git
        return git
    }

    public func stageAllChanges(workspaceId: String) async throws -> GitWorkspaceSnapshot {
        let ack = try await requestFileAction(
            BridgeAction.gitStageAll(workspaceId: workspaceId), timeoutMs: 20_000)
        guard let git = ack.data?.git else { throw RemoteFileActionError.malformedAck }
        gitSnapshots[workspaceId] = git
        return git
    }

    public func stagePaths(workspaceId: String, paths: [String]) async throws -> GitWorkspaceSnapshot {
        let ack = try await requestFileAction(
            BridgeAction.gitStagePaths(workspaceId: workspaceId, paths: paths), timeoutMs: 20_000)
        guard let git = ack.data?.git else { throw RemoteFileActionError.malformedAck }
        gitSnapshots[workspaceId] = git
        return git
    }

    public func unstagePaths(workspaceId: String, paths: [String]) async throws -> GitWorkspaceSnapshot {
        let ack = try await requestFileAction(
            BridgeAction.gitUnstagePaths(workspaceId: workspaceId, paths: paths), timeoutMs: 20_000)
        guard let git = ack.data?.git else { throw RemoteFileActionError.malformedAck }
        gitSnapshots[workspaceId] = git
        return git
    }

    /// Commit with a user-entered message; `stageAll` runs `git add -A`
    /// first (the panel's single "Stage all & Commit" button).
    public func commitChanges(
        workspaceId: String, message: String, stageAll: Bool
    ) async throws -> GitWorkspaceSnapshot {
        let ack = try await requestFileAction(
            BridgeAction.gitCommit(workspaceId: workspaceId, message: message, stageAll: stageAll),
            timeoutMs: 30_000)
        guard let git = ack.data?.git else { throw RemoteFileActionError.malformedAck }
        gitSnapshots[workspaceId] = git
        return git
    }

    /// Push the current branch; `setUpstream` publishes a branch that has
    /// no upstream yet (the Mac runs `git push -u <remote> <branch>`).
    public func pushBranch(
        workspaceId: String, setUpstream: Bool
    ) async throws -> GitWorkspaceSnapshot {
        let ack = try await requestFileAction(
            BridgeAction.gitPush(workspaceId: workspaceId, setUpstream: setUpstream),
            timeoutMs: 60_000)
        guard let git = ack.data?.git else { throw RemoteFileActionError.malformedAck }
        gitSnapshots[workspaceId] = git
        return git
    }

    /// PR summary for the current branch — nil when no PR exists yet
    /// (a successful read, not an error).
    public func fetchPrStatus(workspaceId: String) async throws -> GitPullRequestSummary? {
        let ack = try await requestFileAction(
            BridgeAction.githubPrStatus(workspaceId: workspaceId), timeoutMs: 30_000)
        return ack.data?.pr
    }

    public func fetchPrReadiness(workspaceId: String) async throws -> GitPrReadinessResult {
        let ack = try await requestFileAction(
            BridgeAction.githubPrReadiness(workspaceId: workspaceId), timeoutMs: 30_000)
        guard let readiness = ack.data?.readiness else { throw RemoteFileActionError.malformedAck }
        return readiness
    }

    public func createGithubPr(
        workspaceId: String, title: String?, body: String?, draft: Bool
    ) async throws -> GitPullRequestSummary {
        let ack = try await requestFileAction(
            BridgeAction.githubCreatePr(
                workspaceId: workspaceId, title: title, body: body, draft: draft),
            timeoutMs: 60_000)
        guard let pr = ack.data?.pr else { throw RemoteFileActionError.malformedAck }
        return pr
    }

    private func requestFileAction(
        _ params: [String: Any], timeoutMs: Int = 12_000
    ) async throws -> BridgeActionAck {
        guard let client else { throw RemoteFileActionError.notConnected }
        let paramsData = try JSONSerialization.data(withJSONObject: params)
        let ack = try await client.requestSerialized(
            "bridge.requestActionAck", paramsData: paramsData, timeoutMs: timeoutMs)
        guard ack.ok else {
            throw RemoteFileActionError.denied(ack.error ?? "Action denied.")
        }
        guard let data = ack.result,
            let actionAck = try? JSONDecoder().decode(BridgeActionAck.self, from: data)
        else { throw RemoteFileActionError.malformedAck }
        if actionAck.accepted == false {
            throw RemoteFileActionError.denied(actionAck.message ?? "Denied by Mac policy.")
        }
        if actionAck.executed == false {
            throw RemoteFileActionError.denied(
                actionAck.message ?? "Accepted, but the Mac did not run the file action.")
        }
        return actionAck
    }

    /// One staged roster entry from the in-thread editor.
    public struct RosterDraftEntry: Identifiable, Equatable, Sendable {
        public var id: String
        public var provider: String
        public var model: String?
        public var role: String
        public var brief: String
        public var enabled: Bool
        /// Per-participant approval preset (read_only | default | workspace_write).
        public var permissionPresetId: String?
        /// Per-participant reasoning effort (provider-interpreted); Kimi uses
        /// thinkingEnabled instead.
        public var reasoningEffort: String?
        public var fastModeEnabled: Bool
        public var thinkingEnabled: Bool
        public init(
            id: String, provider: String, model: String?, role: String,
            brief: String, enabled: Bool,
            permissionPresetId: String? = nil, reasoningEffort: String? = nil,
            fastModeEnabled: Bool = false, thinkingEnabled: Bool = false
        ) {
            self.id = id
            self.provider = provider
            self.model = model
            self.role = role
            self.brief = brief
            self.enabled = enabled
            self.permissionPresetId = permissionPresetId
            self.reasoningEffort = reasoningEffort
            self.fastModeEnabled = fastModeEnabled
            self.thinkingEnabled = thinkingEnabled
        }
    }

    /// Apply an edited roster to an existing ensemble (order = array order).
    public func updateEnsembleRoster(
        workspaceId: String, threadId: String, entries: [RosterDraftEntry]
    ) {
        let participants: [[String: Any]] = entries.map { entry in
            var dict: [String: Any] = ["provider": entry.provider, "enabled": entry.enabled]
            if !entry.id.hasPrefix("draft-") { dict["id"] = entry.id }
            if let model = entry.model, !model.isEmpty { dict["model"] = model }
            if !entry.role.isEmpty { dict["role"] = entry.role }
            dict["brief"] = entry.brief
            if let preset = entry.permissionPresetId, !preset.isEmpty {
                dict["permissionPresetId"] = preset
            }
            if let reasoning = entry.reasoningEffort, !reasoning.isEmpty {
                dict["reasoningEffort"] = reasoning
            }
            // Booleans sent explicitly so the user can toggle them OFF (the Mac
            // applies them when present; omitting would preserve the old value).
            dict["fastModeEnabled"] = entry.fastModeEnabled
            dict["thinkingEnabled"] = entry.thinkingEnabled
            return dict
        }
        send(
            BridgeAction.ensembleRosterUpdate(
                workspaceId: workspaceId, threadId: threadId, participants: participants),
            successLabel: "Roster updated.")
        scheduleThreadRefresh(threadId)
    }

    /// Save a roster (draft entries) as a named preset. GLOBAL — the host
    /// forwards it to the renderer's preset store, which re-syncs to all
    /// devices (the new preset shows up in `ensemblePresets`).
    public func saveEnsembleRosterPreset(name: String, entries: [RosterDraftEntry]) {
        let participants: [[String: Any]] = entries.map { entry in
            var dict: [String: Any] = ["provider": entry.provider, "enabled": entry.enabled]
            if let model = entry.model, !model.isEmpty { dict["model"] = model }
            if !entry.role.isEmpty { dict["role"] = entry.role }
            dict["brief"] = entry.brief
            if let preset = entry.permissionPresetId, !preset.isEmpty {
                dict["permissionPresetId"] = preset
            }
            if let reasoning = entry.reasoningEffort, !reasoning.isEmpty {
                dict["reasoningEffort"] = reasoning
            }
            dict["fastModeEnabled"] = entry.fastModeEnabled
            dict["thinkingEnabled"] = entry.thinkingEnabled
            return dict
        }
        send(
            BridgeAction.ensemblePresetSave(name: name, participants: participants),
            successLabel: "Preset saved.")
    }

    /// Delete a roster preset by id. GLOBAL — re-syncs to all devices.
    public func deleteEnsembleRosterPreset(presetId: String) {
        send(
            BridgeAction.ensemblePresetDelete(presetId: presetId),
            successLabel: "Preset deleted.")
    }

    /// The current guest participant child of a thread, if any.
    /// Filters on `sideChatIsActive` so a removed guest (whose child the Mac
    /// marks `closed` rather than deleting) drops out — otherwise the composer
    /// guest chip lingers after the user removes the guest.
    public func guestParticipant(of threadId: String) -> RemoteTaskCard? {
        taskCards.first { $0.parentChatId == threadId && $0.isGuestSideChat && $0.sideChatIsActive }
    }

    /// Invite / change the guest participant on a solo thread.
    public func setGuestParticipant(
        _ card: RemoteTaskCard, provider: String, model: String?,
        reasoningEffort: String? = nil
    ) {
        guard let ws = card.workspaceId, let thread = card.threadId else { return }
        send(
            BridgeAction.setGuestParticipant(
                workspaceId: ws, threadId: thread, provider: provider, model: model,
                reasoningEffort: reasoningEffort),
            successLabel: "Guest invited.")
        scheduleThreadRefresh(thread)
    }

    public func removeGuestParticipant(_ card: RemoteTaskCard) {
        guard let ws = card.workspaceId, let thread = card.threadId else { return }
        send(
            BridgeAction.removeGuestParticipant(workspaceId: ws, threadId: thread),
            successLabel: "Guest removed.")
        scheduleThreadRefresh(thread)
    }

    /// Create an isolated side chat off a parent thread. Inspector callers keep
    /// the child inline; compact callers can still navigate on ack.
    public func createSideChat(
        _ card: RemoteTaskCard, provider: String?, model: String? = nil,
        reasoningEffort: String? = nil, navigateOnAck: Bool = true,
        onCreated: ((String?) -> Void)? = nil
    ) {
        if isDemo {
            guard let thread = card.threadId else { return }
            let prov = provider ?? card.provider ?? "claude"
            let ws = card.workspaceId ?? "demo-ws"
            let newId = "demo-sc-" + UUID().uuidString.prefix(8).lowercased()
            let label = TWTheme.providerLabel(prov)
            let cardJSON =
                #"{"id":"\#(newId)","title":"Side chat — \#(label) exploration","provider":"\#(prov)","workspaceId":"\#(ws)","threadId":"\#(newId)","parentChatId":"\#(thread)","parentChatRelation":"sideChat","status":"idle","chatKind":"single"}"#
            let snapJSON =
                #"{"threadId":"\#(newId)","workspaceId":"\#(ws)","provider":"\#(prov)","totalRows":1,"rows":[{"id":"\#(newId)-1","role":"assistant","kind":"message","speaker":"\#(label)","preview":"New side chat ready. In a live session this isolated thread runs independently of its parent — ask it anything."}]}"#
            if let newCard = Self.decodeDemo(RemoteTaskCard.self, cardJSON) { taskCards.append(newCard) }
            if let snap = Self.decodeDemo(RemoteThreadSnapshot.self, snapJSON) {
                threadSnapshots[newId] = snap
            }
            rememberThreadWorkspace(newId, workspaceId: ws)
            lastActionMessage = "Side chat created."
            onCreated?(newId)
            return
        }
        guard let ws = card.workspaceId, let thread = card.threadId else { return }
        send(
            BridgeAction.createSideChat(
                workspaceId: ws, threadId: thread, provider: provider, model: model,
                reasoningEffort: reasoningEffort),
            successLabel: "Side chat created.",
            navigateToThreadId: nil,
            navigateOnAck: navigateOnAck,
            onThreadCreated: onCreated)
        scheduleThreadRefresh(thread)
    }

    /// Steer-now or remove one queued ensemble prompt.
    public func ensembleQueueItem(
        _ card: RemoteTaskCard, index: Int, text: String, op: String
    ) {
        guard let ws = card.workspaceId, let thread = card.threadId else { return }
        send(
            BridgeAction.ensembleQueueItem(
                workspaceId: ws, threadId: thread, index: index,
                textPrefix: String(text.prefix(60)), op: op),
            successLabel: op == "steerNow" ? "Steering…" : "Removed from queue.")
        scheduleThreadRefresh(thread)
    }

    /// Queue a prompt behind the active ensemble round. Solo chat queueing is
    /// handled by `queueComposerPrompt`; this path uses the bridge-backed
    /// ensemble FIFO that is already projected to paired devices.
    public func queueEnsemblePrompt(_ card: RemoteTaskCard, prompt: String) {
        guard card.isEnsemble, let ws = card.workspaceId, let thread = card.threadId else { return }
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        send(
            BridgeAction.ensembleQueuePrompt(
                workspaceId: ws, threadId: thread, text: trimmed,
                roundId: ensembleStates[card.id]?.roundId),
            successLabel: "Queued.")
        scheduleThreadRefresh(thread)
    }

    /// Queue a solo-chat prompt behind the active run. The Mac owns the
    /// durable FIFO as RunQueueJob records so every paired client sees the
    /// same pending stack.
    public func queueComposerPrompt(
        _ card: RemoteTaskCard, prompt: String, approvalMode: String? = nil,
        model: String? = nil, providerOverride: String? = nil,
        reasoningEffort: String? = nil, extraWorkspaceIds: [String]? = nil
    ) {
        guard !card.isEnsemble, let thread = card.threadId else { return }
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let ws = (card.workspaceId ?? "").isEmpty ? "global" : card.workspaceId!
        guard let provider = providerOverride ?? card.provider else { return }
        send(
            BridgeAction.composerQueuePrompt(
                workspaceId: ws, threadId: thread, provider: provider, text: trimmed,
                approvalMode: approvalMode, model: model,
                extraWorkspaceIds: extraWorkspaceIds,
                reasoningEffort: reasoningEffort),
            successLabel: "Queued.")
        scheduleThreadRefresh(thread)
    }

    /// Steer-now or remove one queued solo composer prompt.
    public func composerQueueItem(
        _ card: RemoteTaskCard, item: RemoteTaskCard.QueuedComposerPrompt, op: String
    ) {
        guard let thread = card.threadId else { return }
        let ws = (card.workspaceId ?? "").isEmpty ? "global" : card.workspaceId!
        send(
            BridgeAction.composerQueueItem(
                workspaceId: ws, threadId: thread, queueId: item.id,
                textPrefix: String(item.text.prefix(60)), op: op),
            successLabel: op == "steerNow" ? "Steering…" : "Removed from queue.")
        scheduleThreadRefresh(thread)
    }

    /// Save thread notes (markdown; empty clears).
    public func setThreadNotes(_ card: RemoteTaskCard, notes: String) {
        if isDemo {
            guard let thread = card.threadId else { return }
            let trimmed = notes.trimmingCharacters(in: .whitespacesAndNewlines)
            editDemoSnapshot(thread) { $0.notes = trimmed.isEmpty ? nil : notes }
            lastActionMessage = "Notes saved."
            return
        }
        guard let ws = card.workspaceId, let thread = card.threadId else { return }
        send(
            BridgeAction.setThreadNotes(workspaceId: ws, threadId: thread, notes: notes),
            successLabel: "Notes saved.")
        scheduleThreadRefresh(thread)
    }

    /// Set, edit, pause, resume, complete, block, or clear the thread goal.
    public func updateGoal(
        _ card: RemoteTaskCard, op: String, objective: String? = nil, reason: String? = nil
    ) {
        guard let thread = card.threadId else { return }
        let ws = (card.workspaceId ?? "").isEmpty ? "global" : card.workspaceId!
        send(
            BridgeAction.goalUpdate(
                workspaceId: ws, threadId: thread, op: op,
                objective: objective, reason: reason),
            successLabel: "Goal updated.")
        scheduleThreadRefresh(thread)
    }

    /// Pin or unpin a transcript message.
    public func toggleMessagePin(_ card: RemoteTaskCard, messageId: String, pinned: Bool) {
        if isDemo {
            guard let thread = card.threadId else { return }
            editDemoSnapshot(thread) { draft in
                var pins = draft.pinnedRows ?? []
                if pinned {
                    if !pins.contains(where: { $0.id == messageId }),
                        let row = (draft.rows ?? []).first(where: { $0.id == messageId })
                    {
                        pins.append(row)
                    }
                } else {
                    pins.removeAll { $0.id == messageId }
                }
                draft.pinnedRows = pins.isEmpty ? nil : pins
            }
            lastActionMessage = pinned ? "Pinned." : "Unpinned."
            return
        }
        guard let ws = card.workspaceId, let thread = card.threadId else { return }
        send(
            BridgeAction.toggleMessagePin(
                workspaceId: ws, threadId: thread, messageId: messageId, pinned: pinned),
            successLabel: pinned ? "Pinned." : "Unpinned.")
        scheduleThreadRefresh(thread)
    }

    /// Manual refresh: tear down whatever half-state exists and redial the
    /// trusted reconnect. Covers "phone launched before the Mac app" —
    /// resolve initially failed, and waiting on backoff feels broken.
    public func refreshConnection() {
        disconnect()
        reconnectTrusted()
    }

    /// Clear the transient ack banner — called when switching threads so a
    /// denial from thread A doesn't render above thread B's composer.
    public func clearActionMessage() {
        lastActionMessage = nil
    }

    /// Ask the Mac for a fresh bounded transcript window for one thread.
    /// Fire-and-forget — the snapshot arrives on the broadcast channel.
    /// Workspace hints for threads we initiated before their taskCard
    /// arrives — without this, opening a just-created thread raced the
    /// projection broadcast and the snapshot request silently no-opped.
    private var threadWorkspaceHints: [String: String] = [:]

    public func rememberThreadWorkspace(_ threadId: String, workspaceId: String) {
        threadWorkspaceHints[threadId] = workspaceId
    }

    public func requestThreadSnapshot(_ threadId: String, limit: Int = 40, beforeRowId: String? = nil) {
        guard !isDemo else { return }  // demo snapshots are pre-seeded; never hit the wire
        guard let workspaceId = remoteScopeForThread(threadId)
        else { return }
        let params = BridgeAction.threadSnapshotRequest(
            workspaceId: workspaceId, threadId: threadId, limit: limit, beforeRowId: beforeRowId)
        Task {
            do {
                let actionAck = try await self.requestFileAction(params)
                if let thread = actionAck.data?.thread {
                    self.mergeThreadSnapshot(thread, key: thread.taskId ?? thread.threadId ?? threadId)
                }
            } catch {
                self.lastActionMessage = String(describing: error)
            }
        }
    }

    public func requestPreviousThreadRows(_ threadId: String, limit: Int = 40) {
        guard !loadingPreviousThreadRows.contains(threadId),
            let firstRowId = threadSnapshots[threadId]?.rows?.first?.id
        else { return }
        guard let workspaceId = remoteScopeForThread(threadId)
        else { return }
        loadingPreviousThreadRows.insert(threadId)
        let params = BridgeAction.threadSnapshotRequest(
            workspaceId: workspaceId, threadId: threadId, limit: limit, beforeRowId: firstRowId)
        Task {
            do {
                let actionAck = try await self.requestFileAction(params)
                if let thread = actionAck.data?.thread {
                    self.mergeThreadSnapshot(thread, key: thread.taskId ?? thread.threadId ?? threadId)
                }
            } catch {
                self.lastActionMessage = String(describing: error)
            }
            self.loadingPreviousThreadRows.remove(threadId)
        }
    }

    private func applySnapshot(_ snapshot: RemoteProjectionSnapshot) {
        var tasks: [RemoteTaskCard] = []
        var approvalCards: [MobileApprovalCard] = []
        var questionCards: [MobileQuestionCard] = []
        var snapshots: [String: RemoteThreadSnapshot] = [:]
        var ensembleSnapshots: [String: RemoteEnsembleState] = [:]
        var diffSnapshots: [String: MobileDiffSummary] = [:]
        var incomingGitSnapshots: [String: GitWorkspaceSnapshot] = [:]
        var workflowCards: [RemoteWorkflow] = []
        var presetCards: [RemoteEnsemblePreset] = []
        for envelope in snapshot.projections {
            switch envelope.kind {
            case "taskCard":
                if let card = envelope.decodePayload(RemoteTaskCard.self) { tasks.append(card) }
            case "workflows":
                if let workflow = envelope.decodePayload(RemoteWorkflow.self) {
                    workflowCards.append(workflow)
                }
            case "ensemblePresets":
                if let preset = envelope.decodePayload(RemoteEnsemblePreset.self) {
                    presetCards.append(preset)
                }
            case "approvalCard":
                if let card = envelope.decodePayload(MobileApprovalCard.self) {
                    approvalCards.append(card)
                }
            case "questionCard":
                if let card = envelope.decodePayload(MobileQuestionCard.self) {
                    questionCards.append(card)
                }
            case "threadSnapshot":
                if let thread = envelope.decodePayload(RemoteThreadSnapshot.self),
                    let key = thread.taskId ?? thread.threadId
                {
                    snapshots[key] = thread
                }
            case "ensembleState":
                if let state = envelope.decodePayload(RemoteEnsembleState.self),
                    let key = state.taskId ?? state.threadId ?? envelope.threadId
                {
                    ensembleSnapshots[key] = state
                }
            case "diffSummary":
                if let diff = envelope.decodePayload(MobileDiffSummary.self),
                    let key = diff.taskId ?? diff.threadId ?? envelope.threadId
                {
                    diffSnapshots[key] = diff
                }
            case "gitSnapshot":
                if let git = envelope.decodePayload(GitWorkspaceSnapshot.self),
                    let workspaceId = envelope.workspaceId
                {
                    incomingGitSnapshots[workspaceId] = git
                }
            case "shellAppearance":
                if let appearance = envelope.decodePayload(TWRemoteShellAppearance.self) {
                    applyShellAppearance(appearance)
                }
            default:
                break
            }
        }
        // Non-destructive empty-snapshot guard (Codex-diagnosed): a Mac
        // mid-restart can emit an establish snapshot BEFORE its state has
        // settled. Accepting empty-over-populated as authoritative produced
        // 'connected, no chats' — keep what we have; the delayed rehydrate
        // snapshot (Mac-side) supplies the real state moments later.
        if tasks.isEmpty, !taskCards.isEmpty {
            print("[tw] ignoring empty snapshot (have \(taskCards.count) cards)")
        } else {
            taskCards = tasks
        }
        // Non-destructive empty guard for workflows — but only treat an empty
        // workflow set as "settling" when the WHOLE snapshot is empty (no task
        // cards either). A snapshot that carries task cards yet no workflows is
        // authoritative: the user deleted their last workflow, so we must clear
        // rather than keep a ghost row that dead-ends on tap. (Workflows + tasks
        // are projected together in one Mac-side pass, so populated-tasks +
        // empty-workflows never means "workflows still hydrating".)
        if workflowCards.isEmpty, !workflows.isEmpty, tasks.isEmpty {
            // Settling snapshot — keep cached workflows.
        } else {
            workflows = workflowCards
        }
        // Roster presets: keep the cached list only DURING first-connect settling
        // (before the projection has hydrated). Unlike workflows we can't key this
        // on `tasks.isEmpty` — "no presets + no active tasks" is a perfectly normal
        // steady state, and using it would resurrect a just-deleted last preset.
        if presetCards.isEmpty, !ensemblePresets.isEmpty, !projectionHydrated {
            // Pre-hydration settling snapshot — keep cached presets.
        } else {
            ensemblePresets = presetCards
        }
        // Real content ends the first-connect "Syncing…" state immediately;
        // an empty settling snapshot does NOT (the grace timer or the Mac's
        // delayed re-seed resolves it instead).
        if !tasks.isEmpty { projectionHydrated = true }
        // Reconcile the optimistic-dismissal sets: keep suppressing only cards
        // the Mac STILL lists as pending (a reply in flight); once it drops a
        // card (resolution confirmed) the id leaves the set, and a card no
        // longer suppressed re-appears (e.g. a reply the Mac rejected).
        let incomingApprovalIds = Set(approvalCards.compactMap { $0.toolCallId })
        repliedApprovalToolCallIds.formIntersection(incomingApprovalIds)
        approvals = approvalCards.filter { card in
            guard let tid = card.toolCallId else { return true }
            return !repliedApprovalToolCallIds.contains(tid)
        }
        let incomingQuestionIds = Set(questionCards.compactMap { $0.resolvedId })
        repliedQuestionIds.formIntersection(incomingQuestionIds)
        questions = questionCards.filter { card in
            guard let qid = card.resolvedId else { return true }
            return !repliedQuestionIds.contains(qid)
        }
        // Merge — don't wipe on-demand snapshots for threads outside the
        // recent-N window when a full periodic snapshot lands.
        for (key, snapshot) in snapshots {
            mergeThreadSnapshot(snapshot, key: key)
        }
        for (key, state) in ensembleSnapshots {
            ensembleStates[key] = state
        }
        for (key, diff) in diffSnapshots {
            diffSummaries[key] = diff
        }
        for (workspaceId, git) in incomingGitSnapshots {
            gitSnapshots[workspaceId] = git
        }
    }

    // ── Actions ────────────────────────────────────────────────────────────────

    /// Reply to an approval. `decision` MUST be one of the Mac validator's
    /// union: accept | acceptForSession | acceptForWorkspace | decline |
    /// cancel ("approve"/"deny" were silently rejected as malformed).
    /// Cards can OMIT workspaceId (kimi approvals carry no workspace path)
    /// and threadId is conditional — but the reply validators require both
    /// as strings. The router only uses workspaceId for the allowlist gate
    /// and the executor never reads threadId, so best-effort fallbacks keep
    /// the buttons live instead of silently dead.
    private func replyContext(workspaceId: String?, threadId: String?, runId: String?)
        -> (workspaceId: String, threadId: String, runId: String?)?
    {
        // Workspace-less (global-scope) chats resolve to the reserved "global"
        // scope — NOT the first workspace, which the Mac would reject or
        // mis-attribute (the cancel-scope bug class). Treat an empty string the
        // same as absent, and route through `remoteScopeForThread` so a loaded
        // global card maps to "global" rather than its empty workspaceId.
        let ws =
            workspaceId.flatMap { $0.isEmpty ? nil : $0 }
            ?? threadId.flatMap { remoteScopeForThread($0) }
            ?? "global"
        return (ws, threadId ?? runId ?? "", runId)
    }

    public func approve(_ card: MobileApprovalCard, decision: String) {
        guard let toolCallId = card.toolCallId,
            let context = replyContext(
                workspaceId: card.workspaceId, threadId: card.threadId, runId: card.runId)
        else { return }
        let ws = context.workspaceId
        let thread = context.threadId
        let label: String
        switch decision {
        case "accept": label = "Allowed once."
        case "acceptForSession": label = "Allowed for this session."
        case "acceptForWorkspace": label = "Allowed in this workspace."
        case "cancel": label = "Run cancelled."
        default: label = "Denied."
        }
        // Optimistically dismiss the modal NOW — don't wait for the round-trip
        // + next projection (which only arrives when the turn advances), which
        // left the modal stuck on screen after Accept.
        repliedApprovalToolCallIds.insert(toolCallId)
        approvals.removeAll { $0.toolCallId == toolCallId }
        send(
            BridgeAction.approvalReply(
                toolCallId: toolCallId, decision: decision, workspaceId: ws, threadId: thread),
            successLabel: label,
            onAckResult: { [weak self] _, ack in
                guard let self else { return }
                switch Self.approvalAckOutcome(ack) {
                case .succeeded:
                    // Optimistic dismissal stands; the resolved-status delta will
                    // also evict it. Nothing to do.
                    return
                case .alreadyResolved:
                    // The approval resolved out from under us (auto-deny timer,
                    // the desktop, or another surface). EVICT — re-presenting it
                    // would loop forever because it will never be pending again.
                    // (This was the root cause of the unbreakable modal loop.)
                    self.repliedApprovalToolCallIds.remove(toolCallId)
                    self.approvals.removeAll { $0.toolCallId == toolCallId }
                case .rejected:
                    // The Mac rejected the reply on policy/ownership grounds. Keep
                    // it dismissed AND suppressed so a deterministic re-deny can't
                    // trap the user in a tap loop; lastActionMessage explains why,
                    // and the desktop / auto-deny timer finalizes the run.
                    self.approvals.removeAll { $0.toolCallId == toolCallId }
                case .dispatchFailed:
                    // The reply reached the Mac, but the host could not dispatch
                    // the approval decision. The approval may still be pending, so
                    // keep it retryable instead of silently dropping the card.
                    self.repliedApprovalToolCallIds.remove(toolCallId)
                    if !self.approvals.contains(where: { $0.toolCallId == toolCallId }) {
                        self.approvals.insert(card, at: 0)
                    }
                case .transportError:
                    // Couldn't reach the Mac — genuinely retryable. Stop
                    // suppressing + restore the card so the user can try again.
                    self.repliedApprovalToolCallIds.remove(toolCallId)
                    if !self.approvals.contains(where: { $0.toolCallId == toolCallId }) {
                        self.approvals.insert(card, at: 0)
                    }
                }
            })
        scheduleThreadRefresh(thread)
    }

    /// Lock-screen Approve/Deny: resolve an approval from a notification action
    /// in the background with NO MobileApprovalCard present (a cold-launched
    /// process has no hydrated cards). Reconnects the E2EE bridge first and only
    /// sends if connected — the decision comes SOLELY from which button was
    /// tapped, never from the (untrusted) push payload. Returns true only when
    /// the Mac acked; the caller posts a "couldn't reach Mac" local notification
    /// on false. The Mac's auto-deny timer is the safety net, so a missed reply
    /// degrades to a system decline, never a spurious approve.
    public func sendApprovalDecisionFromNotification(
        toolCallId: String, decision: String, workspaceId: String?, threadId: String?,
        timeoutMs: Int = 22_000
    ) async -> Bool {
        guard hasStoredPairing else { return false }
        // The lock screen only offers Approve/Deny — richer grants
        // (acceptForSession/Workspace, cancel) stay in-app where the command
        // text is visible.
        guard decision == "accept" || decision == "decline" else { return false }
        let connected = await handleRemoteWake(reason: "notification-action", timeoutMs: timeoutMs)
        guard connected, case .connected = phase, client != nil else { return false }
        guard let context = replyContext(workspaceId: workspaceId, threadId: threadId, runId: nil)
        else { return false }
        let label = decision == "accept" ? "Allowed once." : "Denied."
        // Bound the ack request so reconnect (≤timeoutMs) + ack stays within the
        // OS background-execution budget.
        return await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            send(
                BridgeAction.approvalReply(
                    toolCallId: toolCallId, decision: decision,
                    workspaceId: context.workspaceId, threadId: context.threadId),
                timeoutMs: 7_000,
                successLabel: label,
                navigateToThreadId: context.threadId,
                onAck: { accepted in continuation.resume(returning: accepted) })
        }
    }

    /// Plain notification tap (no action button): bring the bridge up and
    /// deep-link to the thread's approval card. Survives a cold launch — if the
    /// session isn't established yet, the target is restored on `.established`.
    public func handleNotificationTap(threadId: String) {
        Task { [weak self] in
            guard let self else { return }
            _ = await self.handleRemoteWake(reason: "notification-tap", timeoutMs: 22_000)
            await MainActor.run {
                if case .connected = self.phase {
                    self.navigationTarget = threadId
                } else {
                    self.pendingDeepLinkThreadId = threadId
                }
            }
        }
    }

    public func answer(_ card: MobileQuestionCard, _ text: String) {
        guard let promptId = card.resolvedId,
            let context = replyContext(
                workspaceId: card.workspaceId, threadId: card.threadId, runId: card.runId)
        else { return }
        let ws = context.workspaceId
        let thread = context.threadId
        repliedQuestionIds.insert(promptId)
        questions.removeAll { $0.resolvedId == promptId }
        send(
            BridgeAction.questionReply(
                questionId: promptId, answer: text, workspaceId: ws, threadId: thread,
                runId: context.runId),
            successLabel: "Answer sent.",
            onAck: { [weak self] accepted in
                guard let self, !accepted else { return }
                self.repliedQuestionIds.remove(promptId)
                if !self.questions.contains(where: { $0.resolvedId == promptId }) {
                    self.questions.insert(card, at: 0)
                }
            })
        scheduleThreadRefresh(thread)
    }

    /// Dismiss a question — the Mac resolves the parked tool as cancelled.
    public func rejectQuestion(_ card: MobileQuestionCard) {
        guard let promptId = card.resolvedId,
            let context = replyContext(
                workspaceId: card.workspaceId, threadId: card.threadId, runId: card.runId)
        else { return }
        let ws = context.workspaceId
        let thread = context.threadId
        repliedQuestionIds.insert(promptId)
        questions.removeAll { $0.resolvedId == promptId }
        send(
            BridgeAction.questionReject(
                promptId: promptId, workspaceId: ws, threadId: thread, runId: context.runId),
            successLabel: "Question dismissed.",
            onAck: { [weak self] accepted in
                guard let self, !accepted else { return }
                self.repliedQuestionIds.remove(promptId)
                if !self.questions.contains(where: { $0.resolvedId == promptId }) {
                    self.questions.insert(card, at: 0)
                }
            })
        scheduleThreadRefresh(thread)
    }

    /// Provider that owns a thread (for a composerPrompt continuation): the task
    /// card is authoritative; fall back to the loaded snapshot, then to claude so
    /// a Codex/Cursor plan re-dispatches on its OWN provider, never silently dead.
    private func providerForThread(_ threadId: String) -> String {
        if let p = taskCards.first(where: { $0.id == threadId })?.provider, !p.isEmpty {
            return p
        }
        if let p = threadSnapshots[threadId]?.provider, !p.isEmpty { return p }
        return "claude"
    }

    /// True once the user has acted on this plan locally (optimistic) — drives the
    /// action row's disabled state until the Mac's status re-projection confirms.
    public func proposedPlanIsReplied(_ messageId: String) -> Bool {
        repliedProposedPlanIds.contains(messageId)
    }

    /// Approve a proposed plan: dispatch the implement run in DEFAULT (file-write)
    /// mode, and mark the plan `approved` ONLY once that run is accepted. Gating
    /// the status flip on the run's ack means a plan-only / global workspace that
    /// DENIES the elevated 'default' run restores the card instead of lying that
    /// it was approved when nothing ran. The Mac re-signs the elevated posture
    /// trust-side (composerPromptFn → signRunPosture); the phone sends no HMAC.
    /// The prompt references "the plan above", so the agent reads the canonical
    /// plan from its own transcript — the phone never round-trips the (possibly
    /// truncated) preview body.
    /// Approve a proposed plan: dispatch the write-capable implement run, naming
    /// the plan it implements (`proposedPlanImplementOf`). A SINGLE leg — the Mac
    /// flips the plan status to 'approved' ATOMICALLY with the dispatch and
    /// rejects the run if the plan is no longer pending. So a second device
    /// tapping Approve in the projection-latency window can't fire a duplicate
    /// write-capable run, and a lost ack can't strand the card 'pending' (the
    /// flip and the run are one Mac op, re-projected back). A read-only /
    /// plan-only / global workspace denies the elevated run upstream
    /// (accepted == false), so we re-enable the card rather than lie it ran.
    public func proposedPlanApprove(threadId: String, messageId: String) {
        guard let ws = remoteScopeForThread(threadId) else { return }
        // Self-defending against a double-fire even though `.disabled(decided)`
        // also gates the button (the Set insert below is synchronous on
        // @MainActor, so the View binding usually flips first).
        guard !repliedProposedPlanIds.contains(messageId) else { return }
        let provider = providerForThread(threadId)
        repliedProposedPlanIds.insert(messageId)
        send(
            BridgeAction.composerPrompt(
                workspaceId: ws, threadId: threadId, provider: provider,
                text: "The plan above is approved — go ahead and implement it now.",
                approvalMode: "default", proposedPlanImplementOf: messageId),
            successLabel: "Plan approved — implementing.",
            onAck: { [weak self] accepted in
                guard let self, !accepted else { return }
                // Denied (read-only workspace) or rejected (already decided on
                // another device) — re-enable; the Mac's status re-projection
                // collapses the card if it was in fact decided elsewhere.
                self.repliedProposedPlanIds.remove(messageId)
            })
        scheduleThreadRefresh(threadId)
    }

    /// Respond to a proposed plan with feedback: send it as a normal turn WITHOUT
    /// approvalMode (stays in plan mode so the agent re-plans) and dismiss the
    /// current plan card once the turn is accepted. Mirrors the desktop
    /// handleProposedPlanCustom (revise, no permission elevation).
    public func proposedPlanRespond(threadId: String, messageId: String, feedback: String) {
        let trimmed = feedback.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let ws = remoteScopeForThread(threadId) else { return }
        guard !repliedProposedPlanIds.contains(messageId) else { return }
        let provider = providerForThread(threadId)
        repliedProposedPlanIds.insert(messageId)
        send(
            BridgeAction.composerPrompt(
                workspaceId: ws, threadId: threadId, provider: provider, text: trimmed),
            successLabel: "Feedback sent.",
            onAck: { [weak self] accepted in
                guard let self else { return }
                if accepted {
                    self.send(
                        BridgeAction.proposedPlanDecision(
                            workspaceId: ws, threadId: threadId, messageId: messageId,
                            decision: "dismissed"))
                } else {
                    self.repliedProposedPlanIds.remove(messageId)
                }
            })
        scheduleThreadRefresh(threadId)
    }

    /// Dismiss a proposed plan with no run — the executor only flips status.
    public func proposedPlanDismiss(threadId: String, messageId: String) {
        guard let ws = remoteScopeForThread(threadId) else { return }
        guard !repliedProposedPlanIds.contains(messageId) else { return }
        repliedProposedPlanIds.insert(messageId)
        send(
            BridgeAction.proposedPlanDecision(
                workspaceId: ws, threadId: threadId, messageId: messageId, decision: "dismissed"),
            successLabel: "Plan dismissed.",
            onAck: { [weak self] accepted in
                guard let self, !accepted else { return }
                self.repliedProposedPlanIds.remove(messageId)
            })
        scheduleThreadRefresh(threadId)
    }

    /// P3 phone Canvas write-actions: close or reload an open preview. No local
    /// optimistic state to roll back — the projection re-broadcast updates the card.
    public func canvasClose(threadId: String, canvasId: String) {
        sendCanvasAction(threadId: threadId, canvasId: canvasId, action: "close")
    }
    public func canvasReload(threadId: String, canvasId: String) {
        sendCanvasAction(threadId: threadId, canvasId: canvasId, action: "reload")
    }
    private func sendCanvasAction(threadId: String, canvasId: String, action: String) {
        guard let ws = remoteScopeForThread(threadId) else { return }
        send(
            BridgeAction.canvasAction(
                workspaceId: ws, threadId: threadId, canvasId: canvasId, action: action),
            successLabel: action == "close" ? "Canvas closed." : "Canvas reloaded.")
        scheduleThreadRefresh(threadId)
    }

    public func cancelRun(_ card: RemoteTaskCard) {
        guard let thread = card.threadId else { return }
        // Global chats carry no workspaceId; present the reserved "global" scope
        // (NOT an empty string) so the Mac's allowlist gate ACCEPTS the cancel.
        let ws = (card.workspaceId ?? "").isEmpty ? "global" : card.workspaceId!
        // Ensemble Stop must cancel the whole ROUND, not just the current
        // participant. A per-run cancel kills one participant's process but never
        // sets runtime.cancelled, so the orchestrator just advances to the next
        // participant (and the continuation loop keeps going) — which is why a
        // single Stop didn't halt the round. cancelRound sets runtime.cancelled
        // AND cancels each participant by its true provider. Desktop parity:
        // handleCancel → cancelEnsembleRound for ensemble chats.
        if card.isEnsemble {
            send(
                BridgeAction.ensembleCancelRound(workspaceId: ws, threadId: thread),
                successLabel: "Round cancelled.")
            return
        }
        // Solo: fall back to the live stream's run id — the throttled `card.runId`
        // lags the un-throttled stream, so an early Stop tap must still target
        // the in-flight run.
        let runId = card.runId ?? streamingRunIds[card.id]
        guard let provider = card.provider, let runId else { return }
        send(
            BridgeAction.cancelRun(
                provider: provider, runId: runId,
                workspaceId: ws, threadId: thread))
    }

    /// Start a NEW task: create the Mac chat first, then send the initial
    /// prompt into the returned thread. The ownership validator rejects prompts
    /// for unknown thread ids, so the old direct `composerPrompt(ios-*)` path
    /// now fails correctly.
    public func startTask(
        workspaceId: String, provider: String, prompt: String, model: String? = nil,
        reasoningEffort: String? = nil,
        imageAttachments: [[String: Any]]? = nil
    ) {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasAttachments = imageAttachments?.isEmpty == false
        guard !trimmed.isEmpty || hasAttachments else { return }
        let title = String(trimmed.prefix(72))
        send(
            BridgeAction.createThread(
                workspaceId: workspaceId, variant: "workspace", provider: provider,
                title: title.isEmpty ? "New Chat" : title),
            timeoutMs: 12_000,
            successLabel: "Chat created.",
            navigateOnAck: false
        ) { [weak self] threadId in
            guard let self, let threadId else { return }
            self.navigationTarget = threadId
            self.rememberThreadWorkspace(threadId, workspaceId: workspaceId)
            self.send(
                BridgeAction.composerPrompt(
                    workspaceId: workspaceId, threadId: threadId, provider: provider,
                    text: trimmed, model: model, reasoningEffort: reasoningEffort,
                    imageAttachments: imageAttachments),
                timeoutMs: 12_000,
                successLabel: "Sent.",
                navigateToThreadId: threadId)
            self.scheduleThreadRefresh(threadId)
        }
    }

    /// Create an empty chat and navigate to its transcript welcome surface.
    /// The first prompt is sent from `ThreadDetailView`, so the phone gets the
    /// same welcome card and full composer as a reopened empty chat.
    public func createEmptyThread(
        workspaceId: String, variant: String = "workspace", provider: String? = nil,
        threadId: String? = nil, title: String = "New Chat", onCreated: ((String?) -> Void)? = nil
    ) {
        if isDemo {
            createDemoThread(
                workspaceId: workspaceId, variant: variant, provider: provider, title: title,
                onCreated: onCreated)
            return
        }
        send(
            BridgeAction.createThread(
                workspaceId: workspaceId, variant: variant, threadId: threadId, provider: provider,
                title: title),
            timeoutMs: 12_000,
            successLabel: "Chat created.",
            navigateOnAck: true,
            onThreadCreated: { [weak self] threadId in
                guard let self, let threadId else {
                    onCreated?(nil)
                    return
                }
                self.rememberThreadWorkspace(threadId, workspaceId: workspaceId)
                self.scheduleThreadRefresh(threadId)
                onCreated?(threadId)
            },
            // A denied/failed create never reaches onThreadCreated (send only
            // fires that when accepted), which left the new-chat canvas spinning
            // on "Creating…" forever — exactly what "can't start a global /
            // ensemble chat" looks like. Surface the failure so the canvas can
            // show the Mac's reason (e.g. ensemble mode disabled, global not
            // shared while the workspace allowlist is empty) and offer Retry.
            onAck: { accepted in
                if !accepted { onCreated?(nil) }
            }
        )
    }

    /// Create an empty ensemble chat, optionally queue the first prompt.
    /// One draft roster entry from the phone's ensemble editor.
    public struct EnsembleDraftParticipant: Sendable {
        public let provider: String
        public let model: String?
        public init(provider: String, model: String?) {
            self.provider = provider
            self.model = model
        }
    }

    public func startEnsemble(
        workspaceId: String, prompt: String,
        participants: [EnsembleDraftParticipant]? = nil
    ) {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let roster: [[String: Any]]? = participants?.map { entry in
            var record: [String: Any] = ["provider": entry.provider]
            if let model = entry.model, !model.isEmpty, model != "cli-default" {
                record["model"] = model
            }
            return record
        }
        send(
            BridgeAction.createThread(
                workspaceId: workspaceId, variant: "ensemble", participants: roster),
            timeoutMs: 12_000,
            successLabel: "Ensemble created."
        ) { [weak self] threadId in
            guard let self, let threadId else { return }
            self.navigationTarget = threadId
            self.rememberThreadWorkspace(threadId, workspaceId: workspaceId)
            self.send(
                BridgeAction.ensembleSteer(
                    workspaceId: workspaceId, threadId: threadId, text: trimmed),
                successLabel: "Round started.")
            self.scheduleThreadRefresh(threadId)
        }
    }

    /// Create an empty global chat via the reserved 'global' scope (the Mac
    /// grants it startTurn once any workspace is allowlisted; phone-origin
    /// turns in it always run plan-mode).
    public func startGlobalChat() {
        send(
            BridgeAction.createThread(workspaceId: "global", variant: "global"),
            timeoutMs: 12_000,
            successLabel: "Global chat created.",
            navigateOnAck: true
        ) { [weak self] threadId in
            guard let self, let threadId else { return }
            self.rememberThreadWorkspace(threadId, workspaceId: "global")
            self.scheduleThreadRefresh(threadId)
        }
    }

    /// Send a follow-up prompt into an existing thread.
    /// `navigateOnAck: false` keeps the shell's selection where it is —
    /// the side-chat mini pane sends must NOT steal the main transcript
    /// (the ack carries the side chat's threadId, which would otherwise
    /// claim navigationTarget and reload the detail pane).
    public func continueTask(
        _ card: RemoteTaskCard, prompt: String, approvalMode: String? = nil,
        model: String? = nil, providerOverride: String? = nil,
        reasoningEffort: String? = nil,
        imageAttachments: [[String: Any]]? = nil,
        extraWorkspaceIds: [String]? = nil,
        navigateOnAck: Bool = true
    ) {
        if isDemo {
            appendDemoTurn(card: card, prompt: prompt)
            return
        }
        guard let thread = card.threadId else { return }
        // Scope-global chats present the reserved 'global' scope; the Mac
        // clamps their turns to plan mode (no file mutation).
        let cardWorkspace = (card.workspaceId ?? "").isEmpty ? nil : card.workspaceId
        let ws = cardWorkspace ?? "global"
        let ensembleRoundId =
            card.isEnsemble ? (ensembleStates[card.id]?.roundId ?? ensembleStates[thread]?.roundId) : nil
        let threadSummaryFingerprints: Set<String> = currentRunSummaryFingerprints(
            threadId: thread, fallbackRunId: card.runId, fallbackEnsembleRoundId: ensembleRoundId)
        let cardSummaryFingerprints: Set<String> =
            card.id != thread
            ? currentRunSummaryFingerprints(
                threadId: card.id, fallbackRunId: card.runId,
                fallbackEnsembleRoundId: ensembleRoundId) : []
        if card.isEnsemble {
            send(
                BridgeAction.ensembleSteer(
                    workspaceId: ws, threadId: thread, text: prompt,
                    imageAttachments: imageAttachments),
                successLabel: "Sent to ensemble.",
                navigateOnAck: navigateOnAck,
                onAck: { [weak self] accepted in
                    guard accepted else { return }
                    self?.hideRunSummaryFingerprintsForNextTurn(
                        threadSummaryFingerprints, threadId: thread)
                    if card.id != thread {
                        self?.hideRunSummaryFingerprintsForNextTurn(
                            cardSummaryFingerprints, threadId: card.id)
                    }
                })
        } else {
            guard let provider = providerOverride ?? card.provider else { return }
            send(
                BridgeAction.composerPrompt(
                    workspaceId: ws, threadId: thread, provider: provider, text: prompt,
                    approvalMode: approvalMode, model: model,
                    extraWorkspaceIds: extraWorkspaceIds,
                    reasoningEffort: reasoningEffort,
                    imageAttachments: imageAttachments),
                timeoutMs: 12_000,
                successLabel: "Sent.",
                navigateOnAck: navigateOnAck,
                onAck: { [weak self] accepted in
                    guard accepted else { return }
                    self?.hideRunSummaryFingerprintsForNextTurn(
                        threadSummaryFingerprints, threadId: thread)
                    if card.id != thread {
                        self?.hideRunSummaryFingerprintsForNextTurn(
                            cardSummaryFingerprints, threadId: card.id)
                    }
                })
        }
        scheduleThreadRefresh(thread)
    }

    private func send(
        _ params: [String: Any], timeoutMs: Int = 16_000, successLabel: String = "Sent.",
        navigateToThreadId: String? = nil,
        navigateOnAck: Bool = true,
        onThreadCreated: ((String?) -> Void)? = nil,
        onAck: ((Bool) -> Void)? = nil,
        onAckResult: ((Bool, AckResult?) -> Void)? = nil
    ) {
        guard !isDemo, let client else { return }
        Task {
            do {
                let ack = try await client.request(
                    "bridge.requestActionAck", params: params, timeoutMs: timeoutMs)
                await MainActor.run {
                    let accepted = Self.actionAckSucceeded(ack)
                    let threadId = accepted ? (Self.threadId(from: ack) ?? navigateToThreadId) : nil
                    if accepted, navigateOnAck, let threadId {
                        self.navigationTarget = threadId
                    }
                    if accepted {
                        onThreadCreated?(threadId)
                    }
                    onAck?(accepted)
                    onAckResult?(accepted, ack)
                    // Connection-aware copy. A request ack can time out even while the
                    // session is fully ESTABLISHED — a momentarily slow Mac, a heavy op
                    // right after connect, or a dropped ack on a live socket. The Mac is
                    // NOT "busy or asleep" then, so the alarming interpretAck/twFriendlyMessage
                    // copy (which re-maps ANY "timed out" string to that banner) is wrong.
                    // While still .connected, surface calm, accurate text with no
                    // "timeout"/"timed out" wording so it isn't re-mapped and the banner
                    // stays a neutral .info instead of a red "asleep" warning.
                    if !ack.ok, ack.error == "timeout", case .connected = self.phase {
                        self.lastActionMessage =
                            "Your Mac is taking longer than usual to respond — it's still connected."
                    } else {
                        self.lastActionMessage = Self.interpretAck(
                            ack, successLabel: successLabel)
                    }
                }
            } catch {
                await MainActor.run {
                    onAck?(false)
                    onAckResult?(false, nil)
                    self.lastActionMessage = String(describing: error)
                }
            }
        }
    }

    /// Outcome of an approval-reply ack, fine-grained enough to avoid the
    /// unbreakable approval-modal loop. The Mac returns `accepted:true,
    /// executed:false` when the approval is no longer pending (auto-deny timer,
    /// the desktop, or another paired surface resolved it). Treating that as a
    /// plain failure and RESTORING the card re-presents a modal that can never
    /// succeed — every re-tap hits the same already-resolved approval. So we
    /// distinguish "already resolved" (evict) from "policy rejected" (keep
    /// dismissed) from a "transport error" (genuinely retryable → restore).
    enum ApprovalAckOutcome {
        case succeeded
        case alreadyResolved
        case rejected
        case dispatchFailed
        case transportError
    }

    private static func approvalAckOutcome(_ ack: AckResult?) -> ApprovalAckOutcome {
        guard let ack, ack.ok else { return .transportError }
        guard let data = ack.result,
            let actionAck = try? JSONDecoder().decode(BridgeActionAck.self, from: data)
        else { return .succeeded }
        if actionAck.accepted == false { return .rejected }
        if actionAck.executed == false {
            if actionAck.reasonCode == "approvalDispatchFailed"
                || actionAck.message?.localizedCaseInsensitiveContains("Approval dispatch failed")
                    == true
            {
                return .dispatchFailed
            }
            return .alreadyResolved
        }
        return .succeeded
    }

    private static func actionAckSucceeded(_ ack: AckResult) -> Bool {
        guard ack.ok else { return false }
        guard let data = ack.result,
            let actionAck = try? JSONDecoder().decode(BridgeActionAck.self, from: data)
        else { return true }
        if actionAck.accepted == false { return false }
        if actionAck.executed == false { return false }
        return true
    }

    private static func threadId(from ack: AckResult) -> String? {
        guard let data = ack.result else { return nil }
        if let threadId = nestedThreadId(from: data) { return threadId }
        if let actionAck = try? JSONDecoder().decode(BridgeActionAck.self, from: data) {
            if let threadId = actionAck.data?.threadId { return threadId }
            if let threadId = actionAck.threadId { return threadId }
        }
        struct Loose: Codable { let threadId: String? }
        if let loose = try? JSONDecoder().decode(Loose.self, from: data) {
            return loose.threadId
        }
        return nil
    }

    private static func nestedThreadId(from data: Data) -> String? {
        guard
            let object = try? JSONSerialization.jsonObject(
                with: data, options: [.fragmentsAllowed]) as? [String: Any],
            let dataObject = object["data"] as? [String: Any]
        else { return nil }
        if dataObject["actionKind"] as? String == "createSideChat",
            let result = dataObject["result"] as? [String: Any],
            let threadId = result["threadId"] as? String,
            !threadId.isEmpty
        {
            return threadId
        }
        if let threadId = dataObject["threadId"] as? String, !threadId.isEmpty {
            return threadId
        }
        return nil
    }

    private static func interpretAck(_ ack: AckResult, successLabel: String) -> String {
        if !ack.ok {
            if ack.error == "timeout" {
                return
                    "Timed out waiting for your Mac — is TaskWraith running and paired?"
            }
            return ack.error ?? "Action denied."
        }
        if let data = ack.result,
            let actionAck = try? JSONDecoder().decode(BridgeActionAck.self, from: data)
        {
            if actionAck.accepted == false {
                return actionAck.message ?? "Denied by Mac policy."
            }
            if actionAck.executed == false {
                return actionAck.message ?? "Accepted — wiring not complete on Mac."
            }
            if let message = actionAck.message,
                !message.isEmpty,
                message != "Dispatching on your Mac.",
                message != "Chat created on your Mac."
            {
                return message
            }
        }
        return successLabel
    }
}
