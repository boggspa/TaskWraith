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

// ── Paired-Mac persistence ──────────────────────────────────────────────────
// After the first QR pairing the phone remembers WHO it paired with so app
// relaunches and Mac restarts reconnect silently via the relay's resolve
// directory (the Mac pins this phone's identity and accepts without a
// prompt). This is PUBLIC material only — the Mac's identity public key,
// relay URL, display name; the phone's private identity seed stays in the
// Keychain via IdentitySeedStore.

public struct PairedMacRecord: Codable, Sendable, Equatable {
    public let relayUrl: String
    /// Ordered relay candidates captured at pairing time (LAN first, wss
    /// front door second). Optional so records persisted before T70 still
    /// decode; reconnect falls back to the single `relayUrl`.
    public let relayUrls: [String]?
    public let macIdentityPubKey: String
    public let macDisplayName: String

    public init(
        relayUrl: String, macIdentityPubKey: String, macDisplayName: String,
        relayUrls: [String]? = nil
    ) {
        self.relayUrl = relayUrl
        self.relayUrls = relayUrls
        self.macIdentityPubKey = macIdentityPubKey
        self.macDisplayName = macDisplayName
    }
}

public protocol PairedMacStore: Sendable {
    func load() -> PairedMacRecord?
    func save(_ record: PairedMacRecord)
    func clear()
}

public struct UserDefaultsPairedMacStore: PairedMacStore {
    private let key = "taskwraith.pairedMac.v1"
    public init() {}
    public func load() -> PairedMacRecord? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(PairedMacRecord.self, from: data)
    }
    public func save(_ record: PairedMacRecord) {
        if let data = try? JSONEncoder().encode(record) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }
    public func clear() { UserDefaults.standard.removeObject(forKey: key) }
}

@MainActor
public final class RemoteSessionModel: ObservableObject {
    @Published public private(set) var phase: SessionPhase = .idle
    @Published public private(set) var macDisplayName: String = ""
    @Published public private(set) var taskCards: [RemoteTaskCard] = []
    @Published public private(set) var approvals: [MobileApprovalCard] = []
    @Published public private(set) var questions: [MobileQuestionCard] = []
    /// Allowlist-visible workspaces (the compose surface). Empty until the Mac
    /// has at least one entry in Settings → Devices → workspace access.
    @Published public private(set) var workspaces: [WorkspaceSummary] = []
    /// Latest thread snapshot per taskId/threadId (drives the detail view).
    @Published public private(set) var threadSnapshots: [String: RemoteThreadSnapshot] = [:]
    /// Per-provider model catalogs (same source as the desktop picker) —
    /// arrives shortly after establish; empty until then.
    @Published public private(set) var providerModels: [String: [ModelOption]] = [:]
    /// Token totals for the heatmap chips (24h/7d/90d, per provider).
    @Published public private(set) var usageRollup: UsageRollupMessage.Rollup? = nil
    /// Per-provider quota windows (Usage tab; desktop sidebar parity).
    @Published public private(set) var modelUsage: ModelUsageMessage.Usage? = nil
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
    @Published public private(set) var lastActionMessage: String?
    /// Set after createThread succeeds — HomeView navigates to the new chat.
    @Published public var navigationTarget: String?
    /// Expanded row bodies keyed by threadId → rowId.
    @Published public private(set) var rowExpansions: [String: [String: RemoteThreadSnapshot.Row]] =
        [:]
    @Published public private(set) var expandingRows: Set<String> = []
    @Published public private(set) var loadingPreviousThreadRows: Set<String> = []

    /// True when a previous pairing is on disk — drives the "Reconnect to
    /// your Mac" affordance and launch-time auto-resume.
    @Published public private(set) var hasStoredPairing: Bool
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

    public func handleRemoteWake(reason _: String) async -> Bool {
        guard hasStoredPairing else { return false }
        switch phase {
        case .connected:
            if let client {
                let attempt = connectAttempt
                let alive = await client.checkSocketAlive()
                guard connectAttempt == attempt else {
                    return await waitForRemoteWakeConnection(timeoutMs: 10_000)
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
        return await waitForRemoteWakeConnection(timeoutMs: 10_000)
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
        #if !DEBUG && !TASKWRAITH_ENABLE_APNS_REGISTRATION
            return
        #else
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
        #endif
    }
    /// Side-chat child that should open inside the inspector instead of
    /// replacing the split-view detail pane.
    @Published public var inspectorSideChatTarget: String?
    @Published public var fileModeRequest: FileModeRequest?
    @Published public var diffModeRequest: DiffModeRequest?

    private var identitySeed: Data
    private let identityStore: IdentitySeedStore
    private let pairingStore: PairedMacStore
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
        pairingStore: PairedMacStore = UserDefaultsPairedMacStore()
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
        let stored = pairingStore.load()
        self.hasStoredPairing = stored != nil
        if let stored { self.macDisplayName = stored.macDisplayName }
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
        macDisplayName = bootstrap.macDisplayName
        pinnedMacIdentityB64 = bootstrap.macIdentityPubKey
        lastRelayUrls = bootstrap.relayUrls
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
        guard let record = pairingStore.load() else { return }
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
        macDisplayName = record.macDisplayName
        pinnedMacIdentityB64 = record.macIdentityPubKey
        lastRelayUrls = record.relayUrls
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
    }

    /// Drop the stored pairing entirely (the Mac keeps its pin until the user
    /// revokes it there; re-pairing with the same identity reuses it).
    public func forgetPairing() {
        pairingStore.clear()
        hasStoredPairing = false
        pinnedMacIdentityB64 = nil
        relayUrl = nil
        macDisplayName = ""
        disconnect()
        // Security review: "Forget this Mac" must leave NOTHING readable —
        // disconnect() clears the live lists, but cached snapshots,
        // streaming buffers, and usage panels survived it.
        threadSnapshots = [:]
        streamingTexts = [:]
        streamingSegments = [:]
        streamingRunIds = [:]
        streamingProviders = [:]
        streamingItemIds = [:]
        providerModels = [:]
        projectionHydrated = false
        usageRollup = nil
        modelUsage = nil
        gitSnapshots = [:]
        navigationTarget = nil
        visibleThreadId = nil
        pendingApnsToken = nil
        apnsTokenRegistrationInFlight = false
        apnsTokenRetryTask?.cancel()
        apnsTokenRetryTask = nil
        lastActionMessage = nil
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
        guard let relayUrl, let macId = pinnedMacIdentityB64 else { return }
        pairingStore.save(
            PairedMacRecord(
                relayUrl: relayUrl, macIdentityPubKey: macId, macDisplayName: macDisplayName,
                // The full candidate set from the bootstrap (LAN + wss) —
                // ONE pairing then reconnects from home Wi-Fi or cellular
                // alike; `relayUrl` holds the door that last worked.
                relayUrls: lastRelayUrls))
        hasStoredPairing = true
    }

    private func consumeEvents(of client: RelayTransportClient) {
        eventTask = Task { [weak self] in
            for await event in client.events {
                guard let self else { return }
                switch event {
                case .confirmCode(let code):
                    await MainActor.run { self.phase = .awaitingMacConfirm(code: code) }
                case .established:
                    await MainActor.run {
                        self.cancelAutoReconnect(resetAttempts: true)
                        self.phase = .connected
                        self.wasEverConnected = true
                        self.persistCurrentPairing()
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
                        if case .connected = self.phase { self.lastActionMessage = message }
                        else { self.phase = .error(message) }
                    }
                case .closed:
                    await MainActor.run { self.handleSocketClosed() }
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
            // Snapshot re-pull stays as the consistency backstop.
            let fast = wire.channel == "agent-output" || wire.channel == "agent-exit"
            scheduleThreadRefresh(threadId, debounceMs: fast ? 200_000_000 : 450_000_000)
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
        default:
            break
        }
    }

    private func mergeThreadSnapshot(_ incoming: RemoteThreadSnapshot, key: String) {
        guard let current = threadSnapshots[key] else {
            threadSnapshots[key] = incoming
            return
        }

        let incomingRows = incoming.rows ?? []
        let currentRows = current.rows ?? []
        if incomingRows.isEmpty {
            return
        }
        guard !currentRows.isEmpty else {
            threadSnapshots[key] = mergedSnapshot(
                base: incoming, fallback: current, rows: incomingRows,
                windowStartIndex: windowStart(for: incoming),
                totalRows: bestTotalRows(incoming, current))
            return
        }

        let incomingStart = windowStart(for: incoming)
        let currentStart = windowStart(for: current)
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
        let totalRows = bestTotalRows(incoming, current)
        threadSnapshots[key] = mergedSnapshot(
            base: incoming, fallback: current, rows: rows, windowStartIndex: start,
            totalRows: totalRows)
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
            runSummary: base.runSummary ?? fallback.runSummary,
            notes: base.notes ?? fallback.notes,
            pinnedRows: base.pinnedRows ?? fallback.pinnedRows,
            blackboardEntries: base.blackboardEntries ?? fallback.blackboardEntries,
            runSummaries: base.runSummaries ?? fallback.runSummaries,
            windowStartIndex: windowStartIndex,
            hasMoreAbove: windowStartIndex > 0,
            hasMoreBelow: hasMoreBelow)
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

    private func mergeQuestionCard(_ card: MobileQuestionCard) {
        guard let id = card.resolvedId else { return }
        if let status = card.status, status != "pending" {
            questions.removeAll { $0.resolvedId == id }
            return
        }
        if let index = questions.firstIndex(where: { $0.resolvedId == id }) {
            questions[index] = card
        } else {
            questions.insert(card, at: 0)
        }
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
        let ack = try await requestFileAction(
            BridgeAction.workspaceFileList(
                workspaceId: workspaceId, path: path, query: query, limit: limit))
        return (ack.data?.entries ?? [], ack.data?.truncated ?? false)
    }

    public func readWorkspaceFile(
        workspaceId: String, path: String
    ) async throws -> WorkspaceFileReadResult {
        let ack = try await requestFileAction(
            BridgeAction.workspaceFileRead(workspaceId: workspaceId, path: path))
        guard let file = ack.data?.file else { throw RemoteFileActionError.malformedAck }
        return file
    }

    public func writeWorkspaceFile(
        workspaceId: String, path: String, content: String, baseEtag: String
    ) async throws -> WorkspaceFileReadResult {
        let ack = try await requestFileAction(
            BridgeAction.workspaceFileWrite(
                workspaceId: workspaceId, path: path, content: content, baseEtag: baseEtag),
            timeoutMs: 16_000)
        guard let file = ack.data?.file else { throw RemoteFileActionError.malformedAck }
        return file
    }

    /// Bounded workspace diff for the Diff Studio — the Mac runs the same
    /// git surface the desktop Diff Studio uses and returns it in the ack.
    public func fetchWorkspaceDiff(workspaceId: String) async throws -> WorkspaceDiffResult {
        let ack = try await requestFileAction(
            BridgeAction.workspaceDiff(workspaceId: workspaceId), timeoutMs: 16_000)
        guard let diff = ack.data?.diff else { throw RemoteFileActionError.malformedAck }
        return diff
    }

    // ── Git workflows — the Mac's GitService is the single authority; every
    //    mutation is an explicit phone UI action, never agent-initiated. ────

    public func fetchGitSnapshot(workspaceId: String) async throws -> GitWorkspaceSnapshot {
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
        public init(
            id: String, provider: String, model: String?, role: String,
            brief: String, enabled: Bool
        ) {
            self.id = id
            self.provider = provider
            self.model = model
            self.role = role
            self.brief = brief
            self.enabled = enabled
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
            return dict
        }
        send(
            BridgeAction.ensembleRosterUpdate(
                workspaceId: workspaceId, threadId: threadId, participants: participants),
            successLabel: "Roster updated.")
        scheduleThreadRefresh(threadId)
    }

    /// The current guest participant child of a thread, if any.
    public func guestParticipant(of threadId: String) -> RemoteTaskCard? {
        taskCards.first { $0.parentChatId == threadId && $0.isGuestSideChat }
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
        for envelope in snapshot.projections {
            switch envelope.kind {
            case "taskCard":
                if let card = envelope.decodePayload(RemoteTaskCard.self) { tasks.append(card) }
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
        // Real content ends the first-connect "Syncing…" state immediately;
        // an empty settling snapshot does NOT (the grace timer or the Mac's
        // delayed re-seed resolves it instead).
        if !tasks.isEmpty { projectionHydrated = true }
        approvals = approvalCards
        questions = questionCards
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
        let ws =
            workspaceId
            ?? threadId.flatMap { thread in
                taskCards.first(where: { $0.id == thread })?.workspaceId
            }
            ?? workspaces.first?.id
        guard let ws else { return nil }
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
        send(
            BridgeAction.approvalReply(
                toolCallId: toolCallId, decision: decision, workspaceId: ws, threadId: thread),
            successLabel: label)
        scheduleThreadRefresh(thread)
    }

    public func answer(_ card: MobileQuestionCard, _ text: String) {
        guard let promptId = card.resolvedId,
            let context = replyContext(
                workspaceId: card.workspaceId, threadId: card.threadId, runId: card.runId)
        else { return }
        let ws = context.workspaceId
        let thread = context.threadId
        send(
            BridgeAction.questionReply(
                questionId: promptId, answer: text, workspaceId: ws, threadId: thread,
                runId: context.runId),
            successLabel: "Answer sent.")
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
        send(
            BridgeAction.questionReject(
                promptId: promptId, workspaceId: ws, threadId: thread, runId: context.runId),
            successLabel: "Question dismissed.")
        scheduleThreadRefresh(thread)
    }

    public func cancelRun(_ card: RemoteTaskCard) {
        // Fall back to the live stream's run id — the throttled `card.runId`
        // lags the un-throttled stream, so an early Stop tap must still target
        // the in-flight run. Global chats have no workspaceId; the Mac targets a
        // run by id (ownership is checked against chat.runs, not the workspace),
        // so send an empty workspace rather than dropping the cancel entirely.
        let runId = card.runId ?? streamingRunIds[card.id]
        guard let provider = card.provider, let runId, let thread = card.threadId else { return }
        send(
            BridgeAction.cancelRun(
                provider: provider, runId: runId,
                workspaceId: card.workspaceId ?? "", threadId: thread))
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
        send(
            BridgeAction.createThread(
                workspaceId: workspaceId, variant: variant, threadId: threadId, provider: provider,
                title: title),
            timeoutMs: 12_000,
            successLabel: "Chat created.",
            navigateOnAck: true
        ) { [weak self] threadId in
            guard let self, let threadId else {
                onCreated?(nil)
                return
            }
            self.rememberThreadWorkspace(threadId, workspaceId: workspaceId)
            self.scheduleThreadRefresh(threadId)
            onCreated?(threadId)
        }
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
        guard let thread = card.threadId else { return }
        // Scope-global chats present the reserved 'global' scope; the Mac
        // clamps their turns to plan mode (no file mutation).
        let cardWorkspace = (card.workspaceId ?? "").isEmpty ? nil : card.workspaceId
        let ws = cardWorkspace ?? "global"
        if card.isEnsemble {
            send(
                BridgeAction.ensembleSteer(
                    workspaceId: ws, threadId: thread, text: prompt,
                    imageAttachments: imageAttachments),
                successLabel: "Sent to ensemble.",
                navigateOnAck: navigateOnAck)
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
                navigateOnAck: navigateOnAck)
        }
        scheduleThreadRefresh(thread)
    }

    private func send(
        _ params: [String: Any], timeoutMs: Int = 12_000, successLabel: String = "Sent.",
        navigateToThreadId: String? = nil,
        navigateOnAck: Bool = true,
        onThreadCreated: ((String?) -> Void)? = nil,
        onAck: ((Bool) -> Void)? = nil
    ) {
        guard let client else { return }
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
                    self.lastActionMessage = Self.interpretAck(
                        ack, successLabel: successLabel)
                }
            } catch {
                await MainActor.run {
                    onAck?(false)
                    self.lastActionMessage = String(describing: error)
                }
            }
        }
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
