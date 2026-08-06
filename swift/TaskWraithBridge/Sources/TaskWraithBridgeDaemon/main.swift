import Foundation
import AppKit
import CryptoKit
// ScreenCaptureKit predates Swift 6 strict concurrency — `SCContentFilter`
// isn't `Sendable` in the SDK, but the filter we pass between the picker
// and the capture pipeline is only ever used in a fire-once, single-task
// flow (no cross-thread mutation), so `@preconcurrency` downgrades the
// strict-mode complaints to warnings without papering over real races.
@preconcurrency import ScreenCaptureKit

// Background-only daemon. `.accessory` keeps the process out of the Dock
// and Cmd+Tab list; it still has the window-server connection it needs to
// host `SCContentSharingPicker` on demand. Set as early as possible so launch
// does not briefly look like a second TaskWraith app to non-dev testers.
NSApplication.shared.setActivationPolicy(.accessory)

/// TaskWraithBridgeDaemon — self-contained stdio JSON-RPC helper.
///
/// The daemon now owns only the local macOS surfaces that do not require the
/// removed remote-iOS transport layer: Screen Watch / Appwatch, creative-app
/// dispatch, editor opening, Finder reveal, and process status/ping.

// MARK: - TaskWraith product preset

private let daemonDisplayName = "TaskWraith"
private let bonjourServiceType = "_taskwraith._tcp"
private let bonjourQUICServiceType = "_taskwraith-quic._udp"
private let quicALPN = "taskwraith-live-v1"

// MARK: - Lifetime + helpers

let startupTime = Date()
let protocolVersion = "0.1.0-stdio-local"

/// Single serialized stdout sink shared by hello, the dispatcher's responses,
/// and any future notification writers. Constructed early because the
/// daemon-hello announcement should go through it too.
let stdoutWriter = BridgeStdoutWriter()

func writeLine(_ line: String) {
    stdoutWriter.writeLine(line)
}

// MARK: - Proof-of-life announcement

struct DaemonHello: Encodable {
    let kind: String
    let daemon: String
    let protocolVersion: String
    let displayName: String
    let bonjourServiceType: String
    let bonjourQUICServiceType: String
    let quicALPN: String
    let remoteTransportEnabled: Bool
    let pid: Int32
    let timestamp: String
}

let hello = DaemonHello(
    kind: "daemon-hello",
    daemon: "TaskWraithBridgeDaemon",
    protocolVersion: protocolVersion,
    displayName: daemonDisplayName,
    bonjourServiceType: bonjourServiceType,
    bonjourQUICServiceType: bonjourQUICServiceType,
    quicALPN: quicALPN,
    remoteTransportEnabled: false,
    pid: ProcessInfo.processInfo.processIdentifier,
    timestamp: ISO8601DateFormatter().string(from: Date())
)

let encoder = JSONEncoder()
encoder.outputFormatting = .sortedKeys
if let helloData = try? encoder.encode(hello),
   let helloLine = String(data: helloData, encoding: .utf8) {
    // One line, newline-terminated — matches the JSON-RPC framing pattern
    // CodexAppServerClient already uses, so the Electron-side reader can
    // be a straight line-reader (no custom framing).
    writeLine(helloLine)
}

/// Re-encode a `Codable` Swift value as a Foundation tree (Dictionary / Array
/// / scalars) so it's compatible with `JSONSerialization` and therefore with
/// the JSON-RPC response builder. The dispatcher accepts `Any`-typed
/// JSONSerialization-shaped values; this bridges Codable types into that
/// shape without hand-writing serialization for every result struct.
func encodeAsJSONObject<T: Encodable>(_ value: T) throws -> Any {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.dataEncodingStrategy = .base64
    let data = try encoder.encode(value)
    return try JSONSerialization.jsonObject(with: data)
}

/// Decode a JSON-RPC params blob (a Foundation tree) into a typed Decodable.
func decodeParams<T: Decodable>(_ params: Any, as type: T.Type) throws -> T {
    let data = try JSONSerialization.data(withJSONObject: params)
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    decoder.dataDecodingStrategy = .base64
    return try decoder.decode(type, from: data)
}

/// Block until an async value resolves. The dispatcher's handler signature is
/// synchronous (`(Any) throws -> Any`), while ScreenCaptureKit/Appwatch state
/// is actor-backed and async. Bridge via DispatchSemaphore from the handler
/// queue without blocking AppKit's main runloop.
func runBlocking<T: Sendable>(_ operation: @Sendable @escaping () async throws -> T) throws -> T {
    let semaphore = DispatchSemaphore(value: 0)
    var result: Result<T, Error>!
    Task.detached {
        do {
            let value = try await operation()
            result = .success(value)
        } catch {
            result = .failure(error)
        }
        semaphore.signal()
    }
    semaphore.wait()
    return try result.get()
}

/// Variant of `runBlocking` for work that must run on the main actor — used
/// by the `attachedWindow.requestPick` handler because `SCContentSharingPicker`
/// must be presented from the main thread. The handler runs on the daemon's
/// concurrent handler queue (off main), so we hop onto the main actor via a
/// Task isolated to it; the main runloop (`NSApp.run()`) services it.
func runBlockingOnMain<T: Sendable>(
    _ operation: @MainActor @Sendable @escaping () async throws -> T
) throws -> T {
    let semaphore = DispatchSemaphore(value: 0)
    var result: Result<T, Error>!
    Task.detached {
        do {
            let value = try await operation()
            result = .success(value)
        } catch {
            result = .failure(error)
        }
        semaphore.signal()
    }
    semaphore.wait()
    return try result.get()
}

// MARK: - JSON-RPC dispatcher

let dispatcher = JSONRPCDispatcher()

/// `bridge.ping` — keep-alive heartbeat. Returns `{ "pong": true }`. Useful
/// for end-to-end round-trip tests and for the Electron client to verify the
/// daemon is responsive after a long idle period.
dispatcher.register("bridge.ping") { _ in
    return ["pong": true]
}

/// `bridge.status` — diagnostic snapshot of the daemon process state.
dispatcher.register("bridge.status") { _ in
    let uptimeSeconds = Int(Date().timeIntervalSince(startupTime))
    return [
        "daemon": "TaskWraithBridgeDaemon",
        "protocolVersion": protocolVersion,
        "pid": Int(ProcessInfo.processInfo.processIdentifier),
        "uptimeSeconds": uptimeSeconds,
        "startupTime": ISO8601DateFormatter().string(from: startupTime),
        "remoteTransportEnabled": false,
        "screenWatchEnabled": true,
        "creativeAppsEnabled": true,
        "editorOpenEnabled": true
    ]
}

/// `runAnalyst.analyze` — optional local run analysis through Apple
/// Foundation Models. The method is availability-gated inside
/// `RunAnalyst`; hosts without the framework return a structured JSON-RPC
/// unavailable error that Electron converts into a graceful fallback.
dispatcher.register("runAnalyst.analyze") { params in
    return try RunAnalyst.analyze(params)
}

/// `closeout.summarize` — optional on-device close-out prose for a finished
/// run or ensemble round, through Apple Foundation Models. Same availability
/// gating as `runAnalyst.analyze`; Electron falls back to its deterministic
/// close-out text when this returns a bridge-unavailable error.
dispatcher.register("closeout.summarize") { params in
    return try CloseoutSummarizer.summarize(params)
}

/// `continuation.propose` — bounded on-device ranking for composer prefill.
/// The request carries host-owned round enums and opaque candidate IDs only;
/// there is no transcript or telemetry on this control-plane route.
dispatcher.register("continuation.propose") { params in
    return try ContinuationProposer.propose(params)
}

// MARK: - Attached window RPCs (scoped consent leases)

let attachedWindowStore = AttachedWindowStore()

// Request-pick is the one lifecycle method without an existing generation.
// It receives new human consent scope data and returns the generation created.
struct AttachedWindowRequestPickParams: Decodable {
    let scopeID: String
    let chatID: String
    let consentEpoch: Int
    let protectedOwners: ProtectedWindowOwners

    var scope: AttachedWindowScope {
        return AttachedWindowScope(
            scopeID: scopeID,
            chatID: chatID,
            consentEpoch: consentEpoch
        )
    }
}

// This flat wire shape is required by every existing-attachment RPC. There is
// no bare-handle compatibility path because it would reintroduce a global
// attachment authority across chats.
struct AttachedWindowAccessParams: Decodable {
    let handleID: String
    let scopeID: String
    let chatID: String
    let consentEpoch: Int
    let generation: Int

    var access: AttachedWindowAccess {
        return AttachedWindowAccess(
            handleID: handleID,
            scope: AttachedWindowScope(
                scopeID: scopeID,
                chatID: chatID,
                consentEpoch: consentEpoch
            ),
            generation: generation
        )
    }
}

func scopedAttachmentFields(_ lease: AttachedWindowLease) -> [String: Any] {
    var fields = lease.scope.toJSONObject()
    fields["handleID"] = lease.handleID
    fields["generation"] = lease.generation
    return fields
}

func scopedRequestFields(_ access: AttachedWindowAccess) -> [String: Any] {
    var fields = access.scope.toJSONObject()
    fields["handleID"] = access.handleID
    fields["generation"] = access.generation
    return fields
}

func mapAttachmentError(_ error: Error) -> JSONRPCError {
    if let error = error as? AttachmentAuthorizationError {
        switch error {
        case .denied:
            return JSONRPCError.attachmentDenied(error.localizedDescription)
        case .revoked:
            return JSONRPCError.attachmentRevoked(error.localizedDescription)
        }
    }
    if let error = error as? AttachmentParameterError {
        return JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: error.localizedDescription
        )
    }
    return JSONRPCError(
        code: JSONRPCErrorCode.internalError,
        message: error.localizedDescription
    )
}

func requestDictionary(_ params: Any, method: String) throws -> [String: Any] {
    guard let dict = params as? [String: Any] else {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "\(method) expects an object params payload."
        )
    }
    return dict
}

func decodeScopedAccess(_ params: Any, method: String) throws -> AttachedWindowAccess {
    do {
        let parsed = try decodeParams(params, as: AttachedWindowAccessParams.self)
        try parsed.access.validate()
        return parsed.access
    } catch let error as JSONRPCError {
        throw error
    } catch {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "Invalid \(method) params: \(error.localizedDescription)"
        )
    }
}

func resolveAuthorizedAttachment(_ access: AttachedWindowAccess) throws -> AuthorizedAttachment {
    do {
        return try runBlocking { @Sendable [attachedWindowStore, access] in
            try await attachedWindowStore.authorize(access)
        }
    } catch {
        throw mapAttachmentError(error)
    }
}

func prepareAuthorizedAppwatch(_ access: AttachedWindowAccess) throws -> AuthorizedAttachment {
    do {
        return try runBlocking { @Sendable [attachedWindowStore, access] in
            try await attachedWindowStore.prepareStream(access)
        }
    } catch {
        throw mapAttachmentError(error)
    }
}

func revalidateAttachment(_ lease: AttachedWindowLease) throws {
    do {
        try runBlocking { @Sendable [attachedWindowStore, lease] in
            try await attachedWindowStore.revalidate(lease)
        }
    } catch {
        throw mapAttachmentError(error)
    }
}

func captureFilter(for lease: AttachedWindowLease) throws -> SCContentFilter {
    guard let filter = lease.filter else {
        throw JSONRPCError(
            code: JSONRPCErrorCode.internalError,
            message: "Attached-window capture filter is unavailable."
        )
    }
    return filter
}

// MARK: - Native window RPC state

struct NativeWindowAdoptParams: Decodable {
    let scoped: AttachedWindowAccessParams
    let protectedHostPIDs: [Int]

    var access: AttachedWindowAccess { scoped.access }

    private enum CodingKeys: String, CodingKey {
        case protectedHostPIDs
    }

    init(from decoder: Decoder) throws {
        scoped = try AttachedWindowAccessParams(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        protectedHostPIDs = try container.decode([Int].self, forKey: .protectedHostPIDs)
    }
}

struct NativeWindowObservedElementParams: Decodable {
    let scoped: AttachedWindowAccessParams
    let observationID: String
    let inputEpoch: UInt64
    let ref: String

    var access: AttachedWindowAccess { scoped.access }

    private enum CodingKeys: String, CodingKey {
        case observationID = "observationId"
        case inputEpoch
        case ref
    }

    init(from decoder: Decoder) throws {
        scoped = try AttachedWindowAccessParams(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        observationID = try container.decode(String.self, forKey: .observationID)
        inputEpoch = try container.decode(UInt64.self, forKey: .inputEpoch)
        ref = try container.decode(String.self, forKey: .ref)
    }
}

struct NativeWindowFillParams: Decodable {
    let element: NativeWindowObservedElementParams
    let value: String

    var access: AttachedWindowAccess { element.access }

    private enum CodingKeys: String, CodingKey {
        case value
    }

    init(from decoder: Decoder) throws {
        element = try NativeWindowObservedElementParams(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        value = try container.decode(String.self, forKey: .value)
    }
}

struct NativeWindowCaptureParams: Decodable {
    let scoped: AttachedWindowAccessParams
    let maxDimensionPx: Int?

    var access: AttachedWindowAccess { scoped.access }

    private enum CodingKeys: String, CodingKey {
        case maxDimensionPx
    }

    init(from decoder: Decoder) throws {
        scoped = try AttachedWindowAccessParams(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        maxDimensionPx = try container.decodeIfPresent(Int.self, forKey: .maxDimensionPx)
    }
}

/// Main uses this narrow daemon-local endpoint immediately after spawning a
/// process, before it decides whether later IPC may address that process. It
/// is deliberately not a general process inspector: one positive PID in,
/// one proc_bsdinfo-backed birth receipt out.
struct NativeWindowProcessIdentityParams: Decodable {
    let pid: Int
}

/// Ancestry is asked as a closed question — "does this PID descend from that
/// one" — so a caller can never walk the machine's process tree with it.
struct NativeWindowProcessAncestryParams: Decodable {
    let pid: Int
    let ancestorPid: Int
    let maxDepth: Int
}

final class NativeWindowRPCSession: @unchecked Sendable {
    struct Active {
        let access: AttachedWindowAccess
        let target: WindowAccessibilityTargetIdentity
        let adapter: WindowAccessibilityAdapter
    }

    private let lock = NSLock()
    private let permissionAdapter: WindowAccessibilityAdapter
    private var active: Active?

    init(permissionAdapter: WindowAccessibilityAdapter = WindowAccessibilityAdapter()) {
        self.permissionAdapter = permissionAdapter
    }

    func serialized<T>(_ operation: (inout Active?) throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try operation(&active)
    }

    func permissionStatus(prompt: Bool) -> WindowAccessibilityPermissionState {
        serialized { active in
            let adapter = active?.adapter ?? permissionAdapter
            return prompt ? adapter.requestUserPrompt() : adapter.status()
        }
    }

    func clearActive(_ active: inout Active?) {
        guard let current = active else { return }
        _ = current.adapter.release(target: current.target)
        current.adapter.invalidateAllSnapshots()
        active = nil
    }

    func clear() {
        serialized { active in
            clearActive(&active)
        }
    }
}

let nativeWindowRPCSession = NativeWindowRPCSession()

/// A screenshot is only releasable when two complete, content-free AX safety
/// walks agree around the asynchronous ScreenCaptureKit call. Keeping this as
/// a small pure-ish seam lets regression tests prove that a refused safety
/// check never invokes the capture executor.
func validateNativeWindowCaptureSafety(
    beforeCapture: WindowAccessibilityCaptureSafetyReceipt,
    afterCapture: WindowAccessibilityCaptureSafetyReceipt
) throws -> WindowAccessibilityCaptureSafetyReceipt {
    guard beforeCapture.safe, afterCapture.safe else {
        throw WindowAccessibilityFailure(
            code: .secureFieldStatusUnknown,
            message: "AppDrive capture safety could not be verified after frame acquisition."
        )
    }
    guard beforeCapture.target == afterCapture.target else {
        throw WindowAccessibilityFailure(
            code: .windowIdentityMismatch,
            message: "The selected window identity changed during native capture; the frame was discarded."
        )
    }
    guard beforeCapture.inputEpoch == afterCapture.inputEpoch else {
        throw WindowAccessibilityFailure(
            code: .staleInputEpoch,
            message: "The user interacted with the Mac during native capture; the frame was discarded."
        )
    }
    guard
        beforeCapture.nodesExamined == afterCapture.nodesExamined,
        beforeCapture.validationFingerprint == afterCapture.validationFingerprint
    else {
        throw WindowAccessibilityFailure(
            code: .elementChanged,
            message: "The selected window changed during native capture; the frame was discarded."
        )
    }
    return afterCapture
}

func performNativeWindowCapture(
    adapter: WindowAccessibilityAdapter,
    target: WindowAccessibilityTargetIdentity,
    captureExecutor: () throws -> CapturedWindowFrame,
    revalidateLease: () throws -> Void
) throws -> (safety: WindowAccessibilityCaptureSafetyReceipt, frame: CapturedWindowFrame) {
    // Keep the preflight immediately adjacent to ScreenCaptureKit work. The
    // active native-window session serializes attachment revocation while AX
    // mutations/capture are in flight.
    let beforeCapture = try adapter.capture(target: target)
    let frame = try captureExecutor()
    let afterCapture = try adapter.capture(
        target: target,
        expectedInputEpoch: beforeCapture.inputEpoch
    )
    let safety = try validateNativeWindowCaptureSafety(
        beforeCapture: beforeCapture,
        afterCapture: afterCapture
    )
    try revalidateLease()
    return (safety: safety, frame: frame)
}

/// All attachment revocations that can occur outside a native-window RPC are
/// funneled through the same lock as AX mutations. That makes the lease held
/// by `requireActiveNativeWindow` stable through the irreversible AXPress and
/// AXValue calls, rather than relying on a best-effort recheck beforehand.
func revokeAttachedWindowLease(_ lease: AttachedWindowLease) {
    nativeWindowRPCSession.serialized { active in
        try? runBlocking { @Sendable [attachedWindowStore, lease] in
            await attachedWindowStore.revokeIfCurrent(lease)
        }
        if active?.access == lease.access {
            nativeWindowRPCSession.clearActive(&active)
        }
    }
}

func shutdownAttachedWindowRuntime() {
    nativeWindowRPCSession.serialized { active in
        try? runBlocking { @Sendable [attachedWindowStore] in
            await attachedWindowStore.shutdown()
        }
        nativeWindowRPCSession.clearActive(&active)
    }
}

func decodeNativeWindowParams<T: Decodable>(
    _ params: Any,
    as type: T.Type,
    method: String
) throws -> T {
    do {
        return try decodeParams(params, as: type)
    } catch {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "Invalid \(method) params."
        )
    }
}

func validateNativeWindowAccess(
    _ access: AttachedWindowAccess,
    method: String
) throws -> AttachedWindowAccess {
    do {
        try access.validate()
        return access
    } catch {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "Invalid \(method) scoped attachment access."
        )
    }
}

func deriveNativeWindowTarget(
    from lease: AttachedWindowLease
) throws -> WindowAccessibilityTargetIdentity {
    let meta = lease.meta
    guard meta.identityQuality == .exact else {
        throw JSONRPCError.attachmentDenied(
            "Native control requires exact picker window identity."
        )
    }
    guard
        let processIdentity = meta.processIdentity,
        processIdentity.source == .procBSDInfo,
        processIdentity.pid == meta.pid,
        processIdentity.launchTimeMicros > 0,
        let pid = Int32(exactly: meta.pid),
        pid > 1,
        meta.windowID > 0
    else {
        throw JSONRPCError.attachmentDenied(
            "Native control requires exact process-start and window identity."
        )
    }
    let bundleID = meta.bundleID.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !bundleID.isEmpty, bundleID == meta.bundleID else {
        throw JSONRPCError.attachmentDenied(
            "Native control requires a canonical application bundle identity."
        )
    }
    let bounds = meta.bounds
    guard
        bounds.x.isFinite,
        bounds.y.isFinite,
        bounds.width.isFinite,
        bounds.height.isFinite,
        bounds.width > 0,
        bounds.height > 0
    else {
        throw JSONRPCError.attachmentDenied(
            "Native control requires exact finite picker bounds."
        )
    }
    return WindowAccessibilityTargetIdentity(
        pid: pid,
        windowID: UInt32(meta.windowID),
        bundleID: bundleID,
        processLaunchTimeMicros: processIdentity.launchTimeMicros,
        expectedBounds: WindowAccessibilityRect(
            CGRect(
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height
            )
        )
    )
}

func nativeWindowProtectedPIDs(_ supplied: [Int]) throws -> Set<Int32> {
    guard !supplied.isEmpty else {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "nativeWindow.adopt requires non-empty protectedHostPIDs."
        )
    }
    var protected = Set<Int32>()
    for rawPID in supplied {
        guard let pid = Int32(exactly: rawPID), pid > 0 else {
            throw JSONRPCError(
                code: JSONRPCErrorCode.invalidParams,
                message: "protectedHostPIDs must contain positive process identifiers."
            )
        }
        protected.insert(pid)
    }
    protected.insert(ProcessInfo.processInfo.processIdentifier)
    return protected
}

func nativeWindowProcessIdentityResponse(pid: Int) throws -> [String: Any] {
    guard let checkedPID = Int32(exactly: pid), checkedPID > 0 else {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "nativeWindow.processIdentity requires a positive PID."
        )
    }
    let normalizedPID = Int(checkedPID)
    guard
        let receipt = ProcessIdentityReceipt.resolve(pid: normalizedPID),
        receipt.source == .procBSDInfo,
        receipt.pid == normalizedPID,
        receipt.launchTimeMicros > 0,
        receipt.matchesLiveProcess()
    else {
        throw JSONRPCError(
            code: JSONRPCErrorCode.bridgeUnavailable,
            message: "Requested process identity is unavailable."
        )
    }
    // `toJSONObject` is intentionally exact: do not expose bundle, argv,
    // parent/group, window, or liveness metadata on this internal lookup.
    return receipt.toJSONObject()
}

func nativeWindowProcessAncestryResponse(
    pid: Int,
    ancestorPid: Int,
    maxDepth: Int
) throws -> [String: Any] {
    guard
        let checkedPID = Int32(exactly: pid), checkedPID > 0,
        let checkedAncestorPID = Int32(exactly: ancestorPid), checkedAncestorPID > 0,
        maxDepth > 0, maxDepth <= ProcessAncestry.maximumDepth
    else {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "nativeWindow.processAncestry requires positive PIDs and a bounded depth."
        )
    }
    guard
        let links = ProcessAncestry.chain(
            from: Int(checkedPID),
            to: Int(checkedAncestorPID),
            maxDepth: maxDepth
        )
    else {
        throw JSONRPCError(
            code: JSONRPCErrorCode.bridgeUnavailable,
            message: "The requested process is not a live descendant of the expected process."
        )
    }
    // Only the chain that answers the question asked: no argv, bundle, window,
    // or sibling metadata, and nothing about processes off this path.
    return ["chain": links.map { $0.toJSONObject() }]
}

func registerNativeWindowProcessAncestryRPC(on dispatcher: JSONRPCDispatcher) {
    dispatcher.register("nativeWindow.processAncestry") { params in
        try performNativeWindowRPC {
            let dictionary = try requestDictionary(
                params,
                method: "nativeWindow.processAncestry"
            )
            guard
                dictionary.count == 3,
                dictionary["pid"] != nil,
                dictionary["ancestorPid"] != nil,
                dictionary["maxDepth"] != nil
            else {
                throw JSONRPCError(
                    code: JSONRPCErrorCode.invalidParams,
                    message: "nativeWindow.processAncestry expects pid, ancestorPid, and maxDepth."
                )
            }
            let parsed = try decodeNativeWindowParams(
                dictionary,
                as: NativeWindowProcessAncestryParams.self,
                method: "nativeWindow.processAncestry"
            )
            return try nativeWindowProcessAncestryResponse(
                pid: parsed.pid,
                ancestorPid: parsed.ancestorPid,
                maxDepth: parsed.maxDepth
            )
        }
    }
}

func registerNativeWindowProcessIdentityRPC(on dispatcher: JSONRPCDispatcher) {
    dispatcher.register("nativeWindow.processIdentity") { params in
        try performNativeWindowRPC {
            let dictionary = try requestDictionary(
                params,
                method: "nativeWindow.processIdentity"
            )
            guard dictionary.count == 1, dictionary["pid"] != nil else {
                throw JSONRPCError(
                    code: JSONRPCErrorCode.invalidParams,
                    message: "nativeWindow.processIdentity expects exactly one PID."
                )
            }
            let parsed = try decodeNativeWindowParams(
                dictionary,
                as: NativeWindowProcessIdentityParams.self,
                method: "nativeWindow.processIdentity"
            )
            return try nativeWindowProcessIdentityResponse(pid: parsed.pid)
        }
    }
}

func requireActiveNativeWindow(
    _ active: inout NativeWindowRPCSession.Active?,
    access: AttachedWindowAccess
) throws -> (NativeWindowRPCSession.Active, AttachedWindowLease) {
    guard let current = active, current.access == access else {
        throw JSONRPCError.attachmentRevoked(
            "The native-window adoption is absent, stale, or belongs to another scope."
        )
    }
    let attachment = try resolveAuthorizedAttachment(access)
    let liveTarget = try deriveNativeWindowTarget(from: attachment.lease)
    guard liveTarget == current.target else {
        _ = current.adapter.release(target: current.target)
        current.adapter.invalidateAllSnapshots()
        active = nil
        throw JSONRPCError.attachmentRevoked(
            "The authorized native-window identity changed; adopt it again."
        )
    }
    return (current, attachment.lease)
}

func mapNativeWindowAccessibilityFailure(
    _ failure: WindowAccessibilityFailure
) -> JSONRPCError {
    var data: [String: String] = [
        "kind": "nativeWindowFailure",
        "errorCode": failure.code.rawValue,
        "executionState": failure.executionState.rawValue
    ]
    let safeDetailKeys: Set<String> = [
        "operation",
        "axError",
        "idleSeconds",
        "requiredIdleSeconds",
        "refusalReason",
        "maxCharacters",
        "maxUTF8Bytes"
    ]
    for (key, value) in failure.details where safeDetailKeys.contains(key) {
        data[key] = value
    }
    return JSONRPCError(
        code: failure.code == .invalidRequest
            ? JSONRPCErrorCode.invalidParams
            : JSONRPCErrorCode.bridgeUnavailable,
        message: failure.message,
        data: data
    )
}

func mapNativeWindowRPCError(_ error: Error) -> JSONRPCError {
    if let error = error as? JSONRPCError {
        return error
    }
    if let failure = error as? WindowAccessibilityFailure {
        return mapNativeWindowAccessibilityFailure(failure)
    }
    return JSONRPCError(
        code: JSONRPCErrorCode.internalError,
        message: "Native-window operation failed."
    )
}

func encodedJSONObjectDictionary<T: Encodable>(_ value: T) throws -> [String: Any] {
    guard let result = try encodeAsJSONObject(value) as? [String: Any] else {
        throw JSONRPCError(
            code: JSONRPCErrorCode.internalError,
            message: "Native-window result encoding failed."
        )
    }
    return result
}

func nativeWindowISO8601(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}

func nativeWindowSHA256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func nativeWindowViewport(
    _ bounds: WindowAccessibilityRect
) -> [String: Any] {
    [
        "width": max(1, Int(bounds.width.rounded())),
        "height": max(1, Int(bounds.height.rounded()))
    ]
}

func nativeWindowCanvasTree(
    observation: WindowAccessibilityObservation,
    fallbackTitle: String
) throws -> [String: Any] {
    _ = try encodeAsJSONObject(observation)
    let snapshot = observation.snapshot
    var nodesByRef: [String: WindowAccessibilityNode] = [:]
    for node in snapshot.nodes {
        guard nodesByRef[node.ref] == nil else {
            throw JSONRPCError(
                code: JSONRPCErrorCode.internalError,
                message: "Native AX observation contained duplicate refs."
            )
        }
        nodesByRef[node.ref] = node
    }

    func buildNode(
        _ ref: String,
        visiting: inout Set<String>
    ) throws -> [String: Any] {
        guard let node = nodesByRef[ref], !visiting.contains(ref) else {
            throw JSONRPCError(
                code: JSONRPCErrorCode.internalError,
                message: "Native AX observation tree is invalid."
            )
        }
        visiting.insert(ref)
        defer { visiting.remove(ref) }

        var result: [String: Any] = [
            "ref": node.ref,
            "role": node.role,
            "tag": (node.subrole?.isEmpty == false ? node.subrole! : node.role)
        ]
        let name = [node.label, node.title, node.identifier]
            .compactMap { value -> String? in
                guard let value, !value.isEmpty else { return nil }
                return value
            }
            .first
        if let name {
            result["name"] = name
            result["text"] = name
        }
        if let value = node.value, !node.secure {
            result["value"] = value
        }
        if let frame = node.frame {
            result["bbox"] = [
                frame.x - snapshot.target.expectedBounds.x,
                frame.y - snapshot.target.expectedBounds.y,
                frame.width,
                frame.height
            ]
        }
        if !node.childRefs.isEmpty {
            result["children"] = try node.childRefs.map { childRef in
                try buildNode(childRef, visiting: &visiting)
            }
        }
        return result
    }

    var visiting = Set<String>()
    let root = try buildNode(snapshot.rootRef, visiting: &visiting)
    let rootNode = nodesByRef[snapshot.rootRef]
    let title = [rootNode?.title, rootNode?.label, fallbackTitle]
        .compactMap { value -> String? in
            guard let value, !value.isEmpty else { return nil }
            return value
        }
        .first ?? "Managed native window"
    return [
        "url": "window://native",
        "title": title,
        "viewport": nativeWindowViewport(snapshot.target.expectedBounds),
        "capturedAt": nativeWindowISO8601(snapshot.createdAt),
        "root": root,
        "nodeCount": snapshot.nodes.count,
        "truncated": snapshot.truncated,
        "inputEpoch": snapshot.inputEpoch
    ]
}

func nativeWindowObservationResponse(
    _ observation: WindowAccessibilityObservation,
    title: String
) throws -> [String: Any] {
    var response = try encodedJSONObjectDictionary(observation)
    response.removeValue(forKey: "snapshot")
    response.removeValue(forKey: "observationID")
    response["observationId"] = observation.observationID
    response["inputEpoch"] = observation.inputEpoch
    response["tree"] = try nativeWindowCanvasTree(
        observation: observation,
        fallbackTitle: title
    )
    if let verification = observation.actionVerification {
        response["actionVerification"] = [
            "actionId": verification.actionID,
            "verified": verification.verified.rawValue
        ]
    } else {
        response.removeValue(forKey: "actionVerification")
    }
    return response
}

func nativeWindowInspectionResponse(
    _ inspection: WindowAccessibilityInspection,
    target: WindowAccessibilityTargetIdentity
) throws -> [String: Any] {
    var response = try encodedJSONObjectDictionary(inspection)
    response.removeValue(forKey: "observationID")
    response.removeValue(forKey: "node")
    response["observationId"] = inspection.observationID
    let node = inspection.node
    var detail: [String: Any] = [
        "found": true,
        "ref": node.ref,
        "role": node.role,
        "tag": (node.subrole?.isEmpty == false ? node.subrole! : node.role)
    ]
    if let text = [node.label, node.title]
        .compactMap({ $0?.isEmpty == false ? $0 : nil })
        .first {
        detail["text"] = text
    }
    if let frame = node.frame {
        detail["bbox"] = [
            frame.x - target.expectedBounds.x,
            frame.y - target.expectedBounds.y,
            frame.width,
            frame.height
        ]
    }
    response["detail"] = detail
    return response
}

func nativeWindowActionResponse(
    _ attempt: WindowAccessibilityActionAttempt
) throws -> [String: Any] {
    var response = try encodedJSONObjectDictionary(attempt)
    response.removeValue(forKey: "observationID")
    response.removeValue(forKey: "actionID")
    response["observationId"] = attempt.observationID
    response["actionId"] = attempt.actionID
    return response
}

func nativeWindowScopedResponse(
    _ response: [String: Any],
    lease: AttachedWindowLease
) -> [String: Any] {
    var result = response
    for (key, value) in scopedAttachmentFields(lease) {
        result[key] = value
    }
    return result
}

func performNativeWindowRPC<T>(_ operation: () throws -> T) throws -> T {
    do {
        return try operation()
    } catch {
        throw mapNativeWindowRPCError(error)
    }
}

registerNativeWindowProcessIdentityRPC(on: dispatcher)
registerNativeWindowProcessAncestryRPC(on: dispatcher)

dispatcher.register("nativeWindow.accessibilityStatus") { _ in
    try performNativeWindowRPC {
        try encodeAsJSONObject(
            nativeWindowRPCSession.permissionStatus(prompt: false)
        )
    }
}

dispatcher.register("nativeWindow.requestAccessibility") { _ in
    try performNativeWindowRPC {
        try encodeAsJSONObject(
            nativeWindowRPCSession.permissionStatus(prompt: true)
        )
    }
}

dispatcher.register("nativeWindow.adopt") { params in
    try performNativeWindowRPC {
        let parsed = try decodeNativeWindowParams(
            params,
            as: NativeWindowAdoptParams.self,
            method: "nativeWindow.adopt"
        )
        let access = try validateNativeWindowAccess(
            parsed.access,
            method: "nativeWindow.adopt"
        )
        let protectedHostPIDs = try nativeWindowProtectedPIDs(parsed.protectedHostPIDs)

        return try nativeWindowRPCSession.serialized { active in
            let attachment = try resolveAuthorizedAttachment(access)
            let target = try deriveNativeWindowTarget(from: attachment.lease)
            var configuration = WindowAccessibilityConfiguration()
            configuration.protectedHostPIDs = protectedHostPIDs
            let adapter = WindowAccessibilityAdapter(configuration: configuration)
            do {
                let receipt = try adapter.adopt(target: target)
                try revalidateAttachment(attachment.lease)
                var response = try encodedJSONObjectDictionary(receipt)
                response["ok"] = true
                response["pid"] = Int(receipt.target.pid)
                response["viewport"] = nativeWindowViewport(receipt.viewport)
                response = nativeWindowScopedResponse(response, lease: attachment.lease)

                nativeWindowRPCSession.clearActive(&active)
                active = NativeWindowRPCSession.Active(
                    access: access,
                    target: target,
                    adapter: adapter
                )
                return response
            } catch {
                _ = adapter.release(target: target)
                adapter.invalidateAllSnapshots()
                throw error
            }
        }
    }
}

dispatcher.register("nativeWindow.observe") { params in
    try performNativeWindowRPC {
        let access = try decodeScopedAccess(params, method: "nativeWindow.observe")
        return try nativeWindowRPCSession.serialized { active in
            let (current, lease) = try requireActiveNativeWindow(&active, access: access)
            let observation = try current.adapter.observe(target: current.target)
            try revalidateAttachment(lease)
            let response = try nativeWindowObservationResponse(
                observation,
                title: lease.meta.title
            )
            return nativeWindowScopedResponse(response, lease: lease)
        }
    }
}

dispatcher.register("nativeWindow.inspect") { params in
    try performNativeWindowRPC {
        let parsed = try decodeNativeWindowParams(
            params,
            as: NativeWindowObservedElementParams.self,
            method: "nativeWindow.inspect"
        )
        let access = try validateNativeWindowAccess(
            parsed.access,
            method: "nativeWindow.inspect"
        )
        return try nativeWindowRPCSession.serialized { active in
            let (current, lease) = try requireActiveNativeWindow(&active, access: access)
            let inspection = try current.adapter.inspect(
                target: current.target,
                observationID: parsed.observationID,
                inputEpoch: parsed.inputEpoch,
                ref: parsed.ref
            )
            try revalidateAttachment(lease)
            let response = try nativeWindowInspectionResponse(
                inspection,
                target: current.target
            )
            return nativeWindowScopedResponse(response, lease: lease)
        }
    }
}

dispatcher.register("nativeWindow.capture") { params in
    try performNativeWindowRPC {
        let parsed = try decodeNativeWindowParams(
            params,
            as: NativeWindowCaptureParams.self,
            method: "nativeWindow.capture"
        )
        let access = try validateNativeWindowAccess(
            parsed.access,
            method: "nativeWindow.capture"
        )
        let maxDimensionPx = parsed.maxDimensionPx ?? 1_600
        guard (1...4_096).contains(maxDimensionPx) else {
            throw JSONRPCError(
                code: JSONRPCErrorCode.invalidParams,
                message: "nativeWindow.capture maxDimensionPx must be between 1 and 4096."
            )
        }

        return try nativeWindowRPCSession.serialized { active in
            let (current, lease) = try requireActiveNativeWindow(&active, access: access)
            let capture: (safety: WindowAccessibilityCaptureSafetyReceipt, frame: CapturedWindowFrame)
            do {
                let filter = try captureFilter(for: lease)
                capture = try performNativeWindowCapture(
                    adapter: current.adapter,
                    target: current.target,
                    captureExecutor: {
                        try runBlocking { @Sendable [filter, maxDimensionPx] in
                            try await AttachedWindowCapture.captureWindow(
                                filter: filter,
                                maxDimensionPx: maxDimensionPx
                            )
                        }
                    },
                    revalidateLease: {
                        try revalidateAttachment(lease)
                    }
                )
            } catch let error as JSONRPCError {
                throw error
            } catch let error as AttachedWindowError {
                if case .windowGone = error {
                    try? runBlocking { @Sendable [attachedWindowStore, lease] in
                        await attachedWindowStore.revokeIfCurrent(lease)
                    }
                    nativeWindowRPCSession.clearActive(&active)
                    throw JSONRPCError(
                        code: JSONRPCErrorCode.bridgeUnavailable,
                        message: error.localizedDescription
                    )
                }
                throw JSONRPCError(
                    code: JSONRPCErrorCode.internalError,
                    message: error.localizedDescription
                )
            }

            let capturedAt = Date()
            let encodedSafety = try encodedJSONObjectDictionary(capture.safety)
            var response: [String: Any] = [
                "ok": true,
                "captureSafety": encodedSafety,
                "frame": [
                    "mimeType": "image/png",
                    "data": capture.frame.pngData.base64EncodedString(),
                    "width": capture.frame.width,
                    "height": capture.frame.height,
                    "byteLength": capture.frame.pngData.count,
                    "hash": nativeWindowSHA256(capture.frame.pngData),
                    "capturedAt": nativeWindowISO8601(capturedAt),
                    "secretsRedacted": 0
                ]
            ]
            response["windowMeta"] = lease.meta.toJSONObject()
            return nativeWindowScopedResponse(response, lease: lease)
        }
    }
}

dispatcher.register("nativeWindow.click") { params in
    try performNativeWindowRPC {
        let parsed = try decodeNativeWindowParams(
            params,
            as: NativeWindowObservedElementParams.self,
            method: "nativeWindow.click"
        )
        let access = try validateNativeWindowAccess(
            parsed.access,
            method: "nativeWindow.click"
        )
        return try nativeWindowRPCSession.serialized { active in
            let (current, lease) = try requireActiveNativeWindow(&active, access: access)
            let attempt = try current.adapter.click(
                target: current.target,
                observationID: parsed.observationID,
                inputEpoch: parsed.inputEpoch,
                ref: parsed.ref
            )
            let response = try nativeWindowActionResponse(attempt)
            return nativeWindowScopedResponse(response, lease: lease)
        }
    }
}

dispatcher.register("nativeWindow.fill") { params in
    try performNativeWindowRPC {
        let parsed = try decodeNativeWindowParams(
            params,
            as: NativeWindowFillParams.self,
            method: "nativeWindow.fill"
        )
        let access = try validateNativeWindowAccess(
            parsed.access,
            method: "nativeWindow.fill"
        )
        return try nativeWindowRPCSession.serialized { active in
            let (current, lease) = try requireActiveNativeWindow(&active, access: access)
            let attempt = try current.adapter.fill(
                target: current.target,
                observationID: parsed.element.observationID,
                inputEpoch: parsed.element.inputEpoch,
                ref: parsed.element.ref,
                value: parsed.value
            )
            let response = try nativeWindowActionResponse(attempt)
            return nativeWindowScopedResponse(response, lease: lease)
        }
    }
}

dispatcher.register("nativeWindow.release") { params in
    try performNativeWindowRPC {
        let access = try decodeScopedAccess(params, method: "nativeWindow.release")
        return try nativeWindowRPCSession.serialized { active in
            guard let current = active, current.access == access else {
                throw JSONRPCError.attachmentRevoked(
                    "The exact native-window adoption is no longer active."
                )
            }

            // Reauthorization is mandatory, but release remains available after
            // the store has already revoked or replaced this exact attachment.
            do {
                let attachment = try resolveAuthorizedAttachment(access)
                let target = try deriveNativeWindowTarget(from: attachment.lease)
                guard target == current.target else {
                    throw JSONRPCError.attachmentRevoked(
                        "The native-window target identity changed before release."
                    )
                }
            } catch {
                // Exact stored access is sufficient only for local teardown.
                // No target observation, capture, or actuation occurs here.
            }

            let receipt = current.adapter.release(target: current.target)
            current.adapter.invalidateAllSnapshots()
            active = nil
            var response = try encodedJSONObjectDictionary(receipt)
            response["ok"] = true
            response["released"] = true
            for (key, value) in scopedRequestFields(access) {
                response[key] = value
            }
            return response
        }
    }
}

// attachedWindow.requestPick accepts:
// { scopeID, chatID, consentEpoch, protectedOwners: { pids, windowIDs } }.
// protected PIDs are resolved to launch-time receipts by the daemon itself.
dispatcher.register("attachedWindow.requestPick") { params in
    let parsed: AttachedWindowRequestPickParams
    do {
        parsed = try decodeParams(params, as: AttachedWindowRequestPickParams.self)
        try parsed.scope.validate()
    } catch {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "Invalid attachedWindow.requestPick params: \(error.localizedDescription)"
        )
    }

    let protectedOwners: ResolvedProtectedWindowOwners
    do {
        protectedOwners = try parsed.protectedOwners.resolve()
    } catch {
        throw JSONRPCError.attachmentDenied(
            "Protected host process identity validation failed: \(error.localizedDescription)"
        )
    }

    do {
        try runBlocking { @Sendable [attachedWindowStore, scope = parsed.scope] in
            try await attachedWindowStore.beginPicker(scope: scope)
        }
    } catch {
        throw mapAttachmentError(error)
    }
    defer {
        try? runBlocking { @Sendable [attachedWindowStore, scope = parsed.scope] in
            await attachedWindowStore.finishPicker(scope: scope)
        }
    }

    let exclusions: PickerExclusions
    do {
        exclusions = try runBlocking { @Sendable [protectedOwners] in
            try await protectedOwners.pickerExclusions()
        }
    } catch {
        throw JSONRPCError.attachmentDenied(
            "Protected host process identity could not be resolved: \(error.localizedDescription)"
        )
    }

    let picked: (meta: AttachedWindowMeta, filter: SCContentFilter)
    do {
        picked = try runBlockingOnMain { @MainActor @Sendable in
            try await withCheckedThrowingContinuation {
                (continuation: CheckedContinuation<(meta: AttachedWindowMeta, filter: SCContentFilter), Error>) in
                let picker = AttachedWindowPicker()
                // Keep the picker observer alive until its one completion.
                var strongPicker: AttachedWindowPicker? = picker
                picker.pick(exclusions: exclusions, protectedOwners: protectedOwners) { result in
                    switch result {
                    case .success(let value):
                        continuation.resume(returning: value)
                    case .failure(let error):
                        continuation.resume(throwing: error)
                    }
                    strongPicker = nil
                    _ = strongPicker
                }
            }
        }
    } catch let error as AttachedWindowError {
        switch error {
        case .cancelled:
            return [
                "cancelled": true,
                "scopeID": parsed.scope.scopeID,
                "chatID": parsed.scope.chatID,
                "consentEpoch": parsed.scope.consentEpoch
            ]
        case .protectedWindowSelected:
            throw JSONRPCError.attachmentDenied(error.localizedDescription)
        default:
            throw JSONRPCError(
                code: JSONRPCErrorCode.internalError,
                message: error.localizedDescription
            )
        }
    } catch {
        throw JSONRPCError(
            code: JSONRPCErrorCode.internalError,
            message: error.localizedDescription
        )
    }

    let lease: AttachedWindowLease
    do {
        lease = try nativeWindowRPCSession.serialized { active in
            let replacement = try runBlocking {
                @Sendable [attachedWindowStore, picked, scope = parsed.scope, protectedOwners] in
                try await attachedWindowStore.attachReplacingCurrent(
                    meta: picked.meta,
                    filter: picked.filter,
                    scope: scope,
                    protectedOwners: protectedOwners
                )
            }
            nativeWindowRPCSession.clearActive(&active)
            return replacement
        }
    } catch {
        throw mapAttachmentError(error)
    }

    var response = scopedAttachmentFields(lease)
    response["ok"] = true
    response["windowMeta"] = lease.meta.toJSONObject()
    return response
}

// attachedWindow.capture accepts the flat scoped access fields plus optional
// includeOCR and maxDimensionPx. It rechecks after capture and OCR work.
dispatcher.register("attachedWindow.capture") { params in
    let dict = try requestDictionary(params, method: "attachedWindow.capture")
    let access = try decodeScopedAccess(dict, method: "attachedWindow.capture")
    let attachment = try resolveAuthorizedAttachment(access)
    let lease = attachment.lease
    let maxDimension = dict["maxDimensionPx"] as? Int ?? 1600
    let frame: CapturedWindowFrame

    do {
        let filter = try captureFilter(for: lease)
        frame = try runBlocking { @Sendable [filter, maxDimension] in
            try await AttachedWindowCapture.captureWindow(
                filter: filter,
                maxDimensionPx: maxDimension
            )
        }
    } catch let error as JSONRPCError {
        throw error
    } catch let error as AttachedWindowError {
        if case .windowGone = error {
            revokeAttachedWindowLease(lease)
            throw JSONRPCError(
                code: JSONRPCErrorCode.bridgeUnavailable,
                message: error.localizedDescription
            )
        }
        throw JSONRPCError(
            code: JSONRPCErrorCode.internalError,
            message: error.localizedDescription
        )
    }

    try revalidateAttachment(lease)
    var response = scopedAttachmentFields(lease)
    response["ok"] = true
    response["pngBase64"] = frame.pngData.base64EncodedString()
    response["byteLength"] = frame.pngData.count
    response["width"] = frame.width
    response["height"] = frame.height
    response["windowMeta"] = lease.meta.toJSONObject()
    response["capturedAt"] = ISO8601DateFormatter().string(from: Date())

    if dict["includeOCR"] as? Bool ?? true {
        do {
            let ocr = try runBlocking { @Sendable [pngData = frame.pngData] in
                try await AttachedWindowOCR.recognize(pngData: pngData)
            }
            try revalidateAttachment(lease)
            response["ocr"] = ocr.toJSONObject()
        } catch let error as JSONRPCError {
            throw error
        } catch {
            response["ocrError"] = error.localizedDescription
        }
    }

    try revalidateAttachment(lease)
    return response
}

// attachedWindow.detach requires the exact live scope/generation and stops
// Appwatch before returning. A stale call gets attachmentRevoked.
dispatcher.register("attachedWindow.detach") { params in
    let access = try decodeScopedAccess(params, method: "attachedWindow.detach")
    let detached: Bool
    do {
        detached = try nativeWindowRPCSession.serialized { active in
            let didDetach = try runBlocking { @Sendable [attachedWindowStore, access] in
                try await attachedWindowStore.detach(access)
            }
            if active?.access == access {
                nativeWindowRPCSession.clearActive(&active)
            }
            return didDetach
        }
    } catch {
        throw mapAttachmentError(error)
    }
    var response = scopedRequestFields(access)
    response["ok"] = true
    response["detached"] = detached
    return response
}

// attachedWindow.status requires the exact live scope/generation so it cannot
// disclose whether some other chat has an attachment.
dispatcher.register("attachedWindow.status") { params in
    let access = try decodeScopedAccess(params, method: "attachedWindow.status")
    let attachment = try resolveAuthorizedAttachment(access)
    try revalidateAttachment(attachment.lease)
    var response = scopedAttachmentFields(attachment.lease)
    response["attached"] = true
    response["windowMeta"] = attachment.lease.meta.toJSONObject()
    response["attachedAt"] = ISO8601DateFormatter().string(from: attachment.lease.createdAt)
    return response
}

// MARK: - Appwatch RPCs (scoped attachment lease)

@Sendable func appwatchISO8601(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}

@Sendable func parseAppwatchISO8601(_ value: String?) -> Date? {
    guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        return nil
    }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: value) {
        return date
    }
    return ISO8601DateFormatter().date(from: value)
}

@Sendable func makeStreamingPayload(
    config: AppwatchStreamConfig,
    frameCount: Int
) -> [String: Any] {
    return [
        "fps": config.fps,
        "bufferSeconds": config.bufferSeconds,
        "frameCount": frameCount,
        "frameCapacity": config.frameCapacity,
        "estimatedMemoryMB": config.estimatedMemoryMB,
        "memoryBudgetMB": AttachedWindowStream.memoryBudgetMB,
        "startedAt": appwatchISO8601(config.startedAt)
    ]
}

// appwatch.start requires scoped access plus optional fps, bufferSeconds, and
// maxDimensionPx. It confirms the generation after async stream startup.
dispatcher.register("appwatch.start") { params in
    let dict = try requestDictionary(params, method: "appwatch.start")
    let access = try decodeScopedAccess(dict, method: "appwatch.start")
    let attachment = try prepareAuthorizedAppwatch(access)
    let lease = attachment.lease
    guard let stream = attachment.stream else {
        throw JSONRPCError(
            code: JSONRPCErrorCode.internalError,
            message: "Failed to reserve the Appwatch stream."
        )
    }

    let config: AppwatchStreamConfig
    do {
        let filter = try captureFilter(for: lease)
        let fps = dict["fps"] as? Int ?? 5
        let bufferSeconds = dict["bufferSeconds"] as? Int ?? 8
        let maxDimensionPx = dict["maxDimensionPx"] as? Int ?? 1280
        config = try runBlocking { @Sendable [stream, filter, fps, bufferSeconds, maxDimensionPx] in
            try await stream.start(
                filter: filter,
                fps: fps,
                bufferSeconds: bufferSeconds,
                maxDimensionPx: maxDimensionPx
            )
        }
    } catch let error as AppwatchError {
        try? runBlocking { @Sendable [attachedWindowStore, stream, lease] in
            await attachedWindowStore.discardStream(stream, for: lease)
        }
        switch error {
        case .memoryBudgetExceeded:
            throw JSONRPCError(
                code: JSONRPCErrorCode.appwatchBudgetExceeded,
                message: error.localizedDescription
            )
        case .invalidConfig:
            throw JSONRPCError(
                code: JSONRPCErrorCode.invalidParams,
                message: error.localizedDescription
            )
        default:
            throw JSONRPCError(
                code: JSONRPCErrorCode.internalError,
                message: error.localizedDescription
            )
        }
    } catch let error as JSONRPCError {
        try? runBlocking { @Sendable [attachedWindowStore, stream, lease] in
            await attachedWindowStore.discardStream(stream, for: lease)
        }
        throw error
    } catch {
        try? runBlocking { @Sendable [attachedWindowStore, stream, lease] in
            await attachedWindowStore.discardStream(stream, for: lease)
        }
        throw JSONRPCError(
            code: JSONRPCErrorCode.internalError,
            message: error.localizedDescription
        )
    }

    do {
        try runBlocking { @Sendable [attachedWindowStore, stream, lease] in
            try await attachedWindowStore.confirmStreamStarted(stream, for: lease)
        }
    } catch {
        try? runBlocking { @Sendable [attachedWindowStore, stream, lease] in
            await attachedWindowStore.discardStream(stream, for: lease)
        }
        throw mapAttachmentError(error)
    }

    let frameCount = try runBlocking { @Sendable [stream] in
        await stream.status().frameCount
    }
    try revalidateAttachment(lease)

    var response = scopedAttachmentFields(lease)
    response["ok"] = true
    response["streaming"] = makeStreamingPayload(config: config, frameCount: frameCount)
    return response
}

// appwatch.stop requires scoped access and clears only its own stream.
dispatcher.register("appwatch.stop") { params in
    let access = try decodeScopedAccess(params, method: "appwatch.stop")
    let attachment = try resolveAuthorizedAttachment(access)
    let lease = attachment.lease
    guard let stream = attachment.stream else {
        try revalidateAttachment(lease)
        var response = scopedAttachmentFields(lease)
        response["ok"] = true
        response["streaming"] = false
        return response
    }

    try runBlocking { @Sendable [stream] in
        await stream.stop()
    }
    do {
        try runBlocking { @Sendable [attachedWindowStore, stream, lease] in
            try await attachedWindowStore.clearStream(stream, for: lease)
        }
    } catch {
        throw mapAttachmentError(error)
    }
    try revalidateAttachment(lease)

    var response = scopedAttachmentFields(lease)
    response["ok"] = true
    response["streaming"] = false
    return response
}

// appwatch.status needs scoped access and never resets the stream idle clock.
dispatcher.register("appwatch.status") { params in
    let access = try decodeScopedAccess(params, method: "appwatch.status")
    let attachment = try resolveAuthorizedAttachment(access)
    let lease = attachment.lease
    guard let stream = attachment.stream else {
        try revalidateAttachment(lease)
        var response = scopedAttachmentFields(lease)
        response["ok"] = true
        response["streaming"] = false
        return response
    }

    let status = try runBlocking { @Sendable [stream] in
        await stream.status()
    }
    try revalidateAttachment(lease)

    var response = scopedAttachmentFields(lease)
    response["ok"] = true
    response["streaming"] = status.streaming
    response["fps"] = status.fps
    response["bufferSeconds"] = status.bufferSeconds
    response["frameCount"] = status.frameCount
    response["frameCapacity"] = status.frameCapacity
    response["estimatedMemoryMB"] = status.estimatedMemoryMB
    response["memoryBudgetMB"] = status.memoryBudgetMB
    if let oldest = status.oldestAt {
        response["oldestAt"] = appwatchISO8601(oldest)
    }
    if let newest = status.newestAt {
        response["newestAt"] = appwatchISO8601(newest)
    }
    if let pulled = status.lastPullAt {
        response["lastPullAt"] = appwatchISO8601(pulled)
    }
    if let started = status.startedAt {
        response["startedAt"] = appwatchISO8601(started)
    }
    return response
}

// appwatch.latestFrame revalidates after the async ring read and after PNG
// encoding, before returning any pixels.
dispatcher.register("appwatch.latestFrame") { params in
    let access = try decodeScopedAccess(params, method: "appwatch.latestFrame")
    let attachment = try resolveAuthorizedAttachment(access)
    let lease = attachment.lease
    guard let stream = attachment.stream else {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidRequest,
            message: "Appwatch is not streaming for this scoped attachment (call appwatch.start first)."
        )
    }

    let frame = try runBlocking { @Sendable [stream] in
        await stream.latestFrame()
    }
    try revalidateAttachment(lease)
    guard let frame else {
        var response = scopedAttachmentFields(lease)
        response["ok"] = true
        response["hasFrame"] = false
        return response
    }

    let pngData: Data
    do {
        pngData = try AppwatchFrameEncoder.encodePNG(frame: frame)
    } catch let error as AppwatchError {
        throw JSONRPCError(
            code: JSONRPCErrorCode.internalError,
            message: error.localizedDescription
        )
    }
    try revalidateAttachment(lease)

    var response = scopedAttachmentFields(lease)
    response["ok"] = true
    response["hasFrame"] = true
    response["pngBase64"] = pngData.base64EncodedString()
    response["byteLength"] = pngData.count
    response["width"] = frame.width
    response["height"] = frame.height
    response["capturedAt"] = appwatchISO8601(frame.capturedAt)
    return response
}

// appwatch.frames accepts scoped access plus optional since, count, format,
// includeOCR/include_ocr. Every OCR pass and the final payload are rechecked.
dispatcher.register("appwatch.frames") { params in
    let dict = try requestDictionary(params, method: "appwatch.frames")
    let access = try decodeScopedAccess(dict, method: "appwatch.frames")
    let attachment = try resolveAuthorizedAttachment(access)
    let lease = attachment.lease
    guard let stream = attachment.stream else {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidRequest,
            message: "Appwatch is not streaming for this scoped attachment (call appwatch.start first)."
        )
    }

    let includeOCR = (dict["includeOCR"] as? Bool) ?? (dict["include_ocr"] as? Bool) ?? false
    let requestedCount = dict["count"] as? Int ?? 5
    let count = max(1, min(includeOCR ? 5 : 20, requestedCount))
    let format = ((dict["format"] as? String) ?? "jpeg").lowercased() == "png" ? "png" : "jpeg"
    let since = parseAppwatchISO8601(dict["since"] as? String)
    let batch = try runBlocking { @Sendable [stream, since, count] in
        await stream.frames(since: since, count: count)
    }
    try revalidateAttachment(lease)

    var framesPayload: [[String: Any]] = []
    framesPayload.reserveCapacity(batch.frames.count)
    for (index, frame) in batch.frames.enumerated() {
        let imageData: Data
        do {
            imageData = format == "png"
                ? try AppwatchFrameEncoder.encodePNG(frame: frame)
                : try AppwatchFrameEncoder.encodeJPEG(frame: frame)
        } catch let error as AppwatchError {
            throw JSONRPCError(
                code: JSONRPCErrorCode.internalError,
                message: error.localizedDescription
            )
        }

        var framePayload: [String: Any] = [
            "index": index,
            "capturedAt": appwatchISO8601(frame.capturedAt),
            "mimeType": format == "png" ? "image/png" : "image/jpeg",
            "imageBase64": imageData.base64EncodedString(),
            "byteLength": imageData.count,
            "width": frame.width,
            "height": frame.height
        ]
        if includeOCR {
            do {
                let ocr = try runBlocking { @Sendable [imageData] in
                    try await AttachedWindowOCR.recognize(pngData: imageData)
                }
                try revalidateAttachment(lease)
                framePayload["ocr"] = ocr.toJSONObject()
            } catch let error as JSONRPCError {
                throw error
            } catch {
                framePayload["ocrError"] = error.localizedDescription
            }
        }
        try revalidateAttachment(lease)
        framesPayload.append(framePayload)
    }

    var response = scopedAttachmentFields(lease)
    response["ok"] = true
    response["hasFrames"] = !framesPayload.isEmpty
    response["returned"] = framesPayload.count
    response["requested"] = requestedCount
    response["count"] = count
    response["format"] = format
    response["includeOCR"] = includeOCR
    response["availableCapturedAt"] = batch.availableCapturedAt.map { appwatchISO8601($0) }
    response["frames"] = framesPayload
    if let nextSince = batch.nextSince {
        response["nextSince"] = appwatchISO8601(nextSince)
    }
    try revalidateAttachment(lease)
    return response
}


// MARK: - VideoToolbox RPCs
//
// `video.decodeFrame` — native single-frame decode via an explicit
// VTDecompressionSession (AVAssetReader feeds compressed samples, VT decodes,
// we PNG-encode the chosen frame). Mirrors `attachedWindow.capture`: decode
// params → runBlocking → map VideoFrameDecodeError to JSONRPCError → return the
// result dict (`ok`, `pngBase64`, `width`, `height`, `timestampSeconds`,
// `codec`, `usedHardware`). Bad/missing path or no video track → invalidParams;
// decode failure / unsupported (HDR this slice) → internalError.

struct VideoDecodeFrameParams: Decodable {
    let inputPath: String
    let timestampSeconds: Double?
    let preferHardware: Bool?
}

dispatcher.register("video.decodeFrame") { params in
    let parsed: VideoDecodeFrameParams
    do {
        parsed = try decodeParams(params, as: VideoDecodeFrameParams.self)
    } catch {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "Invalid video.decodeFrame params: \(error.localizedDescription)"
        )
    }
    do {
        let frame = try runBlocking { @Sendable [
            inputPath = parsed.inputPath,
            ts = parsed.timestampSeconds ?? 0,
            hw = parsed.preferHardware ?? true
        ] in
            try await VideoFrameDecoder.decodeFrame(
                inputPath: inputPath,
                timestampSeconds: ts,
                preferHardware: hw
            )
        }
        return frame.toJSONObject()
    } catch let err as VideoFrameDecodeError {
        switch err {
        case .badInput(let message):
            throw JSONRPCError(code: JSONRPCErrorCode.invalidParams, message: message)
        case .decodeFailed(let message):
            throw JSONRPCError(code: JSONRPCErrorCode.internalError, message: message)
        }
    } catch let err as JSONRPCError {
        throw err
    } catch {
        throw JSONRPCError(code: JSONRPCErrorCode.internalError, message: error.localizedDescription)
    }
}

// `video.encodeClip` — native VideoToolbox encode-to-MP4 (Approach B,
// AVAssetWriter): AVAssetReader decompresses the source → optional CoreImage
// downscale → AVAssetWriterInput H.264 encode → .mp4 mux at the TS-owned
// staging `outputPath`. Mirrors `video.decodeFrame`: decode params →
// runBlocking → map VideoEncodeError to JSONRPCError → return the metadata dict
// (`ok`, `width`, `height`, `durationMs`, `codec`, `usedHardware`). We do NOT
// return bytes — TS reads + deletes the file at outputPath. Bad/missing path,
// no video track, or HDR source → invalidParams; encode/writer failure or zero
// frames → internalError.

struct VideoEncodeClipParams: Decodable {
    let sourcePath: String
    let outputPath: String
    let scaleWidth: Int?
    let targetBitrateKbps: Int?
    let startSeconds: Double?
    let durationSeconds: Double?
    // Optional static-image overlay composited over every output frame. The TS
    // side JAILS overlayPath to a realpath inside the allowed media roots.
    let overlayPath: String?
    let overlayX: Int?
    let overlayY: Int?
    let overlayWidth: Int?
    let overlayOpacity: Double?
}

dispatcher.register("video.encodeClip") { params in
    let parsed: VideoEncodeClipParams
    do {
        parsed = try decodeParams(params, as: VideoEncodeClipParams.self)
    } catch {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "Invalid video.encodeClip params: \(error.localizedDescription)"
        )
    }
    do {
        let clip = try runBlocking { @Sendable [
            sourcePath = parsed.sourcePath,
            outputPath = parsed.outputPath,
            scaleWidth = parsed.scaleWidth,
            targetBitrateKbps = parsed.targetBitrateKbps,
            startSeconds = parsed.startSeconds,
            durationSeconds = parsed.durationSeconds,
            overlayPath = parsed.overlayPath,
            overlayX = parsed.overlayX,
            overlayY = parsed.overlayY,
            overlayWidth = parsed.overlayWidth,
            overlayOpacity = parsed.overlayOpacity
        ] in
            try await VideoFrameEncoder.encodeClip(
                sourcePath: sourcePath,
                outputPath: outputPath,
                scaleWidth: scaleWidth,
                targetBitrateKbps: targetBitrateKbps,
                startSeconds: startSeconds,
                durationSeconds: durationSeconds,
                overlayPath: overlayPath,
                overlayX: overlayX,
                overlayY: overlayY,
                overlayWidth: overlayWidth,
                overlayOpacity: overlayOpacity
            )
        }
        return clip.toJSONObject()
    } catch let err as VideoEncodeError {
        switch err {
        case .badInput(let message):
            throw JSONRPCError(code: JSONRPCErrorCode.invalidParams, message: message)
        case .encodeFailed(let message):
            throw JSONRPCError(code: JSONRPCErrorCode.internalError, message: message)
        }
    } catch let err as JSONRPCError {
        throw err
    } catch {
        throw JSONRPCError(code: JSONRPCErrorCode.internalError, message: error.localizedDescription)
    }
}

// `video.concatClips` — native AVFoundation concat-to-MP4: N AVAssetReaders →
// one AVAssetWriter. Mirrors `video.encodeClip`: decode params → runBlocking →
// map VideoEncodeError to JSONRPCError → return the metadata dict (`ok`,
// `width`, `height`, `durationMs` [TOTAL], `codec`, `usedHardware`,
// `segmentCount`). We do NOT return bytes — TS reads + deletes the file at
// outputPath. Each segment's coded dims are normalized into segment-0's output
// frame (aspect-fit letterbox over black). <1 segment / a segment with no video
// track / an HDR segment / a bad path → invalidParams; a zero-frame segment or
// a writer failure → internalError.

struct VideoConcatSegmentParams: Decodable {
    let sourcePath: String
    let startSeconds: Double?
    let durationSeconds: Double?
}

struct VideoConcatClipsParams: Decodable {
    let outputPath: String
    let segments: [VideoConcatSegmentParams]
    let scaleWidth: Int?
    let targetBitrateKbps: Int?
}

dispatcher.register("video.concatClips") { params in
    let parsed: VideoConcatClipsParams
    do {
        parsed = try decodeParams(params, as: VideoConcatClipsParams.self)
    } catch {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "Invalid video.concatClips params: \(error.localizedDescription)"
        )
    }
    do {
        let clip = try runBlocking { @Sendable [
            outputPath = parsed.outputPath,
            segments = parsed.segments.map {
                VideoConcatSegment(
                    sourcePath: $0.sourcePath,
                    startSeconds: $0.startSeconds,
                    durationSeconds: $0.durationSeconds
                )
            },
            scaleWidth = parsed.scaleWidth,
            targetBitrateKbps = parsed.targetBitrateKbps
        ] in
            try await VideoFrameEncoder.concatClips(
                outputPath: outputPath,
                segments: segments,
                scaleWidth: scaleWidth,
                targetBitrateKbps: targetBitrateKbps
            )
        }
        return clip.toJSONObject()
    } catch let err as VideoEncodeError {
        switch err {
        case .badInput(let message):
            throw JSONRPCError(code: JSONRPCErrorCode.invalidParams, message: message)
        case .encodeFailed(let message):
            throw JSONRPCError(code: JSONRPCErrorCode.internalError, message: message)
        }
    } catch let err as JSONRPCError {
        throw err
    } catch {
        throw JSONRPCError(code: JSONRPCErrorCode.internalError, message: error.localizedDescription)
    }
}

// `audio.mixdown` — native offline multitrack audio mixdown (C kernel + Swift
// AVFoundation/AudioToolbox glue): decode each WAV/M4A source to planar float32
// → the pure-C `tw_mix` kernel (gain/pan/fade/placement/soft-limit) → write a
// 16-bit PCM WAV (TPDF-dithered) or AAC .m4a at the TS-owned staging
// `outputPath`. Mirrors `video.encodeClip`: decode params → runBlocking → map
// AudioMixError to JSONRPCError → return the metadata dict (`durationMs`,
// `sampleRate`, `channels`, `codec`, `trackCount`). We do NOT return bytes — TS
// reads + deletes the file at outputPath. Empty tracks / a sample-rate-
// mismatched / >2ch / unreadable source / an over-cap decode → invalidParams; a
// kernel or writer failure → internalError.

struct AudioMixTrackParams: Decodable {
    let sourcePath: String
    let gainDb: Double?
    let pan: Double?
    let offsetMs: Double?
    let fadeInMs: Double?
    let fadeOutMs: Double?
}

struct AudioMixParams: Decodable {
    let outputPath: String
    let format: String
    let sampleRate: Int
    let channels: Int
    let bitrateKbps: Int?
    let tracks: [AudioMixTrackParams]
}

dispatcher.register("audio.mixdown") { params in
    let parsed: AudioMixParams
    do {
        parsed = try decodeParams(params, as: AudioMixParams.self)
    } catch {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "Invalid audio.mixdown params: \(error.localizedDescription)"
        )
    }
    do {
        let result = try runBlocking { @Sendable [
            outputPath = parsed.outputPath,
            format = parsed.format,
            sampleRate = parsed.sampleRate,
            channels = parsed.channels,
            bitrateKbps = parsed.bitrateKbps,
            tracks = parsed.tracks.map {
                AudioMixer.AudioMixTrack(
                    sourcePath: $0.sourcePath,
                    gainDb: Float($0.gainDb ?? 0),
                    pan: Float($0.pan ?? 0),
                    offsetMs: $0.offsetMs ?? 0,
                    fadeInMs: $0.fadeInMs ?? 0,
                    fadeOutMs: $0.fadeOutMs ?? 0
                )
            }
        ] in
            try await AudioMixer.mixdown(
                outputPath: outputPath,
                tracks: tracks,
                format: format,
                sampleRate: sampleRate,
                channels: channels,
                bitrateKbps: bitrateKbps
            )
        }
        return result.toJSONObject()
    } catch let err as AudioMixer.AudioMixError {
        switch err {
        case .badInput(let message):
            throw JSONRPCError(code: JSONRPCErrorCode.invalidParams, message: message)
        case .mixFailed(let message):
            throw JSONRPCError(code: JSONRPCErrorCode.internalError, message: message)
        }
    } catch let err as JSONRPCError {
        throw err
    } catch {
        throw JSONRPCError(code: JSONRPCErrorCode.internalError, message: error.localizedDescription)
    }
}

// `audio.windowClip` — cut a [startMs,endMs] WINDOW out of one source audio file
// and write it as a standalone 16-bit PCM WAV at the TS-owned staging `outputPath`.
// Backs `inspect_audio_segment`'s interactive playable clip: it REUSES AudioMixer's
// decode + frame-math + writeWAV (no second WAV writer) to slice the decoded float
// planes. Mirrors `audio.mixdown`: decode params → runBlocking → map AudioMixError to
// JSONRPCError → return the metadata dict (`durationMs`/`sampleRate`/`channels`/
// `codec`). We do NOT return bytes — TS reads + deletes the file at outputPath. An
// unreadable/>2ch source or an empty (post-clamp) window → invalidParams; a decode/
// writer failure → internalError.

struct AudioWindowClipParams: Decodable {
    let sourcePath: String
    let startMs: Int
    let endMs: Int
    let outputPath: String
}

dispatcher.register("audio.windowClip") { params in
    let parsed: AudioWindowClipParams
    do {
        parsed = try decodeParams(params, as: AudioWindowClipParams.self)
    } catch {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "Invalid audio.windowClip params: \(error.localizedDescription)"
        )
    }
    do {
        let result = try runBlocking { @Sendable [
            sourcePath = parsed.sourcePath,
            startMs = parsed.startMs,
            endMs = parsed.endMs,
            outputPath = parsed.outputPath
        ] in
            try await AudioMixer.windowClip(
                sourcePath: sourcePath,
                startMs: startMs,
                endMs: endMs,
                outputPath: outputPath
            )
        }
        return result.toJSONObject()
    } catch let err as AudioMixer.AudioMixError {
        switch err {
        case .badInput(let message):
            throw JSONRPCError(code: JSONRPCErrorCode.invalidParams, message: message)
        case .mixFailed(let message):
            throw JSONRPCError(code: JSONRPCErrorCode.internalError, message: message)
        }
    } catch let err as JSONRPCError {
        throw err
    } catch {
        throw JSONRPCError(code: JSONRPCErrorCode.internalError, message: error.localizedDescription)
    }
}

// `audio.transcribe` — native on-device speech-to-text (Speech framework's
// SFSpeechRecognizer): authorize → on-device-only recognize the (TS-jailed)
// audio file → return the transcript (`text`, per-segment `segments`,
// `localeIdentifier`, `onDevice`). Mirrors `audio.mixdown`: decode params →
// runBlocking → map AudioTranscriber.TranscribeError to JSONRPCError. PRIVACY:
// recognition is on-device ONLY (no network fallback). A denied permission or
// an unsupported/undownloaded locale surfaces as `invalidParams` with an
// actionable message (`.badInput`); a recognizer error → `internalError`.

struct AudioTranscribeParams: Decodable {
    let sourcePath: String
    let localeIdentifier: String?
}

dispatcher.register("audio.transcribe") { params in
    let parsed: AudioTranscribeParams
    do {
        parsed = try decodeParams(params, as: AudioTranscribeParams.self)
    } catch {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "Invalid audio.transcribe params: \(error.localizedDescription)"
        )
    }
    do {
        let result = try runBlocking { @Sendable [
            sourcePath = parsed.sourcePath,
            localeIdentifier = parsed.localeIdentifier
        ] in
            try await AudioTranscriber.transcribe(
                sourcePath: sourcePath,
                localeIdentifier: localeIdentifier
            )
        }
        return result.toJSONObject()
    } catch let err as AudioTranscriber.TranscribeError {
        switch err {
        case .badInput(let message):
            throw JSONRPCError(code: JSONRPCErrorCode.invalidParams, message: message)
        case .recognitionFailed(let message):
            throw JSONRPCError(code: JSONRPCErrorCode.internalError, message: message)
        }
    } catch let err as JSONRPCError {
        throw err
    } catch {
        throw JSONRPCError(code: JSONRPCErrorCode.internalError, message: error.localizedDescription)
    }
}

// MARK: - Document OCR
//
// `document.ocrImage` — on-device Vision OCR over an arbitrary image FILE,
// rather than the attached-window capture buffer. Same recognizer that has
// backed `attached_window_capture` since the appwatch work; this just exposes it
// to the document lane so a scanned/image-only PDF page can be read after
// rasterization. Runs entirely on-device (no network), like audio.transcribe.
//
// Params: `{ sourcePath: string }`. Returns `{ text, blocks }`.
// The sourcePath is realpath-jailed by the main process before it gets here.
struct DocumentOcrParams: Decodable {
    let sourcePath: String
}

dispatcher.register("document.ocrImage") { params in
    let parsed: DocumentOcrParams
    do {
        parsed = try decodeParams(params, as: DocumentOcrParams.self)
    } catch {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "Invalid document.ocrImage params: \(error.localizedDescription)"
        )
    }
    do {
        let result = try runBlocking { @Sendable [sourcePath = parsed.sourcePath] in
            try await AttachedWindowOCR.recognize(imageAtPath: sourcePath)
        }
        return result.toJSONObject()
    } catch let err as AttachedWindowOCR.OcrError {
        switch err {
        case .badInput(let message):
            throw JSONRPCError(code: JSONRPCErrorCode.invalidParams, message: message)
        }
    } catch let err as JSONRPCError {
        throw err
    } catch {
        throw JSONRPCError(code: JSONRPCErrorCode.internalError, message: error.localizedDescription)
    }
}

// MARK: - Creative-app probe (Phase K1)
//
// `creative.runningApplications` — answers "is bundle id X currently running?"
// for one or more requested bundle ids. Used by `creative_app_status` /
// `creative_app_capabilities` on the renderer side to upgrade the status
// snapshot from "installed" (a `fileExists` check) to "installed + running".
//
// Params shape: `{ bundleIds: [string] }`. Returns `{ [bundleId]: bool }`.
// Empty input → empty map; the renderer's caching layer treats that as a
// safe no-op.
dispatcher.register("creative.runningApplications") { params in
    let dict = (params as? [String: Any]) ?? [:]
    guard let bundleIds = dict["bundleIds"] as? [String] else {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "creative.runningApplications expects { bundleIds: [string] }"
        )
    }
    return CreativeAppProbe.runningBundleIds(bundleIds)
}

// MARK: - Creative-app file dispatch (Phase K3)
//
// `creative.openWithApp` — hand a file to a specific app via
// `NSWorkspace.shared.open(_:withApplicationAt:configuration:)`. The
// renderer is responsible for gating: scope the path, validate the
// bundle id against the declared creative-app set, and obtain user
// approval (Phase K3 approval modal). The Swift side just executes
// the transport.
//
// Params: `{ filePath: string, bundleId: string }`.
// Returns: `{ ok, bundleId, appURL, filePath, pid }`.
dispatcher.register("creative.openWithApp") { params in
    let dict = (params as? [String: Any]) ?? [:]
    guard let filePath = dict["filePath"] as? String, !filePath.isEmpty else {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "creative.openWithApp expects { filePath: string }"
        )
    }
    guard let bundleId = dict["bundleId"] as? String, !bundleId.isEmpty else {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "creative.openWithApp expects { bundleId: string }"
        )
    }
    return try CreativeWorkspaceOpener.openWithApp(filePath: filePath, bundleId: bundleId)
}

// `creative.runAppleScript` — execute an AppleScript source string in-
// process via OSAKit, with a default 10s timeout. Phase K4. The Swift
// side does NOT gate the call; the renderer-side
// `creative_applescript_dispatch` MCP tool is responsible for class
// approval before this method is invoked.
//
// Params: `{ source: string, timeoutMs?: number }`.
// Returns: `{ ok, result, durationMs }`. Compile + runtime errors
// surface as JSON-RPC error responses.
dispatcher.register("creative.runAppleScript") { params in
    let dict = (params as? [String: Any]) ?? [:]
    guard let source = dict["source"] as? String, !source.isEmpty else {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "creative.runAppleScript expects { source: string }"
        )
    }
    let timeoutMs = (dict["timeoutMs"] as? Int) ?? 10_000
    return try CreativeAppleScriptRunner.runScript(source: source, timeoutMs: timeoutMs)
}

// `creative.runBlenderPython` — execute a Python script inside Blender's
// `--background --python` mode via Process(). Phase K5. The script runs
// in a per-invocation sandbox tempdir set as Blender's cwd. The Swift
// side does NOT gate; the renderer-side `creative_blender_python` MCP
// tool handles class approval before dispatch.
//
// Params: `{ pythonSource: string, inputBlendPath?: string, timeoutMs?: number }`.
// Returns: `{ ok, exitCode, stdout, stderr, tempDir, durationMs }`.
dispatcher.register("creative.runBlenderPython") { params in
    let dict = (params as? [String: Any]) ?? [:]
    guard let pythonSource = dict["pythonSource"] as? String, !pythonSource.isEmpty else {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "creative.runBlenderPython expects { pythonSource: string }"
        )
    }
    let inputBlendPath = dict["inputBlendPath"] as? String
    let timeoutMs = (dict["timeoutMs"] as? Int) ?? 30_000
    return try CreativeBlenderPythonRunner.runScript(
        pythonSource: pythonSource,
        inputBlendPath: inputBlendPath,
        timeoutMs: timeoutMs
    )
}

// `creative.dispatchMIDI` — send a single MIDI event through the
// daemon's virtual "TaskWraith" Core MIDI source. Logic Pro (or any MIDI
// listener) can route this source as an input. Phase K6.
//
// Params: `{ eventType: string, ...event-specific params }`. See
// CreativeMIDITransport.buildEventBytes for the per-event shape.
dispatcher.register("creative.dispatchMIDI") { params in
    let dict = (params as? [String: Any]) ?? [:]
    guard let eventType = dict["eventType"] as? String, !eventType.isEmpty else {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "creative.dispatchMIDI expects { eventType: string }"
        )
    }
    return try CreativeMIDITransport.dispatchEvent(eventType: eventType, params: dict)
}

// MARK: - Phase L — Editor / IDE transports
//
// `editor.openAtPosition` — shell out to an editor's CLI shim with a
// pre-built positional arg list. The TS-side `EditorAdapters` knows
// the per-editor positional syntax; Swift just resolves the binary on
// PATH and runs it.
//
// Params: `{ cliCommand: string, args: [string], timeoutMs?: number }`.
// Returns: `{ ok, exitCode, cliCommand, resolvedPath, durationMs }`.
dispatcher.register("editor.openAtPosition") { params in
    let dict = (params as? [String: Any]) ?? [:]
    guard let cliCommand = dict["cliCommand"] as? String, !cliCommand.isEmpty else {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "editor.openAtPosition expects { cliCommand: string }"
        )
    }
    let args = (dict["args"] as? [String]) ?? []
    let timeoutMs = (dict["timeoutMs"] as? Int) ?? 5_000
    return try EditorPositionalOpener.openAtPosition(
        cliCommand: cliCommand,
        args: args,
        timeoutMs: timeoutMs
    )
}

// `workspace.revealInFinder` — open Finder with a specific file
// selected. Trivial wrapper around NSWorkspace.shared.selectFile.
// Params: `{ filePath: string }`.
dispatcher.register("workspace.revealInFinder") { params in
    let dict = (params as? [String: Any]) ?? [:]
    guard let filePath = dict["filePath"] as? String else {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "workspace.revealInFinder expects { filePath: string }"
        )
    }
    return try FinderReveal.reveal(filePath: filePath)
}

// MARK: - Dispatch loop

// Read JSON-RPC traffic one-line-per-message from stdin. Three kinds of
// inbound lines:
//   1. Inbound request (`{id, method, params}`) — `JSONRPCDispatcher`
//      handles it and we write the response back.
//   2. Inbound notification (`{method, params}` with no id) — dispatched
//      and the dispatcher returns nil.
//
// Concurrency model:
//   - Main thread: hosts NSApplication's run loop. `attachedWindow.requestPick`
//     drives `SCContentSharingPicker` here, which requires a main-actor
//     execution context. Other handlers don't touch main.
//   - Reader thread: a dedicated serial queue blocks on `readLine`, parses
//     one line at a time, fans out via `handlerQueue`. Lives off-main so
//     `readLine`'s blocking syscall never starves the runloop.
//   - Handler queue (concurrent): N handlers in flight; each safe because
//     they own their state (actors / @unchecked Sendable wrappers).
//   - Stdout writer: serial queue inside `BridgeStdoutWriter` keeps line
//     framing intact across all writers.
//
// On stdin EOF the reader thread terminates NSApplication, which returns
// from `NSApp.run()` and runs the post-loop shutdown.
let handlerQueue = DispatchQueue(
    label: "com.chrisizatt.taskwraith.daemon.handler",
    attributes: .concurrent
)
let stdinReaderQueue = DispatchQueue(label: "com.chrisizatt.taskwraith.daemon.stdin-reader")

stdinReaderQueue.async {
    while let line = readLine(strippingNewline: false) {
        handlerQueue.async {
            if let response = dispatcher.handleLine(line) {
                stdoutWriter.writeLine(response)
            }
        }
    }
    // stdin closed → parent terminated. First cancel a picker on the main
    // actor so any handler waiting on its continuation can finish. Then a
    // handler-queue barrier serializes terminal revocation with every native
    // AX action before asking AppKit to leave its run loop.
    DispatchQueue.main.async {
        AttachedWindowPicker.cancelActivePicker()
        handlerQueue.async(flags: .barrier) {
            shutdownAttachedWindowRuntime()
            DispatchQueue.main.async {
                NSApplication.shared.terminate(nil)
            }
        }
    }
}

// Hand the main thread to AppKit. The picker UI, when called, drives off
// this runloop; everything else runs on the reader/handler queues above.
// `terminate(nil)` from the reader thread is how this returns.
NSApplication.shared.run()

// NSApp.run() returned after the EOF barrier above (or unexpectedly). The
// barrier has already completed terminal lease revocation on ordinary EOF;
// repeat it defensively for an unexpected run-loop exit before flushing.
shutdownAttachedWindowRuntime()
handlerQueue.sync(flags: .barrier) {}
stdoutWriter.flush()
