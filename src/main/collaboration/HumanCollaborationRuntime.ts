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
  normalizeDisplayName,
  type HumanCollaborationShare
} from './HumanCollaborationStore'
import { HumanCollaborationDenialError } from './HumanContributionRules'
import type { HumanCollaborationAuditLike } from './HumanCollaborationAuditLog'
import type { HumanCollaborationPresenceSessionRef } from './HumanCollaborationPresence'

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
// Handshake bound, and it is the AUDIT that makes it necessary rather than the
// key work.
//
// An already-admitted collaborator can re-handshake with no invite token at all
// (`mode` is 'reconnect' whenever a collaboratorId arrives without one), and a
// wrong confirm code frees the pending slot BEFORE it throws — so the
// MAX_PENDING_* caps above never engage against begin → confirm(wrong) → begin.
// Each cycle is one cheap frame for the sender and two synchronous
// pretty-printed full-file audit rewrites for the host. The log keeps the
// NEWEST 2000 rows and is global across every chat and share, so roughly a
// thousand cycles evict every pre-existing row: the collaborator erases the
// record of their own conduct, which is the one thing an audit log exists to
// prevent. It also fires an admission banner per begin.
//
// TWO separate bounds, because they defend different things and a single one
// does neither job well:
//   - the WINDOW CAP bounds the WORK (an X25519 derive, an Ed25519 sign and a
//     banner IPC per begin);
//   - COALESCING (see auditHandshakeEvent) bounds the DURABLE WRITE, which is
//     the actual weapon. At most one row per key per window means the log
//     cannot be rolled at any inbound rate, so the cap does not have to be
//     tight enough to be the whole defence.
// Deliberately NO minimum interval between attempts: a client that fails a
// handshake and immediately retries is honest behaviour, and refusing it broke
// exactly that case.
const HANDSHAKE_WINDOW_MS = 60_000
const HANDSHAKE_MAX_PER_WINDOW = 10
/** When to sweep closed handshake buckets. A real host has a handful; this is
 *  only reached by a client rotating its identity key per attempt. */
const MAX_HANDSHAKE_RATE_KEYS = 256
// Coalesce the collaborator-driven projection rebuild.
//
// The transport's FLUSH_MIN_INTERVAL_MS throttles the outbound reseal+send, but
// it is consulted only AFTER `routeEncryptedAction` has already returned — and
// a subscribe dispatches straight to a full inline rebuild (read + normalize the
// whole chat record, resolve the roster, clone the queue, redact up to 120 rows,
// then JSON.stringify the whole projection once per row the byte budget drops).
// Nothing yields between frames, so an unthrottled stream stalls the main
// process. This must sit on the WIRE path only — `publishProjectionUpdates`
// calls `subscribeProjection` internally, and a limiter inside it would starve
// the host's own already-throttled flush loop.
const SUBSCRIBE_MIN_INTERVAL_MS = 200

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
   * 6-digit SAS for the out-of-band compare (L6-2). `mode` distinguishes a
   * first admission (SAS compare required) from a pinned-identity reconnect
   * (no human compare step — the UI must not present it as one). */
  onAdmissionBegan?: (info: {
    handshakeId: string
    chatId: string
    shareId: string
    displayName: string
    confirmCode: string
    mode: HumanCollaborationHandshakeMode
  }) => void
  /**
   * An external is now active on this chat — make the thread a panel.
   *
   * Fires for EVERY completed handshake, admission and reconnect alike, and the
   * implementation decides idempotently from chat state. Keying it on the
   * handshake mode here would be wrong in both directions: a reconnect must not
   * re-convert, and a first join whose conversion was DEFERRED for a live run
   * arrives next AS a reconnect and must still convert.
   *
   * Must never throw — a failed conversion cannot be allowed to fail a join.
   */
  onExternalSeatActive?: (info: {
    chatId: string
    shareId: string
    collaboratorId: string
  }) => void
  /** P2a durable audit sink (admission, session, rejected-contribution events). */
  audit?: HumanCollaborationAuditLike
  /**
   * Tri-state presence tracker (live / in-grace / expired). Injected rather than
   * constructed here so it stays unit-testable and so the caller owns the sweep
   * timer — the tracker is a pure state machine and deliberately arms nothing.
   *
   * Presence is NOT the session map. A graceful leave still deletes the session
   * (its keys die with it, which is the point of saying goodbye); presence
   * separately records `grace`, so the seat survives a reload without the
   * sealed session surviving it. Conflating the two would either keep keys
   * alive for the grace window or make a reload look like a departure.
   */
  presence?: HumanCollaborationPresenceLike
  now?: () => number
  log?: (line: string) => void
}

/**
 * The slice of `HumanCollaborationPresence` the runtime uses. A structural type
 * rather than the class, so the runtime never depends on the tracker's internals
 * and tests can pass a stub.
 */
export interface HumanCollaborationPresenceLike {
  observeActivity(ref: HumanCollaborationPresenceSessionRef, at?: number): unknown
  noteGracefulLeave(sessionId: string, at?: number): unknown
  expireCollaborator(
    collaboratorId: string,
    reason: 'revoked' | 'kicked' | 'shareDisabled',
    at?: number
  ): unknown
  collaboratorState(collaboratorId: string): 'live' | 'grace' | 'expired' | 'unknown'
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
  // rejectAuditAt coalesces the durable rejection audit row: a flood of
  // cheap-to-reject frames must not amplify into one sync disk write each.
  private readonly appendRate = new Map<
    string,
    { windowStart: number; count: number; last: number; rejectAuditAt?: number }
  >()
  // Per shareId:collaboratorId handshake-rate state (see HANDSHAKE_* above).
  // Deliberately NOT cleared on disconnect, revoke or a failed confirm — every
  // one of those is reachable by the flooder, so clearing there would hand them
  // a free reset and the limit would bound nothing.
  private readonly handshakeRate = new Map<
    string,
    {
      windowStart: number
      count: number
      last: number
      /** Coalesce the two durable handshake rows independently, so a burst of
       * failures cannot suppress the record of a real admission (see
       * auditHandshakeEvent). */
      beganAuditAt?: number
      beganSuppressed?: number
      failAuditAt?: number
      failSuppressed?: number
    }
  >()
  // Per sessionId, last WIRE-driven projection rebuild (see
  // SUBSCRIBE_MIN_INTERVAL_MS). Host-driven publishes do not consult it.
  private readonly subscribeRate = new Map<string, number>()

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
        params as HumanCollaborationSubscribeProjectionInput,
        { observedFromCollaborator: true }
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
    // BEFORE the pending caps, the key derivation, the banner and the audit
    // append — every one of those is a cost this throttle exists to deny, and
    // the audit append is the one that is not merely expensive but destructive.
    this.enforceHandshakeRateLimit(
      this.handshakeKey(shareId, collaboratorId, collaboratorIdentityPubKeyB64)
    )
    // The client-supplied name becomes a host-facing label further down, and on
    // a reconnect nothing else normalizes it: `validateParticipantSession` never
    // reads displayName, so the reserved-name list and the 80-char cap that
    // `consumeInvite` applies are both bypassed on this path. Untreated, a
    // collaborator could present to the host's admission banner as "TaskWraith",
    // and a non-string value would reach React as an object child and blank the
    // host's whole window through the root error boundary.
    const safeDisplayName = normalizeDisplayName(typeof displayName === 'string' ? displayName : '')
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
    // The STORED name wins where there is one — it was normalized at
    // `consumeInvite` and the collaborator does not get to restyle themselves on
    // reconnect. Where there is none (a readOnly share, or a first admission),
    // the normalized client value is what the host sees.
    const bannerDisplayName =
      share.mode === 'readOnly' ? safeDisplayName : existingParticipant?.displayName || safeDisplayName
    this.opts.onAdmissionBegan?.({
      handshakeId,
      chatId,
      shareId,
      displayName: bannerDisplayName,
      confirmCode,
      mode
    })
    this.auditHandshakeEvent(
      'began',
      {
        kind: 'admission.began',
        chatId,
        shareId,
        ...(existingParticipant?.collaboratorId
          ? { collaboratorId: existingParticipant.collaboratorId }
          : {}),
        detail: `${mode} · ${bannerDisplayName}`
      },
      this.handshakeKey(shareId, collaboratorId, collaboratorIdentityPubKeyB64)
    )

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
      //
      // Freeing the slot here is what lets begin → confirm(wrong) → begin evade
      // the MAX_PENDING_* caps, so the attempt is charged to the handshake
      // budget and its audit row is coalesced. Both matter: the charge bounds
      // how fast the loop can turn, the coalesce bounds what one turn can
      // durably cost.
      this.pending.delete(input.handshakeId)
      const failKey = this.handshakeKey(
        pending.shareId,
        pending.context.collaboratorId,
        pending.collaboratorIdentityPubKeyB64
      )
      this.chargeFailedConfirm(failKey)
      this.auditHandshakeEvent(
        'failed',
        {
          kind: 'admission.sas_failed',
          chatId: pending.chatId,
          shareId: pending.shareId,
          ...(pending.context.collaboratorId
            ? { collaboratorId: pending.context.collaboratorId }
            : {}),
          detail: 'confirm code mismatch'
        },
        failKey
      )
      throw new Error('Confirmation code mismatch.')
    }
    const collaboratorPublic = importRawEd25519PublicKey(b64.decode(pending.collaboratorIdentityPubKeyB64))
    const transcriptHash = b64.decode(pending.transcriptHashB64)
    const collaboratorSig = b64.decode(input.collaboratorTranscriptSigB64)
    const transcriptValid = verifyEd25519(collaboratorPublic, transcriptHash, collaboratorSig)
    if (!transcriptValid) {
      this.pending.delete(input.handshakeId)
      const sigFailKey = this.handshakeKey(
        pending.shareId,
        pending.context.collaboratorId,
        pending.collaboratorIdentityPubKeyB64
      )
      this.chargeFailedConfirm(sigFailKey)
      this.auditHandshakeEvent(
        'failed',
        {
          kind: 'admission.sas_failed',
          chatId: pending.chatId,
          shareId: pending.shareId,
          ...(pending.context.collaboratorId
            ? { collaboratorId: pending.context.collaboratorId }
            : {}),
          detail: 'collaborator transcript signature invalid'
        },
        sigFailKey
      )
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
    // A completed handshake is the strongest possible liveness evidence. Note it
    // BEFORE the audit row so a reconnect inside the grace window resolves to
    // `live` — and therefore reports `silent` — rather than the caller seeing a
    // spurious join for someone who never really left.
    this.notePresenceActivity(session)
    this.opts.audit?.append({
      kind: 'admission.sas_confirmed',
      chatId: pending.chatId,
      shareId: admitted.share.shareId,
      collaboratorId: participant.collaboratorId,
      detail: `${pending.mode} · ${participant.displayName}`
    })

    // After the audit row, before the reply: the collaborator's own client
    // learns it joined from this return value, and the thread should already be
    // a panel by then. Guarded because a conversion failure must never surface
    // as a failed join.
    try {
      this.opts.onExternalSeatActive?.({
        chatId: pending.chatId,
        shareId: admitted.share.shareId,
        collaboratorId: participant.collaboratorId
      })
    } catch {
      // Logged nowhere on purpose: the join succeeded, and the next join or the
      // host's own toggle will convert.
    }

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

  /**
   * `observedFromCollaborator` defaults to FALSE, and the default is the point.
   *
   * This method serves two callers that look identical and mean opposite
   * things: a collaborator asking for the projection (real evidence they are
   * there) and `publishProjectionUpdates` rebuilding it because the HOST
   * changed something (no evidence about the collaborator at all). Noting
   * presence unconditionally meant every host-side broadcast refreshed the
   * collaborator's liveness as though they had acted.
   *
   * That was self-defeating rather than merely wrong: the 15s presence sweep
   * broadcasts on each transition, which republishes the projection, which
   * refreshed the very sessions the sweep had just tried to expire. Any
   * streamed chat update did the same. So a collaborator whose laptop closed
   * could never leave `live`, and fixing the relay's missing disconnect signal
   * would NOT have fixed it — the host's own traffic kept resetting the clock.
   *
   * Defaulting to false means a new caller that forgets claims no liveness,
   * which is honest. The opposite default fails silently and in the flattering
   * direction.
   */
  async subscribeProjection(
    input: HumanCollaborationSubscribeProjectionInput,
    opts: { observedFromCollaborator?: boolean } = {}
  ): Promise<ProjectionType> {
    const session = this.requireActiveSession(input.sessionId)
    if (opts.observedFromCollaborator) this.notePresenceActivity(session)
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
    this.notePresenceActivity(session)
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
    // Safe to clear, unlike `handshakeRate`: this map is keyed by sessionId and
    // a reconnect always mints a new one, so there is no window to reset.
    this.subscribeRate.delete(input.sessionId)
    if (!removed) return false
    // The SESSION goes — its keys die with it, which is the whole point of
    // saying goodbye — but the SEAT does not. Presence records `grace` so a tab
    // reload or a roam between networks does not read as a departure. The seat
    // only leaves when the grace window expires, and that is the caller's sweep
    // to run, not ours.
    this.opts.presence?.noteGracefulLeave(input.sessionId)
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
   * Tri-state presence for one collaborator, or `'unknown'` when no tracker is
   * wired. Callers must treat `'unknown'` as NOT present — absence of evidence
   * is not evidence of presence.
   */
  collaboratorPresenceState(collaboratorId: string): 'live' | 'grace' | 'expired' | 'unknown' {
    return this.opts.presence?.collaboratorState(collaboratorId) ?? 'unknown'
  }

  /** Record liveness from any authenticated interaction. Inbound frames are the
   * only liveness signal a passive watcher generates, so subscribing and
   * commenting both count. */
  private notePresenceActivity(session: RuntimeSession): void {
    this.opts.presence?.observeActivity({
      sessionId: session.sessionId,
      chatId: session.chatId,
      shareId: session.shareId,
      collaboratorId: session.collaboratorId,
      displayName: session.displayName
    })
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
   * Is anyone actually watching this chat's projection right now?
   *
   * The cheap gate in front of `publishProjectionUpdates`. Publishing is
   * expensive — it rebuilds, re-redacts and re-seals the whole projection per
   * subscriber, and the byte-budget trim `JSON.stringify`s the projection once
   * per dropped row (HumanShareProjection.ts:101-103), synchronously on main.
   * The transcript hot path fires on every streamed chat update for EVERY chat,
   * the overwhelming majority of which are not shared at all, so callers on
   * that path must be able to answer "is this worth doing?" without paying for
   * it. Deliberately narrower than `connectedChatIds()`: a session that has not
   * subscribed has nothing to receive.
   */
  hasProjectionSubscriberForChat(chatId: string): boolean {
    for (const sessionId of this.projectionSubscribers) {
      if (this.sessions.get(sessionId)?.chatId === chatId) return true
    }
    return false
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

  /**
   * Seal and push a refusal back to the collaborator who sent the contribution.
   *
   * Rides the existing encrypted-projection sink rather than a new transport
   * path, so it reuses the session→room routing that is already proven.
   *
   * Every step is best-effort and swallowed: a refusal that cannot be delivered
   * must not become a second failure on top of the first. Notably
   * `sealForCollaborator` goes through `requireActiveSession`, so it THROWS for
   * exactly the `stale_session` and `revoked` denials — unavoidable, since
   * those sessions' keys are gone by definition.
   */
  private notifyContributionRejected(
    sessionId: string,
    clientMessageId: string,
    err: unknown
  ): void {
    if (!this.opts.publishEncryptedProjection) return
    try {
      const code = err instanceof HumanCollaborationDenialError ? err.code : 'rejected'
      const frame = this.sealForCollaborator(sessionId, {
        method: HUMAN_COLLABORATION_EVENTS.contributionRejected,
        params: {
          code,
          message: err instanceof Error ? err.message : 'The host could not accept that message.',
          clientMessageId
        }
      })
      void Promise.resolve(this.opts.publishEncryptedProjection(sessionId, frame)).catch(() => {})
    } catch {
      // Session already gone — nothing to tell, and nobody to tell it to.
    }
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
      const now = this.now()
      const last = this.subscribeRate.get(frame.sessionId) ?? 0
      if (now - last < SUBSCRIBE_MIN_INTERVAL_MS) {
        // Still register the subscription and the liveness — both are cheap and
        // both are load-bearing — but skip the rebuild. The transport discards
        // this return value anyway, and its coalesced flush delivers the current
        // projection within FLUSH_MIN_INTERVAL_MS regardless, so a throttled
        // subscribe costs the collaborator nothing.
        const session = this.requireActiveSession(frame.sessionId)
        this.notePresenceActivity(session)
        this.projectionSubscribers.add(session.sessionId)
        return undefined
      }
      this.subscribeRate.set(frame.sessionId, now)
      return this.subscribeProjection(
        { sessionId: frame.sessionId },
        { observedFromCollaborator: true }
      )
    }
    if (message.method === HUMAN_COLLABORATION_METHODS.appendComment) {
      const input = params as Partial<HumanCollaborationAppendCommentInput>
      const clientMessageId = requireFrameString(input.clientMessageId, 'Client message id')
      try {
        return await this.appendComment({
          sessionId: frame.sessionId,
          clientMessageId,
          content: requireFrameString(input.content, 'Comment'),
          // Whitelist at the wire boundary too: only the exact P2b string passes.
          ...(input.intent === 'requestHostAction' ? { intent: 'requestHostAction' as const } : {})
        })
      } catch (err) {
        // Tell them. An append is a fire-and-forget notification with no reply
        // frame, so before this every refusal — too long, too fast, too many
        // awaiting review — was a host-only log line while the collaborator's
        // UI still said "Connected" and their text was already discarded. The
        // runtime authors these strings in the COLLABORATOR'S voice ("slow
        // down", "you have too many messages awaiting review"); they were
        // addressed to someone who never received them.
        this.notifyContributionRejected(frame.sessionId, clientMessageId, err)
        throw err
      }
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
        // Do NOT unsubscribe on a transient failure. A projection build reads
        // the chat through `buildProjection`, which can throw for reasons that
        // pass — a store read racing a write, a chat momentarily unresolvable
        // mid-save. The subscription is established in `subscribeProjection`,
        // and an HONEST client calls it exactly once per session (the two IPC
        // join paths each subscribe once), so dropping it here is PERMANENT for
        // the life of the session: the external's
        // transcript freezes silently and neither side is told why. That is one
        // of the two independent causes of the "no live updates after joining"
        // report. Only give up when the session itself has gone (a concurrent
        // disconnect during the await); otherwise keep the subscription and let
        // the next publish retry.
        if (!this.sessions.has(sessionId)) this.projectionSubscribers.delete(sessionId)
        this.opts.log?.(
          `[human-collaboration] projection push skipped for session ${sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }
  }

  /**
   * Who a handshake budget belongs to.
   *
   * The pinned `collaboratorId` where there is one — that is the reconnect lane,
   * the one the attack uses, and it cannot be rotated because
   * `validateParticipantSession` matches it against an active participant.
   * Otherwise the client's own identity key, NOT a per-share constant: a share
   * admits two people and they may well arrive within the same second, so a
   * shared "first admission" bucket would have one honest joiner throttling the
   * other. Rotating that key to buy a fresh budget gains nothing — an admission
   * still has to pass `verifyInvite`, which throws before anything durable is
   * written.
   */
  private handshakeKey(
    shareId: string,
    collaboratorId: string | undefined,
    identityPubKeyB64: string
  ): string {
    return `${shareId}:${collaboratorId || identityPubKeyB64}`
  }

  /**
   * Throttle the handshake lane. Throws WITHOUT writing an audit row — the
   * whole point is that a refused handshake must cost the host nothing durable,
   * because the durable write is the amplifier being defended against.
   *
   * A first admission legitimately involves one handshake, a reconnect one more;
   * ten per minute is far above any honest client and far below what it takes to
   * roll a 2000-row log.
   */
  private enforceHandshakeRateLimit(key: string): void {
    const now = this.now()
    const state = this.handshakeRate.get(key)
    if (!state) {
      // A first-admission key carries the client's own identity pubkey, which
      // the client picks — so an attacker CAN mint a fresh bucket per attempt.
      // That buys them nothing durable (an admission still has to pass
      // `verifyInvite`, which throws before any audit append) but it would grow
      // this map without bound, so retire buckets whose window has closed.
      // Live buckets are never touched: dropping one is what would hand a
      // flooder the reset this limiter exists to deny.
      if (this.handshakeRate.size >= MAX_HANDSHAKE_RATE_KEYS) {
        for (const [candidate, tracked] of this.handshakeRate) {
          if (now - tracked.windowStart >= HANDSHAKE_WINDOW_MS) this.handshakeRate.delete(candidate)
        }
      }
      this.handshakeRate.set(key, { windowStart: now, count: 1, last: now })
      return
    }
    if (now - state.windowStart >= HANDSHAKE_WINDOW_MS) {
      state.windowStart = now
      state.count = 0
    }
    if (state.count >= HANDSHAKE_MAX_PER_WINDOW) {
      throw new Error('Too many collaboration handshake attempts; try again shortly.')
    }
    state.count += 1
    state.last = now
  }

  /**
   * Charge a failed confirm to the handshake budget.
   *
   * `confirmSas` frees the pending slot before it throws, so a wrong code costs
   * the attacker nothing and buys them an unmetered retry. Without this the
   * begin → confirm(wrong) → begin loop stays unbounded even with the begin
   * limiter in place, because each begin is separated by a confirm.
   */
  private chargeFailedConfirm(key: string): void {
    const now = this.now()
    const state = this.handshakeRate.get(key)
    if (!state) {
      this.handshakeRate.set(key, { windowStart: now, count: 1, last: now })
      return
    }
    if (now - state.windowStart >= HANDSHAKE_WINDOW_MS) {
      state.windowStart = now
      state.count = 0
    }
    state.count += 1
    state.last = now
  }

  /**
   * Append a handshake-lane audit row, at most one per key per window, carrying
   * a count of what it stands for.
   *
   * This is the bound that actually defeats log erasure. Every append is a
   * synchronous pretty-printed rewrite of the whole file, and the log keeps only
   * the newest 2000 rows across every chat and share — so an unbounded producer
   * on this lane does not merely cost CPU, it evicts the host's real history,
   * including the record of the erasing party's own conduct. Coalescing makes
   * that impossible at any inbound rate rather than merely slow.
   *
   * The count is what keeps it honest: a suppressed row must still be visible as
   * volume, or a sustained attack would read as one fat-fingered code. Same
   * shape as `rateLimitDenial`, which coalesces the contribution-rejection row
   * for exactly this reason.
   */
  private auditHandshakeEvent(
    slot: 'began' | 'failed',
    input: { kind: 'admission.began' | 'admission.sas_failed'; chatId: string; shareId: string; collaboratorId?: string; detail: string },
    key: string
  ): void {
    const now = this.now()
    const state = this.handshakeRate.get(key)
    const atField = slot === 'began' ? 'beganAuditAt' : 'failAuditAt'
    const countField = slot === 'began' ? 'beganSuppressed' : 'failSuppressed'
    if (state && state[atField] !== undefined && now - (state[atField] as number) < HANDSHAKE_WINDOW_MS) {
      state[countField] = (state[countField] ?? 0) + 1
      return
    }
    const suppressed = state?.[countField] ?? 0
    if (state) {
      state[atField] = now
      state[countField] = 0
    }
    this.opts.audit?.append({
      kind: input.kind,
      chatId: input.chatId,
      shareId: input.shareId,
      ...(input.collaboratorId ? { collaboratorId: input.collaboratorId } : {}),
      detail: suppressed > 0 ? `${input.detail} (+${suppressed} more suppressed)` : input.detail
    })
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
      throw this.rateLimitDenial(session, state, now)
    }
    if (now - state.windowStart >= APPEND_WINDOW_MS) {
      state.windowStart = now
      state.count = 0
    }
    if (state.count >= APPEND_MAX_PER_WINDOW) {
      throw this.rateLimitDenial(session, state, now)
    }
    state.count += 1
    state.last = now
  }

  private rateLimitDenial(
    session: RuntimeSession,
    state: { rejectAuditAt?: number },
    now: number
  ): HumanCollaborationDenialError {
    // Audit at most one rejection row per collaborator per window: rejections
    // are cheap for the sender but each audit append is a synchronous
    // full-file rewrite, so per-frame rows would be a DoS amplifier.
    if (state.rejectAuditAt === undefined || now - state.rejectAuditAt >= APPEND_WINDOW_MS) {
      state.rejectAuditAt = now
      this.opts.audit?.append({
        kind: 'contribution.rejected',
        chatId: session.chatId,
        shareId: session.shareId,
        collaboratorId: session.collaboratorId,
        code: 'quota_exceeded'
      })
    }
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
      this.subscribeRate.delete(sessionId)
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
      this.subscribeRate.delete(sessionId)
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
