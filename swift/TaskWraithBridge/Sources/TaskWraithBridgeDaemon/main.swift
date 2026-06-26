import Foundation
import AppKit
// ScreenCaptureKit predates Swift 6 strict concurrency — `SCContentFilter`
// isn't `Sendable` in the SDK, but the filter we pass between the picker
// and the capture pipeline is only ever used in a fire-once, single-task
// flow (no cross-thread mutation), so `@preconcurrency` downgrades the
// strict-mode complaints to warnings without papering over real races.
@preconcurrency import ScreenCaptureKit

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
        "editorOpenEnabled": true,
        "messagesBridgeEnabled": true
    ]
}

/// `runAnalyst.analyze` — optional local run analysis through Apple
/// Foundation Models. The method is availability-gated inside
/// `RunAnalyst`; hosts without the framework return a structured JSON-RPC
/// unavailable error that Electron converts into a graceful fallback.
dispatcher.register("runAnalyst.analyze") { params in
    return try RunAnalyst.analyze(params)
}

// MARK: - Attached window RPCs (Appshots-equivalent)

// In-memory handle table for windows the user has attached via the macOS
// system picker. Never persisted — dropped on daemon exit so a stale handle
// can never be used after restart. The AI side only ever sees the opaque
// handle string returned by `attachedWindow.requestPick`; window enumeration
// is contained within this daemon process.
let attachedWindowStore = AttachedWindowStore()

/// `attachedWindow.requestPick` — presents the macOS `SCContentSharingPicker`
/// on the main actor and waits for the user to either pick a single window or
/// cancel. Returns `{ handleID, windowMeta }` on success or
/// `{ cancelled: true }` if the user dismissed the picker. The picker IS the
/// security boundary: Apple's UI decides which windows the user can see and
/// pick, and the resulting filter is the implicit grant.
///
/// Picker delivers `(meta, filter)`; we store the filter in the handle table
/// so subsequent captures can call `SCScreenshotManager` directly without
/// re-enumerating windows. The meta returned to the caller is for the
/// renderer pill — pixels themselves require a separate `attachedWindow.capture`.
dispatcher.register("attachedWindow.requestPick") { _ in
    let picked: (meta: AttachedWindowMeta, filter: SCContentFilter)
    do {
        picked = try runBlockingOnMain { @MainActor @Sendable in
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<(meta: AttachedWindowMeta, filter: SCContentFilter), Error>) in
                let picker = AttachedWindowPicker()
                // Hold the picker alive until the observer callback fires.
                // Captured in the closure; the closure clears the reference
                // exactly once, in `finish()`, before the continuation fires.
                var strongPicker: AttachedWindowPicker? = picker
                picker.pick { result in
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
    } catch let err as AttachedWindowError {
        if case .cancelled = err {
            return ["cancelled": true]
        }
        throw JSONRPCError(code: JSONRPCErrorCode.internalError, message: err.localizedDescription)
    } catch {
        throw JSONRPCError(code: JSONRPCErrorCode.internalError, message: error.localizedDescription)
    }
    let entry = try runBlocking { @Sendable [attachedWindowStore, picked] in
        await attachedWindowStore.attach(meta: picked.meta, filter: picked.filter)
    }
    return [
        "ok": true,
        "handleID": entry.handleID,
        "windowMeta": entry.meta.toJSONObject()
    ]
}

struct AttachedWindowCaptureParams: Decodable {
    let handleID: String
    let includeOCR: Bool?
    let maxDimensionPx: Int?
}

/// `attachedWindow.capture` — captures one frame of the previously attached
/// window via `SCScreenshotManager`, optionally runs local Vision OCR, and
/// returns base64 PNG bytes plus structured OCR. No streaming; one call =
/// one frame. The Electron side gates each call through its existing
/// approval flow before forwarding here.
dispatcher.register("attachedWindow.capture") { params in
    let parsed: AttachedWindowCaptureParams
    do {
        parsed = try decodeParams(params, as: AttachedWindowCaptureParams.self)
    } catch {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "Invalid capture params: \(error.localizedDescription)"
        )
    }
    let entry = try runBlocking { @Sendable [attachedWindowStore, handleID = parsed.handleID] in
        await attachedWindowStore.entry(handleID: handleID)
    }
    guard let entry else {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidRequest,
            message: "Attached window handle not found (already detached or never attached)."
        )
    }
    let maxDim = parsed.maxDimensionPx ?? 1600
    let frame: CapturedWindowFrame
    do {
        frame = try runBlocking { @Sendable [filter = entry.filter, maxDim] in
            try await AttachedWindowCapture.captureWindow(
                filter: filter,
                maxDimensionPx: maxDim
            )
        }
    } catch let err as AttachedWindowError {
        if case .windowGone = err {
            // Self-heal: drop the dead handle so the renderer's status pill
            // clears on its next poll. The error code lets the Electron side
            // surface a clean "window closed, please re-attach" message.
            _ = try? runBlocking { @Sendable [attachedWindowStore, handleID = entry.handleID] in
                await attachedWindowStore.detach(handleID: handleID)
            }
            throw JSONRPCError(
                code: JSONRPCErrorCode.bridgeUnavailable,
                message: err.localizedDescription
            )
        }
        throw JSONRPCError(code: JSONRPCErrorCode.internalError, message: err.localizedDescription)
    } catch {
        throw JSONRPCError(code: JSONRPCErrorCode.internalError, message: error.localizedDescription)
    }

    var response: [String: Any] = [
        "ok": true,
        "pngBase64": frame.pngData.base64EncodedString(),
        "byteLength": frame.pngData.count,
        "width": frame.width,
        "height": frame.height,
        "windowMeta": entry.meta.toJSONObject(),
        "capturedAt": ISO8601DateFormatter().string(from: Date())
    ]
    if parsed.includeOCR ?? true {
        do {
            let ocr = try runBlocking { @Sendable [pngData = frame.pngData] in
                try await AttachedWindowOCR.recognize(pngData: pngData)
            }
            response["ocr"] = ocr.toJSONObject()
        } catch {
            // OCR failure isn't fatal — return the image without text. Surfaces
            // the underlying error inline so the user can spot why text is
            // missing from a capture without losing the frame entirely.
            response["ocrError"] = error.localizedDescription
        }
    }
    return response
}

struct AttachedWindowDetachParams: Decodable {
    let handleID: String
}

/// `attachedWindow.detach` — releases the picker grant for a handle.
/// Subsequent capture calls against that handle return a not-found error.
/// Safe to call for unknown handles (returns `{ detached: false }`).
dispatcher.register("attachedWindow.detach") { params in
    let parsed: AttachedWindowDetachParams
    do {
        parsed = try decodeParams(params, as: AttachedWindowDetachParams.self)
    } catch {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "Invalid detach params: \(error.localizedDescription)"
        )
    }
    let detached = try runBlocking { @Sendable [attachedWindowStore, handleID = parsed.handleID] in
        await attachedWindowStore.detach(handleID: handleID)
    }
    return ["ok": true, "detached": detached]
}

/// `attachedWindow.status` — lightweight status check. Returns whether any
/// window is currently attached and, if so, just the title/bundle metadata
/// the user already sees in the renderer pill. Used by the `attached_window_status`
/// MCP tool, which is auto-allowed (no approval) precisely because this
/// payload contains no enumeration and no pixel data.
dispatcher.register("attachedWindow.status") { _ in
    let current = try runBlocking { @Sendable [attachedWindowStore] in
        await attachedWindowStore.current()
    }
    guard let current else {
        return ["attached": false] as [String: Any]
    }
    return [
        "attached": true,
        "handleID": current.handleID,
        "windowMeta": current.meta.toJSONObject(),
        "attachedAt": ISO8601DateFormatter().string(from: current.createdAt)
    ]
}

// MARK: - Appwatch RPCs (Phase M1)
//
// `appwatch.*` extends the single-shot `attachedWindow.capture` (Appshots)
// flow with a low-fps SCStream into a small ring buffer. The agent gets
// "the last frame" or "frames since T" without per-frame ScreenCaptureKit
// overhead. M1 surface is the latest-frame pull only; M2 adds since/count
// batch retrieval and per-frame OCR.
//
// Lifecycle:
//   - `appwatch.start` requires a previously-attached handle (no auto-pick).
//     Idempotent: a second start with the same handle returns the existing
//     config without restarting the stream.
//   - `appwatch.stop` tears the stream down and clears the ring.
//   - 60s without a `appwatch.latestFrame` call auto-stops (idle timeout).
//   - Stream is also stopped on `attachedWindow.detach` (handled inside the
//     store) and on daemon exit.

struct AppwatchStartParams: Decodable {
    let handleID: String
    let fps: Int?
    let bufferSeconds: Int?
    let maxDimensionPx: Int?
}

struct AppwatchFramesParams: Decodable {
    let handleID: String
    let since: String?
    let count: Int?
    let format: String?
    let includeOCR: Bool?

    enum CodingKeys: String, CodingKey {
        case handleID
        case since
        case count
        case format
        case includeOCR
        case includeOCRSnake = "include_ocr"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        handleID = try container.decode(String.self, forKey: .handleID)
        since = try container.decodeIfPresent(String.self, forKey: .since)
        count = try container.decodeIfPresent(Int.self, forKey: .count)
        format = try container.decodeIfPresent(String.self, forKey: .format)
        includeOCR =
            try container.decodeIfPresent(Bool.self, forKey: .includeOCR)
            ?? container.decodeIfPresent(Bool.self, forKey: .includeOCRSnake)
    }
}

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

/// Build the `streaming` object the renderer pill (and the main-side snapshot)
/// renders. Shared by `appwatch.start` and `appwatch.status` so both surfaces
/// stay structurally identical — saves a renderer-side type fork.
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

/// Look up an attached entry by handle, normalising the "no such handle"
/// case into a structured JSON-RPC error so every appwatch handler returns
/// the same shape. Used as the first line in each handler below.
@Sendable func resolveAttachedEntry(
    store: AttachedWindowStore,
    handleID: String
) throws -> AttachedWindowEntry {
    let entry = try runBlocking { @Sendable [store, handleID] in
        await store.entry(handleID: handleID)
    }
    guard let entry else {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidRequest,
            message: "Attached window handle not found (already detached or never attached)."
        )
    }
    return entry
}

/// `appwatch.start` — spin up the SCStream for an already-attached window.
/// Requires a valid handleID. Idempotent: a second start returns the existing
/// config without restarting the stream. Refuses if the configured buffer
/// would exceed the 350 MB memory cap (memoryBudgetExceeded → -32001).
dispatcher.register("appwatch.start") { params in
    let parsed: AppwatchStartParams
    do {
        parsed = try decodeParams(params, as: AppwatchStartParams.self)
    } catch {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "Invalid appwatch.start params: \(error.localizedDescription)"
        )
    }
    let entry = try resolveAttachedEntry(store: attachedWindowStore, handleID: parsed.handleID)
    let fps = parsed.fps ?? 5
    let bufferSeconds = parsed.bufferSeconds ?? 8
    let maxDimensionPx = parsed.maxDimensionPx ?? 1280

    // Reuse the existing stream when present so the handler is idempotent;
    // construct a fresh one on first start. The store's `setStream` will
    // stop and replace if the agent ever passes us a brand-new stream.
    let stream = entry.stream ?? AttachedWindowStream()
    let config: AppwatchStreamConfig
    do {
        config = try runBlocking { @Sendable [stream, filter = entry.filter, fps, bufferSeconds, maxDimensionPx] in
            try await stream.start(
                filter: filter,
                fps: fps,
                bufferSeconds: bufferSeconds,
                maxDimensionPx: maxDimensionPx
            )
        }
    } catch let err as AppwatchError {
        switch err {
        case .memoryBudgetExceeded:
            // Distinct from -32001 (bridgeUnavailable / window gone) so
            // the agent can retune bufferSeconds / fps / maxDimensionPx
            // without us also clearing the attached-window state on
            // the Electron side.
            throw JSONRPCError(
                code: JSONRPCErrorCode.appwatchBudgetExceeded,
                message: err.localizedDescription
            )
        case .invalidConfig:
            throw JSONRPCError(
                code: JSONRPCErrorCode.invalidParams,
                message: err.localizedDescription
            )
        default:
            throw JSONRPCError(
                code: JSONRPCErrorCode.internalError,
                message: err.localizedDescription
            )
        }
    } catch {
        throw JSONRPCError(
            code: JSONRPCErrorCode.internalError,
            message: error.localizedDescription
        )
    }
    let frameCount = try runBlocking { @Sendable [stream] in
        await stream.status().frameCount
    }
    if entry.stream == nil {
        try runBlocking { @Sendable [attachedWindowStore, stream, handleID = parsed.handleID] in
            await attachedWindowStore.setStream(stream, for: handleID)
        }
    }
    return [
        "ok": true,
        "handleID": parsed.handleID,
        "streaming": makeStreamingPayload(config: config, frameCount: frameCount)
    ]
}

struct AppwatchHandleParams: Decodable {
    let handleID: String
}

/// `appwatch.stop` — tear down the stream and clear the ring. Safe to call
/// when not streaming (returns `{ ok: true, streaming: false }`).
dispatcher.register("appwatch.stop") { params in
    let parsed: AppwatchHandleParams
    do {
        parsed = try decodeParams(params, as: AppwatchHandleParams.self)
    } catch {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "Invalid appwatch.stop params: \(error.localizedDescription)"
        )
    }
    let entry = try resolveAttachedEntry(store: attachedWindowStore, handleID: parsed.handleID)
    guard let stream = entry.stream else {
        return [
            "ok": true,
            "handleID": parsed.handleID,
            "streaming": false
        ] as [String: Any]
    }
    try runBlocking { @Sendable [stream] in
        await stream.stop()
    }
    try runBlocking { @Sendable [attachedWindowStore, handleID = parsed.handleID] in
        await attachedWindowStore.clearStream(for: handleID)
    }
    return [
        "ok": true,
        "handleID": parsed.handleID,
        "streaming": false
    ]
}

/// `appwatch.status` — non-mutating read of the stream state. Does NOT bump
/// the idle-timeout pull clock — the renderer pill polls this every second
/// and we don't want a UI poll to keep the stream alive after the agent
/// stopped pulling frames.
dispatcher.register("appwatch.status") { params in
    let parsed: AppwatchHandleParams
    do {
        parsed = try decodeParams(params, as: AppwatchHandleParams.self)
    } catch {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "Invalid appwatch.status params: \(error.localizedDescription)"
        )
    }
    let entry = try resolveAttachedEntry(store: attachedWindowStore, handleID: parsed.handleID)
    guard let stream = entry.stream else {
        return [
            "ok": true,
            "handleID": parsed.handleID,
            "streaming": false
        ] as [String: Any]
    }
    let status = try runBlocking { @Sendable [stream] in
        await stream.status()
    }
    var payload: [String: Any] = [
        "ok": true,
        "handleID": parsed.handleID,
        "streaming": status.streaming,
        "fps": status.fps,
        "bufferSeconds": status.bufferSeconds,
        "frameCount": status.frameCount,
        "frameCapacity": status.frameCapacity,
        "estimatedMemoryMB": status.estimatedMemoryMB,
        "memoryBudgetMB": status.memoryBudgetMB
    ]
    if let oldest = status.oldestAt {
        payload["oldestAt"] = appwatchISO8601(oldest)
    }
    if let newest = status.newestAt {
        payload["newestAt"] = appwatchISO8601(newest)
    }
    if let pulled = status.lastPullAt {
        payload["lastPullAt"] = appwatchISO8601(pulled)
    }
    if let started = status.startedAt {
        payload["startedAt"] = appwatchISO8601(started)
    }
    return payload
}

/// `appwatch.latestFrame` — return the most recent BGRA frame from the ring
/// as PNG bytes. M1 surface; M2 will add `since` / `count` for batch pulls.
/// Bumps the idle-timeout pull clock so an active agent loop keeps the
/// stream alive.
dispatcher.register("appwatch.latestFrame") { params in
    let parsed: AppwatchHandleParams
    do {
        parsed = try decodeParams(params, as: AppwatchHandleParams.self)
    } catch {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "Invalid appwatch.latestFrame params: \(error.localizedDescription)"
        )
    }
    let entry = try resolveAttachedEntry(store: attachedWindowStore, handleID: parsed.handleID)
    guard let stream = entry.stream else {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidRequest,
            message: "Appwatch is not streaming for this handle (call appwatch.start first)."
        )
    }
    let frame = try runBlocking { @Sendable [stream] in
        await stream.latestFrame()
    }
    guard let frame else {
        // Stream is up but no frame has landed yet. Tell the renderer the
        // truth (ok=true, frame=null) so it can show a "warming up" beat
        // rather than a hard error.
        return [
            "ok": true,
            "handleID": parsed.handleID,
            "hasFrame": false
        ] as [String: Any]
    }
    let pngData: Data
    do {
        pngData = try AppwatchFrameEncoder.encodePNG(frame: frame)
    } catch let err as AppwatchError {
        throw JSONRPCError(
            code: JSONRPCErrorCode.internalError,
            message: err.localizedDescription
        )
    } catch {
        throw JSONRPCError(
            code: JSONRPCErrorCode.internalError,
            message: error.localizedDescription
        )
    }
    return [
        "ok": true,
        "handleID": parsed.handleID,
        "hasFrame": true,
        "pngBase64": pngData.base64EncodedString(),
        "byteLength": pngData.count,
        "width": frame.width,
        "height": frame.height,
        "capturedAt": appwatchISO8601(frame.capturedAt)
    ]
}

/// `appwatch.frames` — return a chronological batch from the ring buffer,
/// optionally newer than a fractional-second ISO timestamp. This powers
/// M2 agent loops that want a small visual sequence instead of polling one
/// latest frame repeatedly.
dispatcher.register("appwatch.frames") { params in
    let parsed: AppwatchFramesParams
    do {
        parsed = try decodeParams(params, as: AppwatchFramesParams.self)
    } catch {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "Invalid appwatch.frames params: \(error.localizedDescription)"
        )
    }
    let entry = try resolveAttachedEntry(store: attachedWindowStore, handleID: parsed.handleID)
    guard let stream = entry.stream else {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidRequest,
            message: "Appwatch is not streaming for this handle (call appwatch.start first)."
        )
    }
    let includeOCR = parsed.includeOCR ?? false
    let requestedCount = parsed.count ?? 5
    let countLimit = includeOCR ? 5 : 20
    let count = max(1, min(countLimit, requestedCount))
    let format = (parsed.format ?? "jpeg").lowercased() == "png" ? "png" : "jpeg"
    let since = parseAppwatchISO8601(parsed.since)
    let batch = try runBlocking { @Sendable [stream, since, count] in
        await stream.frames(since: since, count: count)
    }

    var framesPayload: [[String: Any]] = []
    framesPayload.reserveCapacity(batch.frames.count)
    for (index, frame) in batch.frames.enumerated() {
        let imageData: Data
        do {
            imageData = format == "png"
                ? try AppwatchFrameEncoder.encodePNG(frame: frame)
                : try AppwatchFrameEncoder.encodeJPEG(frame: frame)
        } catch let err as AppwatchError {
            throw JSONRPCError(
                code: JSONRPCErrorCode.internalError,
                message: err.localizedDescription
            )
        } catch {
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
                framePayload["ocr"] = ocr.toJSONObject()
            } catch {
                framePayload["ocrError"] = error.localizedDescription
            }
        }
        framesPayload.append(framePayload)
    }

    var payload: [String: Any] = [
        "ok": true,
        "handleID": parsed.handleID,
        "hasFrames": !framesPayload.isEmpty,
        "returned": framesPayload.count,
        "requested": requestedCount,
        "count": count,
        "format": format,
        "includeOCR": includeOCR,
        "availableCapturedAt": batch.availableCapturedAt.map { appwatchISO8601($0) },
        "frames": framesPayload
    ]
    if let nextSince = batch.nextSince {
        payload["nextSince"] = appwatchISO8601(nextSince)
    }
    return payload
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

// MARK: - iMessage / Messages.app bridge RPCs
//
// This is deliberately a local Messages.app bridge, not an iMessage protocol
// client. The daemon reads the user's local Messages database in read-only
// mode and sends via Messages.app automation, so TaskWraith never handles
// Apple ID credentials, IDS/APNs auth, or direct iMessage transport.

dispatcher.register("messages.status") { _ in
    return try encodeAsJSONObject(MessagesBridge.status())
}

dispatcher.register("messages.poll") { params in
    let parsed: MessagesPollParams
    do {
        parsed = try decodeParams(params, as: MessagesPollParams.self)
    } catch {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "Invalid messages.poll params: \(error.localizedDescription)"
        )
    }
    do {
        return try encodeAsJSONObject(MessagesBridge.poll(parsed))
    } catch let err as MessagesBridgeError {
        throw JSONRPCError(code: JSONRPCErrorCode.bridgeUnavailable, message: err.localizedDescription)
    }
}

dispatcher.register("messages.conversations") { params in
    let parsed: MessagesConversationsParams
    do {
        parsed = try decodeParams(params, as: MessagesConversationsParams.self)
    } catch {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "Invalid messages.conversations params: \(error.localizedDescription)"
        )
    }
    do {
        return try encodeAsJSONObject(MessagesBridge.conversations(parsed))
    } catch let err as MessagesBridgeError {
        throw JSONRPCError(code: JSONRPCErrorCode.bridgeUnavailable, message: err.localizedDescription)
    }
}

dispatcher.register("messages.sendText") { params in
    let parsed: MessagesSendTextParams
    do {
        parsed = try decodeParams(params, as: MessagesSendTextParams.self)
    } catch {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "Invalid messages.sendText params: \(error.localizedDescription)"
        )
    }
    do {
        return try encodeAsJSONObject(MessagesBridge.sendText(parsed))
    } catch let err as MessagesBridgeError {
        throw JSONRPCError(code: JSONRPCErrorCode.bridgeUnavailable, message: err.localizedDescription)
    }
}

dispatcher.register("messages.sendAttachment") { params in
    let parsed: MessagesSendAttachmentParams
    do {
        parsed = try decodeParams(params, as: MessagesSendAttachmentParams.self)
    } catch {
        throw JSONRPCError(
            code: JSONRPCErrorCode.invalidParams,
            message: "Invalid messages.sendAttachment params: \(error.localizedDescription)"
        )
    }
    do {
        return try encodeAsJSONObject(MessagesBridge.sendAttachment(parsed))
    } catch let err as MessagesBridgeError {
        throw JSONRPCError(code: JSONRPCErrorCode.bridgeUnavailable, message: err.localizedDescription)
    }
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
    // stdin closed → parent terminated → tear down on the main thread so
    // NSApplication's runloop can exit cleanly. The post-NSApp.run() code
    // below performs the actual drain/flush sequence.
    DispatchQueue.main.async {
        NSApplication.shared.terminate(nil)
    }
}

// Background-only daemon. `.accessory` keeps the process out of the Dock
// and Cmd+Tab list; it still has the window-server connection it needs to
// host `SCContentSharingPicker` on demand. Set before `NSApp.run()` so the
// policy is in effect for the first picker presentation.
NSApplication.shared.setActivationPolicy(.accessory)

// Hand the main thread to AppKit. The picker UI, when called, drives off
// this runloop; everything else runs on the reader/handler queues above.
// `terminate(nil)` from the reader thread is how this returns.
NSApplication.shared.run()

// NSApp.run() returned (terminate or unexpected exit). Drain in the same
// order the prior in-place loop did:
//   1. Wait for in-flight handlers so a ping issued right before EOF isn't
//      silently dropped.
//   2. Flush the stdout writer so the last batch of responses /
//      notifications actually reaches the parent before the pipe closes.
handlerQueue.sync(flags: .barrier) {}
stdoutWriter.flush()
