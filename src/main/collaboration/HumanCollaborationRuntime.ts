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

  constructor(options: HumanCollaborationRuntimeDeps<ProjectionType, AppendType>) {
    this.opts = options
    this.now = options.now ?? Date.now
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
    throw new Error(`Unsupported human collaboration method: ${String(method)}`)
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
      throw new Error('Confirmation code mismatch.')
    }
    const collaboratorPublic = importRawEd25519PublicKey(b64.decode(pending.collaboratorIdentityPubKeyB64))
    const transcriptHash = b64.decode(pending.transcriptHashB64)
    const collaboratorSig = b64.decode(input.collaboratorTranscriptSigB64)
    const transcriptValid = verifyEd25519(collaboratorPublic, transcriptHash, collaboratorSig)
    if (!transcriptValid) {
      throw new Error('Collaborator transcript signature invalid.')
    }

    const admitted =
      pending.mode === 'admission'
        ? this.opts.store.consumeInvite({
            shareId: pending.shareId,
            inviteToken: pending.inviteToken,
            displayName: pending.displayName,
            publicKeyId: pending.publicKeyId,
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
    this.opts.store.validateAppend({
      shareId: session.shareId,
      chatId: session.chatId,
      collaboratorId: session.collaboratorId,
      clientMessageId: input.clientMessageId
    })

    const share = this.getActiveShare(session.shareId)
    return this.opts.appendComment({
      ...input,
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
    const removed = this.sessions.delete(input.sessionId)
    this.projectionSubscribers.delete(input.sessionId)
    if (!removed) return false
    return true
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
        content: requireFrameString(input.content, 'Comment')
      })
    }
    if (message.method === HUMAN_COLLABORATION_METHODS.disconnect) {
      return this.disconnect({ sessionId: frame.sessionId })
    }
    throw new Error(`Unsupported encrypted human collaboration method: ${message.method}`)
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

  private requireActiveSession(sessionId: string): RuntimeSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error('Collaboration session is not active.')
    }
    const share = this.opts.store.getShare(session.shareId)
    if (!share || !share.enabled) {
      this.sessions.delete(sessionId)
      this.projectionSubscribers.delete(sessionId)
      throw new Error('Collaboration share is no longer active.')
    }
    const participant = share.participants.find((candidate) => candidate.collaboratorId === session.collaboratorId)
    if (
      !participant ||
      participant.status !== 'active' ||
      participant.publicKeyId !== session.collaboratorIdentityPubKeyB64
    ) {
      this.sessions.delete(sessionId)
      this.projectionSubscribers.delete(sessionId)
      throw new Error('Collaborator is not active for this share.')
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
