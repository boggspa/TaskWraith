import { randomBytes, randomUUID } from 'crypto'
import type { KeyPair } from '../../shared/e2ee/keys'
import {
  b64,
  exportRawEd25519PublicKey,
  exportRawX25519PublicKey,
  generateEphemeralKeyPair,
  importRawEd25519PublicKey,
  importRawX25519PublicKey,
  signEd25519,
  verifyEd25519
} from '../../shared/e2ee/keys'
import {
  computeHumanCollaborationTranscriptHash,
  deriveHumanCollaborationSessionKeys,
  humanCollaborationConfirmCode
} from '../../shared/collaboration/HumanCollaborationKeySchedule'
import {
  openHumanCollaborationFrame,
  sealHumanCollaborationMessage
} from '../../shared/collaboration/HumanCollaborationCipher'
import {
  HUMAN_COLLABORATION_EVENTS,
  HUMAN_COLLABORATION_METHODS,
  type HumanCollaborationAppendCommentInput,
  type HumanCollaborationBeginHandshakeInput,
  type HumanCollaborationBeginHandshakeResult,
  type HumanCollaborationConfirmSasInput,
  type HumanCollaborationConfirmSasResult,
  type HumanCollaborationDisconnectInput,
  type HumanCollaborationEncryptedFrame,
  type HumanCollaborationHandshakeContext,
  type HumanCollaborationHandshakeMode,
  type HumanCollaborationPlainMessage,
  type HumanCollaborationSubscribeProjectionInput,
  HUMAN_COLLABORATION_PROTOCOL,
  type HumanCollaborationMethod
} from '../../shared/collaboration/HumanCollaborationProtocol'
import type { HumanCollaborationSessionKeys } from '../../shared/collaboration/HumanCollaborationKeySchedule'
import {
  hashInviteToken,
  HumanCollaborationStore,
  type HumanCollaborationShare
} from './HumanCollaborationStore'
import { HumanCollaborationDenialError } from './HumanContributionRules'
import type { HumanCollaborationAuditLike } from './HumanCollaborationAuditLog'

// Append rate limit (per shareId:collaboratorId). Collaborators are untrusted;
// each accepted append triggers a whole-chat persist + a projection reseal +
// fanout, so an unthrottled stream can saturate the host. Honest clients never
// hit these. Kept on the runtime so it costs nothing for non-collaborators.
const APPEND_MIN_INTERVAL_MS = 750
const APPEND_WINDOW_MS = 60_000
const APPEND_MAX_PER_WINDOW = 30
// Bound un-consumed pending handshakes (each holds live derived session keys)
// so a holder of a valid invite token cannot accumulate key material by
// repeatedly calling beginAdmission within the invite TTL.
const MAX_PENDING_PER_SHARE = 4
const MAX_PENDING_TOTAL = 32

export interface HumanCollaborationProjectionRequest {
  sessionId: string
  share: HumanCollaborationShare
  collaboratorId: string
  collaboratorIdentityPubKeyB64: string
  displayName: string
  establishedAt: number
}

export interface HumanCollaborationAppendRequest {
  sessionId: string
  share: HumanCollaborationShare
  shareId: string
  chatId: string
  collaboratorId: string
  collaboratorIdentityPubKeyB64: string
  displayName: string
  establishedAt: number
  clientMessageId: string
  content: string
}

export interface HumanCollaborationRuntimeDeps<ProjectionType, AppendType> {
  identityKeyPair: KeyPair
  store: HumanCollaborationStore
  buildProjection: (input: HumanCollaborationProjectionRequest) => ProjectionType | Promise<ProjectionType>
  appendComment: (input: HumanCollaborationAppendRequest & HumanCollaborationAppendCommentInput) => AppendType | Promise<AppendType>
  publishProjection?: (sessionId: string, projection: ProjectionType) => void | Promise<void>
  publishEncryptedProjection?: (
    sessionId: string,
    frame: HumanCollaborationEncryptedFrame
  ) => void | Promise<void>
  /** Fired when a collaborator begins admission, so the HOST can surface the
   * 6-digit SAS for the out-of-band compare (L6-2). */
  onAdmissionBegan?: (info: {
    handshakeId: string
    chatId: string
    shareId: string
    displayName: string
    confirmCode: string
  }) => void
  /** P2a durable audit sink (admission, session, rejected-contribution events). */
  audit?: HumanCollaborationAuditLike
  now?: () => number
  log?: (line: string) => void
}

interface RuntimePendingAdmission {
  handshakeId: string
  inviteToken: string
  shareId: string
  chatId: string
  inviteId: string
  context: HumanCollaborationHandshakeContext
  confirmCode: string
  hostTranscriptSigB64: string
  transcriptHashB64: string
  publicKeyId: string
  keys: HumanCollaborationSessionKeys
  collaboratorIdentityPubKeyB64: string
  hostIdentityPubKeyB64: string
  displayName: string
  createdAt: number
  mode: HumanCollaborationHandshakeMode
}

interface RuntimeSession {
  sessionId: string
  handshakeId: string
  shareId: string
  chatId: string
  collaboratorId: string
  displayName: string
  collaboratorIdentityPubKeyB64: string
  establishedAt: number
  shareMode: HumanCollaborationShare['mode']
  mode: HumanCollaborationHandshakeMode
  keys: HumanCollaborationSessionKeys
  nextOutboundSeq: number
  lastInboundSeq: number
}

export class HumanCollaborationRuntime<ProjectionType = unknown, AppendType = unknown> {
  private readonly opts: HumanCollaborationRuntimeDeps<ProjectionType, AppendType>
  private readonly now: () => number
  private readonly pending = new Map<string, RuntimePendingAdmission>()
  private readonly sessions = new Map<string, RuntimeSession>()
  private readonly projectionSubscribers = new Set<string>()
  // Per shareId:collaboratorId append-rate state (see APPEND_* constants). Key
  // space is tiny (≤2 collaborators/share) and intentionally NOT reset on
  // disconnect, so a flooder cannot bypass the limit by reconnecting.
  private readonly appendRate = new Map<string, { windowStart: number; count: number; last: number }>()

  constructor(options: HumanCollaborationRuntimeDeps<ProjectionType, AppendType>) {
    this.opts = options
    this.now = options.now ?? Date.now
  }

  /** The host's identity public key (raw, b64) — goes in the invite so a
   * collaborator can pin it (Crypto-F2); also the `hostIdentityPubKeyB64` in
   * every beginAdmission result. */
  hostIdentityPubKeyB64(): string {
    return b64.encode(exportRawEd25519PublicKey(this.opts.identityKeyPair.publicKey))
  }

  async routeAction<ReturnType = unknown>(
    method: HumanCollaborationMethod,
    params: unknown
  ): Promise<ReturnType> {
    if (method === HUMAN_COLLABORATION_METHODS.beginHandshake) {
      return this.beginAdmission(params as HumanCollaborationBeginHandshakeInput) as unknown as Promise<ReturnType>
    }
    if (method === HUMAN_COLLABORATION_METHODS.confirmSas) {
      return this.confirmSas(params as HumanCollaborationConfirmSasInput) as unknown as Promise<ReturnType>
    }
    if (method === HUMAN_COLLABORATION_METHODS.subscribeProjection) {
      return this.subscribeProjection(
        params as HumanCollaborationSubscribeProjectionInput
      ) as unknown as Promise<ReturnType>
    }
    if (method === HUMAN_COLLABORATION_METHODS.appendComment) {
      return this.appendComment(params as HumanCollaborationAppendCommentInput & { sessionId: string }) as unknown as Promise<ReturnType>
    }
    if (method === HUMAN_COLLABORATION_METHODS.disconnect) {
      return this.disconnect(params as HumanCollaborationDisconnectInput) as unknown as Promise<ReturnType>
    }
    throw new HumanCollaborationDenialError(
      'protocol_unsupported',
      `Unsupported human collaboration method: ${String(method)}`
    )
  }

  async beginAdmission(input: HumanCollaborationBeginHandshakeInput): Promise<HumanCollaborationBeginHandshakeResult> {
    const now = this.now()
    this.cleanupExpiredPending(now)
    const { shareId, chatId, displayName, inviteToken, collaboratorId, collaboratorIdentityPubKeyB64, collaboratorEphemeralPubKeyB64, collaboratorNonceB64 } =
      input
    const mode: HumanCollaborationHandshakeMode = collaboratorId && !inviteToken ? 'reconnect' : 'admission'
    if (mode === 'admission' && !inviteToken) {
      throw new Error('Collaboration invite token is required.')
    }
    // Bound un-consumed pending handshakes (each retains live session keys) so a
    // valid-token holder can't accumulate key material by spamming beginAdmission.
    if (this.pending.size >= MAX_PENDING_TOTAL) {
      throw new Error('Too many pending collaboration handshakes; try again shortly.')
    }
    let pendingForShare = 0
    for (const candidate of this.pending.values()) {
      if (candidate.shareId === shareId) pendingForShare += 1
    }
    if (pendingForShare >= MAX_PENDING_PER_SHARE) {
      throw new Error('Too many pending collaboration handshakes; try again shortly.')
    }
    const verification =
      mode === 'admission'
        ? this.opts.store.verifyInvite({
            shareId,
            inviteToken: inviteToken || '',
            chatId,
            displayName,
            publicKeyId: collaboratorIdentityPubKeyB64,
            now
          })
        : this.opts.store.validateParticipantSession({
            shareId,
            chatId,
            collaboratorId: collaboratorId || '',
            publicKeyId: collaboratorIdentityPubKeyB64
          })
    const share = verification.share
    const existingParticipant =
      'existingParticipant' in verification
        ? verification.existingParticipant || undefined
        : verification.participant
    const invite =
      'invite' in verification
        ? verification.invite
        : {
            inviteId: `reconnect:${existingParticipant!.collaboratorId}`,
            tokenHash: `pinned:${existingParticipant!.publicKeyId}`,
            createdAt: now,
            expiresAt: now + 5 * 60 * 1000
          }
    const tokenHash = inviteToken ? hashInviteToken(inviteToken) : invite.tokenHash

    const hostIdentityPubKeyB64 = b64.encode(exportRawEd25519PublicKey(this.opts.identityKeyPair.publicKey))
    const hostEphemeral = generateEphemeralKeyPair()
    const hostNonce = randomBytes(16)
    const hostEphemeralPubKeyB64 = b64.encode(exportRawX25519PublicKey(hostEphemeral.publicKey))
    const hostNonceB64 = b64.encode(hostNonce)

    const context: HumanCollaborationHandshakeContext = {
      protocol: HUMAN_COLLABORATION_PROTOCOL,
      mode,
      shareId,
      chatId,
      inviteId: invite.inviteId,
      inviteTokenHash: tokenHash,
      inviteExpiresAt: invite.expiresAt,
      shareMode: share.mode,
      collaboratorId: existingParticipant?.collaboratorId,
      hostIdentityPubKeyB64,
      collaboratorIdentityPubKeyB64,
      hostEphemeralPubKeyB64,
      collaboratorEphemeralPubKeyB64,
      hostNonceB64,
      collaboratorNonceB64
    }

    const transcriptHash = computeHumanCollaborationTranscriptHash(context)
    const confirmCode = humanCollaborationConfirmCode(context)
    const hostTranscriptSigB64 = b64.encode(signEd25519(this.opts.identityKeyPair.privateKey, transcriptHash))

    const keys = deriveHumanCollaborationSessionKeys({
      hostEphemeralPrivate: hostEphemeral.privateKey,
      collaboratorEphemeralPublic: importRawX25519PublicKey(b64.decode(collaboratorEphemeralPubKeyB64)),
      hostNonce,
      collaboratorNonce: b64.decode(collaboratorNonceB64)
    })

    const handshakeId = randomUUID()
    this.pending.set(handshakeId, {
      handshakeId,
      inviteToken: inviteToken || '',
      shareId,
      chatId,
      inviteId: invite.inviteId,
      context,
      confirmCode,
      hostTranscriptSigB64,
      transcriptHashB64: b64.encode(transcriptHash),
      publicKeyId: collaboratorIdentityPubKeyB64,
      keys,
      collaboratorIdentityPubKeyB64,
      hostIdentityPubKeyB64,
      displayName:
        share.mode === 'readOnly'
          ? displayName
          : existingParticipant?.displayName || displayName,
      createdAt: now,
      mode
    })

    // Surface the SAS to the host so the human can compare it out of band (L6-2).
    this.opts.onAdmissionBegan?.({
      handshakeId,
      chatId,
      shareId,
      displayName: share.mode === 'readOnly' ? displayName : existingParticipant?.displayName || displayName,
      confirmCode
    })
    this.opts.audit?.append({
      kind: 'admission.began',
      chatId,
      shareId,
      ...(existingParticipant?.collaboratorId
        ? { collaboratorId: existingParticipant.collaboratorId }
        : {}),
      detail: `${mode} · ${share.mode === 'readOnly' ? displayName : existingParticipant?.displayName || displayName}`
    })

    return {
      handshakeId,
      protocol: HUMAN_COLLABORATION_PROTOCOL,
      mode,
      shareId,
      chatId,
      inviteId: invite.inviteId,
      hostIdentityPubKeyB64,
      hostEphemeralPubKeyB64,
      hostNonceB64,
      confirmCode,
      hostTranscriptSigB64,
      transcriptHashB64: b64.encode(transcriptHash),
      expiresAt: invite.expiresAt
    }
  }

  async confirmSas(input: HumanCollaborationConfirmSasInput): Promise<HumanCollaborationConfirmSasResult> {
    const now = this.now()
    const pending = this.pending.get(input.handshakeId)
    if (!pending) {
      throw new Error('Collaboration handshake is not active.')
    }
    if (now > pending.context.inviteExpiresAt) {
      this.pending.delete(input.handshakeId)
      throw new Error('Collaboration invite has expired.')
    }
    if (input.confirmCode !== pending.confirmCode) {
      // A failed admission attempt is terminal: drop the pending handshake (and
      // its derived keys) so it can't be retried and doesn't linger until TTL.
      this.pending.delete(input.handshakeId)
      this.opts.audit?.append({
        kind: 'admission.sas_failed',
        chatId: pending.chatId,
        shareId: pending.shareId,
        detail: 'confirm code mismatch'
      })
      throw new Error('Confirmation code mismatch.')
    }
    const collaboratorPublic = importRawEd25519PublicKey(b64.decode(pending.collaboratorIdentityPubKeyB64))
    const transcriptHash = b64.decode(pending.transcriptHashB64)
    const collaboratorSig = b64.decode(input.collaboratorTranscriptSigB64)
    const transcriptValid = verifyEd25519(collaboratorPublic, transcriptHash, collaboratorSig)
    if (!transcriptValid) {
      this.pending.delete(input.handshakeId)
      this.opts.audit?.append({
        kind: 'admission.sas_failed',
        chatId: pending.chatId,
        shareId: pending.shareId,
        detail: 'collaborator transcript signature invalid'
      })
      throw new Error('Collaborator transcript signature invalid.')
    }

    const admitted =
      pending.mode === 'admission'
        ? this.opts.store.consumeInvite({
            shareId: pending.shareId,
            inviteToken: pending.inviteToken,
            displayName: pending.displayName,
            publicKeyId: pending.publicKeyId,
            chatId: pending.chatId,
            now
          })
        : this.opts.store.validateParticipantSession({
            shareId: pending.shareId,
            chatId: pending.chatId,
            collaboratorId: pending.context.collaboratorId || '',
            publicKeyId: pending.publicKeyId
          })

    const participant = admitted.participant
    const sessionId = randomUUID()
    const establishedAt = now
    const session: RuntimeSession = {
      sessionId,
      handshakeId: pending.handshakeId,
      shareId: admitted.share.shareId,
      chatId: pending.chatId,
      collaboratorId: participant.collaboratorId,
      displayName: participant.displayName,
      collaboratorIdentityPubKeyB64: pending.collaboratorIdentityPubKeyB64,
      establishedAt,
      shareMode: admitted.share.mode,
      mode: pending.mode,
      keys: pending.keys,
      nextOutboundSeq: 1,
      lastInboundSeq: 0
    }
    this.sessions.set(sessionId, session)
    this.pending.delete(input.handshakeId)
    this.opts.audit?.append({
      kind: 'admission.sas_confirmed',
      chatId: pending.chatId,
      shareId: admitted.share.shareId,
      collaboratorId: participant.collaboratorId,
      detail: `${pending.mode} · ${participant.displayName}`
    })

    return {
      sessionId,
      shareId: admitted.share.shareId,
      chatId: pending.chatId,
      collaboratorId: participant.collaboratorId,
      displayName: participant.displayName,
      hostIdentityPubKeyB64: pending.hostIdentityPubKeyB64,
      establishedAt
    }
  }

  async subscribeProjection(input: HumanCollaborationSubscribeProjectionInput): Promise<ProjectionType> {
    const session = this.requireActiveSession(input.sessionId)
    this.projectionSubscribers.add(session.sessionId)
    const share = this.getActiveShare(session.shareId)
    return this.opts.buildProjection({
      sessionId: session.sessionId,
      share,
      collaboratorId: session.collaboratorId,
      collaboratorIdentityPubKeyB64: session.collaboratorIdentityPubKeyB64,
      displayName: session.displayName,
      establishedAt: session.establishedAt
    })
  }

  async appendComment(
    input: HumanCollaborationAppendCommentInput & { sessionId: string }
  ): Promise<AppendType> {
    const session = this.requireActiveSession(input.sessionId)
    this.enforceAppendRateLimit(session)
    this.opts.store.validateAppend({
      shareId: session.shareId,
      chatId: session.chatId,
      collaboratorId: session.collaboratorId,
      clientMessageId: input.clientMessageId,
      // Whitelisted intent: anything but the exact P2b action-request string
      // degrades to a plain comment (fail-safe for junk/hostile values).
      ...(input.intent === 'requestHostAction' ? { intent: 'requestHostAction' as const } : {})
    })

    const share = this.getActiveShare(session.shareId)
    return this.opts.appendComment({
      ...input,
      // Sanitized here once so downstream deps never see a hostile intent value.
      intent: input.intent === 'requestHostAction' ? 'requestHostAction' : undefined,
      sessionId: session.sessionId,
      share,
      shareId: session.shareId,
      chatId: session.chatId,
      collaboratorId: session.collaboratorId,
      collaboratorIdentityPubKeyB64: session.collaboratorIdentityPubKeyB64,
      displayName: session.displayName,
      establishedAt: session.establishedAt
    })
  }

  async disconnect(input: HumanCollaborationDisconnectInput): Promise<boolean> {
    const session = this.sessions.get(input.sessionId)
    const removed = this.sessions.delete(input.sessionId)
    this.projectionSubscribers.delete(input.sessionId)
    if (!removed) return false
    if (session) {
      this.opts.audit?.append({
        kind: 'session.disconnected',
        chatId: session.chatId,
        shareId: session.shareId,
        collaboratorId: session.collaboratorId
      })
    }
    return true
  }

  /**
   * chatIds that currently have at least one LIVE collaborator session — a
   * collaborator who completed admission and has not disconnected (graceful
   * leave) or been revoked. This is the only state that reflects "someone is
   * actually connected right now" (the store's participant status and the
   * transport's room map only clear on revoke, not on leave), so it drives the
   * Shares "someone's here" glow. NB: an ungraceful drop (crash / lost network)
   * lingers until revoke or restart.
   */
  connectedChatIds(): string[] {
    const ids = new Set<string>()
    for (const session of this.sessions.values()) ids.add(session.chatId)
    return Array.from(ids)
  }

  /**
   * P2a presence clarity (spec §6): per-session summaries so host surfaces can
   * distinguish "participant active in the store" from "live session connected
   * right now" — per share AND per collaborator, not just per chat. Only
   * non-sensitive routing fields are exposed (no keys, no sequence state).
   */
  sessionSummaries(): Array<{
    chatId: string
    shareId: string
    collaboratorId: string
    displayName: string
    establishedAt: number
    mode: HumanCollaborationHandshakeMode
  }> {
    return Array.from(this.sessions.values()).map((session) => ({
      chatId: session.chatId,
      shareId: session.shareId,
      collaboratorId: session.collaboratorId,
      displayName: session.displayName,
      establishedAt: session.establishedAt,
      mode: session.mode
    }))
  }

  sealForCollaborator(
    sessionId: string,
    message: Omit<HumanCollaborationPlainMessage, 'msgId'> & { msgId?: number }
  ): HumanCollaborationEncryptedFrame {
    const session = this.requireActiveSession(sessionId)
    const seq = session.nextOutboundSeq++
    return sealHumanCollaborationMessage({
      keys: session.keys,
      direction: 'hostToCollaborator',
      sessionId,
      seq,
      message: {
        msgId: message.msgId ?? seq,
        method: message.method,
        ...(message.params !== undefined ? { params: message.params } : {})
      }
    })
  }

  openFromCollaborator(frame: HumanCollaborationEncryptedFrame): HumanCollaborationPlainMessage {
    const session = this.requireActiveSession(frame.sessionId)
    if (frame.seq <= session.lastInboundSeq) {
      throw new Error('Collaboration frame replay detected.')
    }
    const message = openHumanCollaborationFrame({
      keys: session.keys,
      expectedDirection: 'collaboratorToHost',
      frame
    })
    session.lastInboundSeq = frame.seq
    return message
  }

  async routeEncryptedAction(frame: HumanCollaborationEncryptedFrame): Promise<unknown> {
    const message = this.openFromCollaborator(frame)
    const params = message.params && typeof message.params === 'object' ? message.params : {}
    if (message.method === HUMAN_COLLABORATION_METHODS.subscribeProjection) {
      return this.subscribeProjection({ sessionId: frame.sessionId })
    }
    if (message.method === HUMAN_COLLABORATION_METHODS.appendComment) {
      const input = params as Partial<HumanCollaborationAppendCommentInput>
      return this.appendComment({
        sessionId: frame.sessionId,
        clientMessageId: requireFrameString(input.clientMessageId, 'Client message id'),
        content: requireFrameString(input.content, 'Comment'),
        // Whitelist at the wire boundary too: only the exact P2b string passes.
        ...(input.intent === 'requestHostAction' ? { intent: 'requestHostAction' as const } : {})
      })
    }
    if (message.method === HUMAN_COLLABORATION_METHODS.disconnect) {
      return this.disconnect({ sessionId: frame.sessionId })
    }
    throw new HumanCollaborationDenialError(
      'protocol_unsupported',
      `Unsupported encrypted human collaboration method: ${message.method}`
    )
  }

  sealProjectionUpdate(
    sessionId: string,
    projection: ProjectionType
  ): HumanCollaborationEncryptedFrame {
    return this.sealForCollaborator(sessionId, {
      method: HUMAN_COLLABORATION_EVENTS.projectionUpdate,
      params: { projection }
    })
  }

  async publishProjectionUpdates(chatId?: string): Promise<void> {
    if (!this.opts.publishProjection && !this.opts.publishEncryptedProjection) return
    for (const sessionId of Array.from(this.projectionSubscribers)) {
      const session = this.sessions.get(sessionId)
      if (!session || (chatId && session.chatId !== chatId)) continue
      try {
        const projection = await this.subscribeProjection({ sessionId })
        await this.opts.publishProjection?.(sessionId, projection)
        if (this.opts.publishEncryptedProjection) {
          const frame = this.sealProjectionUpdate(sessionId, projection)
          await this.opts.publishEncryptedProjection(sessionId, frame)
        }
      } catch (err) {
        this.projectionSubscribers.delete(sessionId)
        this.opts.log?.(
          `[human-collaboration] projection push skipped for session ${sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }
  }

  private enforceAppendRateLimit(session: RuntimeSession): void {
    const now = this.now()
    const key = `${session.shareId}:${session.collaboratorId}`
    const state = this.appendRate.get(key)
    if (!state) {
      this.appendRate.set(key, { windowStart: now, count: 1, last: now })
      return
    }
    if (now - state.last < APPEND_MIN_INTERVAL_MS) {
      throw this.rateLimitDenial(session)
    }
    if (now - state.windowStart >= APPEND_WINDOW_MS) {
      state.windowStart = now
      state.count = 0
    }
    if (state.count >= APPEND_MAX_PER_WINDOW) {
      throw this.rateLimitDenial(session)
    }
    state.count += 1
    state.last = now
  }

  private rateLimitDenial(session: RuntimeSession): HumanCollaborationDenialError {
    this.opts.audit?.append({
      kind: 'contribution.rejected',
      chatId: session.chatId,
      shareId: session.shareId,
      collaboratorId: session.collaboratorId,
      code: 'quota_exceeded'
    })
    return new HumanCollaborationDenialError('quota_exceeded', 'Comment rate limit exceeded, slow down.')
  }

  private requireActiveSession(sessionId: string): RuntimeSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new HumanCollaborationDenialError('stale_session', 'Collaboration session is not active.')
    }
    const share = this.opts.store.getShare(session.shareId)
    if (!share || !share.enabled) {
      this.sessions.delete(sessionId)
      this.projectionSubscribers.delete(sessionId)
      throw new HumanCollaborationDenialError('revoked', 'Collaboration share is no longer active.')
    }
    const participant = share.participants.find((candidate) => candidate.collaboratorId === session.collaboratorId)
    if (
      !participant ||
      participant.status !== 'active' ||
      participant.publicKeyId !== session.collaboratorIdentityPubKeyB64
    ) {
      this.sessions.delete(sessionId)
      this.projectionSubscribers.delete(sessionId)
      throw new HumanCollaborationDenialError('revoked', 'Collaborator is not active for this share.')
    }
    return session
  }

  private getActiveShare(shareId: string): HumanCollaborationShare {
    const share = this.opts.store.getShare(shareId)
    if (!share || !share.enabled) {
      throw new Error('Collaboration share is no longer active.')
    }
    return share
  }

  private cleanupExpiredPending(now: number): void {
    for (const [handshakeId, pending] of this.pending) {
      if (now > pending.context.inviteExpiresAt) {
        this.pending.delete(handshakeId)
      }
    }
  }
}

function requireFrameString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`)
  }
  return value
}
