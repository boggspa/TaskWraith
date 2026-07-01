/*
 * HumanCollaborationCollaboratorClient — the COLLABORATOR endpoint of the
 * collaboration transport (L5-2).
 *
 * Runs on the collaborator's own Mac (main process). It dials the host's relay
 * room (the `iphone` seat), drives the SAS admission handshake, then subscribes
 * to and renders the least-privilege projection and appends comments — all over
 * the collaboration cipher's own end-to-end crypto (the relay is a blind
 * forwarder). The 6-digit SAS surfaced via `onSasCode` is compared OUT OF BAND
 * by the two humans before either trusts the session (the wire echo proves
 * nothing on its own — see the audit's L1-1).
 *
 * Socket injected (TransportSocketFactory) so it is loopback-testable end to end
 * against HumanCollaborationHostTransport without a real WebSocket.
 */
import { randomBytes, randomUUID } from 'crypto'
import type { TransportSocket, TransportSocketFactory } from '../remote/RemoteTransportClient'
import {
  b64,
  exportRawEd25519PublicKey,
  exportRawX25519PublicKey,
  generateEphemeralKeyPair,
  generateIdentityKeyPair,
  importRawEd25519PublicKey,
  importRawX25519PublicKey,
  signEd25519,
  verifyEd25519,
  type KeyPair
} from '../../shared/e2ee/keys'
import {
  computeHumanCollaborationTranscriptHash,
  deriveHumanCollaborationSessionKeys,
  humanCollaborationConfirmCode,
  type HumanCollaborationSessionKeys
} from '../../shared/collaboration/HumanCollaborationKeySchedule'
import {
  openHumanCollaborationFrame,
  sealHumanCollaborationMessage
} from '../../shared/collaboration/HumanCollaborationCipher'
import {
  HUMAN_COLLABORATION_EVENTS,
  HUMAN_COLLABORATION_METHODS,
  HUMAN_COLLABORATION_PROTOCOL,
  type HumanCollaborationBeginHandshakeResult,
  type HumanCollaborationConfirmSasResult,
  type HumanCollaborationEncryptedFrame,
  type HumanCollaborationHandshakeContext
} from '../../shared/collaboration/HumanCollaborationProtocol'
import {
  makeTransportRequest,
  parseTransportMessage
} from '../../shared/collaboration/HumanCollaborationTransportProtocol'
import { hashInviteToken } from './HumanCollaborationStore'

export interface CollaboratorAdmissionInput {
  shareId: string
  chatId: string
  inviteToken: string
  displayName: string
  shareMode: 'readOnly' | 'comments'
  /** Optional host identity pubkey from the invite; if set it must match the
   * key the host presents (Crypto-F2 defense-in-depth on top of the SAS). */
  expectedHostIdentityPubKeyB64?: string
}

/**
 * Slice 5 reconnect (spec §2/§9-5): re-establish a session with a PINNED
 * identity — no invite token, no human SAS re-compare. The trust anchors that
 * replace the SAS are: (a) the collaborator's persisted identity key, which the
 * host validates against the participant it admitted originally; (b) the host's
 * identity key persisted from the original join, which MUST match (required
 * here, unlike admission where it is optional); (c) fresh transcript signatures
 * from both sides over fresh ephemerals/nonces (fresh session keys every time).
 */
export interface CollaboratorReconnectInput {
  shareId: string
  chatId: string
  collaboratorId: string
  displayName: string
  shareMode: 'readOnly' | 'comments'
  /** REQUIRED for reconnect — the pinned host identity from the original join. */
  expectedHostIdentityPubKeyB64: string
}

export interface HumanCollaborationCollaboratorClientOptions {
  socketFactory: TransportSocketFactory
  /**
   * Slice 5: persisted collaborator identity. When supplied, the same identity
   * is presented across joins/reconnects (the host pins it per participant);
   * omitted → a fresh per-instance identity (Phase 1 behavior, tests).
   */
  identity?: KeyPair
  /** Surfaces the locally-computed 6-digit SAS for the out-of-band human compare. */
  onSasCode?: (code: string) => void
  onProjection?: (projection: unknown) => void
  onEstablished?: (info: { sessionId: string; collaboratorId: string }) => void
  onConnectionChange?: (connected: boolean) => void
  onError?: (err: Error) => void
  log?: (line: string) => void
  now?: () => number
  requestTimeoutMs?: number
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class HumanCollaborationCollaboratorClient {
  private readonly opts: HumanCollaborationCollaboratorClientOptions
  private readonly identity: KeyPair
  private socket: TransportSocket | null = null
  private connected = false
  private readonly pending = new Map<string, PendingRequest>()
  private sessionKeys: HumanCollaborationSessionKeys | null = null
  private sessionId = ''
  private nextOutboundSeq = 1
  private lastInboundSeq = 0
  private disposed = false
  // Captured by beginAdmission; consumed by confirmAdmission once the human has
  // compared the SAS out of band (L6-2). Keys are already derived at begin, but
  // we do NOT send the confirm — and thus never establish — until the gate fires.
  private pendingConfirm: { handshakeId: string; confirmCode: string; sigB64: string } | null = null
  private connectWaiters: Array<{
    resolve: () => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
  }> = []

  constructor(options: HumanCollaborationCollaboratorClientOptions) {
    this.opts = options
    this.identity = options.identity ?? generateIdentityKeyPair()
  }

  /** The identity pubkey this client presents (b64) — persisted callers use it
   * to correlate the pinned participant across joins/reconnects. */
  identityPubKeyB64(): string {
    return b64.encode(exportRawEd25519PublicKey(this.identity.publicKey))
  }

  get isConnected(): boolean {
    return this.connected
  }

  get isEstablished(): boolean {
    return Boolean(this.sessionKeys) && this.sessionId.length > 0
  }

  /** Resolve once the socket is OPEN — the real ws transport DROPS sends before
   * open, so callers must await this before beginAdmission. */
  whenConnected(timeoutMs = 10_000): Promise<void> {
    if (this.connected) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connectWaiters = this.connectWaiters.filter((w) => w.timer !== timer)
        reject(new Error('Collaboration connect timed out.'))
      }, timeoutMs)
      timer.unref?.()
      this.connectWaiters.push({ resolve, reject, timer })
    })
  }

  private settleConnectWaiters(err: Error | null): void {
    const waiters = this.connectWaiters
    this.connectWaiters = []
    for (const w of waiters) {
      clearTimeout(w.timer)
      if (err) w.reject(err)
      else w.resolve()
    }
  }

  connect(relayUrl: string, roomId: string): void {
    if (this.disposed) return
    const url = `${relayUrl.replace(/\/$/, '')}/v1/session/${roomId}`
    this.socket = this.opts.socketFactory(
      url,
      { 'x-taskwraith-role': 'iphone', 'x-taskwraith-protocol': HUMAN_COLLABORATION_PROTOCOL },
      {
        onOpen: () => this.setConnected(true),
        onMessage: (data) => this.handleInbound(data),
        onClose: () => {
          this.setConnected(false)
          // Fail fast: a drop mid-handshake should reject pending begin/confirm
          // AND any whenConnected() waiter immediately, instead of hanging on
          // their timeouts (a dead/unlistened room otherwise stalls the join).
          const err = new Error('Collaboration transport disconnected.')
          this.settleConnectWaiters(err)
          this.rejectPending(err)
        },
        onError: (err) => this.opts.onError?.(err)
      }
    )
  }

  /**
   * Phase 1: begin admission, reconstruct + verify the transcript, surface the
   * locally-computed 6-digit SAS (via onSasCode), derive the session keys, and
   * sign — then HOLD. The session is NOT established yet; the human must compare
   * the SAS out of band and call confirmAdmission() to proceed (L6-2).
   */
  async beginAdmission(input: CollaboratorAdmissionInput): Promise<{ confirmCode: string }> {
    const ephemeral = generateEphemeralKeyPair()
    const nonce = randomBytes(16)
    const collaboratorIdentityPubKeyB64 = b64.encode(exportRawEd25519PublicKey(this.identity.publicKey))
    const collaboratorEphemeralPubKeyB64 = b64.encode(exportRawX25519PublicKey(ephemeral.publicKey))
    const collaboratorNonceB64 = b64.encode(nonce)

    const begin = (await this.request('begin', {
      shareId: input.shareId,
      chatId: input.chatId,
      displayName: input.displayName,
      inviteToken: input.inviteToken,
      collaboratorIdentityPubKeyB64,
      collaboratorEphemeralPubKeyB64,
      collaboratorNonceB64
    })) as HumanCollaborationBeginHandshakeResult

    const context: HumanCollaborationHandshakeContext = {
      protocol: HUMAN_COLLABORATION_PROTOCOL,
      mode: 'admission',
      shareId: input.shareId,
      chatId: input.chatId,
      inviteId: begin.inviteId,
      inviteTokenHash: hashInviteToken(input.inviteToken),
      inviteExpiresAt: begin.expiresAt,
      shareMode: input.shareMode,
      collaboratorId: undefined,
      hostIdentityPubKeyB64: begin.hostIdentityPubKeyB64,
      collaboratorIdentityPubKeyB64,
      hostEphemeralPubKeyB64: begin.hostEphemeralPubKeyB64,
      collaboratorEphemeralPubKeyB64,
      hostNonceB64: begin.hostNonceB64,
      collaboratorNonceB64
    }
    const transcriptHash = computeHumanCollaborationTranscriptHash(context)
    if (!transcriptHash.equals(b64.decode(begin.transcriptHashB64))) {
      throw new Error('Collaboration transcript mismatch — refusing to confirm.')
    }
    const hostIdentity = importRawEd25519PublicKey(b64.decode(begin.hostIdentityPubKeyB64))
    if (!verifyEd25519(hostIdentity, transcriptHash, b64.decode(begin.hostTranscriptSigB64))) {
      throw new Error('Host transcript signature invalid — refusing to confirm.')
    }
    // Optional out-of-band host-key pin (Crypto-F2): if the invite carried the
    // host identity key, it MUST match the one the host just presented.
    if (input.expectedHostIdentityPubKeyB64 && input.expectedHostIdentityPubKeyB64 !== begin.hostIdentityPubKeyB64) {
      throw new Error('Host identity does not match the invite — refusing to confirm.')
    }

    const localCode = humanCollaborationConfirmCode(context)
    this.sessionKeys = deriveHumanCollaborationSessionKeys({
      hostEphemeralPrivate: ephemeral.privateKey,
      collaboratorEphemeralPublic: importRawX25519PublicKey(b64.decode(begin.hostEphemeralPubKeyB64)),
      hostNonce: b64.decode(begin.hostNonceB64),
      collaboratorNonce: nonce
    })
    this.pendingConfirm = {
      handshakeId: begin.handshakeId,
      confirmCode: localCode,
      sigB64: b64.encode(signEd25519(this.identity.privateKey, transcriptHash))
    }
    this.opts.onSasCode?.(localCode)
    return { confirmCode: localCode }
  }

  /**
   * Phase 2: the human compared the SAS and accepted — send the confirm and
   * establish the session. Throws if beginAdmission hasn't run.
   */
  async confirmAdmission(): Promise<HumanCollaborationConfirmSasResult> {
    const pending = this.pendingConfirm
    if (!pending) throw new Error('No pending admission to confirm.')
    const confirm = (await this.request('confirm', {
      handshakeId: pending.handshakeId,
      confirmCode: pending.confirmCode,
      collaboratorTranscriptSigB64: pending.sigB64
    })) as HumanCollaborationConfirmSasResult
    this.pendingConfirm = null
    this.sessionId = confirm.sessionId
    this.opts.onEstablished?.({ sessionId: confirm.sessionId, collaboratorId: confirm.collaboratorId })
    return confirm
  }

  /** Convenience: begin + immediately confirm (no human gate; used in tests). */
  async admit(input: CollaboratorAdmissionInput): Promise<HumanCollaborationConfirmSasResult> {
    await this.beginAdmission(input)
    return this.confirmAdmission()
  }

  /**
   * Slice 5 reconnect: pinned-identity re-admission with NO invite token and NO
   * human SAS re-compare. Replacement trust anchors (all mandatory):
   *   1. the host validates our pinned identity key against the participant it
   *      originally admitted (revoked identities fail closed),
   *   2. we REQUIRE the host's identity key to match the one persisted at the
   *      original join (a different host = hard refusal),
   *   3. both sides sign a FRESH transcript over fresh ephemerals + nonces, so
   *      every reconnect gets brand-new session keys.
   * The host still surfaces the reconnect visibly (admission event + session
   * summaries carry mode 'reconnect'), so it is never silent.
   */
  async reconnect(input: CollaboratorReconnectInput): Promise<HumanCollaborationConfirmSasResult> {
    if (!input.expectedHostIdentityPubKeyB64) {
      throw new Error('Reconnect requires the pinned host identity key.')
    }
    const ephemeral = generateEphemeralKeyPair()
    const nonce = randomBytes(16)
    const collaboratorIdentityPubKeyB64 = b64.encode(exportRawEd25519PublicKey(this.identity.publicKey))
    const collaboratorEphemeralPubKeyB64 = b64.encode(exportRawX25519PublicKey(ephemeral.publicKey))
    const collaboratorNonceB64 = b64.encode(nonce)

    const begin = (await this.request('begin', {
      shareId: input.shareId,
      chatId: input.chatId,
      displayName: input.displayName,
      collaboratorId: input.collaboratorId,
      collaboratorIdentityPubKeyB64,
      collaboratorEphemeralPubKeyB64,
      collaboratorNonceB64
    })) as HumanCollaborationBeginHandshakeResult

    if (begin.mode !== 'reconnect') {
      throw new Error('Host did not treat this as a reconnect — refusing to continue.')
    }
    // Reconstruct the reconnect transcript exactly as the host built it: the
    // pinned-token placeholder replaces the invite hash (there is no token).
    const context: HumanCollaborationHandshakeContext = {
      protocol: HUMAN_COLLABORATION_PROTOCOL,
      mode: 'reconnect',
      shareId: input.shareId,
      chatId: input.chatId,
      inviteId: begin.inviteId,
      inviteTokenHash: `pinned:${collaboratorIdentityPubKeyB64}`,
      inviteExpiresAt: begin.expiresAt,
      shareMode: input.shareMode,
      collaboratorId: input.collaboratorId,
      hostIdentityPubKeyB64: begin.hostIdentityPubKeyB64,
      collaboratorIdentityPubKeyB64,
      hostEphemeralPubKeyB64: begin.hostEphemeralPubKeyB64,
      collaboratorEphemeralPubKeyB64,
      hostNonceB64: begin.hostNonceB64,
      collaboratorNonceB64
    }
    const transcriptHash = computeHumanCollaborationTranscriptHash(context)
    if (!transcriptHash.equals(b64.decode(begin.transcriptHashB64))) {
      throw new Error('Collaboration transcript mismatch — refusing to reconnect.')
    }
    const hostIdentity = importRawEd25519PublicKey(b64.decode(begin.hostIdentityPubKeyB64))
    if (!verifyEd25519(hostIdentity, transcriptHash, b64.decode(begin.hostTranscriptSigB64))) {
      throw new Error('Host transcript signature invalid — refusing to reconnect.')
    }
    // MANDATORY host pin: the SAS is skipped only because this key already
    // survived a human SAS compare at the original join.
    if (input.expectedHostIdentityPubKeyB64 !== begin.hostIdentityPubKeyB64) {
      throw new Error('Host identity changed since the original join — refusing to reconnect.')
    }

    this.sessionKeys = deriveHumanCollaborationSessionKeys({
      hostEphemeralPrivate: ephemeral.privateKey,
      collaboratorEphemeralPublic: importRawX25519PublicKey(b64.decode(begin.hostEphemeralPubKeyB64)),
      hostNonce: b64.decode(begin.hostNonceB64),
      collaboratorNonce: nonce
    })
    const confirm = (await this.request('confirm', {
      handshakeId: begin.handshakeId,
      confirmCode: humanCollaborationConfirmCode(context),
      collaboratorTranscriptSigB64: b64.encode(signEd25519(this.identity.privateKey, transcriptHash))
    })) as HumanCollaborationConfirmSasResult
    this.sessionId = confirm.sessionId
    this.opts.onEstablished?.({ sessionId: confirm.sessionId, collaboratorId: confirm.collaboratorId })
    return confirm
  }


  /** Subscribe to live projection updates (host pushes sealed projection frames). */
  subscribe(): void {
    this.sendSealed(HUMAN_COLLABORATION_METHODS.subscribeProjection, { sessionId: this.sessionId })
  }

  appendComment(
    content: string,
    clientMessageId: string = randomUUID(),
    intent?: 'comment' | 'requestHostAction'
  ): void {
    this.sendSealed(HUMAN_COLLABORATION_METHODS.appendComment, {
      sessionId: this.sessionId,
      clientMessageId,
      content,
      // P2b intent — a pre-P2b host ignores the field (fail-safe: it records a
      // plain host-reviewed comment); a P2b host validates it against rules.
      ...(intent === 'requestHostAction' ? { intent } : {})
    })
  }

  dispose(): void {
    this.disposed = true
    const socket = this.socket
    if (this.isEstablished) {
      try {
        this.sendSealed(HUMAN_COLLABORATION_METHODS.disconnect, { sessionId: this.sessionId })
      } catch {
        // best-effort
      }
    }
    const err = new Error('Collaboration client disposed.')
    this.settleConnectWaiters(err)
    this.rejectPending(err)
    this.socket = null
    // Defer the close a tick so the best-effort disconnect frame egresses
    // before the socket teardown (so the host drops the session promptly).
    setTimeout(() => socket?.close(), 0)
    this.setConnected(false)
  }

  private rejectPending(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pending.clear()
  }

  private request(method: 'begin' | 'confirm', params: unknown): Promise<unknown> {
    if (!this.socket) return Promise.reject(new Error('Collaboration transport is not connected.'))
    const reqId = randomUUID()
    const timeoutMs = this.opts.requestTimeoutMs ?? 30_000
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId)
        reject(new Error(`Collaboration ${method} timed out.`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(reqId, { resolve, reject, timer })
      this.socket?.send(JSON.stringify(makeTransportRequest(reqId, method, params)))
    })
  }

  private sendSealed(method: string, params: unknown): void {
    if (!this.sessionKeys || !this.socket) throw new Error('Collaboration session is not established.')
    const seq = this.nextOutboundSeq++
    const frame = sealHumanCollaborationMessage({
      keys: this.sessionKeys,
      direction: 'collaboratorToHost',
      sessionId: this.sessionId,
      seq,
      message: { msgId: seq, method: method as never, params }
    })
    this.socket.send(JSON.stringify(frame))
  }

  private handleInbound(data: string): void {
    const message = parseTransportMessage(data)
    if (!message) return
    if (message.t === 'collab.res') {
      const pending = this.pending.get(message.reqId)
      if (!pending) return
      this.pending.delete(message.reqId)
      clearTimeout(pending.timer)
      if (message.ok) pending.resolve(message.result)
      else pending.reject(new Error(message.error || 'Collaboration request rejected.'))
      return
    }
    if (message.t === 'humanCollaboration.enc') {
      this.handleSealed(message)
    }
  }

  private handleSealed(frame: HumanCollaborationEncryptedFrame): void {
    if (!this.sessionKeys) return
    if (frame.sessionId !== this.sessionId) return
    if (frame.seq <= this.lastInboundSeq) return // replay / out of order
    let opened
    try {
      opened = openHumanCollaborationFrame({
        keys: this.sessionKeys,
        expectedDirection: 'hostToCollaborator',
        frame
      })
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)))
      return
    }
    this.lastInboundSeq = frame.seq
    if (opened.method === HUMAN_COLLABORATION_EVENTS.projectionUpdate) {
      const params = (opened.params || {}) as { projection?: unknown }
      if (params.projection !== undefined) this.opts.onProjection?.(params.projection)
    }
  }

  private setConnected(value: boolean): void {
    if (this.connected === value) return
    this.connected = value
    if (value) this.settleConnectWaiters(null)
    this.opts.onConnectionChange?.(value)
  }
}
