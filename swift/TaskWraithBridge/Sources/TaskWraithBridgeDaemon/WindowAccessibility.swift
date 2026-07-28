import AppKit
import ApplicationServices
import CryptoKit
import CoreGraphics
import Darwin
import Foundation

/// The Accessibility trust check is intentionally separate from actuation.
/// `requestUserPrompt()` must only be wired to a direct renderer user gesture;
/// an agent tool may read `status()` but must never cause the system prompt.
struct WindowAccessibilityPermissionState: Codable, Equatable, Sendable {
  let trusted: Bool
  let promptRequested: Bool
  let recheckRequired: Bool

  func toJSONObject() -> [String: Any] {
    [
      "trusted": trusted,
      "promptRequested": promptRequested,
      "recheckRequired": recheckRequired,
    ]
  }
}

enum WindowAccessibilityExecutionState: String, Codable, Sendable {
  /// A host precondition failed before an AX mutation API was called.
  case notExecuted
  /// AX reported success. This does not claim the target app performed a
  /// higher-level semantic operation unless `verification` says so.
  case executed
  /// AX returned an error at the mutation boundary. The caller must not retry
  /// automatically because the host cannot prove whether the app observed it.
  case unknown
}

enum WindowAccessibilityFailureCode: String, Codable, Sendable {
  case accessibilityPermissionMissing = "accessibility_permission_missing"
  case invalidRequest = "invalid_request"
  case selfTargetRefused = "self_target_refused"
  case processUnavailable = "process_unavailable"
  case processIdentityMismatch = "process_identity_mismatch"
  case windowUnavailable = "window_unavailable"
  case windowIdentityMismatch = "window_identity_mismatch"
  case windowNotVisible = "window_not_visible"
  case targetNotFocused = "target_not_focused"
  case axWindowNotFound = "ax_window_not_found"
  case ambiguousWindow = "ambiguous_window"
  case snapshotUnavailable = "snapshot_unavailable"
  case snapshotExpired = "snapshot_expired"
  case elementUnavailable = "element_unavailable"
  case elementChanged = "element_changed"
  case elementOutsideWindow = "element_outside_window"
  case elementDisabled = "element_disabled"
  case actionUnsupported = "action_unsupported"
  case notFillable = "not_fillable"
  case secureField = "secure_field"
  case secureFieldStatusUnknown = "secure_field_status_unknown"
  case valueTooLarge = "value_too_large"
  case userActive = "user_active"
  case userPresenceUnavailable = "user_presence_unavailable"
  case staleInputEpoch = "stale_input_epoch"
  case axFailure = "ax_failure"
}

struct WindowAccessibilityFailure: Error, LocalizedError, Equatable, Sendable {
  let code: WindowAccessibilityFailureCode
  let message: String
  let executionState: WindowAccessibilityExecutionState
  let details: [String: String]

  init(
    code: WindowAccessibilityFailureCode,
    message: String,
    executionState: WindowAccessibilityExecutionState = .notExecuted,
    details: [String: String] = [:]
  ) {
    self.code = code
    self.message = message
    self.executionState = executionState
    self.details = details
  }

  var errorDescription: String? { message }

  func toJSONObject() -> [String: Any] {
    [
      "ok": false,
      "errorCode": code.rawValue,
      "error": message,
      "executionState": executionState.rawValue,
      "details": details,
    ]
  }
}

/// Identity captured when the human picks the window.
///
/// `processLaunchTimeMicros` is required in addition to the PID so a recycled PID
/// cannot inherit an old attachment. The exact CGWindowID is re-read before
/// every snapshot and action, while `expectedBounds` binds the public-API AX
/// geometry fallback to picker metadata. Bundle id alone is never identity.
struct WindowAccessibilityTargetIdentity: Codable, Equatable, Hashable, Sendable {
  let pid: Int32
  let windowID: UInt32
  let bundleID: String
  let processLaunchTimeMicros: Int64
  let expectedBounds: WindowAccessibilityRect
}

struct WindowAccessibilityRect: Codable, Equatable, Hashable, Sendable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double

  init(_ rect: CGRect) {
    x = rect.origin.x
    y = rect.origin.y
    width = rect.size.width
    height = rect.size.height
  }

  var cgRect: CGRect {
    CGRect(x: x, y: y, width: width, height: height)
  }
}

struct WindowAccessibilityNode: Codable, Equatable, Sendable {
  let ref: String
  let parentRef: String?
  let childRefs: [String]
  let role: String
  let subrole: String?
  let title: String?
  let label: String?
  let identifier: String?
  let placeholder: String?
  let value: String?
  let frame: WindowAccessibilityRect?
  let enabled: Bool
  let focused: Bool
  let secure: Bool
  let actions: [String]
}

struct WindowAccessibilitySnapshot: Codable, Equatable, Sendable {
  let snapshotID: String
  let target: WindowAccessibilityTargetIdentity
  let createdAt: Date
  let inputEpoch: UInt64
  let rootRef: String
  let nodes: [WindowAccessibilityNode]
  let truncated: Bool
}

struct WindowAccessibilityQuery: Codable, Equatable, Sendable {
  let role: String?
  let subrole: String?
  let titleContains: String?
  let labelContains: String?
  let identifier: String?
  let supportsAction: String?
  let maxResults: Int?

  init(
    role: String? = nil,
    subrole: String? = nil,
    titleContains: String? = nil,
    labelContains: String? = nil,
    identifier: String? = nil,
    supportsAction: String? = nil,
    maxResults: Int? = nil
  ) {
    self.role = role
    self.subrole = subrole
    self.titleContains = titleContains
    self.labelContains = labelContains
    self.identifier = identifier
    self.supportsAction = supportsAction
    self.maxResults = maxResults
  }
}

struct WindowAccessibilityQueryResult: Codable, Equatable, Sendable {
  let snapshotID: String
  let target: WindowAccessibilityTargetIdentity
  let inputEpoch: UInt64
  let matches: [WindowAccessibilityNode]
  let snapshotTruncated: Bool
  let matchesTruncated: Bool
}

struct WindowAccessibilityAdoptionReceipt: Codable, Equatable, Sendable {
  let target: WindowAccessibilityTargetIdentity
  let title: String
  let viewport: WindowAccessibilityRect
}

enum WindowAccessibilityPostActionState: String, Codable, Equatable, Sendable {
  case changed
  case unchanged
  case unknown
}

struct WindowAccessibilityPostActionVerification: Codable, Equatable, Sendable {
  let actionID: String
  let verified: WindowAccessibilityPostActionState
}

struct WindowAccessibilityObservation: Codable, Equatable, Sendable {
  let observationID: String
  let inputEpoch: UInt64
  let snapshot: WindowAccessibilitySnapshot
  let actionVerification: WindowAccessibilityPostActionVerification?
}

struct WindowAccessibilityInspection: Codable, Equatable, Sendable {
  let observationID: String
  let inputEpoch: UInt64
  let node: WindowAccessibilityNode
}

/// Success means a complete, bounded AX walk of the exact selected window found
/// no secure field. Any secure field is conservatively capture-blocking, even
/// when AX does not reveal whether it currently contains text.
struct WindowAccessibilityCaptureSafetyReceipt: Encodable, Equatable, Sendable {
  let safe: Bool
  let target: WindowAccessibilityTargetIdentity
  let checkedAt: Date
  let nodesExamined: Int
  /// Monotonic input counter observed during the complete AX safety walk. It
  /// lets the capture RPC prove that no human input arrived while pixels were
  /// being acquired, without needing an event tap or Input Monitoring.
  let inputEpoch: UInt64
  /// Opaque, content-free digest of the complete AX safety walk. This is kept
  /// off the wire; it exists solely to reject a frame when the selected
  /// window's structural/secure-field state changes during async capture.
  let validationFingerprint: String

  private enum CodingKeys: String, CodingKey {
    case safe
    case target
    case checkedAt
    case nodesExamined
    case inputEpoch
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(safe, forKey: .safe)
    try container.encode(target, forKey: .target)
    try container.encode(checkedAt, forKey: .checkedAt)
    try container.encode(nodesExamined, forKey: .nodesExamined)
    try container.encode(inputEpoch, forKey: .inputEpoch)
  }
}

enum WindowAccessibilityActionVerification: String, Codable, Sendable {
  /// AXValue read-back exactly matched the requested value.
  case confirmed
  /// AX reported success but no reliable semantic postcondition is available.
  case unconfirmed
}

struct WindowAccessibilityActionReceipt: Codable, Equatable, Sendable {
  let ok: Bool
  let action: String
  let snapshotID: String
  let ref: String
  let executed: Bool
  let verification: WindowAccessibilityActionVerification

  func toJSONObject() -> [String: Any] {
    [
      "ok": ok,
      "action": action,
      "snapshotID": snapshotID,
      "ref": ref,
      "executed": executed,
      "verification": verification.rawValue,
    ]
  }
}

struct WindowAccessibilityNativeActionResult: Codable, Equatable, Sendable {
  let ok: Bool
  let found: Bool
  let executed: Bool
  let refusalReason: String?
  let message: String?
  let failureCode: WindowAccessibilityFailureCode?
  let executionState: WindowAccessibilityExecutionState
}

struct WindowAccessibilityActionAttempt: Codable, Equatable, Sendable {
  let observationID: String
  let inputEpoch: UInt64
  let actionID: String
  let result: WindowAccessibilityNativeActionResult
}

struct WindowAccessibilityReleaseReceipt: Codable, Equatable, Sendable {
  let target: WindowAccessibilityTargetIdentity
  let released: Bool
}

struct WindowAccessibilityConfiguration: Sendable {
  var maxNodes: Int = 400
  var maxDepth: Int = 12
  var maxChildrenPerNode: Int = 128
  var maxStoredSnapshots: Int = 8
  var snapshotTTL: TimeInterval = 30
  var maxQueryResults: Int = 50
  var maxFillCharacters: Int = 4_096
  var maxFillUTF8Bytes: Int = 16_384
  var maxWindowsPerApplication: Int = 64
  var geometryTolerance: CGFloat = 2
  /// Mirrors the Canvas human-takeover grace interval. AX mutations do not
  /// advance the HID event-source clock used by this guard.
  var minimumPhysicalInputIdle: TimeInterval = 1.5
  /// Main must supply the current host app/helper/consent-surface PIDs. Do not
  /// deny by bundle id: separately launched, user-selected TaskWraith children
  /// are legitimate external targets.
  var protectedHostPIDs: Set<Int32> = []
}

struct WindowAccessibilityProcessRecord: Equatable, Sendable {
  let pid: Int32
  let bundleID: String
  let launchTimeMicros: Int64?
  let isActive: Bool
  let isTerminated: Bool
}

struct WindowAccessibilityWindowRecord: Equatable, Sendable {
  let windowID: UInt32
  let ownerPID: Int32
  let title: String
  let bounds: CGRect
  let isOnscreen: Bool
}

/// Opaque AX element token. Production wraps `AXUIElement`; tests wrap a
/// synthetic reference object. Equality is delegated to the backend because AX
/// may vend distinct CF references for the same logical element.
final class WindowAccessibilityElement: @unchecked Sendable {
  let rawValue: AnyObject

  init(_ rawValue: AnyObject) {
    self.rawValue = rawValue
  }
}

struct WindowAccessibilityBackendError: Error, Equatable, Sendable {
  let operation: String
  let code: Int32
}

protocol WindowAccessibilityBackend: AnyObject {
  func isProcessTrusted(prompt: Bool) -> Bool
  func secondsSincePhysicalInput() -> TimeInterval?
  func physicalInputEpoch() -> UInt64?
  func processRecord(pid: Int32) -> WindowAccessibilityProcessRecord?
  func windowRecord(windowID: UInt32) -> WindowAccessibilityWindowRecord?
  func applicationElement(pid: Int32) throws -> WindowAccessibilityElement
  func pid(of element: WindowAccessibilityElement) throws -> Int32
  func stringAttribute(_ name: String, of element: WindowAccessibilityElement) throws -> String?
  func displayValueAttribute(of element: WindowAccessibilityElement) throws -> String?
  func boolAttribute(_ name: String, of element: WindowAccessibilityElement) throws -> Bool?
  func numberAttribute(_ name: String, of element: WindowAccessibilityElement) throws -> Int64?
  func pointAttribute(_ name: String, of element: WindowAccessibilityElement) throws -> CGPoint?
  func sizeAttribute(_ name: String, of element: WindowAccessibilityElement) throws -> CGSize?
  func elementAttribute(
    _ name: String,
    of element: WindowAccessibilityElement
  ) throws -> WindowAccessibilityElement?
  func elementArrayAttribute(
    _ name: String,
    of element: WindowAccessibilityElement
  ) throws -> [WindowAccessibilityElement]
  func actionNames(of element: WindowAccessibilityElement) throws -> [String]
  func isAttributeSettable(_ name: String, of element: WindowAccessibilityElement) throws -> Bool
  func performAction(_ name: String, on element: WindowAccessibilityElement) throws
  func setStringAttribute(
    _ name: String,
    value: String,
    on element: WindowAccessibilityElement
  ) throws
  func elementsEqual(_ lhs: WindowAccessibilityElement, _ rhs: WindowAccessibilityElement) -> Bool
}

final class SystemWindowAccessibilityBackend: WindowAccessibilityBackend {
  func isProcessTrusted(prompt: Bool) -> Bool {
    if !prompt {
      return AXIsProcessTrusted()
    }
    // The imported SDK symbol is a mutable global and therefore rejected by
    // Swift 6 strict concurrency. Its documented CFString value is stable.
    let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
    return AXIsProcessTrustedWithOptions(options)
  }

  func secondsSincePhysicalInput() -> TimeInterval? {
    // HID system state excludes synthetic AX operations and does not require
    // an event tap or Input Monitoring permission. The documented any-input
    // pseudo-type covers keyboard, mouse, and tablet events; an idle pointer
    // does not generate events, while movement and dragging reset this age.
    if Self.physicalMouseButtons.contains(where: {
      CGEventSource.buttonState(.hidSystemState, button: $0)
    }) {
      return 0
    }
    let age = CGEventSource.secondsSinceLastEventType(
      .hidSystemState,
      eventType: Self.anyInputEventType
    )
    return age.isFinite && age >= 0 ? age : nil
  }

  func physicalInputEpoch() -> UInt64? {
    Self.physicalEventTypes.reduce(into: UInt64(0)) { epoch, eventType in
      epoch &+= UInt64(
        CGEventSource.counterForEventType(
          .hidSystemState,
          eventType: eventType
        )
      )
    }
  }

  func processRecord(pid: Int32) -> WindowAccessibilityProcessRecord? {
    guard
      let application = NSRunningApplication(processIdentifier: pid_t(pid)),
      let launchTimeMicros = Self.processStartTimeMicros(pid: pid)
    else {
      return nil
    }
    return WindowAccessibilityProcessRecord(
      pid: pid,
      bundleID: application.bundleIdentifier ?? "",
      launchTimeMicros: launchTimeMicros,
      isActive: application.isActive,
      isTerminated: application.isTerminated
    )
  }

  /// Canonical process-start identity shared with AttachedWindow.
  ///
  /// `NSRunningApplication.launchDate` is presentation metadata and can differ
  /// slightly from the kernel's process start timestamp. Authority comparisons
  /// must use the exact `proc_bsdinfo` seconds/useconds tuple on both sides.
  static func processStartTimeMicros(pid: Int32) -> Int64? {
    guard pid > 0 else { return nil }
    var info = proc_bsdinfo()
    let expectedSize = Int32(MemoryLayout<proc_bsdinfo>.size)
    let written = proc_pidinfo(
      pid_t(pid),
      PROC_PIDTBSDINFO,
      0,
      &info,
      expectedSize
    )
    guard
      written == expectedSize,
      Int(info.pbi_pid) == Int(pid),
      info.pbi_start_tvsec > 0
    else {
      return nil
    }
    return Int64(info.pbi_start_tvsec) * 1_000_000
      + Int64(info.pbi_start_tvusec)
  }

  func windowRecord(windowID: UInt32) -> WindowAccessibilityWindowRecord? {
    guard
      let rows = CGWindowListCopyWindowInfo(
        [.optionIncludingWindow, .excludeDesktopElements],
        CGWindowID(windowID)
      ) as? [[String: Any]],
      let row = rows.first,
      let rowWindowID = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
      rowWindowID == windowID,
      let ownerPID = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
      let rawBounds = row[kCGWindowBounds as String] as? [String: Any],
      let bounds = CGRect(dictionaryRepresentation: rawBounds as CFDictionary)
    else {
      return nil
    }
    return WindowAccessibilityWindowRecord(
      windowID: rowWindowID,
      ownerPID: ownerPID,
      title: row[kCGWindowName as String] as? String ?? "",
      bounds: bounds,
      isOnscreen: (row[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false
    )
  }

  func applicationElement(pid: Int32) throws -> WindowAccessibilityElement {
    WindowAccessibilityElement(AXUIElementCreateApplication(pid_t(pid)))
  }

  func pid(of element: WindowAccessibilityElement) throws -> Int32 {
    var pid: pid_t = 0
    let result = AXUIElementGetPid(raw(element), &pid)
    try requireSuccess(result, operation: "AXUIElementGetPid")
    return Int32(pid)
  }

  func stringAttribute(_ name: String, of element: WindowAccessibilityElement) throws -> String? {
    try copyAttribute(name, of: element) as? String
  }

  func displayValueAttribute(of element: WindowAccessibilityElement) throws -> String? {
    guard let value = try copyAttribute(kAXValueAttribute as String, of: element) else {
      return nil
    }
    if let string = value as? String {
      return string
    }
    if let number = value as? NSNumber {
      return number.stringValue
    }
    return nil
  }

  func boolAttribute(_ name: String, of element: WindowAccessibilityElement) throws -> Bool? {
    (try copyAttribute(name, of: element) as? NSNumber)?.boolValue
  }

  func numberAttribute(_ name: String, of element: WindowAccessibilityElement) throws -> Int64? {
    (try copyAttribute(name, of: element) as? NSNumber)?.int64Value
  }

  func pointAttribute(_ name: String, of element: WindowAccessibilityElement) throws -> CGPoint? {
    guard
      let value = try copyAttribute(name, of: element),
      CFGetTypeID(value) == AXValueGetTypeID()
    else {
      return nil
    }
    let axValue = value as! AXValue
    guard AXValueGetType(axValue) == .cgPoint else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(axValue, .cgPoint, &point) ? point : nil
  }

  func sizeAttribute(_ name: String, of element: WindowAccessibilityElement) throws -> CGSize? {
    guard
      let value = try copyAttribute(name, of: element),
      CFGetTypeID(value) == AXValueGetTypeID()
    else {
      return nil
    }
    let axValue = value as! AXValue
    guard AXValueGetType(axValue) == .cgSize else { return nil }
    var size = CGSize.zero
    return AXValueGetValue(axValue, .cgSize, &size) ? size : nil
  }

  func elementAttribute(
    _ name: String,
    of element: WindowAccessibilityElement
  ) throws -> WindowAccessibilityElement? {
    guard
      let value = try copyAttribute(name, of: element),
      CFGetTypeID(value) == AXUIElementGetTypeID()
    else {
      return nil
    }
    return WindowAccessibilityElement(value as! AXUIElement)
  }

  func elementArrayAttribute(
    _ name: String,
    of element: WindowAccessibilityElement
  ) throws -> [WindowAccessibilityElement] {
    guard let value = try copyAttribute(name, of: element) else { return [] }
    guard let values = value as? [AnyObject] else { return [] }
    return values.compactMap { candidate in
      guard CFGetTypeID(candidate) == AXUIElementGetTypeID() else { return nil }
      return WindowAccessibilityElement(candidate)
    }
  }

  func actionNames(of element: WindowAccessibilityElement) throws -> [String] {
    var names: CFArray?
    let result = AXUIElementCopyActionNames(raw(element), &names)
    try requireSuccess(result, operation: "AXUIElementCopyActionNames")
    return (names as? [String]) ?? []
  }

  func isAttributeSettable(_ name: String, of element: WindowAccessibilityElement) throws -> Bool {
    var settable: DarwinBoolean = false
    let result = AXUIElementIsAttributeSettable(raw(element), name as CFString, &settable)
    try requireSuccess(result, operation: "AXUIElementIsAttributeSettable(\(name))")
    return settable.boolValue
  }

  func performAction(_ name: String, on element: WindowAccessibilityElement) throws {
    let result = AXUIElementPerformAction(raw(element), name as CFString)
    try requireSuccess(result, operation: "AXUIElementPerformAction(\(name))")
  }

  func setStringAttribute(
    _ name: String,
    value: String,
    on element: WindowAccessibilityElement
  ) throws {
    let result = AXUIElementSetAttributeValue(raw(element), name as CFString, value as CFString)
    try requireSuccess(result, operation: "AXUIElementSetAttributeValue(\(name))")
  }

  func elementsEqual(_ lhs: WindowAccessibilityElement, _ rhs: WindowAccessibilityElement) -> Bool {
    CFEqual(raw(lhs), raw(rhs))
  }

  private func raw(_ element: WindowAccessibilityElement) -> AXUIElement {
    element.rawValue as! AXUIElement
  }

  private func copyAttribute(
    _ name: String,
    of element: WindowAccessibilityElement
  ) throws -> CFTypeRef? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(raw(element), name as CFString, &value)
    switch result {
    case .success:
      return value
    case .noValue, .attributeUnsupported:
      return nil
    default:
      throw WindowAccessibilityBackendError(
        operation: "AXUIElementCopyAttributeValue(\(name))",
        code: result.rawValue
      )
    }
  }

  private func requireSuccess(_ result: AXError, operation: String) throws {
    guard result == .success else {
      throw WindowAccessibilityBackendError(operation: operation, code: result.rawValue)
    }
  }

  /// `kCGAnyInputEventType` is a C macro, so Swift imports it as a raw value
  /// rather than a named enum case.
  static let anyInputEventType = CGEventType(rawValue: UInt32.max)!

  static let physicalMouseButtons: [CGMouseButton] = [.left, .right, .center]

  /// Keep the epoch granular even though the idle clock uses any-input: the
  /// counter lets observations prove no pointer movement, drag, or tablet use
  /// happened between observe and act.
  static let physicalEventTypes: [CGEventType] = [
    .keyDown,
    .keyUp,
    .flagsChanged,
    .leftMouseDown,
    .leftMouseUp,
    .rightMouseDown,
    .rightMouseUp,
    .otherMouseDown,
    .otherMouseUp,
    .mouseMoved,
    .leftMouseDragged,
    .rightMouseDragged,
    .otherMouseDragged,
    .scrollWheel,
    .tabletPointer,
    .tabletProximity,
  ]
}

/// Bounded, AX-first access to one exact, human-picked external window.
///
/// There is deliberately no CGEvent fallback. An element must come from a
/// recent AX snapshot of the exact process/window identity, remain in that
/// window, and expose the explicit AX mutation being requested.
final class WindowAccessibilityAdapter: @unchecked Sendable {
  /// AX exposes a reliable secure-text-field subrole, but many custom controls
  /// expose a writable AXValue without enough type information to establish
  /// that they are not credential entry. Treat that ambiguity as sensitive:
  /// snapshots redact it, capture refuses, and no native action reaches it.
  private enum FieldSensitivity: String, Encodable, Equatable {
    case nonSensitive
    case secure
    case indeterminate
  }

  private struct ElementSignature: Equatable {
    let role: String
    let subrole: String?
    let title: String?
    let label: String?
    let identifier: String?
    let placeholder: String?
    let frame: WindowAccessibilityRect?
    let sensitivity: FieldSensitivity

    /// The wire format has a Boolean `secure` field. Mark indeterminate
    /// writable custom controls as secure too so no value crosses that
    /// boundary while the capture/action path carries the more precise cause.
    var secure: Bool { sensitivity != .nonSensitive }
  }

  private struct ElementState {
    let element: WindowAccessibilityElement
    let signature: ElementSignature
  }

  private struct SnapshotState {
    let snapshot: WindowAccessibilitySnapshot
    let elements: [String: ElementState]
  }

  private struct PendingAction {
    let actionID: String
    let baselineNodes: [WindowAccessibilityNode]
    let baselineTruncated: Bool
  }

  private enum ResolutionPurpose {
    case observe
    case actuate
  }

  private struct ResolvedTarget {
    let target: WindowAccessibilityTargetIdentity
    let process: WindowAccessibilityProcessRecord
    let windowRecord: WindowAccessibilityWindowRecord
    let applicationElement: WindowAccessibilityElement
    let windowElement: WindowAccessibilityElement
  }

  private struct PendingNode {
    let element: WindowAccessibilityElement
    let ref: String
    let parentRef: String?
    let depth: Int
  }

  private struct CaptureSafetyFingerprintNode: Encodable {
    let parentRef: String?
    let depth: Int
    let role: String
    let subrole: String?
    let title: String?
    let label: String?
    let identifier: String?
    let placeholder: String?
    let frame: WindowAccessibilityRect?
    let secure: Bool
    let sensitivity: FieldSensitivity
    let childCount: Int
  }

  private let backend: WindowAccessibilityBackend
  private let configuration: WindowAccessibilityConfiguration
  private let now: @Sendable () -> Date
  private let uuid: @Sendable () -> UUID
  private let lock = NSLock()
  private var snapshots: [String: SnapshotState] = [:]
  private var pendingActions: [WindowAccessibilityTargetIdentity: PendingAction] = [:]

  init(
    backend: WindowAccessibilityBackend = SystemWindowAccessibilityBackend(),
    configuration: WindowAccessibilityConfiguration = WindowAccessibilityConfiguration(),
    now: @escaping @Sendable () -> Date = { Date() },
    uuid: @escaping @Sendable () -> UUID = { UUID() }
  ) {
    self.backend = backend
    self.configuration = configuration
    self.now = now
    self.uuid = uuid
  }

  func status() -> WindowAccessibilityPermissionState {
    withLock {
      let trusted = backend.isProcessTrusted(prompt: false)
      return WindowAccessibilityPermissionState(
        trusted: trusted,
        promptRequested: false,
        recheckRequired: false
      )
    }
  }

  /// Call only after a direct human click in TaskWraith. Apple's prompt is
  /// asynchronous, so a false return is honest current state, not a denial.
  func requestUserPrompt() -> WindowAccessibilityPermissionState {
    withLock {
      let trusted = backend.isProcessTrusted(prompt: true)
      return WindowAccessibilityPermissionState(
        trusted: trusted,
        promptRequested: true,
        recheckRequired: !trusted
      )
    }
  }

  /// Validates and binds the exact process/window identity. The TypeScript
  /// bridge remains responsible for echoing its run-owned lease envelope.
  func adopt(
    target: WindowAccessibilityTargetIdentity
  ) throws -> WindowAccessibilityAdoptionReceipt {
    try withLock {
      try structured(operation: "adopt") {
        let resolved = try resolveTarget(target, purpose: .observe)
        snapshots = snapshots.filter { $0.value.snapshot.target != target }
        pendingActions.removeValue(forKey: target)
        return WindowAccessibilityAdoptionReceipt(
          target: target,
          title: resolved.windowRecord.title,
          viewport: WindowAccessibilityRect(resolved.windowRecord.bounds)
        )
      }
    }
  }

  /// Fresh AX observation with a physical-input epoch and the verification for
  /// exactly the preceding native action attempt, if any.
  func observe(
    target: WindowAccessibilityTargetIdentity
  ) throws -> WindowAccessibilityObservation {
    try withLock {
      try structured(operation: "observe") {
        let state = try snapshotLocked(target: target)
        let verification: WindowAccessibilityPostActionVerification?
        if let pending = pendingActions.removeValue(forKey: target) {
          let verified: WindowAccessibilityPostActionState
          if pending.baselineTruncated || state.snapshot.truncated {
            verified = .unknown
          } else if pending.baselineNodes == state.snapshot.nodes {
            verified = .unchanged
          } else {
            verified = .changed
          }
          verification = WindowAccessibilityPostActionVerification(
            actionID: pending.actionID,
            verified: verified
          )
        } else {
          verification = nil
        }
        return WindowAccessibilityObservation(
          observationID: state.snapshot.snapshotID,
          inputEpoch: state.snapshot.inputEpoch,
          snapshot: state.snapshot,
          actionVerification: verification
        )
      }
    }
  }

  func inspect(
    target: WindowAccessibilityTargetIdentity,
    observationID: String,
    inputEpoch: UInt64,
    ref: String
  ) throws -> WindowAccessibilityInspection {
    try withLock {
      try structured(operation: "inspect") {
        let state = try requireObservationState(
          target: target,
          observationID: observationID,
          inputEpoch: inputEpoch
        )
        guard let node = state.snapshot.nodes.first(where: { $0.ref == ref }) else {
          throw failure(
            .elementUnavailable,
            "The requested accessibility ref does not exist."
          )
        }
        guard let element = state.elements[ref] else {
          throw failure(
            .elementUnavailable,
            "The requested accessibility ref is unavailable."
          )
        }
        let resolved = try resolveTarget(target, purpose: .observe)
        guard try elementSignature(element.element) == element.signature else {
          throw failure(
            .elementChanged,
            "The accessibility element changed since the observation."
          )
        }
        try requireElement(
          element.element,
          belongsTo: resolved.windowElement,
          expectedPID: target.pid
        )
        return WindowAccessibilityInspection(
          observationID: observationID,
          inputEpoch: inputEpoch,
          node: node
        )
      }
    }
  }

  func release(
    target: WindowAccessibilityTargetIdentity
  ) -> WindowAccessibilityReleaseReceipt {
    withLock {
      let before = snapshots.count
      snapshots = snapshots.filter { $0.value.snapshot.target != target }
      let hadPending = pendingActions.removeValue(forKey: target) != nil
      return WindowAccessibilityReleaseReceipt(
        target: target,
        released: before != snapshots.count || hadPending
      )
    }
  }

  func snapshot(
    target: WindowAccessibilityTargetIdentity
  ) throws -> WindowAccessibilitySnapshot {
    try withLock {
      try structured(operation: "snapshot") {
        try snapshotLocked(target: target).snapshot
      }
    }
  }

  /// Takes a fresh bounded snapshot and filters only that snapshot. Query never
  /// broadens from the exact selected window into the owning application.
  func query(
    target: WindowAccessibilityTargetIdentity,
    query: WindowAccessibilityQuery
  ) throws -> WindowAccessibilityQueryResult {
    try withLock {
      try structured(operation: "query") {
        let state = try snapshotLocked(target: target)
        let requestedLimit = query.maxResults ?? configuration.maxQueryResults
        let limit = max(1, min(configuration.maxQueryResults, requestedLimit))
        let allMatches = state.snapshot.nodes.filter { node in
          matches(node: node, query: query)
        }
        return WindowAccessibilityQueryResult(
          snapshotID: state.snapshot.snapshotID,
          target: target,
          inputEpoch: state.snapshot.inputEpoch,
          matches: Array(allMatches.prefix(limit)),
          snapshotTruncated: state.snapshot.truncated,
          matchesTruncated: allMatches.count > limit
        )
      }
    }
  }

  /// AppDrive capture preflight. Existing Screen Watch capture deliberately
  /// does not call this method. The caller must capture immediately after a
  /// successful receipt and treat every thrown error as a capture refusal.
  func capture(
    target: WindowAccessibilityTargetIdentity,
    expectedInputEpoch: UInt64? = nil
  ) throws -> WindowAccessibilityCaptureSafetyReceipt {
    try withLock {
      try structured(operation: "check secure-field capture safety") {
        guard pendingActions[target] == nil else {
          throw failure(
            .invalidRequest,
            "Observe the selected window after the preceding native action before capturing."
          )
        }
        guard let captureInputEpoch = backend.physicalInputEpoch() else {
          throw failure(
            .secureFieldStatusUnknown,
            "AppDrive capture was refused because physical input freshness could not be determined."
          )
        }
        if let expectedInputEpoch, captureInputEpoch != expectedInputEpoch {
          throw failure(
            .staleInputEpoch,
            "The user interacted with the Mac during native capture; the frame was discarded."
          )
        }
        let resolved = try resolveTarget(target, purpose: .observe)
        let maxNodes = max(1, configuration.maxNodes)
        let maxDepth = max(0, configuration.maxDepth)
        let maxChildrenPerNode = max(0, configuration.maxChildrenPerNode)
        var seen: [WindowAccessibilityElement] = [resolved.windowElement]
        var queue: [PendingNode] = [
          PendingNode(
            element: resolved.windowElement,
            ref: "capture-root",
            parentRef: nil,
            depth: 0
          )
        ]
        var queueIndex = 0
        var complete = true
        var fingerprintNodes: [CaptureSafetyFingerprintNode] = []

        while queueIndex < queue.count, queueIndex < maxNodes {
          let pending = queue[queueIndex]
          queueIndex += 1
          let signature = try elementSignature(pending.element)
          switch signature.sensitivity {
          case .secure:
            // Do not inspect AXValue to distinguish empty from
            // nonempty. Presence itself is the conservative bound.
            throw failure(
              .secureField,
              "AppDrive capture is blocked while the selected window contains a secure field.",
              details: ["refusalReason": "secure_field"]
            )
          case .indeterminate:
            throw failure(
              .secureFieldStatusUnknown,
              "AppDrive capture was refused because a custom writable accessibility element could not be proven non-sensitive.",
              details: ["refusalReason": "secure_field_status_unknown"]
            )
          case .nonSensitive:
            break
          }

          let children = try backend.elementArrayAttribute(
            kAXChildrenAttribute as String,
            of: pending.element
          )
          fingerprintNodes.append(
            CaptureSafetyFingerprintNode(
              parentRef: pending.parentRef,
              depth: pending.depth,
              role: signature.role,
              subrole: signature.subrole,
              title: signature.title,
              label: signature.label,
              identifier: signature.identifier,
              placeholder: signature.placeholder,
              frame: signature.frame,
              secure: signature.secure,
              sensitivity: signature.sensitivity,
              childCount: children.count
            )
          )
          if pending.depth >= maxDepth {
            if !children.isEmpty {
              complete = false
            }
            continue
          }
          if children.count > maxChildrenPerNode {
            complete = false
          }
          for child in children.prefix(maxChildrenPerNode) {
            // Validate even a repeated child before treating it as a cycle:
            // a hostile AX hierarchy must never use a duplicate edge to skip
            // exact PID/window containment checks.
            try requireElement(
              child,
              belongsTo: resolved.windowElement,
              expectedPID: target.pid
            )
            if seen.contains(where: { backend.elementsEqual($0, child) }) {
              complete = false
              continue
            }
            if seen.count >= maxNodes {
              complete = false
              break
            }
            seen.append(child)
            queue.append(
              PendingNode(
                element: child,
                ref: "capture-\(seen.count)",
                parentRef: pending.ref,
                depth: pending.depth + 1
              )
            )
          }
        }
        if queueIndex < queue.count {
          complete = false
        }
        guard complete else {
          throw failure(
            .secureFieldStatusUnknown,
            "AppDrive capture was refused because the bounded AX walk could not determine secure-field status.",
            details: ["refusalReason": "secure_field_status_unknown"]
          )
        }

        // Revalidate process instance, exact window, geometry, and AX
        // correlation after the walk. A stale safety result is unsafe.
        _ = try resolveTarget(target, purpose: .observe)
        guard backend.physicalInputEpoch() == captureInputEpoch else {
          throw failure(
            .userActive,
            "The user interacted with the Mac during capture preflight; capture was refused."
          )
        }
        return WindowAccessibilityCaptureSafetyReceipt(
          safe: true,
          target: target,
          checkedAt: now(),
          nodesExamined: queueIndex,
          inputEpoch: captureInputEpoch,
          validationFingerprint: try captureSafetyFingerprint(fingerprintNodes)
        )
      }
    }
  }

  func requireCaptureSafe(
    target: WindowAccessibilityTargetIdentity
  ) throws -> WindowAccessibilityCaptureSafetyReceipt {
    try capture(target: target)
  }

  func click(
    target: WindowAccessibilityTargetIdentity,
    observationID: String,
    inputEpoch: UInt64,
    ref: String
  ) throws -> WindowAccessibilityActionAttempt {
    try withLock {
      try structured(operation: "click") {
        try actionAttemptLocked(
          target: target,
          observationID: observationID,
          inputEpoch: inputEpoch
        ) {
          try pressLocked(
            target: target,
            snapshotID: observationID,
            expectedInputEpoch: inputEpoch,
            ref: ref
          )
        }
      }
    }
  }

  func fill(
    target: WindowAccessibilityTargetIdentity,
    observationID: String,
    inputEpoch: UInt64,
    ref: String,
    value: String
  ) throws -> WindowAccessibilityActionAttempt {
    try withLock {
      try structured(operation: "fill") {
        try actionAttemptLocked(
          target: target,
          observationID: observationID,
          inputEpoch: inputEpoch
        ) {
          try fillLocked(
            target: target,
            snapshotID: observationID,
            expectedInputEpoch: inputEpoch,
            ref: ref,
            value: value
          )
        }
      }
    }
  }

  func press(
    target: WindowAccessibilityTargetIdentity,
    snapshotID: String,
    expectedInputEpoch: UInt64? = nil,
    ref: String
  ) throws -> WindowAccessibilityActionReceipt {
    try withLock {
      try structured(operation: "press") {
        try pressLocked(
          target: target,
          snapshotID: snapshotID,
          expectedInputEpoch: expectedInputEpoch,
          ref: ref
        )
      }
    }
  }

  /// Sets AXValue only on a small allowlist of ordinary editable roles.
  /// Secure or secret-labelled fields are refused before their current value
  /// is read and before any mutation API is called.
  func fill(
    target: WindowAccessibilityTargetIdentity,
    snapshotID: String,
    expectedInputEpoch: UInt64? = nil,
    ref: String,
    value: String
  ) throws -> WindowAccessibilityActionReceipt {
    try withLock {
      try structured(operation: "fill") {
        try fillLocked(
          target: target,
          snapshotID: snapshotID,
          expectedInputEpoch: expectedInputEpoch,
          ref: ref,
          value: value
        )
      }
    }
  }

  func invalidateAllSnapshots() {
    withLock {
      snapshots.removeAll()
      pendingActions.removeAll()
    }
  }

  func invalidateSnapshots(for target: WindowAccessibilityTargetIdentity) {
    withLock {
      snapshots = snapshots.filter { $0.value.snapshot.target != target }
      pendingActions.removeValue(forKey: target)
    }
  }

  private func pressLocked(
    target: WindowAccessibilityTargetIdentity,
    snapshotID: String,
    expectedInputEpoch: UInt64?,
    ref: String
  ) throws -> WindowAccessibilityActionReceipt {
    let (elementState, resolved) = try resolveActionElement(
      target: target,
      snapshotID: snapshotID,
      expectedInputEpoch: expectedInputEpoch,
      ref: ref
    )
    try requireNonSensitiveActionElement(elementState.signature, action: "press")
    let enabled =
      try backend.boolAttribute(
        kAXEnabledAttribute as String,
        of: elementState.element
      ) ?? true
    guard enabled else {
      throw failure(
        .elementDisabled,
        "The selected accessibility element is disabled."
      )
    }
    let actions = try backend.actionNames(of: elementState.element)
    guard actions.contains(kAXPressAction as String) else {
      throw failure(
        .actionUnsupported,
        "The selected element does not expose the AXPress action."
      )
    }
    try ensureFocused(resolved)
    try requireUserIdle(expectedInputEpoch: expectedInputEpoch)
    try ensureFocused(resolved)
    do {
      try backend.performAction(kAXPressAction as String, on: elementState.element)
    } catch {
      throw mutationFailure(error, operation: "AXPress")
    }
    return WindowAccessibilityActionReceipt(
      ok: true,
      action: "press",
      snapshotID: snapshotID,
      ref: ref,
      executed: true,
      verification: .unconfirmed
    )
  }

  private func fillLocked(
    target: WindowAccessibilityTargetIdentity,
    snapshotID: String,
    expectedInputEpoch: UInt64?,
    ref: String,
    value: String
  ) throws -> WindowAccessibilityActionReceipt {
    guard
      value.count <= configuration.maxFillCharacters,
      value.utf8.count <= configuration.maxFillUTF8Bytes
    else {
      throw failure(
        .valueTooLarge,
        "The proposed AXValue exceeds the bounded fill limit.",
        details: [
          "maxCharacters": String(configuration.maxFillCharacters),
          "maxUTF8Bytes": String(configuration.maxFillUTF8Bytes),
        ]
      )
    }

    let (elementState, resolved) = try resolveActionElement(
      target: target,
      snapshotID: snapshotID,
      expectedInputEpoch: expectedInputEpoch,
      ref: ref
    )
    try requireNonSensitiveActionElement(elementState.signature, action: "fill")
    let fillableRoles: Set<String> = [
      kAXTextFieldRole as String,
      kAXTextAreaRole as String,
      kAXComboBoxRole as String,
    ]
    guard fillableRoles.contains(elementState.signature.role) else {
      throw failure(
        .notFillable,
        "The selected element is not an allowlisted editable text role."
      )
    }
    let enabled =
      try backend.boolAttribute(
        kAXEnabledAttribute as String,
        of: elementState.element
      ) ?? true
    guard enabled else {
      throw failure(
        .elementDisabled,
        "The selected accessibility element is disabled."
      )
    }
    guard
      try backend.isAttributeSettable(
        kAXValueAttribute as String,
        of: elementState.element
      )
    else {
      throw failure(
        .notFillable,
        "The selected element does not expose a settable AXValue."
      )
    }
    try ensureFocused(resolved)
    try requireUserIdle(expectedInputEpoch: expectedInputEpoch)
    try ensureFocused(resolved)
    do {
      try backend.setStringAttribute(
        kAXValueAttribute as String,
        value: value,
        on: elementState.element
      )
    } catch {
      throw mutationFailure(error, operation: "AXValue")
    }
    let readBack = try? backend.displayValueAttribute(of: elementState.element)
    return WindowAccessibilityActionReceipt(
      ok: true,
      action: "fill",
      snapshotID: snapshotID,
      ref: ref,
      executed: true,
      verification: readBack == value ? .confirmed : .unconfirmed
    )
  }

  private func actionAttemptLocked(
    target: WindowAccessibilityTargetIdentity,
    observationID: String,
    inputEpoch: UInt64,
    action: () throws -> WindowAccessibilityActionReceipt
  ) throws -> WindowAccessibilityActionAttempt {
    guard pendingActions[target] == nil else {
      throw failure(
        .invalidRequest,
        "Observe the selected window before attempting another native action."
      )
    }
    let baseline = try requireObservationState(
      target: target,
      observationID: observationID,
      inputEpoch: nil
    )
    let actionID = uuid().uuidString.lowercased()
    let nativeResult: WindowAccessibilityNativeActionResult
    do {
      let receipt = try action()
      nativeResult = WindowAccessibilityNativeActionResult(
        ok: receipt.ok && receipt.executed,
        found: true,
        executed: receipt.executed,
        refusalReason: nil,
        message: nil,
        failureCode: nil,
        executionState: .executed
      )
    } catch {
      let actionFailure = backendFailure(error, operation: "perform native action")
      nativeResult = nativeActionResult(for: actionFailure)
    }
    pendingActions[target] = PendingAction(
      actionID: actionID,
      baselineNodes: baseline.snapshot.nodes,
      baselineTruncated: baseline.snapshot.truncated
    )
    return WindowAccessibilityActionAttempt(
      observationID: observationID,
      inputEpoch: inputEpoch,
      actionID: actionID,
      result: nativeResult
    )
  }

  private func nativeActionResult(
    for actionFailure: WindowAccessibilityFailure
  ) -> WindowAccessibilityNativeActionResult {
    let refusalReason: String?
    switch actionFailure.code {
    case .elementUnavailable:
      refusalReason = "not_found"
    case .secureField:
      refusalReason = "secret_field"
    case .userActive:
      refusalReason = "user_active"
    case .staleInputEpoch:
      refusalReason = "stale_input_epoch"
    case .notFillable, .actionUnsupported, .elementDisabled, .valueTooLarge:
      refusalReason = "not_fillable"
    case .axFailure where actionFailure.executionState == .unknown:
      refusalReason = nil
    default:
      refusalReason = "stale_target"
    }
    return WindowAccessibilityNativeActionResult(
      ok: false,
      found: actionFailure.code != .elementUnavailable,
      executed: false,
      refusalReason: refusalReason,
      message: actionFailure.message,
      failureCode: actionFailure.code,
      executionState: actionFailure.executionState
    )
  }

  private func snapshotLocked(
    target: WindowAccessibilityTargetIdentity
  ) throws -> SnapshotState {
    guard let inputEpoch = backend.physicalInputEpoch() else {
      throw failure(
        .userPresenceUnavailable,
        "Physical input epoch could not be read; the AX observation was refused."
      )
    }
    let resolved = try resolveTarget(target, purpose: .observe)
    let snapshotID = uuid().uuidString.lowercased()
    let createdAt = now()
    let maxNodes = max(1, configuration.maxNodes)
    let maxDepth = max(0, configuration.maxDepth)
    let maxChildrenPerNode = max(0, configuration.maxChildrenPerNode)
    var nodes: [WindowAccessibilityNode] = []
    var elementStates: [String: ElementState] = [:]
    var seen: [WindowAccessibilityElement] = [resolved.windowElement]
    var queue: [PendingNode] = [
      PendingNode(
        element: resolved.windowElement,
        ref: "e1",
        parentRef: nil,
        depth: 0
      )
    ]
    var queueIndex = 0
    var nextRef = 2
    var truncated = false

    while queueIndex < queue.count, nodes.count < maxNodes {
      let pending = queue[queueIndex]
      queueIndex += 1
      let signature = try elementSignature(pending.element)
      let actions = Array(
        Set(try backend.actionNames(of: pending.element)).sorted().prefix(32)
      )
      var childRefs: [String] = []

      if pending.depth < maxDepth {
        let rawChildren = try backend.elementArrayAttribute(
          kAXChildrenAttribute as String,
          of: pending.element
        )
        if rawChildren.count > maxChildrenPerNode {
          truncated = true
        }
        for child in rawChildren.prefix(maxChildrenPerNode) {
          // Preserve exact scope checking on cycles as well as fresh nodes;
          // only after it is known to belong to this window may a duplicate
          // reference be treated as a bounded traversal edge.
          try requireElement(
            child,
            belongsTo: resolved.windowElement,
            expectedPID: target.pid
          )
          if seen.contains(where: { backend.elementsEqual($0, child) }) {
            truncated = true
            continue
          }
          if seen.count >= maxNodes {
            truncated = true
            break
          }
          let childRef = "e\(nextRef)"
          nextRef += 1
          seen.append(child)
          childRefs.append(childRef)
          queue.append(
            PendingNode(
              element: child,
              ref: childRef,
              parentRef: pending.ref,
              depth: pending.depth + 1
            )
          )
        }
      } else if !(try backend.elementArrayAttribute(
        kAXChildrenAttribute as String,
        of: pending.element
      )).isEmpty {
        truncated = true
      }

      let value =
        signature.secure
        ? nil
        : bounded(try backend.displayValueAttribute(of: pending.element))
      nodes.append(
        WindowAccessibilityNode(
          ref: pending.ref,
          parentRef: pending.parentRef,
          childRefs: childRefs,
          role: signature.role,
          subrole: signature.subrole,
          title: signature.title,
          label: signature.label,
          identifier: signature.identifier,
          placeholder: signature.placeholder,
          value: value,
          frame: signature.frame,
          enabled:
            try backend.boolAttribute(
              kAXEnabledAttribute as String,
              of: pending.element
            ) ?? true,
          focused:
            try backend.boolAttribute(
              kAXFocusedAttribute as String,
              of: pending.element
            ) ?? false,
          secure: signature.secure,
          actions: actions
        )
      )
      elementStates[pending.ref] = ElementState(
        element: pending.element,
        signature: signature
      )
    }

    if queueIndex < queue.count {
      truncated = true
    }
    let materializedRefs = Set(nodes.map(\.ref))
    if nodes.contains(where: { node in
      node.childRefs.contains { !materializedRefs.contains($0) }
    }) {
      truncated = true
      nodes = nodes.map { node in
        let materializedChildren = node.childRefs.filter { materializedRefs.contains($0) }
        guard materializedChildren.count != node.childRefs.count else { return node }
        return WindowAccessibilityNode(
          ref: node.ref,
          parentRef: node.parentRef,
          childRefs: materializedChildren,
          role: node.role,
          subrole: node.subrole,
          title: node.title,
          label: node.label,
          identifier: node.identifier,
          placeholder: node.placeholder,
          value: node.value,
          frame: node.frame,
          enabled: node.enabled,
          focused: node.focused,
          secure: node.secure,
          actions: node.actions
        )
      }
    }
    guard backend.physicalInputEpoch() == inputEpoch else {
      throw failure(
        .userActive,
        "The user interacted with the Mac during the AX observation; observe again."
      )
    }
    let snapshot = WindowAccessibilitySnapshot(
      snapshotID: snapshotID,
      target: target,
      createdAt: createdAt,
      inputEpoch: inputEpoch,
      rootRef: "e1",
      nodes: nodes,
      truncated: truncated
    )
    let state = SnapshotState(snapshot: snapshot, elements: elementStates)
    snapshots[snapshotID] = state
    trimSnapshots()
    return state
  }

  private func resolveActionElement(
    target: WindowAccessibilityTargetIdentity,
    snapshotID: String,
    expectedInputEpoch: UInt64?,
    ref: String
  ) throws -> (ElementState, ResolvedTarget) {
    let normalizedRef = ref.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedRef.isEmpty else {
      throw failure(.invalidRequest, "snapshotID and ref are required.")
    }
    let state = try requireObservationState(
      target: target,
      observationID: snapshotID,
      inputEpoch: expectedInputEpoch
    )
    guard let elementState = state.elements[normalizedRef] else {
      throw failure(.elementUnavailable, "The requested accessibility ref does not exist.")
    }
    let resolved = try resolveTarget(target, purpose: .actuate)
    let currentSignature = try elementSignature(elementState.element)
    guard currentSignature == elementState.signature else {
      throw failure(
        .elementChanged,
        "The accessibility element changed since the snapshot; re-snapshot before acting."
      )
    }
    try requireElement(
      elementState.element,
      belongsTo: resolved.windowElement,
      expectedPID: target.pid
    )
    return (elementState, resolved)
  }

  private func requireObservationState(
    target: WindowAccessibilityTargetIdentity,
    observationID: String,
    inputEpoch: UInt64?
  ) throws -> SnapshotState {
    let normalizedID = observationID.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedID.isEmpty else {
      throw failure(.invalidRequest, "observationID is required.")
    }
    guard let state = snapshots[normalizedID] else {
      throw failure(
        .snapshotUnavailable,
        "The accessibility observation is unavailable; observe again."
      )
    }
    guard state.snapshot.target == target else {
      throw failure(
        .windowIdentityMismatch,
        "The observation belongs to a different process/window identity."
      )
    }
    guard now().timeIntervalSince(state.snapshot.createdAt) <= configuration.snapshotTTL else {
      snapshots.removeValue(forKey: normalizedID)
      throw failure(
        .snapshotExpired,
        "The accessibility observation expired; observe again before acting."
      )
    }
    if let inputEpoch {
      guard state.snapshot.inputEpoch == inputEpoch else {
        throw failure(
          .staleInputEpoch,
          "The supplied physical input epoch does not belong to this observation."
        )
      }
      guard let currentEpoch = backend.physicalInputEpoch() else {
        throw failure(
          .userPresenceUnavailable,
          "Physical input epoch could not be revalidated; the operation was refused."
        )
      }
      guard currentEpoch == inputEpoch else {
        throw failure(
          .staleInputEpoch,
          "The user interacted with the Mac after this observation; observe again."
        )
      }
    }
    return state
  }

  private func resolveTarget(
    _ target: WindowAccessibilityTargetIdentity,
    purpose: ResolutionPurpose
  ) throws -> ResolvedTarget {
    guard backend.isProcessTrusted(prompt: false) else {
      throw failure(
        .accessibilityPermissionMissing,
        "Accessibility access is not granted. The user must enable it from TaskWraith."
      )
    }
    guard
      target.pid > 1,
      target.windowID > 0,
      target.processLaunchTimeMicros > 0,
      !target.bundleID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      finitePositive(rect: target.expectedBounds.cgRect)
    else {
      throw failure(.invalidRequest, "The target identity is incomplete.")
    }
    if configuration.protectedHostPIDs.contains(target.pid) {
      throw failure(
        .selfTargetRefused,
        "TaskWraith refuses to observe or actuate its own process."
      )
    }
    guard
      let process = backend.processRecord(pid: target.pid),
      !process.isTerminated
    else {
      throw failure(.processUnavailable, "The selected application is no longer running.")
    }
    guard
      process.pid == target.pid,
      process.bundleID == target.bundleID,
      process.launchTimeMicros == target.processLaunchTimeMicros
    else {
      throw failure(
        .processIdentityMismatch,
        "The selected PID no longer belongs to the exact process instance the user picked."
      )
    }
    if purpose == .actuate, !process.isActive {
      throw failure(
        .targetNotFocused,
        "The selected application is not frontmost; TaskWraith will not actuate it."
      )
    }
    guard let windowRecord = backend.windowRecord(windowID: target.windowID) else {
      throw failure(.windowUnavailable, "The selected window is no longer available.")
    }
    guard
      windowRecord.windowID == target.windowID,
      windowRecord.ownerPID == target.pid,
      rectsMatch(windowRecord.bounds, target.expectedBounds.cgRect)
    else {
      throw failure(
        .windowIdentityMismatch,
        "The selected window id, owner, or picker-bound geometry no longer matches."
      )
    }
    guard
      windowRecord.isOnscreen,
      finitePositive(rect: windowRecord.bounds)
    else {
      throw failure(
        .windowNotVisible,
        "The selected window is minimized, offscreen, or has invalid geometry."
      )
    }
    let applicationElement: WindowAccessibilityElement
    do {
      applicationElement = try backend.applicationElement(pid: target.pid)
      guard try backend.pid(of: applicationElement) == target.pid else {
        throw failure(
          .processIdentityMismatch,
          "Accessibility returned a different application process."
        )
      }
    } catch let error as WindowAccessibilityFailure {
      throw error
    } catch {
      throw backendFailure(error, operation: "resolve application")
    }
    let windows = try backend.elementArrayAttribute(
      kAXWindowsAttribute as String,
      of: applicationElement
    )
    guard windows.count <= configuration.maxWindowsPerApplication else {
      throw failure(
        .ambiguousWindow,
        "The selected application exposes too many windows for bounded correlation."
      )
    }
    let windowElement = try correlateWindow(
      windows,
      target: target,
      windowRecord: windowRecord
    )
    let resolved = ResolvedTarget(
      target: target,
      process: process,
      windowRecord: windowRecord,
      applicationElement: applicationElement,
      windowElement: windowElement
    )
    if purpose == .actuate {
      try ensureFocused(resolved)
    }
    return resolved
  }

  private func correlateWindow(
    _ windows: [WindowAccessibilityElement],
    target: WindowAccessibilityTargetIdentity,
    windowRecord: WindowAccessibilityWindowRecord
  ) throws -> WindowAccessibilityElement {
    var geometryCandidates: [WindowAccessibilityElement] = []
    for window in windows {
      guard try backend.pid(of: window) == target.pid else { continue }
      let role = try backend.stringAttribute(kAXRoleAttribute as String, of: window)
      guard role == (kAXWindowRole as String) else { continue }
      guard
        let position = try backend.pointAttribute(
          kAXPositionAttribute as String,
          of: window
        ),
        let size = try backend.sizeAttribute(kAXSizeAttribute as String, of: window)
      else {
        continue
      }
      let axBounds = CGRect(origin: position, size: size)
      guard rectsMatch(axBounds, target.expectedBounds.cgRect) else { continue }
      let minimized =
        try backend.boolAttribute(kAXMinimizedAttribute as String, of: window) ?? false
      guard !minimized else { continue }
      geometryCandidates.append(window)
    }
    guard geometryCandidates.count == 1 else {
      if geometryCandidates.isEmpty {
        throw failure(
          .axWindowNotFound,
          "No AX window uniquely matches the selected CGWindowID and current geometry."
        )
      }
      throw failure(
        .ambiguousWindow,
        "Multiple AX windows match the selected window geometry; actuation was refused."
      )
    }
    return geometryCandidates[0]
  }

  private func ensureFocused(_ resolved: ResolvedTarget) throws {
    guard
      let currentProcess = backend.processRecord(pid: resolved.process.pid),
      !currentProcess.isTerminated,
      currentProcess.isActive,
      currentProcess.bundleID == resolved.process.bundleID,
      currentProcess.launchTimeMicros == resolved.target.processLaunchTimeMicros
    else {
      throw failure(
        .targetNotFocused,
        "The selected application lost foreground process identity before actuation."
      )
    }
    guard
      let focusedWindow = try backend.elementAttribute(
        kAXFocusedWindowAttribute as String,
        of: resolved.applicationElement
      ),
      backend.elementsEqual(focusedWindow, resolved.windowElement)
    else {
      throw failure(
        .targetNotFocused,
        "The exact selected window is not focused; TaskWraith will not actuate it."
      )
    }
    guard
      let currentWindow = backend.windowRecord(windowID: resolved.windowRecord.windowID),
      currentWindow.windowID == resolved.target.windowID,
      currentWindow.ownerPID == resolved.windowRecord.ownerPID,
      currentWindow.isOnscreen,
      rectsMatch(currentWindow.bounds, resolved.target.expectedBounds.cgRect),
      rectsMatch(currentWindow.bounds, resolved.windowRecord.bounds)
    else {
      throw failure(
        .windowIdentityMismatch,
        "The selected window identity changed before actuation."
      )
    }
  }

  private func requireElement(
    _ element: WindowAccessibilityElement,
    belongsTo window: WindowAccessibilityElement,
    expectedPID: Int32
  ) throws {
    guard try backend.pid(of: element) == expectedPID else {
      throw failure(
        .elementOutsideWindow,
        "The accessibility ref belongs to a different process."
      )
    }
    if backend.elementsEqual(element, window) {
      return
    }
    guard
      let elementWindow = try backend.elementAttribute(
        kAXWindowAttribute as String,
        of: element
      ),
      backend.elementsEqual(elementWindow, window)
    else {
      throw failure(
        .elementOutsideWindow,
        "The accessibility ref no longer belongs to the selected window."
      )
    }
  }

  private func requireUserIdle(expectedInputEpoch: UInt64?) throws {
    if let expectedInputEpoch {
      guard let currentEpoch = backend.physicalInputEpoch() else {
        throw failure(
          .userPresenceUnavailable,
          "Physical input epoch could not be revalidated; actuation was refused."
        )
      }
      guard currentEpoch == expectedInputEpoch else {
        throw failure(
          .staleInputEpoch,
          "The user interacted with the Mac after this observation; observe again."
        )
      }
    }
    guard let seconds = backend.secondsSincePhysicalInput() else {
      throw failure(
        .userPresenceUnavailable,
        "Physical user-presence status could not be determined; actuation was refused."
      )
    }
    guard seconds >= configuration.minimumPhysicalInputIdle else {
      throw failure(
        .userActive,
        "The user is physically interacting with the Mac; wait, then take a fresh snapshot.",
        details: [
          "idleSeconds": String(format: "%.3f", seconds),
          "requiredIdleSeconds": String(
            format: "%.3f",
            configuration.minimumPhysicalInputIdle
          ),
        ]
      )
    }
  }

  private func elementSignature(
    _ element: WindowAccessibilityElement
  ) throws -> ElementSignature {
    guard
      let role = try backend.stringAttribute(kAXRoleAttribute as String, of: element),
      !role.isEmpty
    else {
      throw failure(
        .elementUnavailable,
        "An accessibility element omitted its required AXRole."
      )
    }
    let subrole = bounded(
      try backend.stringAttribute(kAXSubroleAttribute as String, of: element)
    )
    let title = bounded(
      try backend.stringAttribute(kAXTitleAttribute as String, of: element)
    )
    let label = bounded(
      try backend.stringAttribute(kAXDescriptionAttribute as String, of: element)
    )
    let identifier = bounded(
      try backend.stringAttribute(kAXIdentifierAttribute as String, of: element)
    )
    let placeholder = bounded(
      try backend.stringAttribute(kAXPlaceholderValueAttribute as String, of: element)
    )
    let position = try backend.pointAttribute(kAXPositionAttribute as String, of: element)
    let size = try backend.sizeAttribute(kAXSizeAttribute as String, of: element)
    let frame: WindowAccessibilityRect?
    if let position, let size {
      let rect = CGRect(origin: position, size: size)
      frame = finite(rect: rect) ? WindowAccessibilityRect(rect) : nil
    } else {
      frame = nil
    }
    return ElementSignature(
      role: role,
      subrole: subrole,
      title: title,
      label: label,
      identifier: identifier,
      placeholder: placeholder,
      frame: frame,
      sensitivity: try fieldSensitivity(
        element: element,
        role: role,
        subrole: subrole,
        title: title,
        label: label,
        identifier: identifier,
        placeholder: placeholder
      )
    )
  }

  private func fieldSensitivity(
    element: WindowAccessibilityElement,
    role: String,
    subrole: String?,
    title: String?,
    label: String?,
    identifier: String?,
    placeholder: String?
  ) throws -> FieldSensitivity {
    if subrole == (kAXSecureTextFieldSubrole as String) {
      return .secure
    }
    if subrole?.localizedCaseInsensitiveContains("secure") == true {
      return .secure
    }
    let semanticText = [title, label, identifier, placeholder]
      .compactMap { $0?.lowercased() }
      .joined(separator: " ")
    let sensitiveMarkers = [
      "password",
      "passcode",
      "one-time",
      "one time",
      "otp",
      "secret",
      "token",
      "verification code",
      "security code",
      "cvv",
      "cvc",
      "pin",
    ]
    if sensitiveMarkers.contains(where: { semanticText.contains($0) }) {
      // Labels can add a conservative refusal but never prove the inverse:
      // custom/localized controls are evaluated structurally below.
      return .secure
    }
    guard !isStandardEditableTextRole(role) else {
      // Standard AX text roles remain usable when macOS did not designate
      // them as secure. This preserves ordinary localized text fields while
      // relying on the canonical AX secure subrole rather than English copy.
      return .nonSensitive
    }
    do {
      if try backend.isAttributeSettable(kAXValueAttribute as String, of: element) {
        return .indeterminate
      }
      return .nonSensitive
    } catch let error as WindowAccessibilityBackendError
      where error.code == AXError.attributeUnsupported.rawValue
    {
      // A custom non-editable control commonly rejects AXValue outright.
      return .nonSensitive
    } catch {
      // Do not interpret an unsupported/erroring custom AX value surface as
      // proof of safety. Snapshot redacts it and capture/action fail closed.
      return .indeterminate
    }
  }

  private func isStandardEditableTextRole(_ role: String) -> Bool {
    [
      kAXTextFieldRole as String,
      kAXTextAreaRole as String,
      kAXComboBoxRole as String,
    ].contains(role)
  }

  private func requireNonSensitiveActionElement(
    _ signature: ElementSignature,
    action: String
  ) throws {
    switch signature.sensitivity {
    case .nonSensitive:
      return
    case .secure:
      throw failure(
        .secureField,
        "Credential and secure fields are human-only; TaskWraith will not \(action) this element."
      )
    case .indeterminate:
      throw failure(
        .secureFieldStatusUnknown,
        "TaskWraith will not \(action) a custom writable accessibility element whose sensitive-field status is unknown."
      )
    }
  }

  private func captureSafetyFingerprint(
    _ nodes: [CaptureSafetyFingerprintNode]
  ) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(nodes)
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  private func matches(
    node: WindowAccessibilityNode,
    query: WindowAccessibilityQuery
  ) -> Bool {
    if let role = query.role, node.role != role { return false }
    if let subrole = query.subrole, node.subrole != subrole { return false }
    if let identifier = query.identifier, node.identifier != identifier { return false }
    if let titleContains = query.titleContains,
      node.title?.localizedCaseInsensitiveContains(titleContains) != true
    {
      return false
    }
    if let labelContains = query.labelContains,
      node.label?.localizedCaseInsensitiveContains(labelContains) != true
    {
      return false
    }
    if let action = query.supportsAction, !node.actions.contains(action) {
      return false
    }
    return true
  }

  private func trimSnapshots() {
    guard snapshots.count > configuration.maxStoredSnapshots else { return }
    let overflow = snapshots.count - configuration.maxStoredSnapshots
    let oldest = snapshots.values
      .sorted { $0.snapshot.createdAt < $1.snapshot.createdAt }
      .prefix(overflow)
      .map(\.snapshot.snapshotID)
    for snapshotID in oldest {
      snapshots.removeValue(forKey: snapshotID)
    }
  }

  private func mutationFailure(_ error: Error, operation: String) -> WindowAccessibilityFailure {
    let details: [String: String]
    if let backendError = error as? WindowAccessibilityBackendError {
      details = [
        "operation": backendError.operation,
        "axError": String(backendError.code),
      ]
    } else {
      details = ["operation": operation]
    }
    return failure(
      .axFailure,
      "\(operation) returned an accessibility error; execution cannot be confirmed.",
      executionState: .unknown,
      details: details
    )
  }

  private func backendFailure(_ error: Error, operation: String) -> WindowAccessibilityFailure {
    if let failure = error as? WindowAccessibilityFailure {
      return failure
    }
    if let backendError = error as? WindowAccessibilityBackendError {
      return failure(
        .axFailure,
        "Accessibility failed while attempting to \(operation).",
        details: [
          "operation": backendError.operation,
          "axError": String(backendError.code),
        ]
      )
    }
    return failure(
      .axFailure,
      "Accessibility failed while attempting to \(operation)."
    )
  }

  private func structured<T>(
    operation: String,
    _ body: () throws -> T
  ) throws -> T {
    do {
      return try body()
    } catch let error as WindowAccessibilityFailure {
      throw error
    } catch {
      throw backendFailure(error, operation: operation)
    }
  }

  private func failure(
    _ code: WindowAccessibilityFailureCode,
    _ message: String,
    executionState: WindowAccessibilityExecutionState = .notExecuted,
    details: [String: String] = [:]
  ) -> WindowAccessibilityFailure {
    WindowAccessibilityFailure(
      code: code,
      message: message,
      executionState: executionState,
      details: details
    )
  }

  private func bounded(_ value: String?) -> String? {
    guard let value else { return nil }
    if value.count <= 256 { return value }
    return String(value.prefix(256))
  }

  private func finite(rect: CGRect) -> Bool {
    rect.origin.x.isFinite
      && rect.origin.y.isFinite
      && rect.size.width.isFinite
      && rect.size.height.isFinite
  }

  private func finitePositive(rect: CGRect) -> Bool {
    finite(rect: rect) && rect.width > 0 && rect.height > 0
  }

  private func rectsMatch(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
    abs(lhs.origin.x - rhs.origin.x) <= configuration.geometryTolerance
      && abs(lhs.origin.y - rhs.origin.y) <= configuration.geometryTolerance
      && abs(lhs.size.width - rhs.size.width) <= configuration.geometryTolerance
      && abs(lhs.size.height - rhs.size.height) <= configuration.geometryTolerance
  }

  private func withLock<T>(_ body: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try body()
  }
}
