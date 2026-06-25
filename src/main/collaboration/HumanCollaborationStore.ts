import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { createHash, randomBytes, randomUUID } from 'crypto'

export type HumanCollaborationMode = 'readOnly' | 'comments'
export type HumanCollaboratorStatus = 'pending' | 'active' | 'revoked'

export interface HumanCollaboratorParticipant {
  collaboratorId: string
  displayName: string
  publicKeyId: string
  status: HumanCollaboratorStatus
  joinedAt?: number
  revokedAt?: number
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

    share.mode = args.mode
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
    // Prune invites that are both consumed AND well past expiry (createShare is
    // the only place invites accrue), so the list can't grow without bound over
    // a long-lived share. A fresh/unconsumed/in-grace invite is always kept.
    share.invites = [...share.invites.filter((existingInvite) => !isDeadInvite(existingInvite, now)), invite]

    if (!existing) this.memory.shares.push(share)
    this.persist()
    return { share: cloneShare(share)!, invite: { ...invite }, inviteToken, roomId }
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
      throw new Error('Collaborator identity has been revoked for this share.')
    }
    const activeCount =
      share.participants.filter((participant) => participant.status === 'active').length

    if (!existingByKey && activeCount >= MAX_ACTIVE_COLLABORATORS) {
      throw new Error('Collaboration share already has the maximum number of active collaborators.')
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
  }): { share: HumanCollaborationShare; participant: HumanCollaboratorParticipant; existingMessageId?: string } {
    const share = this.memory.shares.find((candidate) => candidate.shareId === args.shareId)
    if (!share || !share.enabled) throw new Error('Collaboration share is not active.')
    if (share.chatId !== args.chatId) throw new Error('Collaboration share does not match chat.')
    if (share.mode !== 'comments') throw new Error('Collaboration share is read-only.')
    const participant = share.participants.find(
      (candidate) => candidate.collaboratorId === args.collaboratorId
    )
    if (!participant || participant.status !== 'active') {
      throw new Error('Collaborator is not active for this share.')
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
    if (!share || !share.enabled) throw new Error('Collaboration share is not active.')
    if (share.chatId !== args.chatId) throw new Error('Collaboration share does not match chat.')
    if (share.mode !== 'comments') throw new Error('Collaboration share is read-only.')
    const participant = share.participants.find(
      (candidate) => candidate.collaboratorId === args.collaboratorId
    )
    if (!participant || participant.status !== 'active') {
      throw new Error('Collaborator is not active for this share.')
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

// An invite is "dead" (safe to prune) once it has been consumed AND its expiry
// is more than the retention grace in the past. Unconsumed invites are kept
// until they expire and consumed-but-recent ones are kept through the grace.
function isDeadInvite(invite: HumanCollaborationInvite, now: number): boolean {
  if (typeof invite.consumedAt !== 'number') return false
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
  'gemini'
])

function normalizeDisplayName(value: string): string {
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
                      : {})
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
                : {}
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
