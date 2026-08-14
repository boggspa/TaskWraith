#!/usr/bin/env swift

import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

struct WindowBounds: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct DriverAction: Codable {
    let type: String
    let key: String?
    let name: String?
    let path: String?
    let xFraction: Double?
    let yFraction: Double?
}

struct DriverRequest: Codable {
    let schemaVersion: Int
    let kind: String
    let expectedPid: Int32
    let expectedPgid: Int32
    let expectedExecutablePath: String
    let windowId: UInt32
    let windowTitle: String
    let windowBounds: WindowBounds
    let artifactRoot: String
    let actions: [DriverAction]
}

struct ActionReceipt: Codable {
    let index: Int
    let type: String
    let key: String?
    let screenshotPath: String?
    let byteLength: Int?
    let xFraction: Double?
    let yFraction: Double?
}

struct DriverReceipt: Codable {
    let schemaVersion: Int
    let kind: String
    let recordedAt: String
    let pid: Int32
    let pgid: Int32
    let windowId: UInt32
    let executablePath: String
    let actions: [ActionReceipt]
}

enum DriverFailure: Error, CustomStringConvertible {
    case refused(String)

    var description: String {
        switch self {
        case .refused(let message): return message
        }
    }
}

let keyCodes: [String: CGKeyCode] = [
    "0": 29,
    "1": 18,
    "2": 19,
    "3": 20,
    "4": 21,
    "5": 23,
    "6": 22,
    "7": 26,
    "8": 28,
    "9": 25,
    "a": 0,
    "s": 1,
    "g": 5,
    "c": 8,
    "v": 9,
    "w": 13,
    "r": 15,
    "bracket-right": 30,
    "o": 31,
    "bracket-left": 33,
    "i": 34,
    "p": 35,
    "return": 36,
    "l": 37,
    "tab": 48,
    "space": 49,
    "left": 123,
    "right": 124
]

func fail(_ message: String) -> Never {
    fputs("[studio-ui-driver] REFUSED — \(message)\n", stderr)
    exit(2)
}

func exactWindowInfo(pid: Int32, windowId: UInt32) -> [[String: Any]] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    let rows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
    return rows.filter { row in
        guard let ownerPid = row[kCGWindowOwnerPID as String] as? Int,
              ownerPid == Int(pid),
              let layer = row[kCGWindowLayer as String] as? Int,
              layer == 0,
              let candidate = row[kCGWindowNumber as String] as? UInt32 else {
            return false
        }
        return candidate == windowId
    }
}

func closeEnough(_ lhs: Double, _ rhs: Double) -> Bool {
    abs(lhs - rhs) <= 1.0
}

func validateWindow(_ request: DriverRequest) throws {
    let matches = exactWindowInfo(pid: request.expectedPid, windowId: request.windowId)
    guard matches.count == 1,
          let bounds = matches[0][kCGWindowBounds as String] as? [String: Any],
          let x = (bounds["X"] as? NSNumber)?.doubleValue,
          let y = (bounds["Y"] as? NSNumber)?.doubleValue,
          let width = (bounds["Width"] as? NSNumber)?.doubleValue,
          let height = (bounds["Height"] as? NSNumber)?.doubleValue,
          closeEnough(x, request.windowBounds.x),
          closeEnough(y, request.windowBounds.y),
          closeEnough(width, request.windowBounds.width),
          closeEnough(height, request.windowBounds.height) else {
        throw DriverFailure.refused("exact window identity or bounds changed")
    }
}

func focusExactWindow(_ request: DriverRequest) throws {
    guard AXIsProcessTrusted() else {
        throw DriverFailure.refused("macOS Accessibility access is unavailable")
    }
    let applicationElement = AXUIElementCreateApplication(pid_t(request.expectedPid))
    var rawWindows: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        applicationElement,
        kAXWindowsAttribute as CFString,
        &rawWindows
    ) == .success,
        let windows = rawWindows as? [AXUIElement]
    else {
        throw DriverFailure.refused("could not inspect the exact Companion accessibility windows")
    }
    let matches = windows.filter { window in
        var rawTitle: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            window,
            kAXTitleAttribute as CFString,
            &rawTitle
        ) == .success,
            let title = rawTitle as? String
        else { return false }
        return title == request.windowTitle
    }
    guard matches.count == 1, let window = matches.first else {
        throw DriverFailure.refused("exact Companion accessibility window identity is unavailable")
    }
    guard AXUIElementSetAttributeValue(
        applicationElement,
        kAXFrontmostAttribute as CFString,
        kCFBooleanTrue
    ) == .success,
        AXUIElementSetAttributeValue(
            applicationElement,
            kAXFocusedWindowAttribute as CFString,
            window
        ) == .success,
        AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success
    else {
        throw DriverFailure.refused("could not focus the exact Companion accessibility window")
    }
}

func boundedScreenshotURL(_ path: String, artifactRoot: String) throws -> URL {
    let root = URL(fileURLWithPath: artifactRoot).standardizedFileURL
    let destination = URL(fileURLWithPath: path).standardizedFileURL
    guard destination.path.hasPrefix(root.path + "/"),
          destination.pathExtension.lowercased() == "png" else {
        throw DriverFailure.refused("screenshot path escaped the acceptance artifact root")
    }
    var isDirectory: ObjCBool = false
    if FileManager.default.fileExists(atPath: destination.path, isDirectory: &isDirectory) {
        let values = try destination.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey])
        guard values.isSymbolicLink != true, values.isRegularFile == true else {
            throw DriverFailure.refused("existing screenshot target is not a safe regular file")
        }
    }
    try FileManager.default.createDirectory(
        at: destination.deletingLastPathComponent(),
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
    )
    return destination
}

final class CaptureResultBox: @unchecked Sendable {
    var result: Result<CGImage, Error>?
}

func capture(windowId: UInt32, pid: Int32, to destination: URL) throws -> Int {
    let semaphore = DispatchSemaphore(value: 0)
    let box = CaptureResultBox()
    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                true,
                onScreenWindowsOnly: true
            )
            guard let window = content.windows.first(where: {
                $0.windowID == windowId && $0.owningApplication?.processID == pid
            }) else {
                throw DriverFailure.refused(
                    "ScreenCaptureKit could not find the exact isolated Studio window"
                )
            }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let configuration = SCStreamConfiguration()
            configuration.width = max(1, Int(window.frame.width * 2))
            configuration.height = max(1, Int(window.frame.height * 2))
            configuration.captureResolution = .best
            configuration.ignoreShadowsSingleWindow = true
            configuration.showsCursor = false
            box.result = .success(
                try await SCScreenshotManager.captureImage(
                    contentFilter: filter,
                    configuration: configuration
                )
            )
        } catch {
            box.result = .failure(error)
        }
        semaphore.signal()
    }
    guard semaphore.wait(timeout: .now() + 20) == .success,
          let result = box.result else {
        throw DriverFailure.refused("exact Studio window screenshot timed out")
    }
    let image = try result.get()
    guard let writer = CGImageDestinationCreateWithURL(
        destination as CFURL,
        UTType.png.identifier as CFString,
        1,
        nil
    ) else {
        throw DriverFailure.refused("could not create the bounded screenshot writer")
    }
    CGImageDestinationAddImage(writer, image, nil)
    guard CGImageDestinationFinalize(writer) else {
        throw DriverFailure.refused("could not finalize the bounded screenshot")
    }
    let attributes = try FileManager.default.attributesOfItem(atPath: destination.path)
    let byteLength = (attributes[.size] as? NSNumber)?.intValue ?? 0
    guard byteLength > 0 else {
        throw DriverFailure.refused("bounded screenshot was empty")
    }
    return byteLength
}

guard CommandLine.arguments.count == 2 else {
    fail("usage: studio-acceptance-ui-driver.swift <request.json>")
}

do {
    let requestURL = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
    let requestData = try Data(contentsOf: requestURL)
    let request = try JSONDecoder().decode(DriverRequest.self, from: requestData)
    guard request.schemaVersion == 1,
          request.kind == "taskwraith-studio-ui-driver-request",
          request.expectedPid > 0,
          request.expectedPgid > 0,
          request.windowId > 0,
          !request.windowTitle.isEmpty,
          !request.actions.isEmpty,
          request.actions.count <= 32 else {
        throw DriverFailure.refused("request shape is invalid")
    }

    let livePgid = getpgid(pid_t(request.expectedPid))
    guard livePgid == request.expectedPgid else {
        throw DriverFailure.refused(
            "process group changed: expected \(request.expectedPgid), observed \(livePgid)"
        )
    }
    guard let application = NSRunningApplication(processIdentifier: pid_t(request.expectedPid)),
          let executablePath = application.executableURL?.standardizedFileURL.path,
          URL(fileURLWithPath: executablePath).lastPathComponent == "TaskWraithStudioCompanion",
          executablePath == URL(fileURLWithPath: request.expectedExecutablePath).standardizedFileURL.path
    else {
        throw DriverFailure.refused("exact Companion executable identity is unavailable")
    }
    guard !executablePath.hasPrefix("/Applications/TaskWraith.app/") else {
        throw DriverFailure.refused("installed TaskWraith is never an acceptance target")
    }

    try validateWindow(request)
    if request.actions.contains(where: { $0.type == "key" || $0.type == "click" }) &&
        !CGPreflightPostEventAccess()
    {
        throw DriverFailure.refused("macOS post-event access is unavailable")
    }
    guard application.activate(options: [.activateAllWindows]) else {
        throw DriverFailure.refused("could not activate the exact isolated Companion")
    }
    try focusExactWindow(request)
    let activationDeadline = Date().addingTimeInterval(3)
    while Date() < activationDeadline &&
        (!application.isActive ||
            NSWorkspace.shared.frontmostApplication?.processIdentifier != request.expectedPid)
    {
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    guard application.isActive,
          NSWorkspace.shared.frontmostApplication?.processIdentifier == request.expectedPid else {
        throw DriverFailure.refused("exact isolated Companion did not become frontmost")
    }
    try validateWindow(request)

    var receipts: [ActionReceipt] = []
    for (index, action) in request.actions.enumerated() {
        let currentPgid = getpgid(pid_t(request.expectedPid))
        guard currentPgid == request.expectedPgid else {
            throw DriverFailure.refused("process group changed during the bounded action list")
        }
        guard application.isActive,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == request.expectedPid else {
            throw DriverFailure.refused("exact isolated Companion lost frontmost status")
        }
        try validateWindow(request)

        if action.type == "key", let key = action.key, let code = keyCodes[key] {
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
                throw DriverFailure.refused("could not construct bounded keyboard event")
            }
            down.postToPid(pid_t(request.expectedPid))
            up.postToPid(pid_t(request.expectedPid))
            receipts.append(
                ActionReceipt(
                    index: index,
                    type: "key",
                    key: key,
                    screenshotPath: nil,
                    byteLength: nil,
                    xFraction: nil,
                    yFraction: nil
                )
            )
        } else if action.type == "click",
                  let xFraction = action.xFraction,
                  let yFraction = action.yFraction,
                  xFraction.isFinite,
                  yFraction.isFinite,
                  xFraction > 0,
                  xFraction < 1,
                  yFraction > 0,
                  yFraction < 1
        {
            let point = CGPoint(
                x: request.windowBounds.x + request.windowBounds.width * xFraction,
                y: request.windowBounds.y + request.windowBounds.height * yFraction
            )
            guard let source = CGEventSource(stateID: .hidSystemState),
                  let down = CGEvent(
                    mouseEventSource: source,
                    mouseType: .leftMouseDown,
                    mouseCursorPosition: point,
                    mouseButton: .left
                  ),
                  let up = CGEvent(
                    mouseEventSource: source,
                    mouseType: .leftMouseUp,
                    mouseCursorPosition: point,
                    mouseButton: .left
                  ) else {
                throw DriverFailure.refused("could not construct bounded pointer event")
            }
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
            try validateWindow(request)
            receipts.append(
                ActionReceipt(
                    index: index,
                    type: "click",
                    key: nil,
                    screenshotPath: nil,
                    byteLength: nil,
                    xFraction: xFraction,
                    yFraction: yFraction
                )
            )
        } else if action.type == "screenshot", let screenshotPath = action.path {
            let destination = try boundedScreenshotURL(
                screenshotPath,
                artifactRoot: request.artifactRoot
            )
            let byteLength = try capture(
                windowId: request.windowId,
                pid: request.expectedPid,
                to: destination
            )
            receipts.append(
                ActionReceipt(
                    index: index,
                    type: "screenshot",
                    key: nil,
                    screenshotPath: destination.path,
                    byteLength: byteLength,
                    xFraction: nil,
                    yFraction: nil
                )
            )
        } else {
            throw DriverFailure.refused("unsupported bounded action at index \(index)")
        }
        usleep(120_000)
    }

    let formatter = ISO8601DateFormatter()
    let receipt = DriverReceipt(
        schemaVersion: 1,
        kind: "taskwraith-studio-ui-driver-receipt",
        recordedAt: formatter.string(from: Date()),
        pid: request.expectedPid,
        pgid: request.expectedPgid,
        windowId: request.windowId,
        executablePath: executablePath,
        actions: receipts
    )
    let output = try JSONEncoder().encode(receipt)
    FileHandle.standardOutput.write(output)
    FileHandle.standardOutput.write(Data([0x0A]))
} catch let failure as DriverFailure {
    fail(failure.description)
} catch {
    fail(String(describing: error))
}
