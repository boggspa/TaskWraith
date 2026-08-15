#!/usr/bin/env swift

import AppKit
import ApplicationServices
import AudioToolbox
import CoreAudio
import CoreGraphics
import CoreMedia
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
    let durationSeconds: Int?
    let playheadTicks: Int64?
    let playheadStepFrames: Int?
}

struct DriverRequest: Codable {
    let schemaVersion: Int
    let kind: String
    let inputDelivery: String
    let allowForegroundInput: Bool
    let expectedPid: Int32
    let expectedPgid: Int32
    let expectedExecutablePath: String
    let windowId: UInt32
    let windowTitle: String
    let windowBounds: WindowBounds
    let artifactRoot: String
    let actions: [DriverAction]
}

struct OutputDeviceReceipt: Codable {
    let id: UInt32
    let name: String
    let uid: String
    let nominalSampleRate: Double
}

struct AudioProbeReceipt: Codable {
    let durationSeconds: Int
    let elapsedSeconds: Double
    let sampleBufferCount: Int
    let frameCount: Int
    let sampleValueCount: Int
    let sampleRate: Double
    let channelCount: Int
    let rms: Double
    let peak: Double
    let nonSilentFraction: Double
    let defaultOutputDevice: OutputDeviceReceipt
}

struct ActionReceipt: Codable {
    let index: Int
    let type: String
    let key: String?
    let screenshotPath: String?
    let byteLength: Int?
    let xFraction: Double?
    let yFraction: Double?
    let audioProbe: AudioProbeReceipt?
    let playheadTicks: Int64?
    let playheadStepFrames: Int?
    let playheadTicksBefore: Int64?
    let observedPlayheadTicks: Int64?

    init(
        index: Int,
        type: String,
        key: String?,
        screenshotPath: String?,
        byteLength: Int?,
        xFraction: Double?,
        yFraction: Double?,
        audioProbe: AudioProbeReceipt?,
        playheadTicks: Int64? = nil,
        playheadStepFrames: Int? = nil,
        playheadTicksBefore: Int64? = nil,
        observedPlayheadTicks: Int64? = nil
    ) {
        self.index = index
        self.type = type
        self.key = key
        self.screenshotPath = screenshotPath
        self.byteLength = byteLength
        self.xFraction = xFraction
        self.yFraction = yFraction
        self.audioProbe = audioProbe
        self.playheadTicks = playheadTicks
        self.playheadStepFrames = playheadStepFrames
        self.playheadTicksBefore = playheadTicksBefore
        self.observedPlayheadTicks = observedPlayheadTicks
    }
}

struct DriverReceipt: Codable {
    let schemaVersion: Int
    let kind: String
    let inputDelivery: String
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
    "shift-left": 123,
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

func exactAccessibilityWindow(_ request: DriverRequest) throws -> AXUIElement {
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
    return window
}

func stringAttribute(_ attribute: String, of element: AXUIElement) -> String? {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success else {
        return nil
    }
    return raw as? String
}

func numberAttribute(_ attribute: String, of element: AXUIElement) -> NSNumber? {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success else {
        return nil
    }
    return raw as? NSNumber
}

/// Finds the one product Playhead through the same public AX tree VoiceOver uses.
///
/// The traversal is depth- and count-bounded so a malformed external tree cannot
/// turn an acceptance request into an unbounded walk.
func exactAccessibilityPlayhead(in window: AXUIElement) throws -> AXUIElement {
    var queue: [(AXUIElement, Int)] = [(window, 0)]
    var matches: [AXUIElement] = []
    var visited = 0
    while !queue.isEmpty && visited < 512 {
        let (element, depth) = queue.removeFirst()
        visited += 1
        if stringAttribute(kAXRoleAttribute, of: element) == kAXSliderRole,
           stringAttribute(kAXTitleAttribute, of: element) == "Playhead",
           stringAttribute(kAXIdentifierAttribute, of: element) == "Playhead"
        {
            matches.append(element)
        }
        guard depth < 8 else { continue }
        var rawChildren: CFTypeRef?
        if AXUIElementCopyAttributeValue(
            element,
            kAXChildrenAttribute as CFString,
            &rawChildren
        ) == .success,
            let children = rawChildren as? [AXUIElement]
        {
            queue.append(contentsOf: children.map { ($0, depth + 1) })
        }
    }
    guard visited < 512, matches.count == 1, let playhead = matches.first else {
        throw DriverFailure.refused("exact operable Playhead accessibility identity is unavailable")
    }
    var settable = DarwinBoolean(false)
    guard AXUIElementIsAttributeSettable(
        playhead,
        kAXValueAttribute as CFString,
        &settable
    ) == .success,
        settable.boolValue else {
        throw DriverFailure.refused("exact Playhead accessibility value is not settable")
    }
    return playhead
}

func setAccessibilityPlayhead(
    _ playhead: AXUIElement,
    to ticks: Int64,
    request: DriverRequest,
    application: NSRunningApplication
) throws -> Int64 {
    guard ticks >= 0,
          let minimum = numberAttribute(kAXMinValueAttribute, of: playhead)?.int64Value,
          let maximum = numberAttribute(kAXMaxValueAttribute, of: playhead)?.int64Value,
          minimum == 0,
          maximum >= minimum,
          ticks <= maximum else {
        throw DriverFailure.refused("requested Playhead value is outside its exact bounded range")
    }
    let foregroundBefore = NSWorkspace.shared.frontmostApplication?.processIdentifier
    guard foregroundBefore != request.expectedPid, !application.isActive else {
        throw DriverFailure.refused("background Playhead control refuses an active Companion")
    }
    guard AXUIElementSetAttributeValue(
        playhead,
        kAXValueAttribute as CFString,
        NSNumber(value: ticks)
    ) == .success else {
        throw DriverFailure.refused("exact Playhead accessibility value-set failed")
    }
    let deadline = Date().addingTimeInterval(1)
    var observed: Int64?
    while Date() < deadline {
        observed = numberAttribute(kAXValueAttribute, of: playhead)?.int64Value
        if observed == ticks { break }
        RunLoop.current.run(until: Date().addingTimeInterval(0.01))
    }
    let foregroundAfter = NSWorkspace.shared.frontmostApplication?.processIdentifier
    guard observed == ticks,
          foregroundAfter == foregroundBefore,
          !application.isActive else {
        throw DriverFailure.refused(
            "Playhead value-set did not settle without changing foreground ownership"
        )
    }
    return ticks
}

func stepAccessibilityPlayhead(
    _ playhead: AXUIElement,
    frames delta: Int,
    request: DriverRequest,
    application: NSRunningApplication
) throws -> (before: Int64, after: Int64) {
    guard delta == -1 || delta == 1,
          let before = numberAttribute(kAXValueAttribute, of: playhead)?.int64Value else {
        throw DriverFailure.refused("requested Playhead step is not exactly one frame")
    }
    let foregroundBefore = NSWorkspace.shared.frontmostApplication?.processIdentifier
    guard foregroundBefore != request.expectedPid, !application.isActive else {
        throw DriverFailure.refused("background Playhead control refuses an active Companion")
    }
    let action = delta < 0 ? kAXDecrementAction : kAXIncrementAction
    guard AXUIElementPerformAction(playhead, action as CFString) == .success else {
        throw DriverFailure.refused("exact Playhead accessibility step failed")
    }
    let deadline = Date().addingTimeInterval(1)
    var observed = before
    while Date() < deadline {
        observed = numberAttribute(kAXValueAttribute, of: playhead)?.int64Value ?? before
        if (delta < 0 && observed < before) || (delta > 0 && observed > before) { break }
        RunLoop.current.run(until: Date().addingTimeInterval(0.01))
    }
    let foregroundAfter = NSWorkspace.shared.frontmostApplication?.processIdentifier
    guard ((delta < 0 && observed < before) || (delta > 0 && observed > before)),
          foregroundAfter == foregroundBefore,
          !application.isActive else {
        throw DriverFailure.refused(
            "Playhead step did not settle without changing foreground ownership"
        )
    }
    return (before, observed)
}

func activateExactWindowForExplicitForeground(
    _ request: DriverRequest,
    application: NSRunningApplication,
    window: AXUIElement
) throws {
    guard application.activate(options: [.activateAllWindows]),
          AXUIElementSetAttributeValue(
            AXUIElementCreateApplication(pid_t(request.expectedPid)),
            kAXFrontmostAttribute as CFString,
            kCFBooleanTrue
          ) == .success,
          AXUIElementSetAttributeValue(
            AXUIElementCreateApplication(pid_t(request.expectedPid)),
            kAXFocusedWindowAttribute as CFString,
            window
          ) == .success,
          AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success else {
        throw DriverFailure.refused("explicit foreground input could not activate the exact window")
    }
    let deadline = Date().addingTimeInterval(3)
    while Date() < deadline &&
        (!application.isActive ||
            NSWorkspace.shared.frontmostApplication?.processIdentifier != request.expectedPid)
    {
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    guard application.isActive,
          NSWorkspace.shared.frontmostApplication?.processIdentifier == request.expectedPid else {
        throw DriverFailure.refused("explicit foreground input did not reach the exact window")
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

func audioObjectString(
    objectId: AudioObjectID,
    selector: AudioObjectPropertySelector
) throws -> String {
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var value: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    let status = AudioObjectGetPropertyData(objectId, &address, 0, nil, &size, &value)
    guard status == noErr else {
        throw DriverFailure.refused("could not read default output-device identity")
    }
    let string = value as String
    guard !string.isEmpty else {
        throw DriverFailure.refused("default output-device identity was empty")
    }
    return string
}

func defaultOutputDeviceReceipt() throws -> OutputDeviceReceipt {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var deviceId = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &address,
        0,
        nil,
        &size,
        &deviceId
    )
    guard status == noErr, deviceId != kAudioObjectUnknown else {
        throw DriverFailure.refused("default output device is unavailable")
    }

    address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyNominalSampleRate,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var nominalSampleRate = Float64(0)
    size = UInt32(MemoryLayout<Float64>.size)
    guard AudioObjectGetPropertyData(
        deviceId,
        &address,
        0,
        nil,
        &size,
        &nominalSampleRate
    ) == noErr,
        nominalSampleRate > 0
    else {
        throw DriverFailure.refused("default output-device sample rate is unavailable")
    }

    return OutputDeviceReceipt(
        id: deviceId,
        name: try audioObjectString(objectId: deviceId, selector: kAudioObjectPropertyName),
        uid: try audioObjectString(objectId: deviceId, selector: kAudioDevicePropertyDeviceUID),
        nominalSampleRate: nominalSampleRate
    )
}

final class ExactWindowAudioAccumulator: NSObject, SCStreamOutput, @unchecked Sendable {
    private let lock = NSLock()
    private var failure: String?
    private var sampleBuffers = 0
    private var frames = 0
    private var sampleValues = 0
    private var nonSilentValues = 0
    private var sumSquares = 0.0
    private var peakValue = 0.0
    private var observedSampleRate = 0.0
    private var observedChannelCount = 0

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard outputType == .audio, sampleBuffer.isValid else { return }
        guard let description = CMSampleBufferGetFormatDescription(sampleBuffer),
              let format = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee,
              format.mFormatID == kAudioFormatLinearPCM,
              format.mFormatFlags & kAudioFormatFlagIsFloat != 0,
              format.mBitsPerChannel == 32,
              let block = CMSampleBufferGetDataBuffer(sampleBuffer)
        else {
            lock.lock()
            failure = failure ?? "ScreenCaptureKit returned non-Float32 window audio"
            lock.unlock()
            return
        }

        let byteLength = CMBlockBufferGetDataLength(block)
        guard byteLength > 0, byteLength % MemoryLayout<Float32>.size == 0 else { return }
        var bytes = [UInt8](repeating: 0, count: byteLength)
        guard CMBlockBufferCopyDataBytes(
            block,
            atOffset: 0,
            dataLength: byteLength,
            destination: &bytes
        ) == noErr else {
            lock.lock()
            failure = failure ?? "could not read ScreenCaptureKit window-audio samples"
            lock.unlock()
            return
        }

        var localValues = 0
        var localNonSilent = 0
        var localSumSquares = 0.0
        var localPeak = 0.0
        bytes.withUnsafeBytes { raw in
            for value in raw.bindMemory(to: Float32.self) where value.isFinite {
                let magnitude = abs(Double(value))
                localValues += 1
                localSumSquares += magnitude * magnitude
                localPeak = max(localPeak, magnitude)
                if magnitude > 0.000_1 { localNonSilent += 1 }
            }
        }

        lock.lock()
        defer { lock.unlock() }
        if observedSampleRate == 0 {
            observedSampleRate = format.mSampleRate
            observedChannelCount = Int(format.mChannelsPerFrame)
        } else if observedSampleRate != format.mSampleRate ||
                    observedChannelCount != Int(format.mChannelsPerFrame) {
            failure = failure ?? "window-audio format changed during the bounded probe"
            return
        }
        sampleBuffers += 1
        frames += CMSampleBufferGetNumSamples(sampleBuffer)
        sampleValues += localValues
        nonSilentValues += localNonSilent
        sumSquares += localSumSquares
        peakValue = max(peakValue, localPeak)
    }

    func receipt(
        durationSeconds: Int,
        elapsedSeconds: Double,
        outputDevice: OutputDeviceReceipt
    ) throws -> AudioProbeReceipt {
        lock.lock()
        defer { lock.unlock() }
        if let failure { throw DriverFailure.refused(failure) }
        guard sampleBuffers > 0,
              frames > 0,
              sampleValues > 0,
              observedSampleRate > 0,
              observedChannelCount > 0
        else {
            throw DriverFailure.refused("exact Studio window produced no attributable audio samples")
        }
        return AudioProbeReceipt(
            durationSeconds: durationSeconds,
            elapsedSeconds: elapsedSeconds,
            sampleBufferCount: sampleBuffers,
            frameCount: frames,
            sampleValueCount: sampleValues,
            sampleRate: observedSampleRate,
            channelCount: observedChannelCount,
            rms: sqrt(sumSquares / Double(sampleValues)),
            peak: peakValue,
            nonSilentFraction: Double(nonSilentValues) / Double(sampleValues),
            defaultOutputDevice: outputDevice
        )
    }
}

final class AudioProbeResultBox: @unchecked Sendable {
    var result: Result<AudioProbeReceipt, Error>?
}

func captureAudio(
    windowId: UInt32,
    pid: Int32,
    durationSeconds: Int
) throws -> AudioProbeReceipt {
    let semaphore = DispatchSemaphore(value: 0)
    let box = AudioProbeResultBox()
    Task {
        do {
            let outputDevice = try defaultOutputDeviceReceipt()
            let content = try await SCShareableContent.excludingDesktopWindows(
                true,
                onScreenWindowsOnly: true
            )
            guard let window = content.windows.first(where: {
                $0.windowID == windowId && $0.owningApplication?.processID == pid
            }) else {
                throw DriverFailure.refused(
                    "ScreenCaptureKit could not find the exact isolated Studio window for audio"
                )
            }
            let accumulator = ExactWindowAudioAccumulator()
            let configuration = SCStreamConfiguration()
            configuration.width = 2
            configuration.height = 2
            configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            configuration.queueDepth = 3
            configuration.capturesAudio = true
            configuration.excludesCurrentProcessAudio = false
            configuration.sampleRate = 48_000
            configuration.channelCount = 2
            let stream = SCStream(
                filter: SCContentFilter(desktopIndependentWindow: window),
                configuration: configuration,
                delegate: nil
            )
            let queue = DispatchQueue(label: "studio.acceptance.window-audio")
            try stream.addStreamOutput(accumulator, type: .audio, sampleHandlerQueue: queue)
            let started = Date()
            try await stream.startCapture()
            try await Task.sleep(nanoseconds: UInt64(durationSeconds) * 1_000_000_000)
            try await stream.stopCapture()
            let elapsed = Date().timeIntervalSince(started)
            box.result = .success(
                try accumulator.receipt(
                    durationSeconds: durationSeconds,
                    elapsedSeconds: elapsed,
                    outputDevice: outputDevice
                )
            )
        } catch {
            box.result = .failure(error)
        }
        semaphore.signal()
    }
    guard semaphore.wait(timeout: .now() + Double(durationSeconds + 20)) == .success,
          let result = box.result
    else {
        throw DriverFailure.refused("exact Studio window audio probe timed out")
    }
    return try result.get()
}

guard CommandLine.arguments.count == 2 else {
    fail("usage: studio-acceptance-ui-driver.swift <request.json>")
}

do {
    let requestURL = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
    let requestData = try Data(contentsOf: requestURL)
    let request = try JSONDecoder().decode(DriverRequest.self, from: requestData)
    let hasInteractiveActions = request.actions.contains {
        $0.type == "key" || $0.type == "click"
    }
    guard request.schemaVersion == 1,
          request.kind == "taskwraith-studio-ui-driver-request",
          (request.inputDelivery == "background-observation-only" ||
              request.inputDelivery == "foreground-global-explicit"),
          ((request.inputDelivery == "background-observation-only" &&
              !request.allowForegroundInput &&
              !hasInteractiveActions) ||
              (request.inputDelivery == "foreground-global-explicit" &&
                  request.allowForegroundInput &&
                  hasInteractiveActions)),
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
    let accessibilityWindow = try exactAccessibilityWindow(request)
    let accessibilityPlayhead = request.actions.contains {
        $0.type == "set-playhead-ticks" || $0.type == "step-playhead-frame"
    } ? try exactAccessibilityPlayhead(in: accessibilityWindow) : nil
    if request.inputDelivery == "foreground-global-explicit" {
        try activateExactWindowForExplicitForeground(
            request,
            application: application,
            window: accessibilityWindow
        )
    }
    try validateWindow(request)

    var receipts: [ActionReceipt] = []
    for (index, action) in request.actions.enumerated() {
        let currentPgid = getpgid(pid_t(request.expectedPid))
        guard currentPgid == request.expectedPgid else {
            throw DriverFailure.refused("process group changed during the bounded action list")
        }
        if request.inputDelivery == "foreground-global-explicit" {
            guard application.isActive,
                  NSWorkspace.shared.frontmostApplication?.processIdentifier ==
                    request.expectedPid else {
                throw DriverFailure.refused("explicit foreground target lost active status")
            }
        }
        try validateWindow(request)

        if action.type == "set-playhead-ticks",
           request.inputDelivery == "background-observation-only",
           let playheadTicks = action.playheadTicks,
           let accessibilityPlayhead
        {
            let observed = try setAccessibilityPlayhead(
                accessibilityPlayhead,
                to: playheadTicks,
                request: request,
                application: application
            )
            try validateWindow(request)
            receipts.append(
                ActionReceipt(
                    index: index,
                    type: "set-playhead-ticks",
                    key: nil,
                    screenshotPath: nil,
                    byteLength: nil,
                    xFraction: nil,
                    yFraction: nil,
                    audioProbe: nil,
                    playheadTicks: playheadTicks,
                    observedPlayheadTicks: observed
                )
            )
        } else if action.type == "step-playhead-frame",
                  request.inputDelivery == "background-observation-only",
                  let playheadStepFrames = action.playheadStepFrames,
                  let accessibilityPlayhead
        {
            let observed = try stepAccessibilityPlayhead(
                accessibilityPlayhead,
                frames: playheadStepFrames,
                request: request,
                application: application
            )
            try validateWindow(request)
            receipts.append(
                ActionReceipt(
                    index: index,
                    type: "step-playhead-frame",
                    key: nil,
                    screenshotPath: nil,
                    byteLength: nil,
                    xFraction: nil,
                    yFraction: nil,
                    audioProbe: nil,
                    playheadStepFrames: playheadStepFrames,
                    playheadTicksBefore: observed.before,
                    observedPlayheadTicks: observed.after
                )
            )
        } else if action.type == "key", let key = action.key, let code = keyCodes[key] {
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
                throw DriverFailure.refused("could not construct bounded keyboard event")
            }
            if key == "shift-left" {
                down.flags = .maskShift
                up.flags = .maskShift
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
                    yFraction: nil,
                    audioProbe: nil
                )
            )
        } else if action.type == "click",
                  request.inputDelivery == "foreground-global-explicit",
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
                    yFraction: yFraction,
                    audioProbe: nil
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
                    yFraction: nil,
                    audioProbe: nil
                )
            )
        } else if action.type == "audio-probe",
                  let durationSeconds = action.durationSeconds,
                  durationSeconds >= 1,
                  durationSeconds <= 600
        {
            let audioProbe = try captureAudio(
                windowId: request.windowId,
                pid: request.expectedPid,
                durationSeconds: durationSeconds
            )
            try validateWindow(request)
            receipts.append(
                ActionReceipt(
                    index: index,
                    type: "audio-probe",
                    key: nil,
                    screenshotPath: nil,
                    byteLength: nil,
                    xFraction: nil,
                    yFraction: nil,
                    audioProbe: audioProbe
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
        inputDelivery: request.inputDelivery,
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
