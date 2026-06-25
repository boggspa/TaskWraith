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
}

export interface HumanCollaborationCollaboratorClientOptions {
  socketFactory: TransportSocketFactory
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
  private readonly identity: KeyPair = generateIdentityKeyPair()
  private socket: TransportSocket | null = null
  private connected = false
  private readonly pending = new Map<string, PendingRequest>()
  private sessionKeys: HumanCollaborationSessionKeys | null = null
  private sessionId = ''
  private nextOutboundSeq = 1
  private lastInboundSeq = 0
  private disposed = false

  constructor(options: HumanCollaborationCollaboratorClientOptions) {
    this.opts = options
  }

  get isConnected(): boolean {
    return this.connected
  }

  get isEstablished(): boolean {
    return Boolean(this.sessionKeys) && this.sessionId.length > 0
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
          // immediately instead of hanging on their 30s timeout.
          this.rejectPending(new Error('Collaboration transport disconnected.'))
        },
        onError: (err) => this.opts.onError?.(err)
      }
    )
  }

  /** Drive the full admission handshake: begin → SAS surface → confirm. */
  async admit(input: CollaboratorAdmissionInput): Promise<HumanCollaborationConfirmSasResult> {
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

    // Reconstruct the transcript INDEPENDENTLY from our own inputs + the host's
    // public handshake reply. A MITM that swapped any host key/nonce/ephemeral
    // yields a different transcript → a different 6-digit code → the humans
    // catch it on the out-of-band compare.
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
    // Integrity: our reconstructed transcript must match the host's claimed hash.
    if (!transcriptHash.equals(b64.decode(begin.transcriptHashB64))) {
      throw new Error('Collaboration transcript mismatch — refusing to confirm.')
    }
    // Verify the host's signature over the transcript with the host identity key
    // it presented (the SAS compare is what binds that key to the real host).
    const hostIdentity = importRawEd25519PublicKey(b64.decode(begin.hostIdentityPubKeyB64))
    if (!verifyEd25519(hostIdentity, transcriptHash, b64.decode(begin.hostTranscriptSigB64))) {
      throw new Error('Host transcript signature invalid — refusing to confirm.')
    }

    const localCode = humanCollaborationConfirmCode(context)
    this.opts.onSasCode?.(localCode)

    // Derive the symmetric session keys (ECDH is symmetric; the salt concatenates
    // both nonces in the same host-first order on both ends).
    this.sessionKeys = deriveHumanCollaborationSessionKeys({
      hostEphemeralPrivate: ephemeral.privateKey,
      collaboratorEphemeralPublic: importRawX25519PublicKey(b64.decode(begin.hostEphemeralPubKeyB64)),
      hostNonce: b64.decode(begin.hostNonceB64),
      collaboratorNonce: nonce
    })

    const collaboratorTranscriptSigB64 = b64.encode(signEd25519(this.identity.privateKey, transcriptHash))
    const confirm = (await this.request('confirm', {
      handshakeId: begin.handshakeId,
      confirmCode: localCode,
      collaboratorTranscriptSigB64
    })) as HumanCollaborationConfirmSasResult

    this.sessionId = confirm.sessionId
    this.opts.onEstablished?.({ sessionId: confirm.sessionId, collaboratorId: confirm.collaboratorId })
    return confirm
  }

  /** Subscribe to live projection updates (host pushes sealed projection frames). */
  subscribe(): void {
    this.sendSealed(HUMAN_COLLABORATION_METHODS.subscribeProjection, { sessionId: this.sessionId })
  }

  appendComment(content: string, clientMessageId: string = randomUUID()): void {
    this.sendSealed(HUMAN_COLLABORATION_METHODS.appendComment, {
      sessionId: this.sessionId,
      clientMessageId,
      content
    })
  }

  dispose(): void {
    this.disposed = true
    if (this.isEstablished) {
      try {
        this.sendSealed(HUMAN_COLLABORATION_METHODS.disconnect, { sessionId: this.sessionId })
      } catch {
        // best-effort
      }
    }
    this.rejectPending(new Error('Collaboration client disposed.'))
    this.socket?.close()
    this.socket = null
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
    this.opts.onConnectionChange?.(value)
  }
}
