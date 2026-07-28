import Foundation
import AppKit
import CoreGraphics
import Darwin
// See main.swift for rationale — ScreenCaptureKit is pre-Swift-6, our
// flow doesn't actually race on its types, `@preconcurrency` downgrades
// the strict-mode complaints to warnings.
@preconcurrency import ScreenCaptureKit

// MARK: - Consent and owner identity

/// Whether the metadata came from the picker filter itself or from the
/// macOS 14/15.0–15.1 geometric fallback. The fallback is presentation-only:
/// this daemon deliberately exposes no AX/input actuation authority.
enum AttachedWindowIdentityQuality: String, Sendable {
    case exact
    case bestEffort
}

/// Canonical selected-window bounds in ScreenCaptureKit's global point
/// coordinate space. Preserve fractional values and negative origins instead
/// of rounding them into a renderer-specific coordinate system.
struct AttachedWindowBounds: Sendable, Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    init(frame: CGRect) {
        self.init(
            x: Double(frame.origin.x),
            y: Double(frame.origin.y),
            width: Double(frame.size.width),
            height: Double(frame.size.height)
        )
    }

    static let zero = AttachedWindowBounds(x: 0, y: 0, width: 0, height: 0)

    func toJSONObject() -> [String: Any] {
        return [
            "x": x,
            "y": y,
            "width": width,
            "height": height
        ]
    }
}

/// A PID alone can be reused after a process exits. The launch-time component
/// makes this a process-instance receipt instead of an accidental authority
/// over a later process that inherited the PID. AppKit provides the preferred
/// receipt for LaunchServices apps; `proc_bsdinfo` covers helper processes.
struct ProcessIdentityReceipt: Codable, Sendable, Equatable, Hashable {
    enum Source: String, Codable, Sendable, Hashable {
        case nsRunningApplication
        case procBSDInfo
    }

    let pid: Int
    let launchTimeMicros: Int64
    let source: Source

    init(pid: Int, launchTimeMicros: Int64, source: Source) {
        self.pid = pid
        self.launchTimeMicros = launchTimeMicros
        self.source = source
    }

    static func resolve(pid: Int) -> ProcessIdentityReceipt? {
        // `proc_bsdinfo` gives us a process-start timestamp for ordinary app
        // processes and non-LaunchServices helpers alike. Using one source
        // consistently also makes the canonical processStartedAt binding
        // stable across every revalidation call.
        return resolve(pid: pid, source: .procBSDInfo)
    }

    func matchesLiveProcess() -> Bool {
        guard let live = ProcessIdentityReceipt.resolve(pid: pid, source: source) else {
            return false
        }
        return live.launchTimeMicros == launchTimeMicros
    }

    /// Stable, order-independent token for Electron/main to bind as an opaque
    /// process-start identity. Keep this separate from JSON object rendering:
    /// object-key ordering must never become an authority decision.
    var processStartedAt: String {
        return "\(source.rawValue):\(launchTimeMicros)"
    }

    static func currentProcessGroupID(pid: Int) -> Int? {
        guard pid > 0 else { return nil }
        let group = getpgid(pid_t(pid))
        return group > 0 ? Int(group) : nil
    }

    func toJSONObject() -> [String: Any] {
        return [
            "pid": pid,
            "launchTimeMicros": launchTimeMicros,
            "source": source.rawValue,
            "processStartedAt": processStartedAt
        ]
    }

    private static func resolve(pid: Int, source: Source) -> ProcessIdentityReceipt? {
        guard pid > 0 else { return nil }
        switch source {
        case .nsRunningApplication:
            // Kept as a receipt vocabulary value for forward compatibility;
            // this daemon currently uses proc_bsdinfo because it covers both
            // LaunchServices applications and Electron helper processes.
            return nil
        case .procBSDInfo:
            var info = proc_bsdinfo()
            let expectedSize = Int32(MemoryLayout<proc_bsdinfo>.size)
            let written = proc_pidinfo(
                pid_t(pid),
                PROC_PIDTBSDINFO,
                0,
                &info,
                expectedSize
            )
            guard written == expectedSize,
                  Int(info.pbi_pid) == pid,
                  info.pbi_start_tvsec > 0 else {
                return nil
            }
            let micros = Int64(info.pbi_start_tvsec) * 1_000_000
                + Int64(info.pbi_start_tvusec)
            return ProcessIdentityReceipt(
                pid: pid,
                launchTimeMicros: micros,
                source: .procBSDInfo
            )
        }
    }

}

/// Per-window metadata returned to Electron after a successful pick.
///
/// On macOS 15.2 and later, `SCContentFilter.includedWindows` lets us bind
/// this metadata to the selected filter exactly. Earlier systems do not expose
/// that API, so the metadata is explicitly best-effort and must never be used
/// as an authority for window input/actuation.
struct AttachedWindowMeta: Sendable {
    let windowID: CGWindowID
    let title: String
    let bundleID: String
    let applicationName: String
    let pid: Int
    let identityQuality: AttachedWindowIdentityQuality
    let processIdentity: ProcessIdentityReceipt?
    let pgid: Int?
    let bounds: AttachedWindowBounds

    init(
        windowID: CGWindowID,
        title: String,
        bundleID: String,
        applicationName: String,
        pid: Int,
        identityQuality: AttachedWindowIdentityQuality = .bestEffort,
        processIdentity: ProcessIdentityReceipt? = nil,
        pgid: Int? = nil,
        bounds: AttachedWindowBounds = .zero
    ) {
        self.windowID = windowID
        self.title = title
        self.bundleID = bundleID
        self.applicationName = applicationName
        self.pid = pid
        self.identityQuality = identityQuality
        self.processIdentity = processIdentity
        self.pgid = pgid
        self.bounds = bounds
    }

    func toJSONObject() -> [String: Any] {
        var json: [String: Any] = [
            "windowID": Int(windowID),
            "title": title,
            "bundleID": bundleID,
            "applicationName": applicationName,
            "pid": pid,
            "identityQuality": identityQuality.rawValue,
            "pgid": pgid ?? NSNull(),
            "bounds": bounds.toJSONObject(),
            // Capturing a selected window is not permission to control it.
            "actuationAuthority": "none"
        ]
        if let processIdentity {
            json["processIdentity"] = processIdentity.toJSONObject()
            json["processStartedAt"] = processIdentity.processStartedAt
        }
        return json
    }
}

/// A main-process-issued consent binding. The daemon treats all three fields
/// as opaque identity data: an agent cannot move an attachment from one chat
/// or consent epoch to another by guessing its handle.
struct AttachedWindowScope: Sendable, Equatable {
    let scopeID: String
    let chatID: String
    let consentEpoch: Int

    func validate() throws {
        guard !scopeID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw AttachmentParameterError.invalidScope("scopeID must not be empty")
        }
        guard !chatID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw AttachmentParameterError.invalidScope("chatID must not be empty")
        }
        guard consentEpoch >= 0 else {
            throw AttachmentParameterError.invalidScope("consentEpoch must be zero or greater")
        }
    }

    func toJSONObject() -> [String: Any] {
        return [
            "scopeID": scopeID,
            "chatID": chatID,
            "consentEpoch": consentEpoch
        ]
    }
}

/// Electron's feasible protected-host input. Main already knows its host main,
/// renderer, and helper PIDs plus any current host window IDs, but it does not
/// need to construct a process-start receipt. The daemon resolves those PIDs
/// immediately and retains the exact receipt internally.
struct ProtectedWindowOwners: Decodable, Sendable, Equatable {
    let pids: [Int]
    let windowIDs: [Int]

    init(pids: [Int], windowIDs: [Int] = []) {
        self.pids = pids
        self.windowIDs = windowIDs
    }

    func resolve() throws -> ResolvedProtectedWindowOwners {
        let normalPids = Array(Set(pids)).sorted()
        let normalProcesses = try normalPids.map { pid -> ProcessIdentityReceipt in
            guard let identity = ProcessIdentityReceipt.resolve(pid: pid) else {
                throw AttachmentParameterError.invalidProtectedOwners(
                    "protected PID \(pid) could not be resolved exactly"
                )
            }
            return identity
        }.sorted { lhs, rhs in
            if lhs.pid != rhs.pid { return lhs.pid < rhs.pid }
            if lhs.launchTimeMicros != rhs.launchTimeMicros {
                return lhs.launchTimeMicros < rhs.launchTimeMicros
            }
            return lhs.source.rawValue < rhs.source.rawValue
        }
        let normalWindowIDs = Array(Set(windowIDs)).sorted()

        guard !normalPids.isEmpty else {
            throw AttachmentParameterError.invalidProtectedOwners(
                "protectedOwners must contain at least one protected PID"
            )
        }
        guard normalPids.allSatisfy({ $0 > 0 }) else {
            throw AttachmentParameterError.invalidProtectedOwners("pids must be positive")
        }
        guard normalWindowIDs.allSatisfy({ $0 > 0 }) else {
            throw AttachmentParameterError.invalidProtectedOwners("windowIDs must be positive")
        }
        guard normalProcesses.allSatisfy({
            $0.pid > 0 && $0.launchTimeMicros > 0 && $0.matchesLiveProcess()
        }) else {
            throw AttachmentParameterError.invalidProtectedOwners(
                "a protected process identity could not be resolved exactly"
            )
        }
        return ResolvedProtectedWindowOwners(
            processes: normalProcesses,
            windowIDs: normalWindowIDs
        )
    }
}

/// Daemon-only protected-host policy. It has exact process-instance receipts,
/// never a bundle-wide exclusion, so a separately launched TaskWraith child
/// remains a selectable self-QA target.
struct ResolvedProtectedWindowOwners: Sendable, Equatable {
    let processes: [ProcessIdentityReceipt]
    let windowIDs: [Int]

    /// The main process supplied PIDs, not opaque receipts. Once resolved,
    /// they remain a safety boundary for the lifetime of this lease: if any
    /// declared protected process is replaced or exits, we cannot prove the
    /// original exclusion set still means what the user saw. Fail closed.
    var hasLiveExactProcessIdentities: Bool {
        return processes.allSatisfy { $0.matchesLiveProcess() }
    }

    func matches(_ meta: AttachedWindowMeta) -> Bool {
        if windowIDs.contains(Int(meta.windowID)) {
            return true
        }
        guard let identity = meta.processIdentity else {
            // If a selected window claims a protected PID but cannot produce a
            // launch receipt, do not guess that PID reuse is harmless.
            return processes.contains { $0.pid == meta.pid }
        }
        return processes.contains(identity)
    }

    /// Resolve exact protected-process receipts to current window IDs before
    /// the picker appears. `SCContentSharingPickerConfiguration` cannot
    /// exclude a PID directly, and excluding a shared bundle ID would wrongly
    /// hide separately launched TaskWraith self-QA children.
    func pickerExclusions() async throws -> PickerExclusions {
        guard hasLiveExactProcessIdentities else {
            throw AttachmentParameterError.invalidProtectedOwners(
                "a protected process identity no longer resolves exactly"
            )
        }
        var excludedWindowIDs = Set(windowIDs)
        let content = try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: true
        )
        for window in content.windows {
            guard let application = window.owningApplication,
                  let identity = ProcessIdentityReceipt.resolve(
                    pid: Int(application.processID)
                  ),
                  processes.contains(identity) else {
                continue
            }
            excludedWindowIDs.insert(Int(window.windowID))
        }
        return PickerExclusions(
            windowIDs: Array(excludedWindowIDs).sorted()
        )
    }
}

struct PickerExclusions: Sendable, Equatable {
    let windowIDs: [Int]
}

enum AttachmentParameterError: LocalizedError, Sendable, Equatable {
    case invalidScope(String)
    case invalidProtectedOwners(String)

    var errorDescription: String? {
        switch self {
        case .invalidScope(let message), .invalidProtectedOwners(let message):
            return message
        }
    }
}

/// Errors that are intentionally distinguishable by the JSON-RPC surface.
/// A denied request used the wrong authority or selected protected host UI;
/// a revoked request was valid once but lost its generation/consent lease.
enum AttachmentAuthorizationError: LocalizedError, Sendable, Equatable {
    case denied(String)
    case revoked(String)

    var errorDescription: String? {
        switch self {
        case .denied(let message), .revoked(let message):
            return message
        }
    }
}

/// The complete access key required for every operation against an existing
/// attachment. It intentionally contains both the opaque handle and the
/// caller's main-issued scope/generation so a global handle cannot cross chat
/// boundaries.
struct AttachedWindowAccess: Sendable, Equatable {
    let handleID: String
    let scope: AttachedWindowScope
    let generation: Int

    func validate() throws {
        guard !handleID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw AttachmentParameterError.invalidScope("handleID must not be empty")
        }
        try scope.validate()
        guard generation > 0 else {
            throw AttachmentParameterError.invalidScope("generation must be greater than zero")
        }
    }
}

/// Immutable snapshot of an attachment permission. The `SCContentFilter` is
/// the actual ScreenCaptureKit grant; it is deliberately not serialised and is
/// held only in memory. `@unchecked Sendable` is limited to the framework
/// object, which ScreenCaptureKit has not annotated for Swift 6.
struct AttachedWindowLease: @unchecked Sendable {
    let handleID: String
    let scope: AttachedWindowScope
    let generation: Int
    let meta: AttachedWindowMeta
    let protectedOwners: ResolvedProtectedWindowOwners
    let filter: SCContentFilter?
    let createdAt: Date

    var access: AttachedWindowAccess {
        return AttachedWindowAccess(
            handleID: handleID,
            scope: scope,
            generation: generation
        )
    }
}

/// Safe actor-crossing snapshot used by the RPC handlers. It never exposes
/// the mutable store entry; the optional stream is itself an actor.
struct AuthorizedAttachment: @unchecked Sendable {
    let lease: AttachedWindowLease
    let stream: AttachedWindowStream?
}

private final class AttachedWindowEntry: @unchecked Sendable {
    let lease: AttachedWindowLease
    var stream: AttachedWindowStream?

    init(lease: AttachedWindowLease) {
        self.lease = lease
    }
}

/// One in-memory, revocable attachment. There is intentionally no table of
/// historical handles: selecting a new window first revokes the prior lease,
/// stops its stream, then publishes one new generation.
actor AttachedWindowStore {
    private var active: AttachedWindowEntry?
    private var activePickerScope: AttachedWindowScope?
    private var lastGeneration = 0
    /// EOF is terminal for this daemon. A picker continuation can complete
    /// after its UI is cancelled, so keep an explicit terminal bit instead of
    /// allowing that late continuation to publish a fresh lease during
    /// shutdown.
    private var isShuttingDown = false

    func beginPicker(scope: AttachedWindowScope) throws {
        try scope.validate()
        guard !isShuttingDown else {
            throw AttachmentAuthorizationError.revoked(
                "Attached-window daemon is shutting down."
            )
        }
        guard activePickerScope == nil else {
            throw AttachmentAuthorizationError.denied(
                "Another attached-window consent picker is already active."
            )
        }
        activePickerScope = scope
    }

    func finishPicker(scope: AttachedWindowScope) {
        if activePickerScope == scope {
            activePickerScope = nil
        }
    }

    /// Publish one new lease only after the old one has been made unusable and
    /// its stream stopped. Clearing `active` before `await stream.stop()` is
    /// important: captures that finish while replacement is in progress fail
    /// their generation recheck instead of returning old pixels.
    func attachReplacingCurrent(
        meta: AttachedWindowMeta,
        filter: SCContentFilter?,
        scope: AttachedWindowScope,
        protectedOwners: ResolvedProtectedWindowOwners
    ) async throws -> AttachedWindowLease {
        try scope.validate()
        guard !isShuttingDown else {
            throw AttachmentAuthorizationError.revoked(
                "Attached-window daemon is shutting down."
            )
        }
        guard protectedOwners.hasLiveExactProcessIdentities else {
            throw AttachmentAuthorizationError.denied(
                "A protected host process identity changed before attachment could be granted."
            )
        }
        if filter != nil,
           !(meta.processIdentity?.matchesLiveProcess() ?? false) {
            throw AttachmentAuthorizationError.denied(
                "The selected window's owner process identity could not be resolved exactly."
            )
        }
        guard !protectedOwners.matches(meta) else {
            throw AttachmentAuthorizationError.denied(
                "The selected window belongs to the protected TaskWraith host."
            )
        }

        let previous = active
        active = nil
        if let stream = previous?.stream {
            await stream.stop()
        }
        // `await stream.stop()` makes this actor reentrant. EOF may have set
        // the terminal bit while the prior stream was draining, so check again
        // immediately before publishing the replacement lease.
        guard !isShuttingDown else {
            throw AttachmentAuthorizationError.revoked(
                "Attached-window daemon is shutting down."
            )
        }

        let lease = AttachedWindowLease(
            handleID: UUID().uuidString.lowercased(),
            scope: scope,
            generation: nextGeneration(),
            meta: meta,
            protectedOwners: protectedOwners,
            filter: filter,
            createdAt: Date()
        )
        active = AttachedWindowEntry(lease: lease)
        return lease
    }

    /// Test seam for the pure lifecycle state machine. Production attachment
    /// always supplies the picker-derived `SCContentFilter`; `nil` is rejected
    /// by capture/start before any ScreenCaptureKit call can be made.
    func _attachForTesting(
        meta: AttachedWindowMeta,
        scope: AttachedWindowScope,
        protectedOwners: ResolvedProtectedWindowOwners
    ) async throws -> AttachedWindowLease {
        return try await attachReplacingCurrent(
            meta: meta,
            filter: nil,
            scope: scope,
            protectedOwners: protectedOwners
        )
    }

    func authorize(_ access: AttachedWindowAccess) async throws -> AuthorizedAttachment {
        let entry = try await entry(for: access)
        return AuthorizedAttachment(lease: entry.lease, stream: entry.stream)
    }

    /// Reserve the entry's single Appwatch actor before an async stream start.
    /// `confirmStreamStarted` must still run after `start` because detach or a
    /// replacement could revoke this lease while ScreenCaptureKit is awaiting.
    func prepareStream(_ access: AttachedWindowAccess) async throws -> AuthorizedAttachment {
        let entry = try await entry(for: access)
        if entry.stream == nil {
            entry.stream = AttachedWindowStream()
        }
        return AuthorizedAttachment(lease: entry.lease, stream: entry.stream)
    }

    func confirmStreamStarted(_ stream: AttachedWindowStream, for lease: AttachedWindowLease) async throws {
        let entry = try await entry(for: lease.access)
        guard entry.stream === stream else {
            await stream.stop()
            throw AttachmentAuthorizationError.revoked(
                "Attached-window stream was replaced before it finished starting."
            )
        }
    }

    func clearStream(_ stream: AttachedWindowStream, for lease: AttachedWindowLease) async throws {
        let entry = try await entry(for: lease.access)
        guard entry.stream === stream else {
            throw AttachmentAuthorizationError.revoked(
                "Attached-window stream was replaced or detached."
            )
        }
        entry.stream = nil
    }

    func discardStream(_ stream: AttachedWindowStream, for lease: AttachedWindowLease) async {
        guard let entry = active,
              entry.lease.handleID == lease.handleID,
              entry.lease.generation == lease.generation,
              entry.stream === stream else {
            await stream.stop()
            return
        }
        entry.stream = nil
        await stream.stop()
    }

    func revalidate(_ lease: AttachedWindowLease) async throws {
        _ = try await entry(for: lease.access)
    }

    @discardableResult
    func detach(_ access: AttachedWindowAccess) async throws -> Bool {
        let entry = try await entry(for: access)
        active = nil
        if let stream = entry.stream {
            await stream.stop()
        }
        return true
    }

    /// Server-side revocation for a window that ScreenCaptureKit says has
    /// disappeared. It cannot be invoked by a caller with only a handle.
    func revokeIfCurrent(_ lease: AttachedWindowLease) async {
        guard let entry = active,
              entry.lease.handleID == lease.handleID,
              entry.lease.generation == lease.generation else {
            return
        }
        active = nil
        if let stream = entry.stream {
            await stream.stop()
        }
    }

    func detachAll() async {
        let entry = active
        active = nil
        activePickerScope = nil
        if let stream = entry?.stream {
            await stream.stop()
        }
    }

    /// Terminal teardown used only when the daemon loses its stdin parent or
    /// its AppKit run loop exits. This is deliberately stronger than
    /// `detachAll()`: no picker result may establish a new lease afterwards.
    func shutdown() async {
        isShuttingDown = true
        await detachAll()
    }

    func count() -> Int {
        return active == nil ? 0 : 1
    }

    func _setStreamForTesting(_ stream: AttachedWindowStream, for lease: AttachedWindowLease) async throws {
        let entry = try await entry(for: lease.access)
        if let previous = entry.stream, previous !== stream {
            await previous.stop()
        }
        entry.stream = stream
    }

    private func entry(for access: AttachedWindowAccess) async throws -> AttachedWindowEntry {
        try access.validate()
        guard let entry = active else {
            throw AttachmentAuthorizationError.revoked(
                "Attached-window consent has been revoked or has not been granted."
            )
        }

        let lease = entry.lease
        guard lease.scope.scopeID == access.scope.scopeID,
              lease.scope.chatID == access.scope.chatID else {
            throw AttachmentAuthorizationError.denied(
                "This attached window belongs to a different consent scope."
            )
        }
        guard lease.scope.consentEpoch == access.scope.consentEpoch,
              lease.generation == access.generation,
              lease.handleID == access.handleID else {
            throw AttachmentAuthorizationError.revoked(
                "Attached-window consent was replaced, detached, or expired."
            )
        }

        // A PID can be reused after an app exits. Re-resolve the exact launch
        // receipt on every scoped RPC before returning screenshot or stream
        // data. Test-only entries have no real ScreenCaptureKit filter and are
        // intentionally exempt from this production boundary.
        if lease.filter != nil,
           !(lease.meta.processIdentity?.matchesLiveProcess() ?? false) {
            throw AttachmentAuthorizationError.revoked(
                "The attached window's owner process identity changed or exited."
            )
        }

        // Picker exclusions are the first line of defense. Recheck both the
        // exact supplied protected PIDs and the selected owner before every
        // RPC: if the host receipt changed, fail closed rather than assuming
        // the stale picker exclusion remains safe.
        if !lease.protectedOwners.hasLiveExactProcessIdentities {
            throw AttachmentAuthorizationError.denied(
                "A protected host process identity changed; attached-window access is no longer safe."
            )
        }
        if lease.protectedOwners.matches(lease.meta) {
            throw AttachmentAuthorizationError.denied(
                "The attached window matches the protected TaskWraith host."
            )
        }
        return entry
    }

    private func nextGeneration() -> Int {
        if lastGeneration == Int.max {
            // A process-local handle table cannot plausibly exhaust this, but
            // keep a positive generation even in a synthetic stress test.
            lastGeneration = 1
        } else {
            lastGeneration += 1
        }
        return lastGeneration
    }
}

// MARK: - Picker

enum AttachedWindowError: LocalizedError {
    case cancelled
    case noWindowSelected
    case protectedWindowSelected
    case windowGone
    case pickerFailed(String)
    case pngEncodingFailed

    var errorDescription: String? {
        switch self {
        case .cancelled:
            return "Window pick was cancelled."
        case .noWindowSelected:
            return "Pick must select a single window."
        case .protectedWindowSelected:
            return "The selected window belongs to the protected TaskWraith host."
        case .windowGone:
            return "Attached window is no longer available (likely closed)."
        case .pickerFailed(let reason):
            return "Window picker failed: \(reason)"
        case .pngEncodingFailed:
            return "Failed to encode captured frame as PNG."
        }
    }
}

/// Presents `SCContentSharingPicker` on the main thread and produces a single
/// `AttachedWindowMeta` + the picker's `SCContentFilter`. The picker is the
/// security boundary: Apple decides what windows are shown, the user clicks
/// one, and we receive a filter we can immediately use for capture.
final class AttachedWindowPicker: NSObject, @unchecked Sendable, SCContentSharingPickerObserver {
    typealias Completion = (Result<(meta: AttachedWindowMeta, filter: SCContentFilter), AttachedWindowError>) -> Void

    @MainActor private static weak var activePicker: AttachedWindowPicker?

    private let stateLock = NSLock()
    private var completion: Completion?
    private var fired = false
    private var protectedOwners: ResolvedProtectedWindowOwners?

    /// Present the picker. Must be invoked from the main thread because
    /// `SCContentSharingPicker.present` shows UI. The store separately guards
    /// this path so only one request can reach the singleton picker at once.
    @MainActor
    func pick(
        exclusions: PickerExclusions,
        protectedOwners: ResolvedProtectedWindowOwners,
        completion: @escaping Completion
    ) {
        stateLock.lock()
        self.completion = completion
        self.protectedOwners = protectedOwners
        stateLock.unlock()

        let picker = SCContentSharingPicker.shared
        var config = SCContentSharingPickerConfiguration()
        config.allowedPickerModes = [.singleWindow]
        // Do not blanket-exclude a bundle: the host and a separately launched
        // TaskWraith child can share one. Only current windows belonging to
        // the main-process-supplied protected process receipts are hidden.
        config.excludedBundleIDs = []
        config.excludedWindowIDs = exclusions.windowIDs
        config.allowsChangingSelectedContent = true
        picker.defaultConfiguration = config
        picker.maximumStreamCount = 1
        picker.add(self)
        Self.activePicker = self
        picker.isActive = true
        picker.present()
    }

    /// EOF and parent teardown use this to release a pending picker
    /// continuation before the daemon drains its handler queue.
    @MainActor
    static func cancelActivePicker() {
        activePicker?.finish(.failure(.cancelled))
    }

    private func finish(_ result: Result<(meta: AttachedWindowMeta, filter: SCContentFilter), AttachedWindowError>) {
        stateLock.lock()
        if fired {
            stateLock.unlock()
            return
        }
        fired = true
        let cb = completion
        completion = nil
        protectedOwners = nil
        stateLock.unlock()

        // Deactivate the picker on main — SCContentSharingPicker.shared is
        // a singleton owned by the WindowServer-connected app context, and
        // toggling `isActive` from a background queue is unsupported.
        Task { @MainActor in
            let picker = SCContentSharingPicker.shared
            picker.isActive = false
            picker.remove(self)
            if Self.activePicker === self {
                Self.activePicker = nil
            }
        }
        cb?(result)
    }

    // MARK: SCContentSharingPickerObserver

    // The protocol declares these as nonisolated. Apple delivers them on the
    // main queue today, but we don't lean on that — the lock + atomic-fire
    // guard inside `finish` keeps state safe regardless.
    func contentSharingPicker(
        _ picker: SCContentSharingPicker,
        didUpdateWith filter: SCContentFilter,
        for stream: SCStream?
    ) {
        let policy: ResolvedProtectedWindowOwners?
        stateLock.lock()
        policy = protectedOwners
        stateLock.unlock()

        Task { [filter, policy] in
            do {
                let meta = try await AttachedWindowMetaResolver.resolve(filter: filter)
                guard let policy, !policy.matches(meta) else {
                    throw AttachedWindowError.protectedWindowSelected
                }
                finish(.success((meta, filter)))
            } catch let err as AttachedWindowError {
                finish(.failure(err))
            } catch {
                finish(.failure(.pickerFailed(error.localizedDescription)))
            }
        }
    }

    func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
        finish(.failure(.cancelled))
    }

    func contentSharingPickerStartDidFailWithError(_ error: any Error) {
        finish(.failure(.pickerFailed(error.localizedDescription)))
    }
}

// MARK: - Metadata resolution

/// Resolves a picker-produced `SCContentFilter` back to a concrete `SCWindow`
/// so the renderer can render title / bundle id / application name. Newer
/// macOS exposes the exact selected `includedWindows`; old macOS cannot, so it
/// gets deliberately labelled best-effort rather than presenting a heuristic
/// as an authority-bearing identity.
enum AttachedWindowMetaResolver {
    static func resolve(filter: SCContentFilter) async throws -> AttachedWindowMeta {
        if #available(macOS 15.2, *) {
            let windows = filter.includedWindows
            guard windows.count == 1, let window = windows.first else {
                throw AttachedWindowError.noWindowSelected
            }
            return try meta(from: window, identityQuality: .exact)
        }

        let content = try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: true
        )
        guard let window = bestMatch(for: filter, in: content.windows) else {
            // Filter doesn't correlate to any visible window — the most
            // likely cause is that the user closed it between picking and
            // our enumeration. Surface as "gone" so the renderer sees a
            // clean reset rather than a partial attach.
            throw AttachedWindowError.windowGone
        }
        return try meta(from: window, identityQuality: .bestEffort)
    }

    private static func meta(
        from window: SCWindow,
        identityQuality: AttachedWindowIdentityQuality
    ) throws -> AttachedWindowMeta {
        let pid = Int(window.owningApplication?.processID ?? 0)
        guard let processIdentity = ProcessIdentityReceipt.resolve(pid: pid) else {
            throw AttachedWindowError.pickerFailed(
                "selected window owner process identity could not be resolved"
            )
        }
        return AttachedWindowMeta(
            windowID: window.windowID,
            title: window.title ?? "",
            bundleID: window.owningApplication?.bundleIdentifier ?? "",
            applicationName: window.owningApplication?.applicationName ?? "",
            pid: pid,
            identityQuality: identityQuality,
            processIdentity: processIdentity,
            pgid: ProcessIdentityReceipt.currentProcessGroupID(pid: pid),
            bounds: AttachedWindowBounds(frame: window.frame)
        )
    }

    /// Best-effort correlation for macOS 14/15.0–15.1. `filter.contentRect`
    /// is in pixel coordinates (relative to captured content), while
    /// `window.frame` is in points. We project frame dimensions into pixels
    /// and choose the unique near match. This is never used for actuation.
    private static func bestMatch(for filter: SCContentFilter, in windows: [SCWindow]) -> SCWindow? {
        let filterRect = filter.contentRect
        let scale = max(0.0001, Double(filter.pointPixelScale))

        var bestWindow: SCWindow?
        var bestScore = Double.infinity
        for window in windows {
            let frame = window.frame
            let pixelWidth = Double(frame.size.width) * scale
            let pixelHeight = Double(frame.size.height) * scale

            let widthDelta = abs(pixelWidth - Double(filterRect.size.width))
            let heightDelta = abs(pixelHeight - Double(filterRect.size.height))
            let score = widthDelta + heightDelta
            if score < bestScore {
                bestScore = score
                bestWindow = window
            }
        }

        // Tolerate up to ~4 px slop on each axis (combined). Beyond that we
        // probably don't have the right window — better to surface as "gone"
        // than to silently describe the wrong one.
        return bestScore < 8 ? bestWindow : nil
    }
}

// MARK: - One-shot capture

/// One-shot window capture. Uses the picker-derived `SCContentFilter`
/// directly — no re-enumeration, no window-id lookup, so capture survives
/// even when the user moves or resizes the window between snapshots.
struct CapturedWindowFrame: @unchecked Sendable {
    let pngData: Data
    let width: Int
    let height: Int
}

enum AttachedWindowCapture {
    static func captureWindow(
        filter: SCContentFilter,
        maxDimensionPx: Int
    ) async throws -> CapturedWindowFrame {
        let filterRect = filter.contentRect
        let baseWidth = max(1.0, Double(filterRect.size.width))
        let baseHeight = max(1.0, Double(filterRect.size.height))
        let longest = max(baseWidth, baseHeight)
        let cap = max(1, maxDimensionPx)
        let scale = min(1.0, Double(cap) / longest)
        let targetWidth = max(1, Int((baseWidth * scale).rounded()))
        let targetHeight = max(1, Int((baseHeight * scale).rounded()))

        let config = SCStreamConfiguration()
        config.width = targetWidth
        config.height = targetHeight
        config.scalesToFit = true
        config.showsCursor = false
        config.capturesAudio = false

        let cgImage: CGImage
        do {
            cgImage = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: config
            )
        } catch {
            // ScreenCaptureKit raises when the target window has gone away.
            // Surface as a structured "window gone" so the JSON-RPC layer
            // can self-heal (clear the handle) and the renderer pill clears.
            throw AttachedWindowError.windowGone
        }

        let bitmap = NSBitmapImageRep(cgImage: cgImage)
        guard let png = bitmap.representation(using: .png, properties: [:]) else {
            throw AttachedWindowError.pngEncodingFailed
        }
        return CapturedWindowFrame(
            pngData: png,
            width: cgImage.width,
            height: cgImage.height
        )
    }
}
