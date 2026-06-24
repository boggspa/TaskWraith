// taskwraith-e2ee-v1 — the iOS endpoint of the transport. The production
// counterpart of tests/fake-iphone/FakeIphoneClient.ts: scan a QR bootstrap
// (or resolve a trusted reconnect), open the relay WebSocket, drive the
// E2eeSession handshake, then exchange encrypted app messages.
//
// An actor so all session + socket state is serialized; the receive loop and
// public API hop onto it. Outbound frames drain from the session in call order
// and are awaited sequentially, preserving wire order. The identity crosses the
// isolation boundary as a 32-byte seed (Sendable) and is reconstructed into a
// CryptoKit key inside the actor.

import Foundation
import CryptoKit

private final class PingContinuationGate: @unchecked Sendable {
    private let lock = NSLock()
    private var didResume = false

    func resume(_ continuation: CheckedContinuation<Bool, Never>, returning value: Bool) {
        lock.lock()
        guard !didResume else {
            lock.unlock()
            return
        }
        didResume = true
        lock.unlock()
        continuation.resume(returning: value)
    }
}

public enum TransportEvent: Sendable {
    case confirmCode(String)
    case established
    case message(method: String, params: Data?)
    case error(String)
    case closed
}

public struct AckResult: Sendable {
    public let ok: Bool
    public let result: Data?  // raw JSON of `result`, if any
    public let error: String?
}

public enum TransportError: Error, Sendable {
    case invalidRelayUrl
    case notScanned
    case resolveFailed(Int)
    case resolveNoSession
    case timeout(String)
    case badBootstrap(String)
    case badIdentity
}

public actor RelayTransportClient {
    private let identity: Curve25519.Signing.PrivateKey
    private let identityPubKeyB64: String
    private var session: E2eeSession?
    private var bootstrap: PairingBootstrapPayload?
    private var wsTask: URLSessionWebSocketTask?
    private let urlSession: URLSession

    private var established = false
    private var establishedWaiters: [CheckedContinuation<Void, Never>] = []
    private var ackWaiters: [String: CheckedContinuation<AckResult, Never>] = [:]
    private var requestCounter = 0

    private let eventContinuation: AsyncStream<TransportEvent>.Continuation
    public nonisolated let events: AsyncStream<TransportEvent>

    /// `identitySeed` is the 32-byte Ed25519 raw representation the app persists
    /// in the Keychain (`Curve25519.Signing.PrivateKey().rawRepresentation`).
    public init(identitySeed: Data, urlSession: URLSession = .shared) throws {
        guard let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: identitySeed) else {
            throw TransportError.badIdentity
        }
        self.identity = key
        self.identityPubKeyB64 = Base64.encode(key.publicKey.rawRepresentation)
        self.urlSession = urlSession
        var cont: AsyncStream<TransportEvent>.Continuation!
        self.events = AsyncStream { cont = $0 }
        self.eventContinuation = cont
    }

    public var isEstablished: Bool { established }
    public var currentSessionId: String? { bootstrap?.sessionId }
    public nonisolated var identityPublicKeyBase64: String { identityPubKeyB64 }

    // ── Pairing entry points ──────────────────────────────────────────────────

    /// Scan a QR bootstrap: validate, pin the Mac identity, create the session.
    public func scan(_ payload: PairingBootstrapPayload) throws {
        guard payload.v == 1, payload.protocol == TWProtocol.id else {
            throw TransportError.badBootstrap("unsupported protocol \(payload.protocol)")
        }
        // Defense-in-depth (review LOW): the Mac reaps an expired pairing
        // listener, but reject a stale QR phone-side too. resolveAndScan
        // passes .greatestFiniteMagnitude, so reconnect is unaffected.
        let nowMs = Date().timeIntervalSince1970 * 1000
        if payload.expiresAt.isFinite, payload.expiresAt > 0, payload.expiresAt < nowMs {
            throw TransportError.badBootstrap("pairing code expired")
        }
        // Reject a bootstrap whose Mac key can't be imported — otherwise
        // createSession would leave peerIdentity nil and silently degrade to
        // trust-on-first-use with no pin (review LOW).
        guard let raw = Base64.decode(payload.macIdentityPubKey),
            (try? TWKeys.importEd25519PublicKey(raw: raw)) != nil
        else {
            throw TransportError.badBootstrap("invalid Mac identity key")
        }
        createSession(from: payload)
    }

    /// Trusted reconnect: ask the relay's resolve directory where the paired
    /// Mac is now listening, then create a session on that sessionId.
    ///
    /// `timeoutMs` bounds the WHOLE resolve roundtrip — a dial to an
    /// unroutable door (cellular → a LAN-only candidate) blackholes rather
    /// than erroring, and `task.receive()` would otherwise wait on the OS
    /// timeout for minutes. The multi-door candidate walk depends on this
    /// failing fast.
    public func resolveAndScan(
        relayUrl: String, macIdentityPubKey: String, timeoutMs: Int = 10_000
    ) async throws {
        let nonce = Data((0..<16).map { _ in UInt8.random(in: 0...255) })
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let request = try TWResolve.signResolveRequest(
            identity: identity, macIdentityPubKey: macIdentityPubKey, nonce: nonce,
            issuedAt: issuedAt)
        guard let resolveUrl = URL(string: "\(Self.wsBase(relayUrl))/v1/resolve") else {
            throw TransportError.invalidRelayUrl
        }
        var urlRequest = URLRequest(url: resolveUrl)
        urlRequest.setValue(TWProtocol.id, forHTTPHeaderField: "x-taskwraith-protocol")
        let task = urlSession.webSocketTask(with: urlRequest)
        task.resume()
        let requestData = try JSONEncoder().encode(request)
        guard let requestText = String(data: requestData, encoding: .utf8) else {
            task.cancel(with: .goingAway, reason: nil)
            throw TransportError.invalidRelayUrl
        }
        let message: URLSessionWebSocketTask.Message
        do {
            message = try await withThrowingTaskGroup(
                of: URLSessionWebSocketTask.Message.self
            ) { group in
                group.addTask {
                    try await task.send(.string(requestText))
                    return try await task.receive()
                }
                group.addTask {
                    try await Task.sleep(nanoseconds: UInt64(timeoutMs) * 1_000_000)
                    throw TransportError.timeout("resolve")
                }
                let first = try await group.next()!
                group.cancelAll()
                return first
            }
        } catch {
            task.cancel(with: .goingAway, reason: nil)
            throw error
        }
        task.cancel(with: .normalClosure, reason: nil)
        let data: Data?
        switch message {
        case .string(let text): data = text.data(using: .utf8)
        case .data(let raw): data = raw
        @unknown default: data = nil
        }
        guard let data else { throw TransportError.resolveNoSession }
        struct ResolveResponse: Decodable { let ok: Bool; let sessionId: String?; let status: Int? }
        let decoded = try JSONDecoder().decode(ResolveResponse.self, from: data)
        if let status = decoded.status, status != 200 { throw TransportError.resolveFailed(status) }
        guard decoded.ok, let sessionId = decoded.sessionId else {
            throw TransportError.resolveNoSession
        }
        createSession(
            from: PairingBootstrapPayload(
                v: 1, protocol: TWProtocol.id, relayUrl: relayUrl, sessionId: sessionId,
                macIdentityPubKey: macIdentityPubKey, macDisplayName: "",
                expiresAt: .greatestFiniteMagnitude))
    }

    private func createSession(from payload: PairingBootstrapPayload) {
        bootstrap = payload
        let macIdentity = Base64.decode(payload.macIdentityPubKey).flatMap {
            try? TWKeys.importEd25519PublicKey(raw: $0)
        }
        session = E2eeSession(
            role: .iphone, sessionId: payload.sessionId, identity: identity,
            peerIdentity: macIdentity)
    }

    // ── Connection ────────────────────────────────────────────────────────────

    public func connect() throws {
        guard let bootstrap, let session else { throw TransportError.notScanned }
        established = false
        let base = bootstrap.relayUrl.hasSuffix("/")
            ? String(bootstrap.relayUrl.dropLast()) : bootstrap.relayUrl
        guard let sessionUrl = URL(string: "\(base)/v1/session/\(bootstrap.sessionId)") else {
            throw TransportError.invalidRelayUrl
        }
        var request = URLRequest(url: sessionUrl)
        request.setValue("iphone", forHTTPHeaderField: "x-taskwraith-role")
        request.setValue(TWProtocol.id, forHTTPHeaderField: "x-taskwraith-protocol")
        let task = urlSession.webSocketTask(with: request)
        wsTask = task
        task.resume()
        session.start()
        Task { await self.drainAndTransmit() }
        Task { await self.receiveLoop(task) }
    }

    public func connectAndWaitEstablished(timeoutMs: Int = 8000) async throws {
        try connect()
        try await waitForEstablished(timeoutMs: timeoutMs)
    }

    public func waitForEstablished(timeoutMs: Int = 8000) async throws {
        if established { return }
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            establishedWaiters.append(c)
            scheduleEstablishedTimeout(after: timeoutMs)
        }
        if !established { throw TransportError.timeout("established") }
    }

    private func scheduleEstablishedTimeout(after ms: Int) {
        Task {
            try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
            self.fireEstablishedTimeout()
        }
    }

    private func fireEstablishedTimeout() {
        guard !established else { return }
        let waiters = establishedWaiters
        establishedWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
    }

    /// Hard drop (no close handshake), like losing coverage. Session app state
    /// survives; reconnect() re-handshakes on the same session.
    public func dropConnection() {
        established = false
        wsTask?.cancel(with: .goingAway, reason: nil)
        wsTask = nil
    }

    public func reconnect() throws { try connect() }

    public func close() {
        established = false
        wsTask?.cancel(with: .normalClosure, reason: nil)
        wsTask = nil
        eventContinuation.yield(.closed)
    }

    public func checkSocketAlive(timeoutMs: Int = 2_500) async -> Bool {
        guard let task = wsTask else { return false }
        let gate = PingContinuationGate()
        return await withCheckedContinuation { continuation in
            task.sendPing { error in
                gate.resume(continuation, returning: error == nil)
            }
            Task {
                try? await Task.sleep(nanoseconds: UInt64(timeoutMs) * 1_000_000)
                gate.resume(continuation, returning: false)
            }
        }
    }

    // ── App messages ────────────────────────────────────────────────────────────

    public func sendAction(_ method: String, params: Data?) async {
        guard let session else { return }
        do { try session.sendApp(method, params: params) } catch {
            eventContinuation.yield(
                .error(TransportErrorCopy.friendlyMessage(for: error, relayUrl: bootstrap?.relayUrl)))
        }
        await drainAndTransmit()
    }

    /// Send an action and await its correlated `bridge.ack`.
    public func request(_ method: String, params: [String: Any], timeoutMs: Int = 8000) async throws
        -> AckResult
    {
        requestCounter += 1
        let requestId = "ios-req-\(requestCounter)"
        var withId = params
        withId["requestId"] = requestId
        let body = try JSONSerialization.data(withJSONObject: withId)
        return await withCheckedContinuation { (c: CheckedContinuation<AckResult, Never>) in
            ackWaiters[requestId] = c
            Task { await self.sendAction(method, params: body) }
            Task {
                try? await Task.sleep(nanoseconds: UInt64(timeoutMs) * 1_000_000)
                self.fireAckTimeout(requestId)
            }
        }
    }

    public func requestSerialized(
        _ method: String, paramsData: Data, timeoutMs: Int = 8000
    ) async throws -> AckResult {
        let object =
            (try JSONSerialization.jsonObject(with: paramsData, options: [.fragmentsAllowed])
                as? [String: Any]) ?? [:]
        return try await request(method, params: object, timeoutMs: timeoutMs)
    }

    private func fireAckTimeout(_ requestId: String) {
        guard let waiter = ackWaiters.removeValue(forKey: requestId) else { return }
        waiter.resume(returning: AckResult(ok: false, result: nil, error: "timeout"))
    }

    public func ping() async {
        session?.ping()
        await drainAndTransmit()
    }

    // ── Internals ────────────────────────────────────────────────────────────────

    private func receiveLoop(_ task: URLSessionWebSocketTask) async {
        dbg("receiveLoop start")
        while wsTask === task {
            do {
                let message = try await task.receive()
                // The relay forwards frames verbatim; the `ws` library re-sends a
                // received text frame as a Buffer → a BINARY WS frame. So accept
                // BOTH .string and .data and decode the UTF-8 JSON either way.
                let data: Data?
                switch message {
                case .string(let text): data = text.data(using: .utf8)
                case .data(let raw): data = raw
                @unknown default: data = nil
                }
                if let data {
                    dbg("recv \(String(data: data, encoding: .utf8)?.prefix(80) ?? "<binary>")")
                    if let frame = try? JSONDecoder().decode(E2eeFrame.self, from: data) {
                        session?.handleFrame(frame)
                        await drainAndTransmit()
                    } else {
                        dbg("recv DECODE-FAIL")
                    }
                }
            } catch {
                dbg("recv error \(error)")
                if wsTask === task {
                    established = false
                    wsTask = nil
                    eventContinuation.yield(
                .error(TransportErrorCopy.friendlyMessage(for: error, relayUrl: bootstrap?.relayUrl)))
                    eventContinuation.yield(.closed)
                }
                return
            }
        }
    }

    /// Drain the session's accumulated outputs after any session call: transmit
    /// frames in order, dispatch delivered messages (+ resolve ack waiters),
    /// surface the confirm code, fulfill establishment, surface errors.
    private func drainAndTransmit() async {
        guard let session else { return }
        for frame in session.drainOutbox() {
            if let data = try? JSONEncoder().encode(frame),
                let text = String(data: data, encoding: .utf8)
            {
                dbg("send \(text.prefix(80))")
                do {
                    try await wsTask?.send(.string(text))
                } catch {
                    dbg("send error \(error)")
                    established = false
                    wsTask = nil
                    eventContinuation.yield(
                .error(TransportErrorCopy.friendlyMessage(for: error, relayUrl: bootstrap?.relayUrl)))
                    eventContinuation.yield(.closed)
                    return
                }
            }
        }
        if let code = session.takeConfirmCode() { eventContinuation.yield(.confirmCode(code)) }
        if session.takeEstablishedEdge() {
            established = true
            let waiters = establishedWaiters
            establishedWaiters.removeAll()
            for waiter in waiters { waiter.resume() }
            eventContinuation.yield(.established)
        }
        for message in session.drainMessages() {
            if message.method == "bridge.ack", let params = message.params,
                let obj = try? JSONSerialization.jsonObject(with: params) as? [String: Any],
                let requestId = obj["requestId"] as? String,
                let waiter = ackWaiters.removeValue(forKey: requestId)
            {
                var resultData: Data?
                if let result = obj["result"] {
                    resultData = try? JSONSerialization.data(
                        withJSONObject: result, options: [.fragmentsAllowed])
                }
                waiter.resume(
                    returning: AckResult(
                        ok: (obj["ok"] as? Bool) ?? false, result: resultData,
                        error: obj["error"] as? String))
            }
            eventContinuation.yield(.message(method: message.method, params: message.params))
        }
        if let error = session.takeError() {
            eventContinuation.yield(
                .error(TransportErrorCopy.friendlyMessage(for: error, relayUrl: bootstrap?.relayUrl)))
        }
    }

    private nonisolated static let debugEnabled =
        ProcessInfo.processInfo.environment["TWK_DEBUG"] == "1"
    private nonisolated func dbg(_ line: String) {
        if Self.debugEnabled { FileHandle.standardError.write(Data("[twk] \(line)\n".utf8)) }
    }

    static func httpBase(_ relayUrl: String) -> String {
        var s = relayUrl
        if s.hasPrefix("ws://") { s = "http://" + s.dropFirst(5) }
        else if s.hasPrefix("wss://") { s = "https://" + s.dropFirst(6) }
        if s.hasSuffix("/") { s = String(s.dropLast()) }
        return s
    }

    static func wsBase(_ relayUrl: String) -> String {
        var s = relayUrl
        if s.hasPrefix("http://") { s = "ws://" + s.dropFirst(7) }
        else if s.hasPrefix("https://") { s = "wss://" + s.dropFirst(8) }
        if s.hasSuffix("/") { s = String(s.dropLast()) }
        return s
    }
}
