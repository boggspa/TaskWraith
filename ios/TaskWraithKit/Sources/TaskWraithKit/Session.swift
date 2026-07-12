// taskwraith-e2ee-v1 — session state machine (Swift port of
// src/shared/e2ee/session.ts). The iOS app instantiates role `.iphone`; the
// `.mac` branches are ported too so the logic stays a faithful mirror (and so
// the dual-counter / resume discipline that drop/resume depends on matches the
// Node side byte-for-byte at the app-message layer).
//
// PULL model: the machine is a synchronous, single-owner state object that
// ACCUMULATES outputs (frames to send, delivered messages, confirm code,
// established edge, errors). The owner (RelayTransportClient, an actor) calls a
// method then drains the accumulators — no actor-isolated callbacks, so it
// composes cleanly with Swift strict concurrency.

import Foundation
import CryptoKit

public final class E2eeSession {
    public enum SessionError: Error, Sendable {
        case macIdentityMismatch
        case iphoneIdentityMismatch
        case clientAuthBeforeKeys
        case signatureInvalid
        case confirmCodeMismatch
        case serverAuthTooEarly
        case encBeforeEstablished
        case unexpectedRehandshake
        case noKeys
        case notEstablished
    }

    public struct DeliveredMessage: Sendable {
        public let method: String
        public let params: Data?  // raw JSON bytes of `params`, if present
    }

    private let role: Role
    private let sessionId: String
    private let identity: Curve25519.Signing.PrivateKey
    private var peerIdentity: Curve25519.Signing.PublicKey?

    private let nonceBytes = 16
    private let bufferMaxMsgs = 500
    private let bufferMaxBytes = 10 * 1024 * 1024

    // ── Output accumulators (drained by the owner after each call) ────────────
    private var outbox: [E2eeFrame] = []
    private var delivered: [DeliveredMessage] = []
    private var pendingConfirmCode: String?
    private var establishedEdge = false
    private var pendingError: Error?
    /// Monotonic proof that the authenticated peer answered a transport ping.
    /// Relay WebSocket pings only prove the relay is awake; this counter proves
    /// the Mac endpoint itself decrypted our ping and returned a pong.
    private var receivedPongCount: UInt64 = 0

    // Per-connection handshake state.
    private var ephemeral: Curve25519.KeyAgreement.PrivateKey?
    private var myNonce: Data?
    private var keys: SessionKeys?
    private var transcriptHash: Data?
    private var clientEphB64 = ""
    private var serverEphB64 = ""
    private var clientNonceB64 = ""
    private var serverNonceB64 = ""
    private var established = false

    // Per-connection transport counters.
    private var sendSeq = 0
    private var lastRecvSeq = -1

    // Resume gating (hold new app messages until the peer's resume — see
    // session.ts markEstablished/handleControl for the rationale).
    private var awaitingPeerResume = false
    /// Mac-only: serverHello sent, awaiting clientAuth (SAS-grind guard).
    private var awaitingClientAuth = false
    private var peerResumeReceived = false
    private var peerResumeLastAcked = 0
    private var currentConnectionFirstOutboundMsgId = 1

    // Cross-reconnect app state.
    private var nextOutboundMsgId = 1
    private var lastDeliveredInboundMsgId = 0
    /// Per-session-object resume epoch (see session.ts) — a relaunched app
    /// is a new epoch, telling the peer to reset its inbound dedup.
    private let localEpoch = UUID().uuidString
    private var peerEpoch: String? = nil
    private struct Buffered { var msgId: Int; var plaintext: Data }
    private var replayBuffer: [Buffered] = []
    private var replayBytes = 0

    public init(
        role: Role, sessionId: String, identity: Curve25519.Signing.PrivateKey,
        peerIdentity: Curve25519.Signing.PublicKey? = nil
    ) {
        self.role = role
        self.sessionId = sessionId
        self.identity = identity
        self.peerIdentity = peerIdentity
    }

    public var isEstablished: Bool { established }

    // ── Drains ────────────────────────────────────────────────────────────────
    public func drainOutbox() -> [E2eeFrame] { defer { outbox.removeAll() }; return outbox }
    public func drainMessages() -> [DeliveredMessage] {
        defer { delivered.removeAll() }
        return delivered
    }
    public func takeConfirmCode() -> String? { defer { pendingConfirmCode = nil }; return pendingConfirmCode }
    public func takeEstablishedEdge() -> Bool { defer { establishedEdge = false }; return establishedEdge }
    public func takeError() -> Error? { defer { pendingError = nil }; return pendingError }
    public var peerPongCount: UInt64 { receivedPongCount }

    /// Begin (or restart, after reconnect) the handshake.
    public func start() {
        resetConnectionState()
        let eph = TWKeys.generateEphemeral()
        ephemeral = eph
        myNonce = Data((0..<nonceBytes).map { _ in UInt8.random(in: 0...255) })
        if role == .iphone {
            clientEphB64 = Base64.encode(eph.publicKey.rawRepresentation)
            clientNonceB64 = Base64.encode(myNonce!)
            outbox.append(
                .clientHello(
                    ClientHelloFrame(
                        protocol: TWProtocol.id, sessionId: sessionId,
                        ephemeralPubKey: clientEphB64, nonce: clientNonceB64)))
        }
    }

    public func reconnect() { start() }

    private func resetConnectionState() {
        ephemeral = nil
        myNonce = nil
        keys = nil
        transcriptHash = nil
        clientEphB64 = ""
        serverEphB64 = ""
        clientNonceB64 = ""
        serverNonceB64 = ""
        established = false
        sendSeq = 0
        lastRecvSeq = -1
        awaitingPeerResume = false
        awaitingClientAuth = false
        peerResumeReceived = false
        peerResumeLastAcked = 0
        currentConnectionFirstOutboundMsgId = nextOutboundMsgId
    }

    public func handleFrame(_ frame: E2eeFrame) {
        do {
            switch frame {
            case .clientHello(let f):
                if role == .mac { try onClientHello(f.ephemeralPubKey, f.nonce) }
            case .serverHello(let f):
                if role == .iphone {
                    try onServerHello(f.ephemeralPubKey, f.nonce, f.macIdentityPubKey)
                }
            case .clientAuth(let f):
                if role == .mac {
                    try onClientAuth(f.iphoneIdentityPubKey, f.confirmCode, f.transcriptSig)
                }
            case .serverAuth(let f):
                if role == .iphone { try onServerAuth(f.transcriptSig) }
            case .enc(let f):
                try onEncrypted(f)
            }
        } catch {
            pendingError = error
        }
    }

    private func deriveKeys() throws {
        let peerEphB64 = role == .mac ? clientEphB64 : serverEphB64
        let peerEph = try TWKeys.importX25519PublicKey(raw: Base64.decode(peerEphB64) ?? Data())
        let ikm = try TWKeys.sharedSecret(ephemeral!, peerEph)
        keys = TWKeySchedule.deriveSessionKeys(
            ikm: ikm, clientNonce: Base64.decode(clientNonceB64) ?? Data(),
            serverNonce: Base64.decode(serverNonceB64) ?? Data())
    }

    /// v2 transcript: binds BOTH long-lived identities (identity-splice
    /// defense). Computable only once the peer's identity is known — the
    /// phone after serverHello, the Mac upon clientAuth.
    private func computeTranscript(macIdentityB64: String, iphoneIdentityB64: String) {
        transcriptHash = TWKeySchedule.transcriptHash(
            TranscriptInputs(
                sessionId: sessionId, clientEphemeralPubKeyB64: clientEphB64,
                serverEphemeralPubKeyB64: serverEphB64, clientNonceB64: clientNonceB64,
                serverNonceB64: serverNonceB64,
                macIdentityPubKeyB64: macIdentityB64,
                iphoneIdentityPubKeyB64: iphoneIdentityB64))
    }

    private func onClientHello(_ clientEphB64In: String, _ clientNonceB64In: String) throws {
        // SAS-grind defense (mirrors session.ts): refuse repeated clientHello
        // only during first pairing. A trusted reconnect has a pinned peer
        // identity and no user-visible code to grind; blocking it can leave a
        // dropped iOS app unable to reconnect.
        if role == .mac, awaitingClientAuth, peerIdentity == nil {
            throw SessionError.unexpectedRehandshake
        }
        resetConnectionState()
        let eph = TWKeys.generateEphemeral()
        ephemeral = eph
        myNonce = Data((0..<nonceBytes).map { _ in UInt8.random(in: 0...255) })
        clientEphB64 = clientEphB64In
        clientNonceB64 = clientNonceB64In
        serverEphB64 = Base64.encode(eph.publicKey.rawRepresentation)
        serverNonceB64 = Base64.encode(myNonce!)
        // Keys at hello; the transcript waits for clientAuth (it binds the
        // iPhone identity, which arrives there).
        try deriveKeys()
        outbox.append(
            .serverHello(
                ServerHelloFrame(
                    protocol: TWProtocol.id, sessionId: sessionId, ephemeralPubKey: serverEphB64,
                    nonce: serverNonceB64,
                    macIdentityPubKey: Base64.encode(identity.publicKey.rawRepresentation))))
        awaitingClientAuth = true
    }

    private func onServerHello(
        _ serverEphB64In: String, _ serverNonceB64In: String, _ macIdentityB64: String
    ) throws {
        serverEphB64 = serverEphB64In
        serverNonceB64 = serverNonceB64In
        let macIdentity = try TWKeys.importEd25519PublicKey(
            raw: Base64.decode(macIdentityB64) ?? Data())
        if let pinned = peerIdentity {
            if pinned.rawRepresentation != macIdentity.rawRepresentation {
                throw SessionError.macIdentityMismatch
            }
        } else {
            peerIdentity = macIdentity
        }
        try deriveKeys()
        computeTranscript(
            macIdentityB64: macIdentityB64,
            iphoneIdentityB64: Base64.encode(identity.publicKey.rawRepresentation))
        let code = TWKeySchedule.confirmCode(transcriptHash!)
        pendingConfirmCode = code
        let sig = try identity.signature(for: transcriptHash!)
        outbox.append(
            .clientAuth(
                ClientAuthFrame(
                    sessionId: sessionId,
                    iphoneIdentityPubKey: Base64.encode(identity.publicKey.rawRepresentation),
                    confirmCode: code, transcriptSig: Base64.encode(sig))))
    }

    private func onClientAuth(
        _ iphoneIdentityB64: String, _ confirmCode: String, _ transcriptSigB64: String
    ) throws {
        // Terminal-ish: a clientAuth (any outcome) ends the in-flight window.
        awaitingClientAuth = false
        guard keys != nil else { throw SessionError.clientAuthBeforeKeys }
        // Bind the CLAIMED iPhone identity before verifying: a spliced
        // identity changes the Mac's code (user-visible) and produces a
        // serverAuth signature the phone rejects (automatic).
        computeTranscript(
            macIdentityB64: Base64.encode(identity.publicKey.rawRepresentation),
            iphoneIdentityB64: iphoneIdentityB64)
        guard let th = transcriptHash else { throw SessionError.clientAuthBeforeKeys }
        let iphoneIdentity = try TWKeys.importEd25519PublicKey(
            raw: Base64.decode(iphoneIdentityB64) ?? Data())
        guard TWKeys.verify(Base64.decode(transcriptSigB64) ?? Data(), of: th, with: iphoneIdentity)
        else { throw SessionError.signatureInvalid }
        let ourCode = TWKeySchedule.confirmCode(th)
        guard ourCode == confirmCode else { throw SessionError.confirmCodeMismatch }
        pendingConfirmCode = ourCode
        if let pinned = peerIdentity,
            pinned.rawRepresentation != iphoneIdentity.rawRepresentation
        {
            throw SessionError.iphoneIdentityMismatch
        }
        peerIdentity = iphoneIdentity
        let sig = try identity.signature(for: th)
        outbox.append(
            .serverAuth(ServerAuthFrame(sessionId: sessionId, transcriptSig: Base64.encode(sig))))
        markEstablished()
    }

    private func onServerAuth(_ transcriptSigB64: String) throws {
        guard let th = transcriptHash, let peer = peerIdentity else {
            throw SessionError.serverAuthTooEarly
        }
        guard TWKeys.verify(Base64.decode(transcriptSigB64) ?? Data(), of: th, with: peer) else {
            throw SessionError.signatureInvalid
        }
        markEstablished()
    }

    private func markEstablished() {
        established = true
        establishedEdge = true
        currentConnectionFirstOutboundMsgId = nextOutboundMsgId
        if peerResumeReceived {
            awaitingPeerResume = false
            replayUnacked(peerResumeLastAcked)
        } else {
            awaitingPeerResume = true
        }
        sendControl(
            TWProtocol.transportResume,
            ["lastAckedMsgId": lastDeliveredInboundMsgId, "epoch": localEpoch])
    }

    // ── Sending ────────────────────────────────────────────────────────────────

    /// Send an application message. `params` is pre-encoded JSON (or nil). Held
    /// until the peer's resume if we just (re)established.
    public func sendApp(_ method: String, params: Data?) throws {
        guard established else { throw SessionError.notEstablished }
        let msgId = nextOutboundMsgId
        nextOutboundMsgId += 1
        let plaintext = try encodeAppMessage(msgId: msgId, method: method, params: params)
        bufferOutbound(Buffered(msgId: msgId, plaintext: plaintext))
        if !awaitingPeerResume { try encryptAndSend(plaintext) }
    }

    private func sendControl(_ method: String, _ params: [String: Any]?) {
        do {
            let paramsData = try params.map { try JSONSerialization.data(withJSONObject: $0) }
            let plaintext = try encodeAppMessage(msgId: 0, method: method, params: paramsData)
            try encryptAndSend(plaintext)
        } catch {
            pendingError = error
        }
    }

    public func ping() { if established { sendControl(TWProtocol.transportPing, nil) } }

    private func encodeAppMessage(msgId: Int, method: String, params: Data?) throws -> Data {
        var obj: [String: Any] = ["msgId": msgId, "method": method]
        if let params,
            let value = try? JSONSerialization.jsonObject(with: params, options: [.fragmentsAllowed])
        {
            obj["params"] = value
        }
        return try JSONSerialization.data(withJSONObject: obj)
    }

    private func encryptAndSend(_ plaintext: Data) throws {
        guard let keys else { throw SessionError.noKeys }
        let direction = sendDirection(for: role)
        let key = direction == .macToIphone ? keys.macToIphone : keys.iphoneToMac
        let seq = sendSeq
        sendSeq += 1
        let sealed = try TWCipher.seal(
            key: key, direction: direction, sessionId: sessionId, seq: seq, plaintext: plaintext)
        outbox.append(
            .enc(
                EncryptedFrame(
                    sessionId: sessionId, seq: seq, nonce: Base64.encode(sealed.nonce),
                    ct: Base64.encode(sealed.ct), tag: Base64.encode(sealed.tag),
                    ack: lastDeliveredInboundMsgId == 0 ? nil : lastDeliveredInboundMsgId)))
    }

    private func bufferOutbound(_ entry: Buffered) {
        replayBuffer.append(entry)
        replayBytes += entry.plaintext.count
        while replayBuffer.count > bufferMaxMsgs || replayBytes > bufferMaxBytes {
            let dropped = replayBuffer.removeFirst()
            replayBytes -= dropped.plaintext.count
        }
    }

    // ── Receiving ────────────────────────────────────────────────────────────────

    private func onEncrypted(_ frame: EncryptedFrame) throws {
        guard let keys else { throw SessionError.encBeforeEstablished }
        if frame.seq <= lastRecvSeq { return }
        let direction = recvDirection(for: role)
        let key = direction == .macToIphone ? keys.macToIphone : keys.iphoneToMac
        let plaintext = try TWCipher.open(
            key: key, direction: direction, sessionId: sessionId, seq: frame.seq,
            frame: SealedFrame(
                nonce: Base64.decode(frame.nonce) ?? Data(), ct: Base64.decode(frame.ct) ?? Data(),
                tag: Base64.decode(frame.tag) ?? Data()))
        lastRecvSeq = frame.seq
        if let ack = frame.ack { trimReplayBuffer(ack) }

        guard let obj = try JSONSerialization.jsonObject(with: plaintext) as? [String: Any],
            let method = obj["method"] as? String
        else { return }
        let msgId = obj["msgId"] as? Int ?? 0

        if method.hasPrefix("transport.") {
            // Control frames ride pre-establishment by design (the peer's
            // resume lands before THIS side finishes its handshake); they
            // carry only transport bookkeeping.
            handleControl(method: method, params: obj["params"])
            return
        }
        // App messages REQUIRE a completed, AUTHENTICATED handshake — keys
        // exist after the ephemeral ECDH but the peer's pinned identity is
        // only proven at clientAuth/serverAuth. Gating on `keys` (the old
        // guard) let a hostile relay's forged frame reach delivery before any
        // identity proof. (Mirrors session.ts.)
        guard established else { return }
        if msgId <= lastDeliveredInboundMsgId { return }
        lastDeliveredInboundMsgId = msgId
        var paramsData: Data?
        if let params = obj["params"] {
            paramsData = try? JSONSerialization.data(
                withJSONObject: params, options: [.fragmentsAllowed])
        }
        delivered.append(DeliveredMessage(method: method, params: paramsData))
    }

    private func handleControl(method: String, params: Any?) {
        if method == TWProtocol.transportPing {
            sendControl(TWProtocol.transportPong, nil)
        } else if method == TWProtocol.transportPong {
            receivedPongCount &+= 1
        } else if method == TWProtocol.transportResume {
            let resumeParams = params as? [String: Any]
            let lastAcked = (resumeParams?["lastAckedMsgId"] as? Int) ?? 0
            // Fresh-peer epoch (mirrors session.ts EXACTLY): a peer whose
            // epoch changed restarted its msgId counters — reset the inbound
            // watermark, drop only pre-handshake replay entries, then flush
            // messages queued during the current establish pass. peerResume
            // flags are set BEFORE the branch so a same-connection re-resume
            // still flushes correctly.
            let epoch = resumeParams?["epoch"] as? String
            let freshPeer = epoch != nil && peerEpoch != nil && epoch != peerEpoch
            if let epoch { peerEpoch = epoch }
            peerResumeReceived = true
            peerResumeLastAcked = lastAcked
            if freshPeer {
                lastDeliveredInboundMsgId = 0
                dropReplayBefore(currentConnectionFirstOutboundMsgId)
                awaitingPeerResume = false
                replayUnacked(0)
                return
            }
            trimReplayBuffer(lastAcked)
            if awaitingPeerResume {
                awaitingPeerResume = false
                replayUnacked(lastAcked)
            } else if established {
                replayUnacked(lastAcked)
            }
        }
    }

    private func trimReplayBuffer(_ ackMsgId: Int) {
        while let first = replayBuffer.first, first.msgId <= ackMsgId {
            replayBytes -= first.plaintext.count
            replayBuffer.removeFirst()
        }
    }

    private func dropReplayBefore(_ firstMsgIdToKeep: Int) {
        while let first = replayBuffer.first, first.msgId < firstMsgIdToKeep {
            replayBytes -= first.plaintext.count
            replayBuffer.removeFirst()
        }
    }

    private func replayUnacked(_ lastAckedMsgId: Int) {
        for entry in replayBuffer where entry.msgId > lastAckedMsgId {
            try? encryptAndSend(entry.plaintext)
        }
    }
}
