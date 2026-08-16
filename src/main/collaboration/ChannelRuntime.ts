import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import {
  b64,
  exportRawEd25519PublicKey,
  exportRawX25519PublicKey,
  generateEphemeralKeyPair,
  importRawEd25519PublicKey,
  importRawX25519PublicKey,
  signEd25519,
  verifyEd25519,
  type KeyPair
} from '../../shared/e2ee/keys'
import { openChannelFrame, sealChannelMessage } from '../../shared/collaboration/ChannelCipher'
import { channelMemberPublicPresentation } from '../../shared/collaboration/ChannelMemberPresentation'
import {
  channelConfirmCode,
  computeChannelTranscriptHash,
  deriveChannelSessionKeys,
  type ChannelSessionKeys
} from '../../shared/collaboration/ChannelKeySchedule'
import {
  CHANNEL_WIRE_PROTOCOL,
  makeChannelEvent,
  makeChannelResponse,
  parseChannelAdmissionBeginParams,
  parseChannelAdmissionConfirmParams,
  parseChannelLogAppendParams,
  parseChannelLogResumeParams,
  parseChannelReconnectParams,
  parseChannelWireMessage,
  type ChannelEncryptedFrame,
  type ChannelHandshakeBeginResult,
  type ChannelHandshakeConfirmResult,
  type ChannelHandshakeContext,
  type ChannelHandshakeMode,
  type ChannelQueuedAppendResult,
  type ChannelWireError,
  type ChannelWireRequest
} from '../../shared/collaboration/ChannelWireProtocol'
import { parseSignedChannelAgentPost } from '../../shared/collaboration/ChannelAgentProtocol'
import {
  ChannelError,
  ChannelStore,
  hashChannelInviteToken,
  type Channel,
  type ChannelInvite,
  type ChannelMember
} from './ChannelStore'
import {
  ChannelMessageLog,
  MAX_REPLAY_BYTES,
  type ChannelAgentAppendInput,
  type ChannelAppendInput,
  type ChannelAppendResult,
  type ChannelMessage
} from './ChannelMessageLog'
import type { ChannelAuditLike } from './ChannelAuditLog'
import { ChannelHumanPolicyError, type ChannelHumanPolicyStore } from './ChannelHumanPolicyStore'
import {
  ChannelHumanReviewError,
  type ChannelHumanReviewEntry,
  type ChannelHumanReviewStore
} from './ChannelHumanReviewStore'
import type {
  ChannelExternalSeatPresence,
  ChannelExternalSeatRuntimeAuthority
} from './ChannelExternalSeatAuthority'

const HANDSHAKE_TTL_MS = 2 * 60 * 1000
const MAX_PENDING_HANDSHAKES = 32
const MAX_PENDING_PER_CHANNEL = 8
const HANDSHAKE_RATE_WINDOW_MS = 60_000
const MAX_HANDSHAKES_PER_ROOM_WINDOW = 12
const APPEND_RATE_WINDOW_MS = 60_000
const MAX_APPENDS_PER_MEMBER_WINDOW = 120
const MAX_OUTBOUND_FRAME_BYTES = 950_000
const MAX_SNAPSHOT_MEMBERS = 64
const PRESENCE_GRACE_MS = 90_000
const HUMAN_REVIEW_AUDIT_DOMAIN = 'taskwraith.channel.human-review-audit.v1'

function humanReviewAuditDedupeKey(kind: string, reviewId: string): string {
  return createHash('sha256')
    .update(`${HUMAN_REVIEW_AUDIT_DOMAIN}\n${kind}\n${reviewId}`, 'utf8')
    .digest('hex')
}

export interface ChannelRuntimeTransport {
  send(roomId: string, payload: string): boolean
  close(roomId: string): void
}

export interface ChannelRuntimeOptions {
  identityKeyPair: KeyPair
  store: ChannelStore
  log: ChannelMessageLog
  audit?: ChannelAuditLike
  now?: () => number
  logger?: (line: string) => void
  onAdmissionBegan?: (info: {
    handshakeId: string
    channelId: string
    memberId: string
    displayName: string
    confirmCode: string
    expiresAt: number
    mode: ChannelHandshakeMode
  }) => void
  /**
   * Runs after Channel metadata binds an invite to a pending member but before
   * a handshake can complete. Used to durably activate migration policy.
   */
  onAdmissionBound?: (info: {
    channelId: string
    inviteId: string
    memberId: string
    roomId: string
    tokenHash: string
    expiresAt: number
  }) => void
  /** Fault-injection seam: the record is already fsynced when this runs. */
  afterDurableCommit?: (result: ChannelAppendResult) => void | Promise<void>
  onReplayBatch?: (info: {
    channelId: string
    memberId: string
    recordCount: number
    serializedBytes: number
    highWaterSequence: number
    live: boolean
  }) => void
  /** Migration-bound policy authority. Missing means ordinary Channel rules. */
  humanPolicy?: Pick<ChannelHumanPolicyStore, 'evaluate'>
  /** Durable authority for migrated contributions that require host review. */
  humanReview?: Pick<
    ChannelHumanReviewStore,
    | 'enqueue'
    | 'get'
    | 'listAwaitingMaterialization'
    | 'approve'
    | 'deny'
    | 'markMaterialized'
    | 'lapse'
    | 'sweep'
  >
}

export interface ChannelHumanReviewApprovalResult {
  review: ChannelHumanReviewEntry
  append: ChannelAppendResult
}

export interface ChannelRoomBinding {
  channelId: string
  roomId: string
  memberId?: string
}

interface PendingHandshake {
  handshakeId: string
  mode: ChannelHandshakeMode
  channelId: string
  memberId: string
  roomId: string
  displayName: string
  context: ChannelHandshakeContext
  confirmCode: string
  transcriptHash: Buffer
  memberIdentityPubKeyB64: string
  keys: ChannelSessionKeys
  expiresAt: number
}

interface RuntimeSession {
  sessionId: string
  mode: ChannelHandshakeMode
  channelId: string
  memberId: string
  roomId: string
  memberIdentityPubKeyB64: string
  keys: ChannelSessionKeys
  establishedAt: number
  nextOutboundSeq: number
  lastInboundSeq: number
  live: boolean
}

interface MemberPresenceRecord {
  state: 'live' | 'grace' | 'expired'
  since: number
  graceEnteredAt?: number
}

function wireError(error: unknown): ChannelWireError {
  if (error instanceof ChannelError) {
    return { code: error.code, message: error.message.slice(0, 240) }
  }
  return { code: 'protocol_unsupported', message: 'Channel request failed' }
}

function validNonce(value: string): Buffer {
  const nonce = b64.decode(value)
  if (nonce.length !== 16) {
    throw new ChannelError('protocol_unsupported', 'Handshake nonce is invalid')
  }
  return nonce
}

function safeCodeEquals(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

export class ChannelRuntime implements ChannelExternalSeatRuntimeAuthority {
  private readonly opts: ChannelRuntimeOptions
  private readonly now: () => number
  private readonly hostIdentityPubKeyB64: string
  private transport: ChannelRuntimeTransport | null = null
  private readonly pending = new Map<string, PendingHandshake>()
  private readonly sessions = new Map<string, RuntimeSession>()
  private readonly channelQueues = new Map<string, Promise<void>>()
  private readonly quiescingChannels = new Set<string>()
  private readonly handshakeRates = new Map<string, number[]>()
  private readonly appendRates = new Map<string, number[]>()
  private readonly memberPresenceByChannel = new Map<string, Map<string, MemberPresenceRecord>>()
  private authorityReady = false
  private disposed = false

  constructor(options: ChannelRuntimeOptions) {
    this.opts = options
    this.now = options.now ?? Date.now
    this.hostIdentityPubKeyB64 = b64.encode(
      exportRawEd25519PublicKey(options.identityKeyPair.publicKey)
    )
  }

  attachTransport(transport: ChannelRuntimeTransport): void {
    this.transport = transport
  }

  hostIdentityPublicKey(): string {
    return this.hostIdentityPubKeyB64
  }

  /**
   * Global recovery signal for the external-seat authority. The runtime starts
   * NOT ready so that X1's projection fails closed until startup recovery has
   * completed; a caller that serves the authority before this returns true can
   * otherwise mistake a policy record lost mid-migration for a legitimate
   * People fallback.
   */
  markRecovered(): void {
    this.authorityReady = true
  }

  memberPresence(channelId: string, memberId: string): ChannelExternalSeatPresence {
    if (!this.authorityReady || this.disposed || this.quiescingChannels.has(channelId)) {
      return 'recovery_blocked'
    }
    const record = this.memberPresenceByChannel.get(channelId)?.get(memberId)
    if (!record) return 'unknown'
    return this.resolveMemberPresenceRecord(record)
  }

  private ensureMemberPresenceChannel(channelId: string): Map<string, MemberPresenceRecord> {
    let forChannel = this.memberPresenceByChannel.get(channelId)
    if (!forChannel) {
      forChannel = new Map()
      this.memberPresenceByChannel.set(channelId, forChannel)
    }
    return forChannel
  }

  private resolveMemberPresenceRecord(record: MemberPresenceRecord): ChannelExternalSeatPresence {
    if (record.state === 'grace' && record.graceEnteredAt !== undefined) {
      const elapsed = this.now() - record.graceEnteredAt
      if (elapsed >= PRESENCE_GRACE_MS) {
        record.state = 'expired'
        record.since = this.now()
        record.graceEnteredAt = undefined
        return 'expired'
      }
      if (elapsed < 0) {
        // Clock moved backwards (wake-from-sleep, NTP correction). Re-anchor
        // rather than expire: a negative age is never evidence that someone left.
        record.graceEnteredAt = this.now()
      }
    }
    return record.state
  }

  private observeMemberPresence(channelId: string, memberId: string, now = this.now()): void {
    const forChannel = this.ensureMemberPresenceChannel(channelId)
    const record = forChannel.get(memberId)
    if (record && record.state === 'expired') {
      // Expiry is terminal for this record. A returning member arrives on a new
      // session and must not be resurrected by a late frame on the dead one.
      return
    }
    forChannel.set(memberId, {
      state: 'live',
      since: now,
      graceEnteredAt: undefined
    })
  }

  private noteMemberTransportClose(channelId: string, memberId: string, now = this.now()): void {
    const record = this.memberPresenceByChannel.get(channelId)?.get(memberId)
    if (!record || record.state !== 'live') return
    record.state = 'grace'
    record.since = now
    record.graceEnteredAt = now
  }

  private expireMemberPresence(channelId: string, memberId: string, now = this.now()): void {
    const forChannel = this.ensureMemberPresenceChannel(channelId)
    forChannel.set(memberId, { state: 'expired', since: now })
  }

  createChannel(args: {
    chatId: string
    title: string
    ownerDisplayName: string
    reference?: Parameters<ChannelStore['createChannel']>[0]['reference']
    now?: number
  }): { channel: Channel; owner: ChannelMember } {
    const created = this.opts.store.createChannel({
      chatId: args.chatId,
      title: args.title,
      owner: {
        displayName: args.ownerDisplayName,
        identityPublicKey: this.hostIdentityPubKeyB64
      },
      ...(args.reference ? { reference: args.reference } : {}),
      ...(args.now === undefined ? {} : { now: args.now })
    })
    this.audit({
      kind: 'channel.created',
      channelId: created.channel.channelId,
      memberId: created.owner.memberId,
      at: args.now
    })
    return created
  }

  createInvite(args: { channelId: string; now?: number; ttlMs?: number }): {
    invite: ChannelInvite
    inviteToken: string
  } {
    this.assertChannelAccepting(args.channelId)
    const issued = this.opts.store.createInvite(args)
    this.audit({
      kind: 'invite.created',
      channelId: args.channelId,
      detail: issued.invite.inviteId,
      at: args.now
    })
    return issued
  }

  listRoomBindings(now = this.now()): ChannelRoomBinding[] {
    return this.collectRoomBindings(now, false)
  }

  private collectRoomBindings(now: number, includeQuiescing: boolean): ChannelRoomBinding[] {
    const bindings = new Map<string, ChannelRoomBinding>()
    for (const channel of this.opts.store.listChannels()) {
      if (channel.status !== 'active') continue
      if (!includeQuiescing && this.quiescingChannels.has(channel.channelId)) continue
      for (const member of this.opts.store.listMembers(channel.channelId)) {
        if (member.roomId && (includeQuiescing || member.status === 'active')) {
          bindings.set(member.roomId, {
            channelId: channel.channelId,
            roomId: member.roomId,
            memberId: member.memberId
          })
        }
      }
      for (const invite of this.opts.store.listInvites(channel.channelId)) {
        if (
          (includeQuiescing || (invite.revokedAt === undefined && invite.expiresAt > now)) &&
          !bindings.has(invite.roomId)
        ) {
          bindings.set(invite.roomId, {
            channelId: channel.channelId,
            roomId: invite.roomId,
            ...(invite.memberId ? { memberId: invite.memberId } : {})
          })
        }
      }
    }
    return [...bindings.values()]
  }

  assertRoomCanOpen(channelId: string, roomId: string, now = this.now()): void {
    const binding = this.listRoomBindings(now).find(
      (candidate) => candidate.channelId === channelId && candidate.roomId === roomId
    )
    if (!binding) {
      throw new ChannelError('not_member', 'Relay room is not active for this Channel')
    }
  }

  async handleTransportMessage(roomId: string, data: string): Promise<void> {
    if (this.disposed) return
    const message = parseChannelWireMessage(data)
    if (!message) {
      this.audit({ kind: 'protocol.rejected', code: 'protocol_unsupported' })
      return
    }
    if (message.t === 'channel.enc') {
      await this.handleEncrypted(roomId, message)
      return
    }
    if (message.t !== 'channel.req') {
      this.audit({ kind: 'protocol.rejected', code: 'protocol_unsupported' })
      return
    }

    try {
      let result: ChannelHandshakeBeginResult | ChannelHandshakeConfirmResult
      let establishedSessionId: string | undefined
      switch (message.method) {
        case 'channel.admission.begin':
          result = this.beginAdmission(roomId, message)
          break
        case 'channel.reconnect':
          result = this.beginReconnect(roomId, message)
          break
        case 'channel.admission.confirm': {
          result = this.confirmHandshake(roomId, message)
          establishedSessionId = result.sessionId
          break
        }
        default:
          throw new ChannelError(
            'protocol_unsupported',
            'Application methods require an encrypted session'
          )
      }
      this.sendRaw(roomId, JSON.stringify(makeChannelResponse(message.reqId, { ok: true, result })))
      if (establishedSessionId) {
        queueMicrotask(() => {
          const session = this.sessions.get(establishedSessionId!)
          if (session) this.broadcastMembersSnapshot(session.channelId)
        })
      }
    } catch (error) {
      const denial = wireError(error)
      this.audit({
        kind: 'admission.failed',
        code: denial.code,
        detail: message.method
      })
      this.sendRaw(
        roomId,
        JSON.stringify(makeChannelResponse(message.reqId, { ok: false, error: denial }))
      )
    }
  }

  handleRoomDisconnected(roomId: string): void {
    const closing = [...this.sessions.values()].filter((session) => session.roomId === roomId)
    for (const session of closing) {
      const hasOtherLiveSession = [...this.sessions.values()].some(
        (candidate) => candidate.memberId === session.memberId && candidate.roomId !== roomId
      )
      if (!hasOtherLiveSession && !this.quiescingChannels.has(session.channelId)) {
        this.noteMemberTransportClose(session.channelId, session.memberId, this.now())
      }
      this.sessions.delete(session.sessionId)
      this.audit({
        kind: 'session.disconnected',
        channelId: session.channelId,
        memberId: session.memberId
      })
    }
    for (const [handshakeId, pending] of this.pending) {
      if (pending.roomId === roomId) this.pending.delete(handshakeId)
    }
  }

  appendHost(
    channelId: string,
    input: Omit<
      ChannelAppendInput,
      'channelId' | 'principalMemberId' | 'identityPublicKey' | 'roomId'
    >
  ): Promise<ChannelAppendResult> {
    this.assertChannelAccepting(channelId)
    return this.enqueueChannel(channelId, async () => {
      this.assertChannelAccepting(channelId)
      const channel = this.opts.store.getChannel(channelId)
      if (!channel) throw new ChannelError('not_member', 'Channel was not found')
      const result = this.opts.log.appendWithResult({
        channelId,
        principalMemberId: channel.ownerMemberId,
        identityPublicKey: this.hostIdentityPubKeyB64,
        ...input
      })
      this.auditCommit(result)
      if (!result.deduplicated) {
        await this.opts.afterDurableCommit?.(result)
        this.fanOut(result.record)
      }
      return result
    })
  }

  approveHumanReview(reviewId: string): Promise<ChannelHumanReviewApprovalResult> {
    this.sweepHumanReviews(this.now())
    const pending = this.requireHumanReview(reviewId)
    this.assertChannelAccepting(pending.channelId)
    return this.enqueueChannel(pending.channelId, async () => {
      this.assertChannelAccepting(pending.channelId)
      const review = this.runHumanReviewOperation(() =>
        this.opts.humanReview!.approve(reviewId, this.now())
      )
      this.auditHumanReview('human.review.approved', review)
      const result = this.materializeHumanReview(review)
      this.auditCommit(result)
      if (!result.deduplicated) {
        await this.opts.afterDurableCommit?.(result)
        this.fanOut(result.record)
      }
      return {
        review: this.requireHumanReview(reviewId),
        append: result
      }
    })
  }

  denyHumanReview(reviewId: string, reason?: string): Promise<ChannelHumanReviewEntry> {
    this.sweepHumanReviews(this.now())
    const pending = this.requireHumanReview(reviewId)
    this.assertChannelAccepting(pending.channelId)
    return this.enqueueChannel(pending.channelId, () => {
      this.assertChannelAccepting(pending.channelId)
      const review = this.runHumanReviewOperation(() =>
        this.opts.humanReview!.deny(reviewId, reason, this.now())
      )
      this.auditHumanReview('human.review.denied', review)
      return review
    })
  }

  flushApprovedHumanReviews(channelId: string, memberId?: string): Promise<ChannelAppendResult[]> {
    this.assertChannelAccepting(channelId)
    return this.enqueueChannel(channelId, () => {
      this.assertChannelAccepting(channelId)
      return this.flushApprovedHumanReviewsWithinQueue(channelId, memberId)
    })
  }

  /** Startup-only recovery before any relay transport is attached. */
  reconcileHumanReviewBeforeServing(reviewId: string): ChannelHumanReviewApprovalResult {
    const review = this.requireHumanReview(reviewId)
    if (review.state !== 'approved') {
      throw new ChannelError(
        'policy_denied',
        'Channel human review is not awaiting materialization'
      )
    }
    this.assertChannelAccepting(review.channelId)
    const append = this.materializeHumanReview(review)
    this.auditCommit(append)
    return { review: this.requireHumanReview(reviewId), append }
  }

  sweepHumanReviews(now = this.now()): ChannelHumanReviewEntry[] {
    if (!this.opts.humanReview) return []
    const lapsed = this.runHumanReviewOperation(() => this.opts.humanReview!.sweep(now))
    for (const review of lapsed) this.auditHumanReview('human.review.lapsed', review)
    return lapsed
  }

  lapseHumanReviews(
    filter: { channelId: string; memberId?: string },
    reason: 'member_revoked' | 'channel_closed',
    now = this.now()
  ): ChannelHumanReviewEntry[] {
    if (!this.opts.humanReview) return []
    const lapsed = this.runHumanReviewOperation(() =>
      this.opts.humanReview!.lapse(filter, reason, now)
    )
    for (const review of lapsed) this.auditHumanReview('human.review.lapsed', review)
    return lapsed
  }

  /**
   * Main-only terminal delivery path. Signature/authority verification and the
   * append-only fsync happen in ChannelMessageLog before either audit or live
   * member fan-out. It deliberately does not invoke afterDurableCommit, which
   * is the human-mention admission source.
   */
  appendSignedAgentPost(input: ChannelAgentAppendInput): Promise<ChannelAppendResult> {
    const signedPost = parseSignedChannelAgentPost(input?.signedPost)
    if (!signedPost) throw new ChannelError('identity_mismatch', 'Signed agent post is invalid')
    const channelId = signedPost.post.channelId
    this.assertChannelAccepting(channelId)
    return this.enqueueChannel(channelId, async () => {
      this.assertChannelAccepting(channelId)
      const result = this.opts.log.appendSignedAgentPost({
        signedPost,
        ...(input.now === undefined ? {} : { now: input.now })
      })
      this.auditCommit(result)
      if (!result.deduplicated) this.fanOut(result.record)
      return result
    })
  }

  revokeMember(args: {
    channelId: string
    memberId: string
    now?: number
  }): Promise<ChannelMember> {
    this.assertChannelAccepting(args.channelId)
    return this.enqueueChannel(args.channelId, async () => {
      this.assertChannelAccepting(args.channelId)
      this.expireMemberPresence(args.channelId, args.memberId, args.now ?? this.now())
      await this.flushApprovedHumanReviewsWithinQueue(args.channelId, args.memberId)
      const member = this.opts.store.revokeMember(args)
      const channel = this.opts.store.getChannel(args.channelId)
      for (const [sessionId, session] of this.sessions) {
        if (session.channelId !== args.channelId || session.memberId !== args.memberId) continue
        this.sendEvent(session, 'channel.member.revoked', {
          channelId: args.channelId,
          memberId: args.memberId,
          membershipRevision: channel?.membershipRevision ?? 0
        })
        this.sessions.delete(sessionId)
        this.transport?.close(session.roomId)
      }
      try {
        this.lapseHumanReviews(
          { channelId: args.channelId, memberId: args.memberId },
          'member_revoked',
          args.now ?? this.now()
        )
      } catch (error) {
        this.opts.logger?.(
          `[channel-runtime] human review lapse failed after member revocation: ${
            error instanceof Error ? error.message : 'unknown'
          }`
        )
      }
      this.audit({
        kind: 'member.revoked',
        channelId: args.channelId,
        memberId: args.memberId,
        at: args.now
      })
      this.broadcastMembersSnapshot(args.channelId)
      return member
    })
  }

  /**
   * Permanently fence one Channel in this runtime, drain its ordered append
   * queue, and close every invite/member room. The durable owner may erase or
   * close metadata only after this resolves.
   */
  quiesceChannel(channelId: string): Promise<void> {
    if (!this.opts.store.getChannel(channelId)) return Promise.resolve()
    this.quiescingChannels.add(channelId)
    return this.enqueueChannel(channelId, () => {
      const roomIds = this.collectRoomBindings(this.now(), true)
        .filter((binding) => binding.channelId === channelId)
        .map((binding) => binding.roomId)
      for (const [handshakeId, pending] of this.pending) {
        if (pending.channelId === channelId) this.pending.delete(handshakeId)
      }
      for (const [sessionId, session] of this.sessions) {
        if (session.channelId === channelId) this.sessions.delete(sessionId)
      }
      this.memberPresenceByChannel.delete(channelId)
      for (const roomId of roomIds) this.transport?.close(roomId)
    })
  }

  dispose(): void {
    this.disposed = true
    this.authorityReady = false
    this.pending.clear()
    this.sessions.clear()
    this.memberPresenceByChannel.clear()
    this.quiescingChannels.clear()
    this.transport = null
  }

  private beginAdmission(roomId: string, request: ChannelWireRequest): ChannelHandshakeBeginResult {
    const input = parseChannelAdmissionBeginParams(request.params)
    if (!input) {
      throw new ChannelError('protocol_unsupported', 'Admission parameters are invalid')
    }
    if (input.roomId !== roomId) {
      throw new ChannelError('identity_mismatch', 'Admission room does not match transport')
    }
    this.assertChannelAccepting(input.channelId)
    const now = this.now()
    this.cleanExpiredPending(now)
    this.checkHandshakeCapacity(input.channelId)
    this.consumeHandshakeRate(roomId, now)

    const memberIdentity = importRawEd25519PublicKey(b64.decode(input.memberIdentityPubKeyB64))
    void memberIdentity
    const memberEphemeral = importRawX25519PublicKey(b64.decode(input.memberEphemeralPubKeyB64))
    const memberNonce = validNonce(input.memberNonceB64)
    const admission = this.opts.store.beginMemberAdmission({
      channelId: input.channelId,
      inviteId: input.inviteId,
      inviteToken: input.inviteToken,
      roomId,
      displayName: input.displayName,
      identityPublicKey: input.memberIdentityPubKeyB64,
      now
    })
    this.opts.onAdmissionBound?.({
      channelId: input.channelId,
      inviteId: admission.invite.inviteId,
      memberId: admission.member.memberId,
      roomId: admission.invite.roomId,
      tokenHash: admission.invite.tokenHash,
      expiresAt: admission.invite.expiresAt
    })
    const channel = this.opts.store.getChannel(input.channelId)
    if (!channel) throw new ChannelError('not_member', 'Channel was not found')
    return this.createPendingHandshake({
      mode: 'admission',
      channel,
      member: admission.member,
      roomId,
      inviteId: admission.invite.inviteId,
      inviteTokenHash: hashChannelInviteToken(input.inviteToken),
      inviteExpiresAt: admission.invite.expiresAt,
      memberIdentityPubKeyB64: input.memberIdentityPubKeyB64,
      memberEphemeralPubKeyB64: input.memberEphemeralPubKeyB64,
      memberEphemeral,
      memberNonce,
      memberNonceB64: input.memberNonceB64,
      now
    })
  }

  private beginReconnect(roomId: string, request: ChannelWireRequest): ChannelHandshakeBeginResult {
    const input = parseChannelReconnectParams(request.params)
    if (!input) {
      throw new ChannelError('protocol_unsupported', 'Reconnect parameters are invalid')
    }
    if (input.roomId !== roomId) {
      throw new ChannelError('identity_mismatch', 'Reconnect room does not match transport')
    }
    this.assertChannelAccepting(input.channelId)
    const now = this.now()
    this.cleanExpiredPending(now)
    this.checkHandshakeCapacity(input.channelId)
    this.consumeHandshakeRate(roomId, now)
    const member = this.opts.store.validateMemberSession({
      channelId: input.channelId,
      memberId: input.memberId,
      identityPublicKey: input.memberIdentityPubKeyB64,
      roomId
    })
    const memberIdentity = importRawEd25519PublicKey(b64.decode(input.memberIdentityPubKeyB64))
    void memberIdentity
    const memberEphemeral = importRawX25519PublicKey(b64.decode(input.memberEphemeralPubKeyB64))
    const memberNonce = validNonce(input.memberNonceB64)
    const channel = this.opts.store.getChannel(input.channelId)
    if (!channel) throw new ChannelError('not_member', 'Channel was not found')
    return this.createPendingHandshake({
      mode: 'reconnect',
      channel,
      member,
      roomId,
      inviteId: `pinned:${member.memberId}`,
      inviteTokenHash: `pinned:${member.identityPublicKey}`,
      inviteExpiresAt: now + HANDSHAKE_TTL_MS,
      memberIdentityPubKeyB64: input.memberIdentityPubKeyB64,
      memberEphemeralPubKeyB64: input.memberEphemeralPubKeyB64,
      memberEphemeral,
      memberNonce,
      memberNonceB64: input.memberNonceB64,
      now
    })
  }

  private createPendingHandshake(args: {
    mode: ChannelHandshakeMode
    channel: Channel
    member: ChannelMember
    roomId: string
    inviteId: string
    inviteTokenHash: string
    inviteExpiresAt: number
    memberIdentityPubKeyB64: string
    memberEphemeralPubKeyB64: string
    memberEphemeral: ReturnType<typeof importRawX25519PublicKey>
    memberNonce: Buffer
    memberNonceB64: string
    now: number
  }): ChannelHandshakeBeginResult {
    const hostEphemeral = generateEphemeralKeyPair()
    const hostNonce = randomBytes(16)
    const hostEphemeralPubKeyB64 = b64.encode(exportRawX25519PublicKey(hostEphemeral.publicKey))
    const hostNonceB64 = b64.encode(hostNonce)
    const expiresAt = Math.min(args.inviteExpiresAt, args.now + HANDSHAKE_TTL_MS)
    const context: ChannelHandshakeContext = {
      protocol: CHANNEL_WIRE_PROTOCOL,
      mode: args.mode,
      channelId: args.channel.channelId,
      chatId: args.channel.chatId,
      inviteId: args.inviteId,
      inviteTokenHash: args.inviteTokenHash,
      inviteExpiresAt: args.inviteExpiresAt,
      memberId: args.member.memberId,
      roomId: args.roomId,
      hostIdentityPubKeyB64: this.hostIdentityPubKeyB64,
      memberIdentityPubKeyB64: args.memberIdentityPubKeyB64,
      hostEphemeralPubKeyB64,
      memberEphemeralPubKeyB64: args.memberEphemeralPubKeyB64,
      hostNonceB64,
      memberNonceB64: args.memberNonceB64
    }
    const transcriptHash = computeChannelTranscriptHash(context)
    const confirmCode = channelConfirmCode(context)
    const handshakeId = randomUUID()
    const pending: PendingHandshake = {
      handshakeId,
      mode: args.mode,
      channelId: args.channel.channelId,
      memberId: args.member.memberId,
      roomId: args.roomId,
      displayName: args.member.displayName,
      context,
      confirmCode,
      transcriptHash,
      memberIdentityPubKeyB64: args.memberIdentityPubKeyB64,
      keys: deriveChannelSessionKeys({
        localEphemeralPrivate: hostEphemeral.privateKey,
        peerEphemeralPublic: args.memberEphemeral,
        hostNonce,
        memberNonce: args.memberNonce
      }),
      expiresAt
    }
    this.pending.set(handshakeId, pending)
    this.audit({
      kind: 'admission.began',
      channelId: pending.channelId,
      memberId: pending.memberId,
      detail: pending.mode
    })
    this.opts.onAdmissionBegan?.({
      handshakeId,
      channelId: pending.channelId,
      memberId: pending.memberId,
      displayName: pending.displayName,
      confirmCode,
      expiresAt,
      mode: pending.mode
    })
    return {
      handshakeId,
      protocol: CHANNEL_WIRE_PROTOCOL,
      mode: pending.mode,
      channelId: pending.channelId,
      chatId: args.channel.chatId,
      inviteId: args.inviteId,
      memberId: pending.memberId,
      roomId: pending.roomId,
      hostIdentityPubKeyB64: this.hostIdentityPubKeyB64,
      hostEphemeralPubKeyB64,
      hostNonceB64,
      confirmCode,
      hostTranscriptSigB64: b64.encode(
        signEd25519(this.opts.identityKeyPair.privateKey, transcriptHash)
      ),
      transcriptHashB64: b64.encode(transcriptHash),
      inviteExpiresAt: args.inviteExpiresAt,
      expiresAt
    }
  }

  private confirmHandshake(
    roomId: string,
    request: ChannelWireRequest
  ): ChannelHandshakeConfirmResult {
    const input = parseChannelAdmissionConfirmParams(request.params)
    if (!input) {
      throw new ChannelError('protocol_unsupported', 'Confirmation parameters are invalid')
    }
    const pending = this.pending.get(input.handshakeId)
    if (!pending || pending.roomId !== roomId) {
      throw new ChannelError('not_member', 'Pending handshake was not found for this room')
    }
    this.assertChannelAccepting(pending.channelId)
    this.pending.delete(input.handshakeId)
    const now = this.now()
    const signatureValid = verifyEd25519(
      importRawEd25519PublicKey(b64.decode(pending.memberIdentityPubKeyB64)),
      pending.transcriptHash,
      b64.decode(input.memberTranscriptSigB64)
    )
    if (
      pending.expiresAt <= now ||
      !safeCodeEquals(input.confirmCode, pending.confirmCode) ||
      !signatureValid
    ) {
      if (pending.mode === 'admission') {
        this.opts.store.failMemberAdmission({
          channelId: pending.channelId,
          inviteId: pending.context.inviteId,
          memberId: pending.memberId,
          now
        })
      }
      throw new ChannelError('identity_mismatch', 'SAS or transcript signature did not match')
    }

    const member =
      pending.mode === 'admission'
        ? this.opts.store.confirmMemberAdmission({
            channelId: pending.channelId,
            inviteId: pending.context.inviteId,
            memberId: pending.memberId,
            now
          })
        : this.opts.store.validateMemberSession({
            channelId: pending.channelId,
            memberId: pending.memberId,
            identityPublicKey: pending.memberIdentityPubKeyB64,
            roomId: pending.roomId
          })
    for (const [sessionId, session] of this.sessions) {
      if (session.channelId === pending.channelId && session.memberId === pending.memberId) {
        this.sessions.delete(sessionId)
      }
    }
    const session: RuntimeSession = {
      sessionId: randomUUID(),
      mode: pending.mode,
      channelId: pending.channelId,
      memberId: pending.memberId,
      roomId: pending.roomId,
      memberIdentityPubKeyB64: pending.memberIdentityPubKeyB64,
      keys: pending.keys,
      establishedAt: now,
      nextOutboundSeq: 1,
      lastInboundSeq: 0,
      live: false
    }
    this.sessions.set(session.sessionId, session)
    this.observeMemberPresence(pending.channelId, pending.memberId, now)
    this.audit({
      kind: pending.mode === 'admission' ? 'admission.confirmed' : 'session.reconnected',
      channelId: pending.channelId,
      memberId: pending.memberId
    })
    const channel = this.opts.store.getChannel(pending.channelId)
    return {
      sessionId: session.sessionId,
      channelId: session.channelId,
      memberId: member.memberId,
      membershipRevision: channel?.membershipRevision ?? 0,
      hostIdentityPubKeyB64: this.hostIdentityPubKeyB64,
      establishedAt: session.establishedAt
    }
  }

  private async handleEncrypted(roomId: string, frame: ChannelEncryptedFrame): Promise<void> {
    const session = this.sessions.get(frame.sessionId)
    if (!session || session.roomId !== roomId) {
      this.audit({ kind: 'protocol.rejected', code: 'not_member' })
      return
    }
    if (frame.direction !== 'memberToHost' || frame.seq !== session.lastInboundSeq + 1) {
      this.audit({
        kind: 'protocol.rejected',
        channelId: session.channelId,
        memberId: session.memberId,
        code: 'resync_required'
      })
      this.sessions.delete(session.sessionId)
      return
    }
    let message
    try {
      message = openChannelFrame({
        keys: session.keys,
        expectedDirection: 'memberToHost',
        frame
      })
    } catch {
      this.audit({
        kind: 'protocol.rejected',
        channelId: session.channelId,
        memberId: session.memberId,
        code: 'identity_mismatch'
      })
      this.sessions.delete(session.sessionId)
      return
    }
    session.lastInboundSeq = frame.seq
    if (message.t !== 'channel.req') {
      this.sendEncryptedResponse(session, 'invalid-request', {
        ok: false,
        error: {
          code: 'protocol_unsupported',
          message: 'Members may send requests only'
        }
      })
      return
    }
    try {
      switch (message.method) {
        case 'channel.log.append':
          await this.handleAppend(session, message)
          break
        case 'channel.log.resume':
          await this.handleResume(session, message)
          break
        default:
          throw new ChannelError(
            'protocol_unsupported',
            'Method is not allowed in an encrypted member request'
          )
      }
    } catch (error) {
      const denial = wireError(error)
      this.audit({
        kind: 'message.rejected',
        channelId: session.channelId,
        memberId: session.memberId,
        code: denial.code
      })
      this.sendEncryptedResponse(session, message.reqId, {
        ok: false,
        error: denial
      })
    }
  }

  private async handleAppend(session: RuntimeSession, request: ChannelWireRequest): Promise<void> {
    const input = parseChannelLogAppendParams(request.params)
    if (!input) {
      throw new ChannelError(
        'protocol_unsupported',
        'channel.log.append params are invalid or contain forbidden fields'
      )
    }
    await this.enqueueChannel(session.channelId, async () => {
      this.revalidateSession(session)
      this.consumeAppendRate(session, this.now())
      const policyOutcome = this.enforceHumanAppendPolicy(session, input.content)
      if (policyOutcome === 'host_review') {
        await this.handleHumanReviewAppend(session, request, input)
        return
      }
      const result = this.opts.log.appendWithResult({
        channelId: session.channelId,
        principalMemberId: session.memberId,
        identityPublicKey: session.memberIdentityPubKeyB64,
        roomId: session.roomId,
        clientMessageId: input.clientMessageId,
        content: input.content
      })
      await this.finishMemberAppend(session, request.reqId, result)
    })
  }

  private enforceHumanAppendPolicy(
    session: RuntimeSession,
    content: string
  ): 'append' | 'host_review' {
    if (!this.opts.humanPolicy) return 'append'
    let decision: ReturnType<ChannelHumanPolicyStore['evaluate']>
    try {
      decision = this.opts.humanPolicy.evaluate({
        channelId: session.channelId,
        memberId: session.memberId,
        intent: 'comment',
        contentBytes: Buffer.byteLength(content, 'utf8')
      })
    } catch (error) {
      if (error instanceof ChannelHumanPolicyError && error.code === 'recovery_blocked') {
        throw new ChannelError('recovery_blocked', 'Channel human policy recovery is blocked')
      }
      throw error
    }
    if (decision.outcome === 'append') return 'append'
    if (decision.outcome === 'host_review') return 'host_review'
    if (decision.outcome === 'deny' && decision.code === 'quota_exceeded') {
      throw new ChannelError('quota_exceeded', decision.message)
    }
    throw new ChannelError(
      'policy_denied',
      decision.outcome === 'deny'
        ? decision.message
        : 'Channel contribution is not available under this migrated policy'
    )
  }

  private async handleHumanReviewAppend(
    session: RuntimeSession,
    request: ChannelWireRequest,
    input: { clientMessageId: string; content: string }
  ): Promise<void> {
    if (!this.opts.humanReview) {
      throw new ChannelError(
        'policy_denied',
        'Channel host review is required but its durable authority is unavailable'
      )
    }
    const queued = this.runHumanReviewOperation(() =>
      this.opts.humanReview!.enqueue({
        channelId: session.channelId,
        memberId: session.memberId,
        identityPublicKeyB64: session.memberIdentityPubKeyB64,
        roomId: session.roomId,
        clientMessageId: input.clientMessageId,
        content: input.content,
        now: this.now()
      })
    )
    if (queued.outcome === 'duplicate_terminal' || !queued.entry) {
      throw new ChannelError('policy_denied', 'Channel human review was already resolved')
    }
    const review = queued.entry
    if (review.state === 'denied' || review.state === 'lapsed') {
      throw new ChannelError('policy_denied', 'Channel human review was not accepted')
    }
    if (review.state === 'approved' || review.state === 'materialized') {
      const result = this.materializeHumanReview(review)
      await this.finishMemberAppend(session, request.reqId, result)
      return
    }

    this.auditHumanReview(
      queued.outcome === 'queued' ? 'human.review.queued' : 'human.review.deduplicated',
      review
    )
    const result: ChannelQueuedAppendResult = {
      accepted: false,
      queuedForHostReview: true,
      deduplicated: queued.outcome === 'duplicate',
      review: {
        reviewId: review.reviewId,
        state: review.state,
        enqueuedAt: review.enqueuedAt,
        expiresAt: review.expiresAt
      }
    }
    this.sendEncryptedResponse(session, request.reqId, { ok: true, result })
    this.sendEvent(session, 'channel.log.appendResult', result, request.reqId)
  }

  private async finishMemberAppend(
    session: RuntimeSession,
    requestId: string,
    result: ChannelAppendResult
  ): Promise<void> {
    this.auditCommit(result)
    if (!result.deduplicated) await this.opts.afterDurableCommit?.(result)
    const response = {
      accepted: true as const,
      deduplicated: result.deduplicated,
      record: result.record
    }
    this.sendEncryptedResponse(session, requestId, { ok: true, result: response })
    this.sendEvent(session, 'channel.log.appendResult', response, requestId)
    if (!result.deduplicated) this.fanOut(result.record)
  }

  private async handleResume(session: RuntimeSession, request: ChannelWireRequest): Promise<void> {
    const input = parseChannelLogResumeParams(request.params)
    if (!input) throw new ChannelError('invalid_cursor', 'channel.log.resume params are invalid')
    await this.enqueueChannel(session.channelId, async () => {
      this.revalidateSession(session)
      session.live = false
      this.sendMembersSnapshot(session)
      let cursor = input.resumeAfter
      let sentBatch = false
      let highWaterSequence = 0
      const requestedMaxBytes = Math.min(input.maxBytes ?? MAX_REPLAY_BYTES, MAX_REPLAY_BYTES)
      const logMaxBytes = Math.max(1, requestedMaxBytes - 1_024)
      for (;;) {
        const batch = this.opts.log.replay({
          channelId: session.channelId,
          resumeAfter: cursor,
          ...(input.maxRecords === undefined ? {} : { maxRecords: input.maxRecords }),
          maxBytes: logMaxBytes
        })
        highWaterSequence = batch.highWaterSequence
        const nextCursor = batch.records.at(-1)?.sequence ?? cursor
        const live = nextCursor >= highWaterSequence
        if (batch.records.length > 0 || !sentBatch) {
          const payload = {
            channelId: session.channelId,
            records: batch.records,
            highWaterSequence,
            live
          }
          const serializedBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
          if (serializedBytes > requestedMaxBytes) {
            throw new ChannelError(
              'recovery_blocked',
              'Replay batch exceeds the negotiated byte limit'
            )
          }
          if (!this.sendEvent(session, 'channel.log.batch', payload)) {
            throw new ChannelError('host_unavailable', 'Member room became unavailable')
          }
          this.opts.onReplayBatch?.({
            channelId: session.channelId,
            memberId: session.memberId,
            recordCount: batch.records.length,
            serializedBytes,
            highWaterSequence,
            live
          })
          sentBatch = true
        }
        cursor = nextCursor
        if (live) break
      }
      session.live = true
      this.audit({
        kind: 'replay.completed',
        channelId: session.channelId,
        memberId: session.memberId,
        detail: String(highWaterSequence)
      })
      this.sendEncryptedResponse(session, request.reqId, {
        ok: true,
        result: { highWaterSequence }
      })
    })
  }

  private fanOut(record: ChannelMessage): void {
    for (const session of [...this.sessions.values()]) {
      if (session.channelId !== record.channelId || !session.live) continue
      this.sendEvent(session, 'channel.log.batch', {
        channelId: record.channelId,
        records: [record],
        highWaterSequence: record.sequence,
        live: true
      })
    }
  }

  private broadcastMembersSnapshot(channelId: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.channelId === channelId) this.sendMembersSnapshot(session)
    }
  }

  private sendMembersSnapshot(session: RuntimeSession): boolean {
    const channel = this.opts.store.getChannel(session.channelId)
    if (!channel) return false
    const members = this.opts.store
      .listMembers(session.channelId)
      .filter((member) => member.status === 'active')
      .slice(-MAX_SNAPSHOT_MEMBERS)
      .map((member) => {
        const presentation = channelMemberPublicPresentation(member.presentation)
        return {
          memberId: member.memberId,
          kind: member.kind,
          displayName: member.displayName,
          status: member.status,
          joinedAt: member.joinedAt,
          ...(presentation ? { presentation } : {})
        }
      })
    return this.sendEvent(session, 'channel.members.snapshot', {
      channelId: session.channelId,
      membershipRevision: channel.membershipRevision,
      members
    })
  }

  private sendEvent(
    session: RuntimeSession,
    method: Parameters<typeof makeChannelEvent>[0],
    params: unknown,
    reqId?: string
  ): boolean {
    return this.sendEncrypted(session, makeChannelEvent(method, params, reqId))
  }

  private sendEncryptedResponse(
    session: RuntimeSession,
    reqId: string,
    outcome: { ok: true; result: unknown } | { ok: false; error: ChannelWireError }
  ): boolean {
    return this.sendEncrypted(session, makeChannelResponse(reqId, outcome))
  }

  private sendEncrypted(
    session: RuntimeSession,
    message: Parameters<typeof sealChannelMessage>[0]['message']
  ): boolean {
    const frame = sealChannelMessage({
      keys: session.keys,
      direction: 'hostToMember',
      sessionId: session.sessionId,
      seq: session.nextOutboundSeq,
      message
    })
    const payload = JSON.stringify(frame)
    if (Buffer.byteLength(payload, 'utf8') > MAX_OUTBOUND_FRAME_BYTES) {
      throw new ChannelError('recovery_blocked', 'Encrypted Channel frame exceeds relay limit')
    }
    session.nextOutboundSeq += 1
    const sent = this.sendRaw(session.roomId, payload)
    if (!sent) {
      this.sessions.delete(session.sessionId)
      session.live = false
    }
    return sent
  }

  private sendRaw(roomId: string, payload: string): boolean {
    if (!this.transport || this.disposed) return false
    try {
      return this.transport.send(roomId, payload)
    } catch (error) {
      this.opts.logger?.(
        `[channel-runtime] room send failed: ${error instanceof Error ? error.message : 'unknown'}`
      )
      return false
    }
  }

  private revalidateSession(session: RuntimeSession): ChannelMember {
    this.assertChannelAccepting(session.channelId)
    if (!this.sessions.has(session.sessionId)) {
      throw new ChannelError('not_member', 'Channel session is not active')
    }
    return this.opts.store.validateMemberSession({
      channelId: session.channelId,
      memberId: session.memberId,
      identityPublicKey: session.memberIdentityPubKeyB64,
      roomId: session.roomId
    })
  }

  private checkHandshakeCapacity(channelId: string): void {
    if (this.pending.size >= MAX_PENDING_HANDSHAKES) {
      throw new ChannelError('quota_exceeded', 'Too many pending Channel handshakes')
    }
    const perChannel = [...this.pending.values()].filter(
      (pending) => pending.channelId === channelId
    ).length
    if (perChannel >= MAX_PENDING_PER_CHANNEL) {
      throw new ChannelError('quota_exceeded', 'Too many pending handshakes for this Channel')
    }
  }

  private assertChannelAccepting(channelId: string): void {
    if (this.quiescingChannels.has(channelId)) {
      throw new ChannelError('channel_closed', 'Channel is quiescing')
    }
  }

  private cleanExpiredPending(now: number): void {
    for (const [handshakeId, pending] of this.pending) {
      if (pending.expiresAt > now) continue
      this.pending.delete(handshakeId)
      if (pending.mode !== 'admission') continue
      try {
        this.opts.store.failMemberAdmission({
          channelId: pending.channelId,
          inviteId: pending.context.inviteId,
          memberId: pending.memberId,
          now
        })
      } catch {
        // Store expiry/recovery remains authoritative.
      }
    }
  }

  private consumeHandshakeRate(roomId: string, now: number): void {
    const retained = (this.handshakeRates.get(roomId) ?? []).filter(
      (at) => at > now - HANDSHAKE_RATE_WINDOW_MS
    )
    if (retained.length >= MAX_HANDSHAKES_PER_ROOM_WINDOW) {
      throw new ChannelError('quota_exceeded', 'Channel handshake rate limit reached')
    }
    retained.push(now)
    this.handshakeRates.set(roomId, retained)
  }

  private consumeAppendRate(session: RuntimeSession, now: number): void {
    const key = `${session.channelId}\u0000${session.memberId}`
    const retained = (this.appendRates.get(key) ?? []).filter(
      (at) => at > now - APPEND_RATE_WINDOW_MS
    )
    if (retained.length >= MAX_APPENDS_PER_MEMBER_WINDOW) {
      throw new ChannelError('quota_exceeded', 'Channel append rate limit reached')
    }
    retained.push(now)
    this.appendRates.set(key, retained)
  }

  private materializeHumanReview(review: ChannelHumanReviewEntry): ChannelAppendResult {
    if (!this.opts.humanReview) {
      throw new ChannelError('recovery_blocked', 'Channel human review authority is unavailable')
    }
    const result = this.opts.log.appendWithResult({
      channelId: review.channelId,
      principalMemberId: review.memberId,
      identityPublicKey: review.identityPublicKeyB64,
      roomId: review.roomId,
      clientMessageId: review.clientMessageId,
      content: review.content,
      now: review.resolvedAt ?? this.now()
    })
    const materialized = this.runHumanReviewOperation(() =>
      this.opts.humanReview!.markMaterialized(
        review.reviewId,
        { sequence: result.record.sequence, messageId: result.record.messageId },
        this.now()
      )
    )
    this.auditHumanReview('human.review.materialized', materialized)
    return result
  }

  private async flushApprovedHumanReviewsWithinQueue(
    channelId: string,
    memberId?: string
  ): Promise<ChannelAppendResult[]> {
    if (!this.opts.humanReview) return []
    const results: ChannelAppendResult[] = []
    for (const review of this.runHumanReviewOperation(() =>
      this.opts.humanReview!.listAwaitingMaterialization()
    )) {
      if (review.channelId !== channelId) continue
      if (memberId !== undefined && review.memberId !== memberId) continue
      const result = this.materializeHumanReview(review)
      this.auditCommit(result)
      if (!result.deduplicated) {
        await this.opts.afterDurableCommit?.(result)
        this.fanOut(result.record)
      }
      results.push(result)
    }
    return results
  }

  private requireHumanReview(reviewId: string): ChannelHumanReviewEntry {
    if (!this.opts.humanReview) {
      throw new ChannelError('recovery_blocked', 'Channel human review authority is unavailable')
    }
    const review = this.runHumanReviewOperation(() => this.opts.humanReview!.get(reviewId))
    if (!review) {
      throw new ChannelError('protocol_unsupported', 'Channel human review was not found')
    }
    return review
  }

  private runHumanReviewOperation<T>(operation: () => T): T {
    try {
      return operation()
    } catch (error) {
      if (!(error instanceof ChannelHumanReviewError)) throw error
      switch (error.code) {
        case 'recovery_blocked':
          throw new ChannelError('recovery_blocked', error.message)
        case 'quota_exceeded':
          throw new ChannelError('quota_exceeded', error.message)
        case 'idempotency_conflict':
          throw new ChannelError('idempotency_conflict', error.message)
        case 'invalid_state':
          throw new ChannelError('policy_denied', error.message)
        case 'invalid':
        case 'not_found':
        default:
          throw new ChannelError('protocol_unsupported', error.message)
      }
    }
  }

  private auditHumanReview(
    kind: Parameters<ChannelAuditLike['append']>[0]['kind'],
    review: ChannelHumanReviewEntry
  ): void {
    this.audit({
      kind,
      channelId: review.channelId,
      memberId: review.memberId,
      contentHash: review.contentHash,
      dedupeKey: humanReviewAuditDedupeKey(kind, review.reviewId)
    })
  }

  private enqueueChannel<T>(channelId: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.channelQueues.get(channelId) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(operation)
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    this.channelQueues.set(channelId, tail)
    return run.finally(() => {
      if (this.channelQueues.get(channelId) === tail) this.channelQueues.delete(channelId)
    })
  }

  private auditCommit(result: ChannelAppendResult): void {
    this.audit({
      kind: result.deduplicated ? 'message.deduplicated' : 'message.accepted',
      channelId: result.record.channelId,
      memberId: result.record.authorMemberId,
      contentHash: result.record.contentHash
    })
  }

  private audit(event: Parameters<ChannelAuditLike['append']>[0]): void {
    try {
      this.opts.audit?.append(event)
    } catch (error) {
      this.opts.logger?.(
        `[channel-runtime] audit append failed: ${error instanceof Error ? error.message : 'unknown'}`
      )
    }
  }
}
