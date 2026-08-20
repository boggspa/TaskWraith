#!/usr/bin/env swift

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

private let schemaVersion = 1
private let requestKind = "taskwraith-studio-accessibility-identity-probe-request"
private let receiptKind = "taskwraith-studio-accessibility-identity-probe-receipt"

enum ProbeFailure: Error, CustomStringConvertible {
  case refused(String)

  var description: String {
    switch self {
    case .refused(let message): return message
    }
  }
}

struct BoundsReceipt: Codable, Equatable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct ExpectedApplication {
  let pid: Int32
  let pgid: Int32
  let bundleIdentifier: String
  let executablePath: String
  let activationPolicy: String
  let dockLabel: String
}

struct ExpectedWindow {
  let windowId: UInt32
  let title: String
  let bounds: BoundsReceipt
}

struct ProbeRequest {
  let dockOwner: String
  let includeDock: Bool
  let maximumDepth: Int
  let maximumElements: Int
  let host: ExpectedApplication
  let companion: ExpectedApplication
  let window: ExpectedWindow
}

struct ApplicationReceipt: Codable {
  let pid: Int32
  let pgid: Int32
  let bundleIdentifier: String
  let executablePath: String
  let activationPolicy: String
  let isActive: Bool
  let dockLabel: String
}

struct WindowReceipt: Codable {
  let windowId: UInt32
  let title: String
  let ownerName: String
  let bounds: BoundsReceipt
  let accessibilityRole: String
  let accessibilityTitle: String
}

struct AccessibilityElementReceipt: Codable {
  let order: Int
  let path: String
  let depth: Int
  let role: String?
  let identifier: String?
  let label: String?
  let value: String?
  let enabled: Bool?
  let valueSettable: Bool
  let actions: [String]
  let frame: BoundsReceipt?
}

struct DockMembershipReceipt: Codable {
  let subject: String
  let label: String
  let matchCount: Int
}

struct DockReceipt: Codable {
  let requested: Bool
  let available: Bool
  let dockPid: Int32?
  let memberships: [DockMembershipReceipt]
}

struct FocusReceipt: Codable {
  let frontmostPid: Int32
  let frontmostBundleIdentifier: String
  let cursorX: Double
  let cursorY: Double
  let hostIsActive: Bool
  let companionIsActive: Bool
}

struct ProbeReceipt: Codable {
  let schemaVersion: Int
  let kind: String
  let dockOwner: String
  let recordedAt: String
  let host: ApplicationReceipt
  let companion: ApplicationReceipt
  let window: WindowReceipt
  let elements: [AccessibilityElementReceipt]
  let dock: DockReceipt
  let focus: FocusReceipt
}

func exactKeys(_ object: [String: Any], _ expected: Set<String>, _ label: String) throws {
  guard Set(object.keys) == expected else {
    throw ProbeFailure.refused("\(label) has an unexpected key set")
  }
}

func record(_ value: Any?, _ label: String) throws -> [String: Any] {
  guard let value = value as? [String: Any] else {
    throw ProbeFailure.refused("\(label) must be an object")
  }
  return value
}

func exactInteger(_ value: Any?, _ label: String) throws -> Int64 {
  guard let number = value as? NSNumber,
    CFGetTypeID(number) != CFBooleanGetTypeID(),
    let exact = Int64(number.stringValue)
  else {
    throw ProbeFailure.refused("\(label) must be an exact integer")
  }
  return exact
}

func exactString(_ value: Any?, _ label: String) throws -> String {
  guard let value = value as? String, !value.isEmpty else {
    throw ProbeFailure.refused("\(label) must be a non-empty string")
  }
  return value
}

func exactBoolean(_ value: Any?, _ label: String) throws -> Bool {
  guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
    throw ProbeFailure.refused("\(label) must be a boolean")
  }
  return number.boolValue
}

func finiteDouble(_ value: Any?, _ label: String) throws -> Double {
  guard let number = value as? NSNumber,
    CFGetTypeID(number) != CFBooleanGetTypeID(),
    number.doubleValue.isFinite
  else {
    throw ProbeFailure.refused("\(label) must be finite")
  }
  return number.doubleValue
}

func parseBounds(_ value: Any?, _ label: String) throws -> BoundsReceipt {
  let object = try record(value, label)
  try exactKeys(object, ["x", "y", "width", "height"], label)
  let bounds = BoundsReceipt(
    x: try finiteDouble(object["x"], "\(label).x"),
    y: try finiteDouble(object["y"], "\(label).y"),
    width: try finiteDouble(object["width"], "\(label).width"),
    height: try finiteDouble(object["height"], "\(label).height"))
  guard bounds.width > 0, bounds.height > 0 else {
    throw ProbeFailure.refused("\(label) is empty")
  }
  return bounds
}

func parseApplication(_ value: Any?, _ label: String) throws -> ExpectedApplication {
  let object = try record(value, label)
  try exactKeys(
    object,
    ["pid", "pgid", "bundleIdentifier", "executablePath", "activationPolicy", "dockLabel"],
    label)
  let pid = try exactInteger(object["pid"], "\(label).pid")
  let pgid = try exactInteger(object["pgid"], "\(label).pgid")
  guard pid > 0, pid <= Int64(Int32.max), pgid > 0, pgid <= Int64(Int32.max) else {
    throw ProbeFailure.refused("\(label) pid/pgid is outside Int32")
  }
  let policy = try exactString(object["activationPolicy"], "\(label).activationPolicy")
  guard ["regular", "accessory", "prohibited"].contains(policy) else {
    throw ProbeFailure.refused("\(label) activation policy is invalid")
  }
  return ExpectedApplication(
    pid: Int32(pid),
    pgid: Int32(pgid),
    bundleIdentifier: try exactString(object["bundleIdentifier"], "\(label).bundleIdentifier"),
    executablePath: try exactString(object["executablePath"], "\(label).executablePath"),
    activationPolicy: policy,
    dockLabel: try exactString(object["dockLabel"], "\(label).dockLabel"))
}

func parseRequest(_ data: Data) throws -> ProbeRequest {
  let raw = try JSONSerialization.jsonObject(with: data)
  let object = try record(raw, "request")
  try exactKeys(
    object,
    [
      "schemaVersion", "kind", "dockOwner", "includeDock", "maximumDepth",
      "maximumElements", "host", "companion", "window",
    ],
    "request")
  guard try exactInteger(object["schemaVersion"], "schemaVersion") == schemaVersion,
    try exactString(object["kind"], "kind") == requestKind
  else { throw ProbeFailure.refused("request schema identity is invalid") }
  let dockOwner = try exactString(object["dockOwner"], "dockOwner")
  guard dockOwner == "host" || dockOwner == "companion" else {
    throw ProbeFailure.refused("dockOwner must be host or companion")
  }
  let maximumDepth = try exactInteger(object["maximumDepth"], "maximumDepth")
  let maximumElements = try exactInteger(object["maximumElements"], "maximumElements")
  guard maximumDepth >= 1, maximumDepth <= 12, maximumElements >= 16,
    maximumElements <= 1_024
  else { throw ProbeFailure.refused("AX traversal bounds are invalid") }
  let windowObject = try record(object["window"], "window")
  try exactKeys(windowObject, ["windowId", "title", "bounds"], "window")
  let windowId = try exactInteger(windowObject["windowId"], "window.windowId")
  guard windowId > 0, windowId <= Int64(UInt32.max) else {
    throw ProbeFailure.refused("window.windowId is invalid")
  }
  return ProbeRequest(
    dockOwner: dockOwner,
    includeDock: try exactBoolean(object["includeDock"], "includeDock"),
    maximumDepth: Int(maximumDepth),
    maximumElements: Int(maximumElements),
    host: try parseApplication(object["host"], "host"),
    companion: try parseApplication(object["companion"], "companion"),
    window: ExpectedWindow(
      windowId: UInt32(windowId),
      title: try exactString(windowObject["title"], "window.title"),
      bounds: try parseBounds(windowObject["bounds"], "window.bounds")))
}

func policyName(_ policy: NSApplication.ActivationPolicy) -> String {
  switch policy {
  case .regular: return "regular"
  case .accessory: return "accessory"
  case .prohibited: return "prohibited"
  @unknown default: return "unknown"
  }
}

func standardizedPath(_ value: String) -> String {
  URL(fileURLWithPath: value).standardizedFileURL.path
}

func inspectApplication(_ expected: ExpectedApplication, _ label: String) throws
  -> (NSRunningApplication, ApplicationReceipt)
{
  guard let application = NSRunningApplication(processIdentifier: pid_t(expected.pid)),
    !application.isTerminated,
    let bundleIdentifier = application.bundleIdentifier,
    let executablePath = application.executableURL?.standardizedFileURL.path
  else { throw ProbeFailure.refused("\(label) running application is unavailable") }
  let pgid = getpgid(pid_t(expected.pid))
  let policy = policyName(application.activationPolicy)
  guard pgid == expected.pgid,
    bundleIdentifier == expected.bundleIdentifier,
    executablePath == standardizedPath(expected.executablePath),
    policy == expected.activationPolicy
  else {
    throw ProbeFailure.refused("\(label) process, bundle, executable, or activation policy changed")
  }
  return (
    application,
    ApplicationReceipt(
      pid: expected.pid,
      pgid: pgid,
      bundleIdentifier: bundleIdentifier,
      executablePath: executablePath,
      activationPolicy: policy,
      isActive: application.isActive,
      dockLabel: expected.dockLabel)
  )
}

func stringAttribute(_ name: String, _ element: AXUIElement) -> String? {
  var raw: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &raw) == .success else {
    return nil
  }
  return raw as? String
}

func booleanAttribute(_ name: String, _ element: AXUIElement) -> Bool? {
  var raw: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &raw) == .success,
    let number = raw as? NSNumber,
    CFGetTypeID(number) == CFBooleanGetTypeID()
  else { return nil }
  return number.boolValue
}

func valueAttribute(_ element: AXUIElement) -> String? {
  var raw: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &raw) == .success,
    let raw
  else { return nil }
  if let value = raw as? String { return value }
  if let number = raw as? NSNumber {
    return CFGetTypeID(number) == CFBooleanGetTypeID()
      ? (number.boolValue ? "true" : "false") : number.stringValue
  }
  return nil
}

func pointAttribute(_ name: String, _ element: AXUIElement) -> CGPoint? {
  var raw: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &raw) == .success,
    let raw,
    CFGetTypeID(raw) == AXValueGetTypeID(),
    case let value = unsafeBitCast(raw, to: AXValue.self),
    AXValueGetType(value) == .cgPoint
  else { return nil }
  var point = CGPoint.zero
  return AXValueGetValue(value, .cgPoint, &point) ? point : nil
}

func sizeAttribute(_ name: String, _ element: AXUIElement) -> CGSize? {
  var raw: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &raw) == .success,
    let raw,
    CFGetTypeID(raw) == AXValueGetTypeID(),
    case let value = unsafeBitCast(raw, to: AXValue.self),
    AXValueGetType(value) == .cgSize
  else { return nil }
  var size = CGSize.zero
  return AXValueGetValue(value, .cgSize, &size) ? size : nil
}

func frame(of element: AXUIElement) -> BoundsReceipt? {
  guard let point = pointAttribute(kAXPositionAttribute, element),
    let size = sizeAttribute(kAXSizeAttribute, element),
    [point.x, point.y, size.width, size.height].allSatisfy(\.isFinite)
  else { return nil }
  return BoundsReceipt(x: point.x, y: point.y, width: size.width, height: size.height)
}

func actions(of element: AXUIElement) -> [String] {
  var raw: CFArray?
  guard AXUIElementCopyActionNames(element, &raw) == .success,
    let names = raw as? [String]
  else { return [] }
  return names.sorted()
}

func children(of element: AXUIElement) throws -> [AXUIElement] {
  var raw: CFTypeRef?
  let status = AXUIElementCopyAttributeValue(
    element, kAXChildrenAttribute as CFString, &raw)
  if status == .noValue || status == .attributeUnsupported { return [] }
  guard status == .success, let raw, CFGetTypeID(raw) == CFArrayGetTypeID(),
    let children = raw as? [AXUIElement]
  else { throw ProbeFailure.refused("AX children could not be read exactly") }
  return children
}

func close(_ left: Double, _ right: Double) -> Bool { abs(left - right) <= 0.75 }

func exactWindow(_ request: ProbeRequest) throws -> (AXUIElement, WindowReceipt) {
  let rows =
    CGWindowListCopyWindowInfo(
      [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  let matches = rows.filter {
    ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == request.companion.pid
      && ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == request.window.windowId
      && ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
  }
  guard matches.count == 1, let row = matches.first,
    let title = row[kCGWindowName as String] as? String,
    let ownerName = row[kCGWindowOwnerName as String] as? String,
    let rawBounds = row[kCGWindowBounds as String] as? [String: Any],
    let x = (rawBounds["X"] as? NSNumber)?.doubleValue,
    let y = (rawBounds["Y"] as? NSNumber)?.doubleValue,
    let width = (rawBounds["Width"] as? NSNumber)?.doubleValue,
    let height = (rawBounds["Height"] as? NSNumber)?.doubleValue,
    title == request.window.title,
    close(x, request.window.bounds.x), close(y, request.window.bounds.y),
    close(width, request.window.bounds.width), close(height, request.window.bounds.height)
  else { throw ProbeFailure.refused("exact WindowServer workspace identity is unavailable") }

  let appElement = AXUIElementCreateApplication(pid_t(request.companion.pid))
  var rawWindows: CFTypeRef?
  guard
    AXUIElementCopyAttributeValue(
      appElement, kAXWindowsAttribute as CFString, &rawWindows) == .success,
    let windows = rawWindows as? [AXUIElement]
  else { throw ProbeFailure.refused("Companion AX windows are unreadable") }
  let axMatches = windows.filter {
    guard stringAttribute(kAXTitleAttribute, $0) == request.window.title,
      let point = pointAttribute(kAXPositionAttribute, $0),
      let size = sizeAttribute(kAXSizeAttribute, $0)
    else { return false }
    return close(point.x, request.window.bounds.x) && close(point.y, request.window.bounds.y)
      && close(size.width, request.window.bounds.width)
      && close(size.height, request.window.bounds.height)
  }
  guard axMatches.count == 1, let window = axMatches.first,
    let role = stringAttribute(kAXRoleAttribute, window),
    let axTitle = stringAttribute(kAXTitleAttribute, window)
  else { throw ProbeFailure.refused("exact Companion AX workspace is absent or duplicated") }
  return (
    window,
    WindowReceipt(
      windowId: request.window.windowId,
      title: title,
      ownerName: ownerName,
      bounds: BoundsReceipt(x: x, y: y, width: width, height: height),
      accessibilityRole: role,
      accessibilityTitle: axTitle)
  )
}

func orderedElements(
  from window: AXUIElement,
  maximumDepth: Int,
  maximumElements: Int
) throws -> [AccessibilityElementReceipt] {
  var queue: [(AXUIElement, String, Int)] = [(window, "window", 0)]
  var seen: [AXUIElement] = []
  var receipts: [AccessibilityElementReceipt] = []
  while !queue.isEmpty {
    let (element, path, depth) = queue.removeFirst()
    if seen.contains(where: { CFEqual($0, element) }) { continue }
    seen.append(element)
    guard seen.count <= maximumElements else {
      throw ProbeFailure.refused("AX tree exceeds the bounded element count")
    }
    let role = stringAttribute(kAXRoleAttribute, element)
    let identifier = stringAttribute(kAXIdentifierAttribute, element)
    let description = stringAttribute(kAXDescriptionAttribute, element)
    let title = stringAttribute(kAXTitleAttribute, element)
    var settable = DarwinBoolean(false)
    let settableStatus = AXUIElementIsAttributeSettable(
      element, kAXValueAttribute as CFString, &settable)
    if role != nil || identifier != nil || description != nil || title != nil {
      receipts.append(
        AccessibilityElementReceipt(
          order: receipts.count,
          path: path,
          depth: depth,
          role: role,
          identifier: identifier,
          label: description ?? title,
          value: valueAttribute(element),
          enabled: booleanAttribute(kAXEnabledAttribute, element),
          valueSettable: settableStatus == .success && settable.boolValue,
          actions: actions(of: element),
          frame: frame(of: element)))
    }
    let kids = try children(of: element)
    guard depth < maximumDepth else {
      guard kids.isEmpty else {
        throw ProbeFailure.refused("AX tree exceeds the bounded traversal depth")
      }
      continue
    }
    guard seen.count + queue.count + kids.count <= maximumElements else {
      throw ProbeFailure.refused("AX tree exceeds the bounded element count")
    }
    for (index, child) in kids.enumerated() {
      queue.append((child, "\(path)/\(index)", depth + 1))
    }
  }
  guard !receipts.isEmpty else { throw ProbeFailure.refused("AX tree is empty") }
  return receipts
}

func dockReceipt(_ request: ProbeRequest) throws -> DockReceipt {
  let requested = request.includeDock
  let empty = [
    DockMembershipReceipt(subject: "host", label: request.host.dockLabel, matchCount: 0),
    DockMembershipReceipt(
      subject: "companion", label: request.companion.dockLabel, matchCount: 0),
  ]
  guard requested,
    let dock = NSWorkspace.shared.runningApplications.first(where: {
      $0.bundleIdentifier == "com.apple.dock" && !$0.isTerminated
    })
  else {
    return DockReceipt(requested: requested, available: false, dockPid: nil, memberships: empty)
  }
  let root = AXUIElementCreateApplication(dock.processIdentifier)
  var queue: [(AXUIElement, Int)] = [(root, 0)]
  var seen: [AXUIElement] = []
  var counts = [request.host.dockLabel: 0, request.companion.dockLabel: 0]
  while !queue.isEmpty, seen.count < 1_024 {
    let (element, depth) = queue.removeFirst()
    if seen.contains(where: { CFEqual($0, element) }) { continue }
    seen.append(element)
    let label =
      stringAttribute(kAXDescriptionAttribute, element)
      ?? stringAttribute(kAXTitleAttribute, element)
    if let label, counts[label] != nil { counts[label, default: 0] += 1 }
    let kids = try children(of: element)
    guard depth < 8 else {
      guard kids.isEmpty else {
        throw ProbeFailure.refused("Dock AX tree exceeds the bounded traversal depth")
      }
      continue
    }
    guard seen.count + queue.count + kids.count <= 1_024 else {
      throw ProbeFailure.refused("Dock AX tree exceeds the bounded element count")
    }
    queue.append(contentsOf: kids.map { ($0, depth + 1) })
  }
  return DockReceipt(
    requested: true,
    available: true,
    dockPid: dock.processIdentifier,
    memberships: [
      DockMembershipReceipt(
        subject: "host", label: request.host.dockLabel,
        matchCount: counts[request.host.dockLabel] ?? 0),
      DockMembershipReceipt(
        subject: "companion", label: request.companion.dockLabel,
        matchCount: counts[request.companion.dockLabel] ?? 0),
    ])
}

func run(_ request: ProbeRequest) throws -> ProbeReceipt {
  guard AXIsProcessTrusted() else {
    throw ProbeFailure.refused("macOS Accessibility permission is unavailable")
  }
  let (hostApp, host) = try inspectApplication(request.host, "host")
  let (companionApp, companion) = try inspectApplication(request.companion, "companion")
  let (windowElement, window) = try exactWindow(request)
  guard let frontmost = NSWorkspace.shared.frontmostApplication,
    let frontmostBundleIdentifier = frontmost.bundleIdentifier,
    frontmost.processIdentifier > 0
  else { throw ProbeFailure.refused("frontmost application identity is unavailable") }
  let cursor = NSEvent.mouseLocation
  return ProbeReceipt(
    schemaVersion: schemaVersion,
    kind: receiptKind,
    dockOwner: request.dockOwner,
    recordedAt: ISO8601DateFormatter().string(from: Date()),
    host: host,
    companion: companion,
    window: window,
    elements: try orderedElements(
      from: windowElement,
      maximumDepth: request.maximumDepth,
      maximumElements: request.maximumElements),
    dock: try dockReceipt(request),
    focus: FocusReceipt(
      frontmostPid: frontmost.processIdentifier,
      frontmostBundleIdentifier: frontmostBundleIdentifier,
      cursorX: cursor.x,
      cursorY: cursor.y,
      hostIsActive: hostApp.isActive,
      companionIsActive: companionApp.isActive))
}

do {
  guard CommandLine.arguments.count == 2 else {
    throw ProbeFailure.refused("usage: studio-accessibility-identity-probe.swift REQUEST.json")
  }
  let requestURL = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
  let request = try parseRequest(Data(contentsOf: requestURL))
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys]
  FileHandle.standardOutput.write(try encoder.encode(run(request)))
  FileHandle.standardOutput.write(Data([0x0A]))
} catch {
  fputs("studio-accessibility-identity-probe: \(error)\n", stderr)
  exit(2)
}
