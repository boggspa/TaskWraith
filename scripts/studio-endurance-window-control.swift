#!/usr/bin/env swift

import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

struct WindowControlRequest: Codable {
  let schemaVersion: Int
  let kind: String
  let expectedPid: Int32
  let expectedPgid: Int32
  let expectedExecutablePath: String
  let windowId: UInt32
  let windowTitle: String
  let timeoutMilliseconds: Int
}

struct WindowControlReceipt: Codable {
  let schemaVersion: Int
  let kind: String
  let pid: Int32
  let pgid: Int32
  let executablePath: String
  let windowId: UInt32
  let windowTitle: String
  let accessibilityRole: String
  let accessibilityAction: String
  let stateBefore: String
  let stateAfter: String
  let focusIsolation: FocusIsolationReceipt
  let recordedAt: String
}

struct FocusSnapshot {
  let frontmostPid: Int32
  let frontmostBundleIdentifier: String?
  let targetActive: Bool
  let cursorX: Double
  let cursorY: Double
}

struct FocusIsolationReceipt: Codable {
  let frontmostPidBefore: Int32
  let frontmostPidAfter: Int32
  let frontmostBundleIdentifierBefore: String?
  let frontmostBundleIdentifierAfter: String?
  let targetActiveBefore: Bool
  let targetActiveAfter: Bool
  let cursorXBefore: Double
  let cursorYBefore: Double
  let cursorXAfter: Double
  let cursorYAfter: Double
  let focusPreserved: Bool
  let cursorPreserved: Bool
}

enum WindowControlFailure: Error, CustomStringConvertible {
  case refused(String)

  var description: String {
    switch self {
    case .refused(let message): return message
    }
  }
}

let expectedRequestKeys: Set<String> = [
  "schemaVersion",
  "kind",
  "expectedPid",
  "expectedPgid",
  "expectedExecutablePath",
  "windowId",
  "windowTitle",
  "timeoutMilliseconds",
]

func readRequest() throws -> WindowControlRequest {
  guard CommandLine.arguments.count == 2 else {
    throw WindowControlFailure.refused(
      "usage: studio-endurance-window-control.swift <request.json>"
    )
  }
  let requestURL = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
  guard requestURL.path.hasPrefix("/") else {
    throw WindowControlFailure.refused("request path must be absolute")
  }
  let values = try requestURL.resourceValues(forKeys: [
    .isRegularFileKey,
    .isSymbolicLinkKey,
    .fileSizeKey,
  ])
  guard values.isRegularFile == true, values.isSymbolicLink != true else {
    throw WindowControlFailure.refused("request must be a regular non-symlink file")
  }
  guard let byteLength = values.fileSize, byteLength > 0, byteLength <= 65_536 else {
    throw WindowControlFailure.refused("request byte length is outside 1...65536")
  }
  let data = try Data(contentsOf: requestURL, options: .mappedIfSafe)
  guard
    let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
    Set(object.keys) == expectedRequestKeys
  else {
    throw WindowControlFailure.refused("request has missing or extra top-level keys")
  }
  let request = try JSONDecoder().decode(WindowControlRequest.self, from: data)
  guard
    request.schemaVersion == 1,
    request.kind == "taskwraith-studio-endurance-window-control-request",
    request.expectedPid > 1,
    request.expectedPgid > 1,
    request.windowId > 0,
    request.windowTitle == "TaskWraith Studio",
    request.timeoutMilliseconds >= 1_000,
    request.timeoutMilliseconds <= 10_000
  else {
    throw WindowControlFailure.refused("request values are outside the closed contract")
  }
  let executable = URL(fileURLWithPath: request.expectedExecutablePath).standardizedFileURL
  guard
    executable.path.hasPrefix("/"),
    executable.lastPathComponent == "TaskWraithStudioCompanion",
    !executable.path.hasPrefix("/Applications/TaskWraith.app/")
  else {
    throw WindowControlFailure.refused("installed or inexact Companion is never a target")
  }
  return request
}

func exactProcess(_ request: WindowControlRequest) throws -> NSRunningApplication {
  let livePgid = getpgid(pid_t(request.expectedPid))
  guard livePgid == request.expectedPgid else {
    throw WindowControlFailure.refused(
      "process group changed: expected \(request.expectedPgid), observed \(livePgid)"
    )
  }
  guard
    let application = NSRunningApplication(
      processIdentifier: pid_t(request.expectedPid)
    ),
    !application.isTerminated,
    let executableURL = application.executableURL?.standardizedFileURL,
    executableURL.path
      == URL(fileURLWithPath: request.expectedExecutablePath).standardizedFileURL.path
  else {
    throw WindowControlFailure.refused("exact Companion executable is unavailable")
  }
  return application
}

func visibleWindowRows(pid: Int32) -> [[String: Any]] {
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  let rows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
  return rows.filter { row in
    let owner = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
    let layer = (row[kCGWindowLayer as String] as? NSNumber)?.intValue
    return owner == pid && layer == 0
  }
}

func validateExactVisibleWindow(_ request: WindowControlRequest) throws {
  let matches = visibleWindowRows(pid: request.expectedPid).filter { row in
    let identifier = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value
    let title = row[kCGWindowName as String] as? String
    return identifier == request.windowId && title == request.windowTitle
  }
  guard matches.count == 1 else {
    throw WindowControlFailure.refused("exact visible Studio window is unavailable")
  }
}

func stringAttribute(_ attribute: String, of element: AXUIElement) -> String? {
  var raw: CFTypeRef?
  guard
    AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success
  else {
    return nil
  }
  return raw as? String
}

func exactAccessibilityWindow(_ request: WindowControlRequest) throws -> AXUIElement {
  guard AXIsProcessTrusted() else {
    throw WindowControlFailure.refused("macOS Accessibility access is unavailable")
  }
  let application = AXUIElementCreateApplication(pid_t(request.expectedPid))
  var rawWindows: CFTypeRef?
  guard
    AXUIElementCopyAttributeValue(
      application,
      kAXWindowsAttribute as CFString,
      &rawWindows
    ) == .success,
    let windows = rawWindows as? [AXUIElement]
  else {
    throw WindowControlFailure.refused("Companion accessibility windows are unreadable")
  }
  let matches = windows.filter {
    stringAttribute(kAXTitleAttribute, of: $0) == request.windowTitle
  }
  guard matches.count == 1, let window = matches.first else {
    throw WindowControlFailure.refused("exact accessibility window is unavailable")
  }
  return window
}

func exactCloseButton(in window: AXUIElement) throws -> AXUIElement {
  var rawClose: CFTypeRef?
  guard
    AXUIElementCopyAttributeValue(
      window,
      kAXCloseButtonAttribute as CFString,
      &rawClose
    ) == .success,
    let rawClose,
    CFGetTypeID(rawClose) == AXUIElementGetTypeID()
  else {
    throw WindowControlFailure.refused("exact window close button is unavailable")
  }
  let close = unsafeBitCast(rawClose, to: AXUIElement.self)
  guard stringAttribute(kAXRoleAttribute, of: close) == kAXButtonRole else {
    throw WindowControlFailure.refused("window close control is not an AXButton")
  }
  var enabled: CFTypeRef?
  guard
    AXUIElementCopyAttributeValue(close, kAXEnabledAttribute as CFString, &enabled)
      == .success,
    (enabled as? NSNumber)?.boolValue == true
  else {
    throw WindowControlFailure.refused("window close control is disabled")
  }
  var rawActions: CFArray?
  guard
    AXUIElementCopyActionNames(close, &rawActions) == .success,
    let actions = rawActions as? [String],
    actions.contains(kAXPressAction)
  else {
    throw WindowControlFailure.refused("window close control has no AXPress action")
  }
  return close
}

func focusSnapshot(
  target: NSRunningApplication
) throws -> FocusSnapshot {
  guard let frontmost = NSWorkspace.shared.frontmostApplication else {
    throw WindowControlFailure.refused("frontmost application is unavailable")
  }
  let cursor = NSEvent.mouseLocation
  return FocusSnapshot(
    frontmostPid: frontmost.processIdentifier,
    frontmostBundleIdentifier: frontmost.bundleIdentifier,
    targetActive: target.isActive,
    cursorX: cursor.x,
    cursorY: cursor.y
  )
}

func validateFocusIsolation(
  before: FocusSnapshot,
  after: FocusSnapshot,
  targetPid: Int32
) throws -> FocusIsolationReceipt {
  let focusPreserved =
    before.frontmostPid != targetPid && before.frontmostPid == after.frontmostPid
    && before.frontmostBundleIdentifier == after.frontmostBundleIdentifier && !before.targetActive
    && !after.targetActive
  let cursorPreserved =
    abs(before.cursorX - after.cursorX) <= 0.5 && abs(before.cursorY - after.cursorY) <= 0.5
  guard focusPreserved, cursorPreserved else {
    throw WindowControlFailure.refused(
      "background close changed focus, target activity, or cursor position"
    )
  }
  return FocusIsolationReceipt(
    frontmostPidBefore: before.frontmostPid,
    frontmostPidAfter: after.frontmostPid,
    frontmostBundleIdentifierBefore: before.frontmostBundleIdentifier,
    frontmostBundleIdentifierAfter: after.frontmostBundleIdentifier,
    targetActiveBefore: before.targetActive,
    targetActiveAfter: after.targetActive,
    cursorXBefore: before.cursorX,
    cursorYBefore: before.cursorY,
    cursorXAfter: after.cursorX,
    cursorYAfter: after.cursorY,
    focusPreserved: focusPreserved,
    cursorPreserved: cursorPreserved
  )
}

func waitForExactClosure(_ request: WindowControlRequest) throws {
  let deadline = Date().addingTimeInterval(
    Double(request.timeoutMilliseconds) / 1_000
  )
  while Date() <= deadline {
    _ = try exactProcess(request)
    let rows = visibleWindowRows(pid: request.expectedPid)
    let originalRemains = rows.contains { row in
      (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value == request.windowId
    }
    let titledStudioWindows = rows.filter {
      ($0[kCGWindowName as String] as? String) == request.windowTitle
    }
    if !originalRemains && titledStudioWindows.isEmpty {
      return
    }
    Thread.sleep(forTimeInterval: 0.05)
  }
  throw WindowControlFailure.refused("exact Studio window did not close before timeout")
}

func isoTimestamp() -> String {
  ISO8601DateFormatter().string(from: Date())
}

do {
  let request = try readRequest()
  let application = try exactProcess(request)
  _ = application
  try validateExactVisibleWindow(request)
  let window = try exactAccessibilityWindow(request)
  let close = try exactCloseButton(in: window)
  let focusBefore = try focusSnapshot(target: application)
  guard focusBefore.frontmostPid != request.expectedPid, !focusBefore.targetActive else {
    throw WindowControlFailure.refused("background close has no distinct operator focus")
  }
  guard AXUIElementPerformAction(close, kAXPressAction as CFString) == .success else {
    throw WindowControlFailure.refused("AXPress on exact close control failed")
  }
  try waitForExactClosure(request)
  let focusAfter = try focusSnapshot(target: application)
  let focusIsolation = try validateFocusIsolation(
    before: focusBefore,
    after: focusAfter,
    targetPid: request.expectedPid
  )
  let receipt = WindowControlReceipt(
    schemaVersion: 1,
    kind: "taskwraith-studio-endurance-window-control-receipt",
    pid: request.expectedPid,
    pgid: request.expectedPgid,
    executablePath: URL(fileURLWithPath: request.expectedExecutablePath)
      .standardizedFileURL.path,
    windowId: request.windowId,
    windowTitle: request.windowTitle,
    accessibilityRole: kAXButtonRole,
    accessibilityAction: kAXPressAction,
    stateBefore: "visible",
    stateAfter: "closed",
    focusIsolation: focusIsolation,
    recordedAt: isoTimestamp()
  )
  let output = try JSONEncoder().encode(receipt)
  FileHandle.standardOutput.write(output)
  FileHandle.standardOutput.write(Data([0x0A]))
} catch {
  fputs(
    "[studio-endurance-window-control] REFUSED — \(error)\n",
    stderr
  )
  exit(2)
}
