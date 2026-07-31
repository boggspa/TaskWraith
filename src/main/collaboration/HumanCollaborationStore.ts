import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { createHash, randomBytes, randomUUID } from 'crypto'
import {
  assertSettablePreset,
  contributionModeForRules,
  contributionRulesForPreset,
  deriveContributionRules,
  effectiveContributionRules,
  HumanCollaborationDenialError,
  normalizeContributionRules,
  type HumanContributionPreset,
  type HumanContributionRules
} from './HumanContributionRules'
// The ONE palette-bound guard, shared with the contacts store so a ninth hue
// cannot be silently rejected here while being accepted there.
import { isContactColorIndex } from './HumanCollaborationContactsStore'

/**
 * A valid roster position: a non-negative integer, bounded so a hostile or buggy
 * value cannot be stored. Fractions are REJECTED, not floored — see `seatOrder`.
 */
const MAX_SEAT_ORDER = 4096
function isSeatOrder(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_SEAT_ORDER
}

export type HumanCollaborationMode = 'readOnly' | 'comments'
export type HumanCollaboratorStatus = 'pending' | 'active' | 'revoked'

export interface HumanCollaboratorParticipant {
  collaboratorId: string
  displayName: string
  publicKeyId: string
  status: HumanCollaboratorStatus
  joinedAt?: number
  revokedAt?: number
  /**
   * Roster position in the effective panel. Lives HERE, on the collaborator's
   * own record, and never on the chat — that is what lets a join or a leave
   * reorder the panel without rewriting chat state (see
   * `src/shared/effectiveEnsembleRoster.ts` for why the roster is derived).
   * Absent ⇒ the resolver appends them after every model seat.
   *
   * A non-negative INTEGER. Fractions are rejected rather than floored: `1.9`
   * flooring to `1` would silently tie with whoever already holds slot 1, which
   * is the same quiet reordering this field's guards exist to prevent.
   *
   * Ties are NOT renumbered here. Two actives may legitimately hold the same
   * order mid-drag, and `resolveEffectiveRoster` breaks a tie deterministically
   * (model seat first, then by seat id) so a render and a turn queue built from
   * the same inputs can never disagree.
   */
  seatOrder?: number
  /**
   * Index into the shared bubble-colour palette, accenting this person's name
   * chip and their own message bubbles. An INDEX, never a CSS string — a
   * free-form colour would be an injection surface the moment any surface
   * interpolates it into a stylesheet.
   *
   * Scope: this is a PER-SHARE OVERRIDE. `HumanCollaborationContactsStore` holds
   * the person's cross-chat default (and derives a stable hue from their pubkey
   * when unset). Resolution order for a renderer is: this field, then the
   * contact's, then the pubkey derivation. Recolouring someone in one share
   * deliberately does not repaint them everywhere.
   *
   * NB it does NOT currently cross to the collaborator: `buildHumanShareProjection`
   * whitelists `collaboratorId`/`displayName`/`status` only. That is the right
   * posture — an external should not learn the host's private mute state — so if
   * a future slice projects seat data, project the colour and NOT `seatDisabled`.
   */
  colorIndex?: number
  /**
   * Host-muted. A muted external keeps its seat and its position — this is not
   * a soft delete, and it must never be confused with `status: 'revoked'`,
   * which withdraws trust and cannot be undone.
   */
  seatDisabled?: boolean
}

export interface HumanCollaborationInvite {
  inviteId: string
  tokenHash: string
  createdAt: number
  expiresAt: number
  consumedAt?: number
  collaboratorId?: string
  /** The relay room (one per invite/collaborator) the host listens on and the
   * collaborator dials. Optional for back-compat with pre-transport invites. */
  roomId?: string
}

export interface HumanCollaborationShare {
  shareId: string
  chatId: string
  mode: HumanCollaborationMode
  enabled: boolean
  createdAt: number
  updatedAt: number
  nextSequence: number
  participants: HumanCollaboratorParticipant[]
  invites: HumanCollaborationInvite[]
  idempotency: Record<string, string>
  /**
   * Phase 2 (P2a) contribution rules. OPTIONAL for migration/back-compat: a
   * share without persisted rules behaves exactly like Phase 1 — callers use
   * `effectiveContributionRules(share)` which derives from `mode`. Only ever
   * written by HOST-side APIs (createShare/updateShareRules); collaborator
   * frames and renderer state are never authority for this field.
   */
  contributionRules?: HumanContributionRules
  /**
   * Host review: contributions from this share are QUEUED rather than appended,
   * and reach the transcript only when the host approves them.
   *
   * Deliberately a share field and NOT part of `contributionRules`. The rules
   * object is derived per-preset by `contributionRulesForPreset`, so a value
   * living there would be recomputed away on the next preset write; this has to
   * survive one. It is also a different question — the rules say what a
   * collaborator MAY do, this says whether the host sees it first.
   *
   * Absent ⇒ off, which is what keeps every existing share behaving exactly as
   * it does today. The queue is the end state, but it is inert until a host
   * opts a share in, so a build carrying the machinery cannot change anyone's
   * behaviour before the review surface exists to go with it.
   */
  requiresHostApproval?: boolean
  /**
   * Grant this share the FULL thread, including rows written before it existed.
   *
   * A share field for the same reason `requiresHostApproval` is one: the rules
   * object is recomputed per preset and would erase it, and it answers a
   * different question — the rules say what a collaborator may DO, this says
   * how far back they may SEE.
   *
   * Absent ⇒ the projection floors at the share's `createdAt`. That default is
   * the whole point. Rows written before a share existed were written by
   * someone with no reason to expect they would ever leave the machine, and
   * granting them is a decision the host takes explicitly rather than a side
   * effect of raising a row limit or adding paging.
   */
  fullHistory?: boolean
}

export interface HumanCollaborationSnapshot {
  shares: HumanCollaborationShare[]
}

export interface CreateShareResult {
  share: HumanCollaborationShare
  invite: HumanCollaborationInvite
  inviteToken: string
  /** Per-invite relay room id (the host opens this room; the collaborator dials it). */
  roomId: string
}

export interface ConsumeInviteResult {
  share: HumanCollaborationShare
  participant: HumanCollaboratorParticipant
}

export interface VerifyInviteResult {
  share: HumanCollaborationShare
  invite: HumanCollaborationInvite
  existingParticipant: HumanCollaboratorParticipant | null
}

export interface HumanCollaborationReconnectCandidate {
  shareId: string
  chatId: string
  mode: HumanCollaborationMode
  inviteId: string
  roomId: string
  inviteExpiresAt: number
  participant: HumanCollaboratorParticipant
}

const DEFAULT_INVITE_TTL_MS = 10 * 60 * 1000
const MAX_ACTIVE_COLLABORATORS = 2
// Cap the per-share idempotency map so a stream of unique clientMessageIds from
// an untrusted collaborator cannot grow it without bound and make every
// subsequent whole-snapshot persist (and resident memory) climb. 512 vastly
// exceeds any legitimate in-flight retry window for 2 collaborators.
const MAX_IDEMPOTENCY_ENTRIES = 512
// Keep a consumed invite for a grace window (so an in-flight admission isn't
// lost), then it may be pruned at the next createShare.
const CONSUMED_INVITE_RETENTION_MS = 24 * 60 * 60 * 1000

export class HumanCollaborationStore {
  private memory: HumanCollaborationSnapshot = { shares: [] }

  constructor(private readonly storagePath?: string) {
    this.memory = this.load()
  }

  listShares(chatId?: string): HumanCollaborationShare[] {
    return cloneSnapshot(this.memory).shares.filter((share) => !chatId || share.chatId === chatId)
  }

  /**
   * Discover active participant reconnect targets by pinned collaborator identity.
   * Returns candidates for trusted reconnect workflows (share id + room id +
   * participant identity), filtered to currently enabled shares.
   */
  listReconnectCandidates(publicKeyId: string): HumanCollaborationReconnectCandidate[] {
    const normalizedPublicKeyId = String(publicKeyId).trim()
    if (!normalizedPublicKeyId) return []
    const candidates: HumanCollaborationReconnectCandidate[] = []

    for (const share of this.memory.shares) {
      if (!share.enabled) continue
      for (const participant of share.participants) {
        if (participant.status !== 'active' || participant.publicKeyId !== normalizedPublicKeyId) {
          continue
        }
        const invite = [...share.invites]
          .filter((entry) => entry.collaboratorId === participant.collaboratorId && Boolean(entry.roomId))
          .sort((a, b) => b.createdAt - a.createdAt)[0]
        if (!invite?.roomId) continue
        candidates.push({
          shareId: share.shareId,
          chatId: share.chatId,
          mode: share.mode,
          inviteId: invite.inviteId,
          roomId: invite.roomId,
          inviteExpiresAt: invite.expiresAt,
          participant: { ...participant }
        })
      }
    }

    return candidates.sort((a, b) => b.inviteExpiresAt - a.inviteExpiresAt)
  }

  getShare(shareId: string): HumanCollaborationShare | null {
    return cloneShare(this.memory.shares.find((share) => share.shareId === shareId) || null)
  }

  getShareForChat(chatId: string): HumanCollaborationShare | null {
    return cloneShare(
      this.memory.shares.find((share) => share.chatId === chatId && share.enabled) || null
    )
  }

  /**
   * Cheap existence check (no clone). The hot saveChat path uses this to skip
   * the expensive listShares() deep-clone for the common case of a chat that
   * has no share at all — see ChatService.preserveCollaboratorComments.
   */
  hasShareForChat(chatId: string): boolean {
    return this.memory.shares.some((share) => share.chatId === chatId)
  }

  createShare(args: {
    chatId: string
    mode: HumanCollaborationMode
    /** Optional P2a preset; when set it wins and `mode` is re-derived from it. */
    preset?: HumanContributionPreset
    now?: number
    inviteTtlMs?: number
  }): CreateShareResult {
    const now = args.now ?? Date.now()
    const existing = this.memory.shares.find((share) => share.chatId === args.chatId && share.enabled)
    const share =
      existing ||
      ({
        shareId: randomUUID(),
        chatId: args.chatId,
        mode: args.mode,
        enabled: true,
        createdAt: now,
        updatedAt: now,
        nextSequence: 1,
        participants: [],
        invites: [],
        idempotency: {}
      } satisfies HumanCollaborationShare)

    if (args.preset) {
      // Host chose an explicit contribution preset: rules win, mode derives.
      const rules = contributionRulesForPreset(assertSettablePreset(args.preset))
      share.contributionRules = rules
      share.mode = contributionModeForRules(rules)
    } else {
      share.mode = args.mode
      // Keep existing rules only while they still agree with the requested
      // mode; otherwise re-derive so mode stays the Phase 1 source of truth.
      if (
        !share.contributionRules ||
        contributionModeForRules(share.contributionRules) !== share.mode
      ) {
        share.contributionRules = deriveContributionRules(share.mode)
      }
    }
    share.updatedAt = now
    const inviteToken = randomBytes(24).toString('base64url')
    const roomId = randomUUID()
    const invite: HumanCollaborationInvite = {
      inviteId: randomUUID(),
      tokenHash: hashInviteToken(inviteToken),
      createdAt: now,
      expiresAt: now + (args.inviteTtlMs ?? DEFAULT_INVITE_TTL_MS),
      roomId
    }
    // Prune invites well past expiry — consumed or not (createShare is the only
    // place invites accrue), so the list can't grow without bound over a
    // long-lived share. Fresh/not-yet-expired and in-grace invites are kept.
    share.invites = [...share.invites.filter((existingInvite) => !isDeadInvite(existingInvite, now)), invite]

    if (!existing) this.memory.shares.push(share)
    this.persist()
    return { share: cloneShare(share)!, invite: { ...invite }, inviteToken, roomId }
  }

  /**
   * History-erasure step: remove every share record owned by the given chats.
   * Record removal is the revocation — the runtime denies by absence on the
   * collaborator's next inbound frame and drops the session — and the persist
   * throws on failure so the outer deletion transaction stays pending instead
   * of committing while share records survive. Idempotent per scope.
   */
  purgeChatShares(chatIds: readonly string[]): number {
    const targets = new Set(chatIds)
    const retained = this.memory.shares.filter((share) => !targets.has(share.chatId))
    const removed = this.memory.shares.length - retained.length
    if (removed === 0) return 0
    this.memory.shares = retained
    this.persist()
    return removed
  }

  /** Global history clear: remove every share record. */
  purgeAllShares(): number {
    const removed = this.memory.shares.length
    if (removed === 0) return 0
    this.memory.shares = []
    this.persist()
    return removed
  }

  revokeShare(shareId: string, now: number = Date.now()): HumanCollaborationShare | null {
    const share = this.memory.shares.find((candidate) => candidate.shareId === shareId)
    if (!share) return null
    share.enabled = false
    share.updatedAt = now
    share.participants = share.participants.map((participant) =>
      participant.status === 'active'
        ? { ...participant, status: 'revoked', revokedAt: now }
        : participant
    )
    this.persist()
    return cloneShare(share)
  }

  revokeParticipant(args: {
    shareId: string
    collaboratorId: string
    now?: number
  }): HumanCollaborationShare | null {
    const now = args.now ?? Date.now()
    const share = this.memory.shares.find((candidate) => candidate.shareId === args.shareId)
    if (!share) return null
    share.participants = share.participants.map((participant) =>
      participant.collaboratorId === args.collaboratorId && participant.status !== 'revoked'
        ? { ...participant, status: 'revoked', revokedAt: now }
        : participant
    )
    share.updatedAt = now
    this.persist()
    return cloneShare(share)
  }

  /**
   * Turn host review on or off for a share. HOST-only: a collaborator frame is
   * never authority for this, which is why it is not reachable through
   * `updateShareRules` (that takes a preset a collaborator's UI can display).
   */
  setRequiresHostApproval(args: {
    shareId: string
    requiresHostApproval: boolean
    now?: number
  }): HumanCollaborationShare | null {
    const share = this.memory.shares.find((candidate) => candidate.shareId === args.shareId)
    if (!share || !share.enabled) return null
    const next = args.requiresHostApproval === true
    if ((share.requiresHostApproval === true) === next) return cloneShare(share)
    if (next) share.requiresHostApproval = true
    else delete share.requiresHostApproval
    share.updatedAt = args.now ?? Date.now()
    this.persist()
    return cloneShare(share)
  }

  /**
   * The per-share full-history opt-in.
   *
   * Off by default and deliberately its own verb, not part of the contribution
   * rules: those describe what a collaborator may DO, this describes what they
   * may SEE, and it is the only switch in the feature that changes disclosure
   * RETROACTIVELY. Turning it on hands over rows written before the share
   * existed — written by someone with no reason to expect they would ever leave
   * the machine — so it must always be a decision somebody took, never a side
   * effect of changing a limit.
   *
   * Deleting rather than storing `false` keeps the in-memory record clean, so
   * `share.fullHistory === true` reads the same everywhere. It is NOT what
   * guarantees the on-disk shape — `normalizeSnapshot` emits the key only when
   * the value is exactly `true`, and that normalizer is what a hand-edited or
   * legacy file passes through. Do not remove one on the strength of the other.
   */
  setFullHistory(args: {
    shareId: string
    fullHistory: boolean
    now?: number
  }): HumanCollaborationShare | null {
    const share = this.memory.shares.find((candidate) => candidate.shareId === args.shareId)
    if (!share || !share.enabled) return null
    const next = args.fullHistory === true
    if ((share.fullHistory === true) === next) return cloneShare(share)
    if (next) share.fullHistory = true
    else delete share.fullHistory
    share.updatedAt = args.now ?? Date.now()
    this.persist()
    return cloneShare(share)
  }

  /**
   * Host-only seat presentation: roster position, name-chip colour, muted.
   *
   * Deliberately separate from `revokeParticipant`. Muting a seat is reversible
   * presentation; revoking withdraws trust, permanently rejects that pubkey for
   * the share, and has no undo. Collapsing them into one "disable" verb is how
   * you end up with a kick that can be taken back.
   *
   * Only an ACTIVE participant can be reseated — a pending one has not completed
   * SAS and a revoked one holds no seat, so neither has a position to move.
   * Every field is optional and `null` clears it; an out-of-range value is
   * REJECTED (returns null) rather than clamped, so a bad write fails loudly
   * instead of quietly reordering the panel.
   */
  updateParticipantSeat(args: {
    shareId: string
    collaboratorId: string
    seatOrder?: number | null
    colorIndex?: number | null
    seatDisabled?: boolean
    now?: number
  }): HumanCollaborationShare | null {
    const now = args.now ?? Date.now()
    const share = this.memory.shares.find((candidate) => candidate.shareId === args.shareId)
    // Explicit rather than incidental: today `revokeShare` revokes every active
    // participant, so a disabled share has no seatable target anyway. A future
    // path that disables a share WITHOUT revoking people would open this.
    if (!share || !share.enabled) return null
    const target = share.participants.find(
      (participant) =>
        participant.collaboratorId === args.collaboratorId && participant.status === 'active'
    )
    if (!target) return null
    if (args.seatOrder !== undefined && args.seatOrder !== null && !isSeatOrder(args.seatOrder)) {
      return null
    }
    if (
      args.colorIndex !== undefined &&
      args.colorIndex !== null &&
      !isContactColorIndex(args.colorIndex)
    ) {
      return null
    }
    // Validate everything BEFORE applying anything, then apply only if something
    // actually changes. A no-op write would still bump `updatedAt` and trigger a
    // whole-snapshot synchronous write — and a drag-reorder UI emits a great many
    // no-ops, which is exactly the sync-writeJson main-thread stall class.
    let changed = false
    if (args.seatOrder !== undefined) {
      const next = args.seatOrder === null ? undefined : args.seatOrder
      if (target.seatOrder !== next) {
        if (next === undefined) delete target.seatOrder
        else target.seatOrder = next
        changed = true
      }
    }
    if (args.colorIndex !== undefined) {
      const next = args.colorIndex === null ? undefined : args.colorIndex
      if (target.colorIndex !== next) {
        if (next === undefined) delete target.colorIndex
        else target.colorIndex = next
        changed = true
      }
    }
    if (args.seatDisabled !== undefined) {
      const next = args.seatDisabled === true ? true : undefined
      if (target.seatDisabled !== next) {
        if (next === undefined) delete target.seatDisabled
        else target.seatDisabled = true
        changed = true
      }
    }
    if (!changed) return cloneShare(share)
    share.updatedAt = now
    this.persist()
    return cloneShare(share)
  }

  /**
   * P2a: host-only rules update. Sets the share's contribution rules to the
   * chosen preset and keeps the legacy `mode` in lockstep so every Phase 1
   * gate (mode checks, projection, handshake `shareMode`, v1 clients) stays
   * consistent. Rejects the non-settable direct-dispatch tier.
   */
  updateShareRules(args: {
    shareId: string
    preset: HumanContributionPreset
    now?: number
  }): HumanCollaborationShare | null {
    const now = args.now ?? Date.now()
    const share = this.memory.shares.find((candidate) => candidate.shareId === args.shareId)
    if (!share || !share.enabled) return null
    const rules = contributionRulesForPreset(assertSettablePreset(args.preset))
    share.contributionRules = rules
    share.mode = contributionModeForRules(rules)
    share.updatedAt = now
    this.persist()
    return cloneShare(share)
  }

  consumeInvite(args: {
    shareId: string
    inviteToken: string
    displayName: string
    publicKeyId: string
    chatId?: string
    now?: number
  }): ConsumeInviteResult {
    const now = args.now ?? Date.now()
    const state = this.findInvite({
      shareId: args.shareId,
      inviteToken: args.inviteToken,
      // Re-bind the chat at consume time too (begin already checked it), so the
      // terminal admission step never relies solely on pending-handshake integrity.
      chatId: args.chatId,
      publicKeyId: args.publicKeyId,
      displayName: args.displayName,
      now
    })
    const share = state.share

    const existingByKey = state.existingByKey
    const invite = state.invite
    if (!share || !share.enabled) throw new Error('Collaboration share is not active.')
    const activeCount = share.participants.filter((participant) => participant.status === 'active').length
    if (!existingByKey && activeCount >= MAX_ACTIVE_COLLABORATORS) {
      throw new Error('Collaboration share already has the maximum number of active collaborators.')
    }

    const participant: HumanCollaboratorParticipant = existingByKey
      ? {
          ...existingByKey,
          displayName: normalizeDisplayName(args.displayName),
          status: 'active',
          joinedAt: existingByKey.joinedAt ?? now,
          revokedAt: undefined
        }
      : {
          collaboratorId: randomUUID(),
          displayName: normalizeDisplayName(args.displayName),
          publicKeyId: args.publicKeyId,
          status: 'active',
          joinedAt: now
        }

    if (existingByKey) {
      share.participants = share.participants.map((candidate) =>
        candidate.publicKeyId === args.publicKeyId ? participant : candidate
      )
    } else {
      share.participants = [...share.participants, participant]
    }
    invite.consumedAt = now
    invite.collaboratorId = participant.collaboratorId
    share.updatedAt = now
    this.persist()
    return { share: cloneShare(share)!, participant: { ...participant } }
  }

  verifyInvite(args: {
    shareId: string
    inviteToken: string
    chatId?: string
    displayName: string
    publicKeyId: string
    now?: number
  }): VerifyInviteResult {
    const now = args.now ?? Date.now()
    const state = this.findInvite({
      shareId: args.shareId,
      inviteToken: args.inviteToken,
      chatId: args.chatId,
      publicKeyId: args.publicKeyId,
      displayName: args.displayName,
      now
    })

    if (!state.share || !state.share.enabled) {
      throw new Error('Collaboration share is not active.')
    }

    return {
      share: cloneShare(state.share)!,
      invite: { ...state.invite },
      existingParticipant: state.existingByKey ? { ...state.existingByKey } : null
    }
  }

  validateParticipantSession(args: {
    shareId: string
    chatId: string
    collaboratorId: string
    publicKeyId: string
  }): { share: HumanCollaborationShare; participant: HumanCollaboratorParticipant } {
    const share = this.memory.shares.find((candidate) => candidate.shareId === args.shareId)
    if (!share || !share.enabled) throw new Error('Collaboration share is not active.')
    if (share.chatId !== args.chatId) throw new Error('Collaboration share does not match chat.')
    const participant = share.participants.find(
      (candidate) => candidate.collaboratorId === args.collaboratorId
    )
    if (!participant || participant.status !== 'active') {
      throw new Error('Collaborator is not active for this share.')
    }
    if (participant.publicKeyId !== args.publicKeyId) {
      throw new Error('Collaborator identity does not match this session.')
    }
    return { share: cloneShare(share)!, participant: { ...participant } }
  }

  private findInvite(args: {
    shareId: string
    inviteToken: string
    chatId?: string
    publicKeyId: string
    displayName: string
    now: number
  }): {
    share: HumanCollaborationShare | null
    tokenHash: string
    invite: HumanCollaborationInvite
    existingByKey: HumanCollaboratorParticipant | null
  } {
    const share = this.memory.shares.find((candidate) => candidate.shareId === args.shareId)
    const displayNameNormalized = normalizeDisplayName(args.displayName)
    if (!share || !share.enabled) {
      return {
        share: null,
        tokenHash: hashInviteToken(args.inviteToken),
        invite: { inviteId: '', tokenHash: '', createdAt: args.now, expiresAt: args.now },
        existingByKey: null
      }
    }
    if (args.chatId && share.chatId !== args.chatId) {
      throw new Error('Collaboration share does not match chat.')
    }

    const existingByKey =
      share.participants.find((participant) => participant.publicKeyId === args.publicKeyId) || null
    if (existingByKey?.status === 'revoked') {
      throw new HumanCollaborationDenialError(
        'revoked',
        'Collaborator identity has been revoked for this share.'
      )
    }
    const activeCount =
      share.participants.filter((participant) => participant.status === 'active').length

    if (!existingByKey && activeCount >= MAX_ACTIVE_COLLABORATORS) {
      throw new HumanCollaborationDenialError(
        'quota_exceeded',
        'Collaboration share already has the maximum number of active collaborators.'
      )
    }

    const tokenHash = hashInviteToken(args.inviteToken)
    const invite = share.invites.find((candidate) => candidate.tokenHash === tokenHash)
    if (!invite) {
      throw new Error('Collaboration invite is invalid.')
    }
    if (invite.consumedAt) {
      throw new Error('Collaboration invite has already been used.')
    }
    if (invite.expiresAt <= args.now) {
      throw new Error('Collaboration invite has expired.')
    }

    if (!displayNameNormalized) {
      throw new Error('Display name is required.')
    }

    return { share, tokenHash, invite, existingByKey }
  }

  validateAppend(args: {
    shareId: string
    chatId: string
    collaboratorId: string
    clientMessageId: string
    /** P2b contribution intent; plain comment when omitted (v1 clients). */
    intent?: 'comment' | 'requestHostAction'
  }): { share: HumanCollaborationShare; participant: HumanCollaboratorParticipant; existingMessageId?: string } {
    const share = this.memory.shares.find((candidate) => candidate.shareId === args.shareId)
    if (!share) throw new HumanCollaborationDenialError('stale_session', 'Collaboration share is not active.')
    if (!share.enabled) throw new HumanCollaborationDenialError('revoked', 'Collaboration share is not active.')
    if (share.chatId !== args.chatId) {
      throw new HumanCollaborationDenialError('rule_denied', 'Collaboration share does not match chat.')
    }
    if (share.mode !== 'comments') {
      throw new HumanCollaborationDenialError('read_only', 'Collaboration share is read-only.')
    }
    // P2a: rules are evaluated in main before EVERY contribution action.
    // Rules can only narrow what `mode` already allowed (fail-closed).
    const rules = effectiveContributionRules(share)
    if (!rules.appendComment) {
      throw new HumanCollaborationDenialError('rule_denied', 'Collaboration share is read-only.')
    }
    if (args.intent === 'requestHostAction' && !rules.requestHostAction) {
      throw new HumanCollaborationDenialError(
        'rule_denied',
        'This share does not accept host-action requests.'
      )
    }
    if (
      rules.allowedCollaboratorIds &&
      rules.allowedCollaboratorIds.length > 0 &&
      !rules.allowedCollaboratorIds.includes(args.collaboratorId)
    ) {
      throw new HumanCollaborationDenialError(
        'rule_denied',
        'Collaborator is not allowed to contribute under the current rules.'
      )
    }
    const participant = share.participants.find(
      (candidate) => candidate.collaboratorId === args.collaboratorId
    )
    if (!participant || participant.status !== 'active') {
      throw new HumanCollaborationDenialError('revoked', 'Collaborator is not active for this share.')
    }
    const existingMessageId = share.idempotency[idempotencyKey(args.collaboratorId, args.clientMessageId)]
    return { share: cloneShare(share)!, participant: { ...participant }, existingMessageId }
  }

  recordAppend(args: {
    shareId: string
    chatId: string
    collaboratorId: string
    clientMessageId: string
    messageId: string
  }): number {
    const share = this.memory.shares.find((candidate) => candidate.shareId === args.shareId)
    if (!share) throw new HumanCollaborationDenialError('stale_session', 'Collaboration share is not active.')
    if (!share.enabled) throw new HumanCollaborationDenialError('revoked', 'Collaboration share is not active.')
    if (share.chatId !== args.chatId) {
      throw new HumanCollaborationDenialError('rule_denied', 'Collaboration share does not match chat.')
    }
    if (share.mode !== 'comments' || !effectiveContributionRules(share).appendComment) {
      throw new HumanCollaborationDenialError('read_only', 'Collaboration share is read-only.')
    }
    const participant = share.participants.find(
      (candidate) => candidate.collaboratorId === args.collaboratorId
    )
    if (!participant || participant.status !== 'active') {
      throw new HumanCollaborationDenialError('revoked', 'Collaborator is not active for this share.')
    }
    const sequence = share.nextSequence
    share.nextSequence += 1
    share.idempotency[idempotencyKey(args.collaboratorId, args.clientMessageId)] = args.messageId
    // Bound the idempotency map (string keys preserve insertion order, so
    // slice(0, excess) drops the OLDEST). Prevents unbounded growth + a
    // quadratic per-append persist cost under a flood of unique clientMessageIds.
    const keys = Object.keys(share.idempotency)
    if (keys.length > MAX_IDEMPOTENCY_ENTRIES) {
      for (const stale of keys.slice(0, keys.length - MAX_IDEMPOTENCY_ENTRIES)) {
        delete share.idempotency[stale]
      }
    }
    share.updatedAt = Date.now()
    this.persist()
    return sequence
  }

  private load(): HumanCollaborationSnapshot {
    if (!this.storagePath || !existsSync(this.storagePath)) return { shares: [] }
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as HumanCollaborationSnapshot
      return normalizeSnapshot(parsed)
    } catch {
      return { shares: [] }
    }
  }

  private persist(): void {
    if (!this.storagePath) return
    mkdirSync(dirname(this.storagePath), { recursive: true })
    const tmp = `${this.storagePath}.tmp`
    writeFileSync(tmp, JSON.stringify(normalizeSnapshot(this.memory), null, 2))
    renameSync(tmp, this.storagePath)
  }
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url')
}

function idempotencyKey(collaboratorId: string, clientMessageId: string): string {
  return `${collaboratorId}:${clientMessageId}`
}

// An invite is "dead" (safe to prune) once its expiry is more than the
// retention grace in the past — for BOTH consumed and unconsumed invites. An
// unconsumed invite can no longer admit anyone past its expiry, so it is just
// as dead as a consumed one; keeping it only leaks a stale relay seat on boot
// re-open. Not-yet-expired invites and consumed-but-recent ones (within the
// grace, for the ledger/UI) are kept.
function isDeadInvite(invite: HumanCollaborationInvite, now: number): boolean {
  return invite.expiresAt < now - CONSUMED_INVITE_RETENTION_MS
}

// Names a collaborator must not present as their own — the renderer/transcript
// host + assistant labels ("You", "Assistant", "Host") and the provider/system
// identities. Matched after collapsing to lowercase alphanumerics so affix
// variants ("the Host" -> "thehost", "Assistant " -> "assistant") are caught,
// while equality-after-stripping (not substring) keeps legit names like
// "Claudia"/"Yousef" untouched.
const RESERVED_DISPLAY_NAMES = new Set([
  'host',
  'thehost',
  'system',
  'guest',
  // The transcript renders a static "External" badge beside a collaborator's
  // name, so it is the single strongest trust label in this feature — and it is
  // also the default a nameless joiner arrives with. Reserving it stops a
  // collaborator presenting AS the badge (and stops the default rendering as
  // the tautological "External [External]"); an unnamed joiner becomes
  // "External (collaborator)", the same shape "Guest" produced before it.
  'external',
  'collaborator',
  'remote',
  'you',
  'user',
  'assistant',
  'bossman',
  'taskwraith',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'gemini',
  'pi'
])

/**
 * The ONE normalizer for a collaborator-supplied name. Exported because the
 * handshake needs it too: a reconnect never reaches `consumeInvite`, so without
 * this the raw client string reached the host's admission banner — the single
 * surface where the host makes the admit/reject call, and the one place a
 * reserved name like "TaskWraith" must never be presentable.
 */
export function normalizeDisplayName(value: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  const safe = trimmed.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').slice(0, 80)
  if (!safe) return 'Collaborator'
  const collapsed = safe.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (RESERVED_DISPLAY_NAMES.has(collapsed)) {
    return `${safe} (collaborator)`
  }
  return safe
}

function normalizeSnapshot(value: Partial<HumanCollaborationSnapshot>): HumanCollaborationSnapshot {
  return {
    shares: Array.isArray(value.shares)
      ? value.shares
          .filter((share): share is HumanCollaborationShare => Boolean(share?.shareId && share?.chatId))
          .map((share) => ({
            shareId: String(share.shareId),
            chatId: String(share.chatId),
            mode: share.mode === 'comments' ? 'comments' : 'readOnly',
            enabled: share.enabled !== false,
            createdAt: numberOrNow(share.createdAt),
            updatedAt: numberOrNow(share.updatedAt),
            nextSequence:
              typeof share.nextSequence === 'number' && share.nextSequence > 0
                ? Math.floor(share.nextSequence)
                : 1,
            participants: Array.isArray(share.participants)
              ? share.participants
                  .filter((participant) => Boolean(participant?.collaboratorId && participant?.publicKeyId))
                  .map((participant) => ({
                    collaboratorId: String(participant.collaboratorId),
                    displayName: normalizeDisplayName(participant.displayName),
                    publicKeyId: String(participant.publicKeyId),
                    status:
                      participant.status === 'active' || participant.status === 'revoked'
                        ? participant.status
                        : 'pending',
                    ...(typeof participant.joinedAt === 'number' ? { joinedAt: participant.joinedAt } : {}),
                    ...(typeof participant.revokedAt === 'number'
                      ? { revokedAt: participant.revokedAt }
                      : {}),
                    // Seat fields. A non-finite or negative order is DROPPED
                    // rather than coerced to 0 — coercing would silently move
                    // that person to the front of the turn queue, which is
                    // exactly the kind of quiet promotion nobody asked for.
                    ...(isSeatOrder(participant.seatOrder)
                      ? { seatOrder: participant.seatOrder }
                      : {}),
                    // Out-of-range palette indices are dropped, not clamped, so
                    // the renderer falls back to its pubkey-derived hue instead
                    // of honouring a request nobody legitimately made. Shares the
                    // ONE palette guard with the contacts store — hard-coding the
                    // bound here would silently keep rejecting a ninth hue.
                    ...(isContactColorIndex(participant.colorIndex)
                      ? { colorIndex: participant.colorIndex }
                      : {}),
                    ...(participant.seatDisabled === true ? { seatDisabled: true } : {})
                  }))
              : [],
            invites: Array.isArray(share.invites)
              ? share.invites
                  .filter((invite) => Boolean(invite?.inviteId && invite?.tokenHash))
                  .map((invite) => ({
                    inviteId: String(invite.inviteId),
                    tokenHash: String(invite.tokenHash),
                    createdAt: numberOrNow(invite.createdAt),
                    expiresAt: numberOrNow(invite.expiresAt),
                    ...(typeof invite.consumedAt === 'number' ? { consumedAt: invite.consumedAt } : {}),
                    ...(typeof invite.collaboratorId === 'string'
                      ? { collaboratorId: invite.collaboratorId }
                      : {}),
                    ...(typeof invite.roomId === 'string' ? { roomId: invite.roomId } : {})
                  }))
              : [],
            idempotency:
              share.idempotency && typeof share.idempotency === 'object'
                ? { ...share.idempotency }
                : {},
            // Fail-closed rules normalization: unknown/forged shapes degrade to
            // preset baselines, providerDispatch can never widen (P2a).
            ...(share.contributionRules
              ? (() => {
                  const rules = normalizeContributionRules(share.contributionRules)
                  return rules ? { contributionRules: rules } : {}
                })()
              : {}),
            // Strict `=== true`, so a truthy junk value from a hand-edited file
            // cannot switch host review on. This normaliser is an ALLOWLIST
            // rebuild applied on every read AND every write — a field missing
            // from it is silently dropped on load and permanently erased on the
            // next persist, with no error anywhere.
            ...(share.requiresHostApproval === true ? { requiresHostApproval: true } : {}),
            ...(share.fullHistory === true ? { fullHistory: true } : {})
          }))
      : []
  }
}

function numberOrNow(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
}

function cloneSnapshot(snapshot: HumanCollaborationSnapshot): HumanCollaborationSnapshot {
  return normalizeSnapshot(JSON.parse(JSON.stringify(snapshot)) as HumanCollaborationSnapshot)
}

function cloneShare(share: HumanCollaborationShare | null): HumanCollaborationShare | null {
  if (!share) return null
  return cloneSnapshot({ shares: [share] }).shares[0] || null
}
