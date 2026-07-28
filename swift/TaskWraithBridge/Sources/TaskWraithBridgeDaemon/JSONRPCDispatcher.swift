import Foundation

/// Minimal JSON-RPC 2.0 dispatcher for the daemon's stdio control channel.
///
/// The bridge ships a small local-control surface (`bridge.status`,
/// `bridge.ping`, Screen Watch, creative-app, and editor helpers) without
/// taking a dependency on the removed remote-iOS transport layer.
///
/// Wire format: one JSON object per stdin/stdout line, terminated by `\n`.
/// Matches the framing used by `CodexAppServerClient` so a single line-reader
/// on the Electron side can be reused.
///
/// Concurrency: the dispatch loop is single-threaded (blocking `readLine`
/// reads + synchronous handler invocations). When a future method needs
/// concurrency (e.g. opening a transport listener), it can dispatch async
/// work itself and return immediately; the dispatcher only requires handlers
/// to return *something* JSON-encodable.

/// Standard JSON-RPC 2.0 error codes plus a few bridge-specific ones.
enum JSONRPCErrorCode {
    static let parseError = -32700
    static let invalidRequest = -32600
    static let methodNotFound = -32601
    static let invalidParams = -32602
    static let internalError = -32603
    // Reserved -32000..-32099 for server-defined errors. Bridge codes:
    static let bridgeUnavailable = -32001
    /// `appwatch.start` was called with a config whose estimated
    /// buffer footprint exceeds the daemon's memory cap. Distinct
    /// from `-32001` so agents can branch — `-32001` historically
    /// means "the attached window is gone" and triggers self-heal
    /// on the Electron side, whereas this code means "retune
    /// bufferSeconds / fps / maxDimensionPx and retry against the
    /// same handle." The error's `message` carries the estimated
    /// MB + cap MB numbers for the agent to plan its retry.
    static let appwatchBudgetExceeded = -32002
    /// Caller supplied a different chat/scope or attempted to select a
    /// protected host process. This is distinct from a once-valid lease that
    /// has subsequently been replaced or detached.
    static let attachmentDenied = -32003
    /// A handle/consent generation was valid earlier but is no longer live.
    /// Callers must obtain fresh user-mediated attachment consent.
    static let attachmentRevoked = -32004
}

final class JSONRPCDispatcher: @unchecked Sendable {
    typealias Handler = (Any) throws -> Any

    private var handlers: [String: Handler] = [:]

    /// Register a method handler. Subsequent registrations of the same name
    /// replace the previous handler — convenient for tests, but production
    /// daemons should register each method exactly once.
    func register(_ method: String, _ handler: @escaping Handler) {
        handlers[method] = handler
    }

    /// Process a single line from stdin. Returns the JSON-encoded response
    /// line (without trailing newline) or `nil` for notifications (requests
    /// with no `id`) and for parse failures we can't attribute to anyone.
    func handleLine(_ line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        guard let data = trimmed.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let envelope = object as? [String: Any] else {
            // Can't attribute to an id when we can't even parse — write a
            // null-id error response per JSON-RPC 2.0 spec.
            return makeErrorResponse(id: NSNull(), code: JSONRPCErrorCode.parseError, message: "Parse error")
        }

        let id = envelope["id"]
        let methodValue = envelope["method"] as? String
        let params = envelope["params"] ?? [String: Any]()

        guard let method = methodValue, !method.isEmpty else {
            return makeErrorResponse(id: id ?? NSNull(), code: JSONRPCErrorCode.invalidRequest, message: "Invalid request: missing method")
        }

        guard let handler = handlers[method] else {
            // Notifications (no id) get no response even for missing methods.
            if id == nil { return nil }
            return makeErrorResponse(id: id ?? NSNull(), code: JSONRPCErrorCode.methodNotFound, message: "Method not found: \(method)")
        }

        do {
            let result = try handler(params)
            // Notifications never get a response, even on success.
            if id == nil { return nil }
            return makeSuccessResponse(id: id ?? NSNull(), result: result)
        } catch let error as JSONRPCError {
            return makeErrorResponse(
                id: id ?? NSNull(),
                code: error.code,
                message: error.message,
                data: error.data
            )
        } catch {
            return makeErrorResponse(id: id ?? NSNull(), code: JSONRPCErrorCode.internalError, message: error.localizedDescription)
        }
    }

    // MARK: - Response builders

    private func makeSuccessResponse(id: Any, result: Any) -> String? {
        let response: [String: Any] = [
            "jsonrpc": "2.0",
            "id": id,
            "result": result
        ]
        return serialize(response)
    }

    private func makeErrorResponse(
        id: Any,
        code: Int,
        message: String,
        data: Any? = nil
    ) -> String? {
        var error: [String: Any] = [
            "code": code,
            "message": message
        ]
        if let data {
            error["data"] = data
        }
        let response: [String: Any] = [
            "jsonrpc": "2.0",
            "id": id,
            "error": error
        ]
        return serialize(response)
    }

    private func serialize(_ object: [String: Any]) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let line = String(data: data, encoding: .utf8) else {
            return nil
        }
        return line
    }
}

/// Throw this from a handler to control the error code surfaced to the caller.
/// Plain `Error`s become `-32603 internalError`.
struct JSONRPCError: Error {
    let code: Int
    let message: String
    let data: [String: String]?

    init(code: Int, message: String, data: [String: String]? = nil) {
        self.code = code
        self.message = message
        self.data = data
    }

    static func attachmentDenied(_ message: String) -> JSONRPCError {
        return JSONRPCError(
            code: JSONRPCErrorCode.attachmentDenied,
            message: message,
            data: ["kind": "attachmentDenied"]
        )
    }

    static func attachmentRevoked(_ message: String) -> JSONRPCError {
        return JSONRPCError(
            code: JSONRPCErrorCode.attachmentRevoked,
            message: message,
            data: ["kind": "attachmentRevoked"]
        )
    }
}
