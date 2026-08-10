import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { basename, dirname, join } from 'path'

import {
  parseSignedChannelAgentDelegation,
  verifyChannelAgentDelegation,
  type SignedChannelAgentDelegation
} from '../../shared/collaboration/ChannelAgentProtocol'
import { importRawEd25519PublicKey } from '../../shared/e2ee/keys'

export const CHANNEL_SCHEMA_VERSION = 3
export const MAX_CHANNEL_MEMBERS = 8
export const DEFAULT_CHANNEL_INVITE_TTL_MS = 10 * 60 * 1000

export type ChannelErrorCode =
  | 'protocol_unsupported'
  | 'human_only'
  | 'not_member'
  | 'identity_mismatch'
  | 'revoked'
  | 'quota_exceeded'
  | 'idempotency_conflict'
  | 'invalid_cursor'
  | 'resync_required'
  | 'recovery_blocked'
  | 'host_unavailable'
  | 'channel_closed'

export class ChannelError extends Error {
  constructor(
    readonly code: ChannelErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ChannelError'
  }
}

export type ChannelStatus = 'active' | 'closed'
export type ChannelMemberStatus = 'pending' | 'active' | 'revoked'
export type ChannelMemberKind = 'human' | 'agent'
export type ChannelMessageKind = 'human.text' | 'agent.text'

/**
 * A reference intentionally identifies TaskWraith-owned state without copying
 * its content into the Channel store. P1 surfaces the immutable envelope even
 * when the referent is later unavailable.
 */
export type TaskWraithReference =
  | { kind: 'chat'; id: string }
  | { kind: 'message'; id: string }
  | { kind: 'run'; id: string }
  | { kind: 'artifact'; id: string }

export interface ChannelDisplayEnvelope {
  readonly title: string
  readonly status: ChannelStatus
  readonly memberCount: number
  readonly messageCount: number
}

export interface Channel {
  channelId: string
  chatId: string
  ownerMemberId: string
  status: ChannelStatus
  createdAt: number
  updatedAt: number
  membershipRevision: number
  messageCount: number
  reference?: TaskWraithReference
  display: ChannelDisplayEnvelope
}

interface ChannelMemberBase {
  memberId: string
  channelId: string
  kind: ChannelMemberKind
  displayName: string
  identityPublicKey: string
  status: ChannelMemberStatus
  roomId?: string
  joinedAt: number
  revokedAt?: number
}

export interface HumanChannelMember extends ChannelMemberBase {
  kind: 'human'
  roomId?: string
  agentSeatId?: never
  keyGeneration?: never
}

export interface AgentChannelMember extends ChannelMemberBase {
  kind: 'agent'
  roomId?: never
  /** Stable TaskWraith seat identity; never a provider session or run id. */
  agentSeatId: string
  /** Owner-delegated credential generation for this immutable membership. */
  keyGeneration: number
}

export type ChannelMember = HumanChannelMember | AgentChannelMember

export interface ChannelInvite {
  inviteId: string
  channelId: string
  roomId: string
  tokenHash: string
  createdAt: number
  expiresAt: number
  memberId?: string
  consumedAt?: number
  revokedAt?: number
}

export interface ChannelStoreSnapshot {
  schemaVersion: typeof CHANNEL_SCHEMA_VERSION
  channels: Channel[]
  members: ChannelMember[]
  invites: ChannelInvite[]
}

export interface ResolvedChannelReference<T> {
  reference?: TaskWraithReference
  display: ChannelDisplayEnvelope
  state: 'available' | 'referent unavailable'
  value?: T
}

const MAX_TITLE_LENGTH = 200
const MAX_DISPLAY_NAME_LENGTH = 120
const MAX_IDENTIFIER_LENGTH = 512

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function nowOr(args: { now?: number }): number {
  return args.now ?? Date.now()
}

function nonBlank(value: unknown, label: string, max = MAX_IDENTIFIER_LENGTH): string {
  if (typeof value !== 'string') {
    throw new ChannelError('protocol_unsupported', `${label} is required`)
  }
  const normalized = value.trim()
  if (!normalized || normalized.length > max) {
    throw new ChannelError('protocol_unsupported', `${label} is invalid`)
  }
  return normalized
}

function isReference(value: unknown): value is TaskWraithReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return (
    (raw.kind === 'chat' ||
      raw.kind === 'message' ||
      raw.kind === 'run' ||
      raw.kind === 'artifact') &&
    typeof raw.id === 'string' &&
    Boolean(raw.id.trim()) &&
    raw.id.length <= MAX_IDENTIFIER_LENGTH &&
    Object.keys(raw).length === 2
  )
}

function isChannelStatus(value: unknown): value is ChannelStatus {
  return value === 'active' || value === 'closed'
}

function isMemberStatus(value: unknown): value is ChannelMemberStatus {
  return value === 'pending' || value === 'active' || value === 'revoked'
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function validBoundedIdentifier(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.trim() !== value
  ) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function validAgentPublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false
  try {
    const raw = Buffer.from(value, 'base64')
    if (raw.length !== 32 || raw.toString('base64') !== value) return false
    importRawEd25519PublicKey(raw)
    return true
  } catch {
    return false
  }
}

function buildEnvelope(
  channel: Pick<Channel, 'display' | 'status' | 'messageCount'>,
  memberCount: number
): ChannelDisplayEnvelope {
  return {
    title: channel.display.title,
    status: channel.status,
    memberCount,
    messageCount: channel.messageCount
  }
}

export function hashChannelInviteToken(token: string): string {
  return createHash('sha256').update(String(token), 'utf8').digest('hex')
}

function tokenHashMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashChannelInviteToken(token), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/**
 * Main-owned metadata authority for the Channels P1 substrate. It deliberately
 * owns no transport, IPC, renderer state, provider history, or agent action.
 */
export class ChannelStore {
  private snapshot: ChannelStoreSnapshot = {
    schemaVersion: CHANNEL_SCHEMA_VERSION,
    channels: [],
    members: [],
    invites: []
  }
  private recoveryBlocked = false
  /** Per-channel isolation when one channel's display envelope drifts on disk. */
  private channelRecoveryBlocked = new Set<string>()

  constructor(private readonly storagePath?: string) {
    this.snapshot = this.load()
  }

  createChannel(args: {
    chatId: string
    owner: { displayName: string; identityPublicKey: string }
    title: string
    reference?: TaskWraithReference
    now?: number
  }): { channel: Channel; owner: HumanChannelMember } {
    this.assertHealthy()
    const chatId = nonBlank(args.chatId, 'chat id')
    if (this.snapshot.channels.some((channel) => channel.chatId === chatId)) {
      throw new ChannelError('protocol_unsupported', 'A Channel already exists for this chat')
    }
    const createdAt = nowOr(args)
    const title = nonBlank(args.title, 'title', MAX_TITLE_LENGTH)
    if (args.reference !== undefined && !isReference(args.reference)) {
      throw new ChannelError('protocol_unsupported', 'reference is invalid')
    }

    const channelId = randomUUID()
    const owner: HumanChannelMember = {
      memberId: randomUUID(),
      channelId,
      kind: 'human',
      displayName: nonBlank(args.owner.displayName, 'display name', MAX_DISPLAY_NAME_LENGTH),
      identityPublicKey: nonBlank(args.owner.identityPublicKey, 'identity public key'),
      status: 'active',
      joinedAt: createdAt
    }
    const channel: Channel = {
      channelId,
      chatId,
      ownerMemberId: owner.memberId,
      status: 'active',
      createdAt,
      updatedAt: createdAt,
      membershipRevision: 1,
      messageCount: 0,
      ...(args.reference ? { reference: clone(args.reference) } : {}),
      display: { title, status: 'active', memberCount: 1, messageCount: 0 }
    }

    this.snapshot.channels.push(channel)
    this.snapshot.members.push(owner)
    this.persist()
    return { channel: clone(channel), owner: clone(owner) }
  }

  listChannels(): Channel[] {
    this.assertHealthy()
    return this.snapshot.channels.map((channel) => clone(channel))
  }

  getChannel(channelId: string): Channel | null {
    return clone(this.findChannel(channelId) ?? null)
  }

  getMember(channelId: string, memberId: string): ChannelMember | null {
    return clone(
      this.snapshot.members.find(
        (member) => member.channelId === channelId && member.memberId === memberId
      ) ?? null
    )
  }

  findMemberByIdentity(channelId: string, identityPublicKey: string): ChannelMember | null {
    const identity = nonBlank(identityPublicKey, 'identity public key')
    return clone(
      this.snapshot.members.find(
        (member) => member.channelId === channelId && member.identityPublicKey === identity
      ) ?? null
    )
  }

  listMembers(channelId: string): ChannelMember[] {
    return this.snapshot.members
      .filter((member) => member.channelId === channelId)
      .map((member) => clone(member))
  }

  createInvite(args: { channelId: string; now?: number; ttlMs?: number }): {
    invite: ChannelInvite
    inviteToken: string
  } {
    const channel = this.requireActiveChannel(args.channelId)
    const now = nowOr(args)
    this.expirePendingAdmissions(channel, now)
    const ttlMs = args.ttlMs ?? DEFAULT_CHANNEL_INVITE_TTL_MS
    if (!Number.isFinite(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60 * 1000) {
      throw new ChannelError('quota_exceeded', 'Invite lifetime is invalid')
    }
    const inviteToken = randomBytes(24).toString('base64url')
    const invite: ChannelInvite = {
      inviteId: randomUUID(),
      channelId: channel.channelId,
      roomId: randomUUID(),
      tokenHash: hashChannelInviteToken(inviteToken),
      createdAt: now,
      expiresAt: now + ttlMs
    }
    this.snapshot.invites.push(invite)
    this.persist()
    return { invite: clone(invite), inviteToken }
  }

  getInvite(channelId: string, inviteId: string): ChannelInvite | null {
    return clone(
      this.snapshot.invites.find(
        (invite) => invite.channelId === channelId && invite.inviteId === inviteId
      ) ?? null
    )
  }

  listInvites(channelId: string): ChannelInvite[] {
    return this.snapshot.invites
      .filter((invite) => invite.channelId === channelId)
      .map((invite) => clone(invite))
  }

  beginMemberAdmission(args: {
    channelId: string
    inviteId: string
    inviteToken: string
    roomId: string
    displayName: string
    identityPublicKey: string
    now?: number
  }): { invite: ChannelInvite; member: HumanChannelMember } {
    const channel = this.requireActiveChannel(args.channelId)
    const now = nowOr(args)
    this.expirePendingAdmissions(channel, now)
    const invite = this.requireUsableInvite({
      channelId: channel.channelId,
      inviteId: args.inviteId,
      inviteToken: args.inviteToken,
      roomId: args.roomId,
      now
    })
    const identityPublicKey = nonBlank(args.identityPublicKey, 'identity public key')
    const existing = this.snapshot.members.find(
      (member) =>
        member.channelId === channel.channelId && member.identityPublicKey === identityPublicKey
    )
    if (existing) {
      if (existing.status === 'revoked') {
        throw new ChannelError('revoked', 'This pinned identity has been revoked')
      }
      if (
        existing.status === 'pending' &&
        existing.memberId === invite.memberId &&
        existing.roomId === invite.roomId
      ) {
        return { invite: clone(invite), member: clone(existing) }
      }
      throw new ChannelError(
        'identity_mismatch',
        'This identity is already bound; use pinned reconnect'
      )
    }
    if (invite.memberId) {
      throw new ChannelError('revoked', 'Invite is already bound to another admission')
    }
    if (this.seatHoldingMembers(channel.channelId).length >= MAX_CHANNEL_MEMBERS) {
      throw new ChannelError('quota_exceeded', 'Channel member limit reached')
    }

    const member: HumanChannelMember = {
      memberId: randomUUID(),
      channelId: channel.channelId,
      kind: 'human',
      displayName: nonBlank(args.displayName, 'display name', MAX_DISPLAY_NAME_LENGTH),
      identityPublicKey,
      status: 'pending',
      roomId: invite.roomId,
      joinedAt: now
    }
    invite.memberId = member.memberId
    this.snapshot.members.push(member)
    this.bumpMembership(channel, now)
    this.persist()
    return { invite: clone(invite), member: clone(member) }
  }

  confirmMemberAdmission(args: {
    channelId: string
    inviteId: string
    memberId: string
    now?: number
  }): HumanChannelMember {
    const channel = this.requireActiveChannel(args.channelId)
    const invite = this.requireInvite(channel.channelId, args.inviteId)
    const member = this.requireHumanMember(channel.channelId, args.memberId)
    if (invite.memberId !== member.memberId || !member.roomId || member.roomId !== invite.roomId) {
      throw new ChannelError('identity_mismatch', 'Admission is not bound to this invite room')
    }
    if (member.status === 'revoked' || invite.revokedAt !== undefined) {
      throw new ChannelError('revoked', 'Admission was revoked')
    }
    if (member.status === 'active' && invite.consumedAt !== undefined) return clone(member)
    if (member.status !== 'pending' || invite.consumedAt !== undefined) {
      throw new ChannelError('protocol_unsupported', 'Admission is not pending')
    }
    const now = nowOr(args)
    if (invite.expiresAt <= now) {
      this.failMemberAdmission({
        channelId: channel.channelId,
        inviteId: invite.inviteId,
        memberId: member.memberId,
        now
      })
      throw new ChannelError('revoked', 'Invite expired before confirmation')
    }

    member.status = 'active'
    member.joinedAt = now
    invite.consumedAt = now
    this.bumpMembership(channel, now)
    this.persist()
    return clone(member)
  }

  failMemberAdmission(args: {
    channelId: string
    inviteId: string
    memberId: string
    now?: number
  }): HumanChannelMember {
    const channel = this.requireActiveChannel(args.channelId)
    const invite = this.requireInvite(channel.channelId, args.inviteId)
    const member = this.requireHumanMember(channel.channelId, args.memberId)
    if (invite.memberId !== member.memberId) {
      throw new ChannelError('identity_mismatch', 'Admission is not bound to this invite')
    }
    if (member.status === 'revoked') return clone(member)
    const now = nowOr(args)
    member.status = 'revoked'
    member.revokedAt = now
    invite.revokedAt = now
    this.bumpMembership(channel, now)
    this.persist()
    return clone(member)
  }

  /**
   * Direct main-only helper retained for deterministic store/log tests. Remote
   * sessions must use the pending invite + SAS transition above.
   */
  admitMember(args: {
    channelId: string
    displayName: string
    identityPublicKey: string
    roomId: string
    now?: number
  }): HumanChannelMember {
    const channel = this.requireActiveChannel(args.channelId)
    const identityPublicKey = nonBlank(args.identityPublicKey, 'identity public key')
    const existing = this.snapshot.members.find(
      (member) =>
        member.channelId === channel.channelId && member.identityPublicKey === identityPublicKey
    )
    if (existing) {
      if (existing.kind !== 'human') {
        throw new ChannelError('identity_mismatch', 'This identity belongs to an agent member')
      }
      if (existing.status === 'revoked') {
        throw new ChannelError('revoked', 'This pinned identity has been revoked')
      }
      return clone(existing)
    }
    if (this.seatHoldingMembers(channel.channelId).length >= MAX_CHANNEL_MEMBERS) {
      throw new ChannelError('quota_exceeded', 'Channel member limit reached')
    }
    const roomId = nonBlank(args.roomId, 'room id')
    if (
      this.snapshot.members.some((member) => member.roomId === roomId) ||
      this.snapshot.invites.some((invite) => invite.roomId === roomId)
    ) {
      throw new ChannelError('identity_mismatch', 'Relay room is already bound')
    }

    const admitted: HumanChannelMember = {
      memberId: randomUUID(),
      channelId: channel.channelId,
      kind: 'human',
      displayName: nonBlank(args.displayName, 'display name', MAX_DISPLAY_NAME_LENGTH),
      identityPublicKey,
      status: 'active',
      roomId,
      joinedAt: nowOr(args)
    }
    this.snapshot.members.push(admitted)
    this.bumpMembership(channel, admitted.joinedAt)
    this.persist()
    return clone(admitted)
  }

  /**
   * Main-only membership transition for a delegation already committed to the
   * Channel agent authority store. Relay and renderer inputs never reach this
   * method. The immutable member binds a stable seat to one key generation;
   * later delegations may reuse that exact binding without rewriting it.
   */
  registerAgentMember(args: {
    channelId: string
    displayName: string
    signedDelegation: SignedChannelAgentDelegation
    now?: number
  }): AgentChannelMember {
    const channel = this.requireActiveChannel(args.channelId)
    const signed = parseSignedChannelAgentDelegation(args.signedDelegation)
    if (!signed || !signed.delegation.scopes.includes('channel.post')) {
      throw new ChannelError('protocol_unsupported', 'Agent membership delegation is invalid')
    }
    const delegation = signed.delegation
    if (
      delegation.channelId !== channel.channelId ||
      delegation.ownerMemberId !== channel.ownerMemberId
    ) {
      throw new ChannelError('identity_mismatch', 'Agent delegation has the wrong Channel root')
    }
    const owner = this.requireHumanMember(channel.channelId, channel.ownerMemberId)
    let verified: ReturnType<typeof verifyChannelAgentDelegation>
    try {
      const ownerPublicKey = importRawEd25519PublicKey(
        Buffer.from(owner.identityPublicKey, 'base64')
      )
      verified = verifyChannelAgentDelegation(ownerPublicKey, signed, delegation.notBefore)
    } catch {
      throw new ChannelError('identity_mismatch', 'Pinned Channel owner identity is invalid')
    }
    if (!verified.ok) {
      throw new ChannelError('identity_mismatch', 'Agent delegation signature is invalid')
    }
    const existingById = this.snapshot.members.find(
      (member) => member.memberId === delegation.agentMemberId
    )
    if (existingById) {
      if (
        existingById.channelId !== channel.channelId ||
        existingById.kind !== 'agent' ||
        existingById.agentSeatId !== delegation.agentSeatId ||
        existingById.identityPublicKey !== delegation.agentPublicKeyB64 ||
        existingById.keyGeneration !== delegation.keyGeneration
      ) {
        throw new ChannelError('identity_mismatch', 'Agent member id has another binding')
      }
      if (existingById.status === 'revoked') {
        throw new ChannelError('revoked', 'Agent membership has been revoked')
      }
      return clone(existingById)
    }

    const joinedAt = nowOr(args)
    if (
      !validTimestamp(joinedAt) ||
      !Number.isSafeInteger(joinedAt) ||
      joinedAt < delegation.issuedAt
    ) {
      throw new ChannelError('protocol_unsupported', 'Agent membership timestamp is invalid')
    }
    if (joinedAt >= delegation.expiresAt) {
      throw new ChannelError('revoked', 'Agent membership delegation has expired')
    }

    const sameSeat = this.snapshot.members.filter(
      (member): member is AgentChannelMember =>
        member.channelId === channel.channelId &&
        member.kind === 'agent' &&
        member.agentSeatId === delegation.agentSeatId
    )
    if (sameSeat.some((member) => member.status !== 'revoked')) {
      throw new ChannelError('identity_mismatch', 'Agent seat already has an active membership')
    }
    if (sameSeat.length === 0 && delegation.keyGeneration !== 1) {
      throw new ChannelError('identity_mismatch', 'First agent membership generation must be one')
    }
    if (sameSeat.length > 0) {
      const maximumGeneration = Math.max(...sameSeat.map((member) => member.keyGeneration))
      if (delegation.keyGeneration !== maximumGeneration + 1) {
        throw new ChannelError('identity_mismatch', 'Agent membership generation is not contiguous')
      }
    }
    if (
      this.snapshot.members.some(
        (member) =>
          member.channelId === channel.channelId &&
          member.identityPublicKey === delegation.agentPublicKeyB64
      )
    ) {
      throw new ChannelError('identity_mismatch', 'Agent key is already pinned to a member')
    }
    if (this.seatHoldingMembers(channel.channelId).length >= MAX_CHANNEL_MEMBERS) {
      throw new ChannelError('quota_exceeded', 'Channel member limit reached')
    }

    const admitted: AgentChannelMember = {
      memberId: delegation.agentMemberId,
      channelId: channel.channelId,
      kind: 'agent',
      displayName: nonBlank(args.displayName, 'display name', MAX_DISPLAY_NAME_LENGTH),
      identityPublicKey: delegation.agentPublicKeyB64,
      status: 'active',
      agentSeatId: delegation.agentSeatId,
      keyGeneration: delegation.keyGeneration,
      joinedAt
    }
    this.snapshot.members.push(admitted)
    this.bumpMembership(channel, joinedAt)
    this.persist()
    return clone(admitted)
  }

  revokeMember(args: { channelId: string; memberId: string; now?: number }): ChannelMember {
    const channel = this.requireActiveChannel(args.channelId)
    const member = this.requireMember(channel.channelId, args.memberId)
    if (member.memberId === channel.ownerMemberId) {
      throw new ChannelError(
        'protocol_unsupported',
        'The Channel owner cannot be revoked individually'
      )
    }
    if (member.status === 'revoked') return clone(member)

    member.status = 'revoked'
    member.revokedAt = nowOr(args)
    const invite = this.snapshot.invites.find(
      (candidate) =>
        candidate.channelId === channel.channelId && candidate.memberId === member.memberId
    )
    if (invite && invite.revokedAt === undefined) invite.revokedAt = member.revokedAt
    this.bumpMembership(channel, member.revokedAt)
    this.persist()
    return clone(member)
  }

  closeChannel(args: { channelId: string; now?: number }): Channel {
    this.assertHealthy()
    const channel = this.requireChannel(args.channelId)
    if (channel.status === 'closed') return clone(channel)
    channel.status = 'closed'
    channel.updatedAt = nowOr(args)
    for (const invite of this.snapshot.invites) {
      if (
        invite.channelId === channel.channelId &&
        invite.consumedAt === undefined &&
        invite.revokedAt === undefined
      ) {
        invite.revokedAt = channel.updatedAt
      }
    }
    channel.display = buildEnvelope(channel, this.activeMembers(channel.channelId).length)
    this.persist()
    return clone(channel)
  }

  /**
   * Explicit whole-Channel erasure. The caller must delete the corresponding
   * append log and audit rows first; metadata is intentionally the final
   * durable ownership record removed so a crash can retry from channel ids.
   */
  purgeChannels(channelIds: readonly string[]): string[] {
    this.assertHealthy()
    const requested = new Set(channelIds.map((channelId) => nonBlank(channelId, 'channel id')))
    const purgedChannelIds = this.snapshot.channels
      .filter((channel) => requested.has(channel.channelId))
      .map((channel) => channel.channelId)
    if (requested.size > 0) this.removeStaleTemporaryFiles()
    if (purgedChannelIds.length === 0) return []

    const purged = new Set(purgedChannelIds)
    const previous = this.snapshot
    this.snapshot = {
      schemaVersion: CHANNEL_SCHEMA_VERSION,
      channels: previous.channels.filter((channel) => !purged.has(channel.channelId)),
      members: previous.members.filter((member) => !purged.has(member.channelId)),
      invites: previous.invites.filter((invite) => !purged.has(invite.channelId))
    }
    try {
      this.persist()
    } catch (error) {
      this.snapshot = previous
      throw error
    }
    for (const channelId of purged) this.channelRecoveryBlocked.delete(channelId)
    return purgedChannelIds
  }

  purgeAllChannels(): string[] {
    this.assertHealthy()
    this.removeStaleTemporaryFiles()
    return this.purgeChannels(this.snapshot.channels.map((channel) => channel.channelId))
  }

  /**
   * Resolves a principal supplied out-of-band by main. Inbound append bodies
   * never nominate their own author or room.
   */
  validateMemberSession(args: {
    channelId: string
    memberId: string
    identityPublicKey: string
    roomId?: string
  }): HumanChannelMember {
    const channel = this.requireActiveChannel(args.channelId)
    const member = this.requireMember(channel.channelId, args.memberId)
    if (member.status === 'revoked') throw new ChannelError('revoked', 'Member is revoked')
    if (member.status !== 'active') {
      throw new ChannelError('not_member', 'Member admission is not active')
    }
    if (member.kind !== 'human') {
      throw new ChannelError('human_only', 'Relay sessions are human-only')
    }
    if (member.identityPublicKey !== nonBlank(args.identityPublicKey, 'identity public key')) {
      throw new ChannelError('identity_mismatch', 'Pinned identity does not match this member')
    }

    if (member.memberId === channel.ownerMemberId) {
      if (args.roomId !== undefined) {
        throw new ChannelError('identity_mismatch', 'Host member does not have a relay room')
      }
    } else if (member.roomId !== nonBlank(args.roomId, 'room id')) {
      throw new ChannelError('identity_mismatch', 'Session is not bound to this member room')
    }
    return clone(member)
  }

  /** Called only after a complete durable log record has been committed. */
  recordCommittedMessage(channelId: string, sequence: number, now = Date.now()): Channel {
    const channel = this.requireActiveChannel(channelId)
    if (!Number.isInteger(sequence) || sequence < 1) {
      throw new ChannelError('recovery_blocked', 'Committed sequence is invalid')
    }
    if (sequence <= channel.messageCount) return clone(channel)
    if (sequence !== channel.messageCount + 1) {
      throw new ChannelError('recovery_blocked', 'Channel metadata sequence has a gap')
    }
    channel.messageCount = sequence
    channel.updatedAt = now
    channel.display = buildEnvelope(channel, this.activeMembers(channel.channelId).length)
    this.persist()
    return clone(channel)
  }

  /**
   * The append log is authoritative. A valid log may be ahead when main died
   * after fsync but before the metadata rewrite; metadata may never be ahead.
   */
  reconcileMessageCount(channelId: string, highWaterSequence: number, now = Date.now()): Channel {
    const channel = this.requireChannel(channelId)
    if (!Number.isInteger(highWaterSequence) || highWaterSequence < 0) {
      throw new ChannelError('recovery_blocked', 'Recovered sequence is invalid')
    }
    if (channel.messageCount > highWaterSequence) {
      throw new ChannelError('recovery_blocked', 'Channel metadata is ahead of durable history')
    }
    if (channel.messageCount === highWaterSequence) return clone(channel)
    channel.messageCount = highWaterSequence
    channel.updatedAt = Math.max(channel.updatedAt, now)
    channel.display = buildEnvelope(channel, this.activeMembers(channel.channelId).length)
    this.persist()
    return clone(channel)
  }

  getDisplayEnvelope(channelId: string): ChannelDisplayEnvelope {
    const channel = this.requireChannel(channelId)
    return clone(buildEnvelope(channel, this.activeMembers(channel.channelId).length))
  }

  resolveReference<T>(
    channelId: string,
    resolver: (reference: TaskWraithReference) => T | undefined
  ): ResolvedChannelReference<T> {
    const channel = this.requireChannel(channelId)
    const display = this.getDisplayEnvelope(channelId)
    if (!channel.reference) return { display, state: 'referent unavailable' }
    const value = resolver(clone(channel.reference))
    return value === undefined
      ? { reference: clone(channel.reference), display, state: 'referent unavailable' }
      : { reference: clone(channel.reference), display, state: 'available', value }
  }

  private activeMembers(channelId: string): ChannelMember[] {
    return this.snapshot.members.filter(
      (member) => member.channelId === channelId && member.status === 'active'
    )
  }

  private seatHoldingMembers(channelId: string): ChannelMember[] {
    return this.snapshot.members.filter(
      (member) => member.channelId === channelId && member.status !== 'revoked'
    )
  }

  private bumpMembership(channel: Channel, now: number): void {
    channel.membershipRevision += 1
    channel.updatedAt = now
    channel.display = buildEnvelope(channel, this.activeMembers(channel.channelId).length)
  }

  private expirePendingAdmissions(channel: Channel, now: number): void {
    let changed = false
    for (const invite of this.snapshot.invites) {
      if (
        invite.channelId !== channel.channelId ||
        invite.expiresAt > now ||
        invite.consumedAt !== undefined ||
        invite.revokedAt !== undefined ||
        !invite.memberId
      ) {
        continue
      }
      const member = this.snapshot.members.find(
        (candidate) =>
          candidate.channelId === channel.channelId && candidate.memberId === invite.memberId
      )
      if (member?.status === 'pending') {
        member.status = 'revoked'
        member.revokedAt = now
        invite.revokedAt = now
        changed = true
      }
    }
    if (changed) {
      this.bumpMembership(channel, now)
      this.persist()
    }
  }

  private requireUsableInvite(args: {
    channelId: string
    inviteId: string
    inviteToken: string
    roomId: string
    now: number
  }): ChannelInvite {
    const invite = this.requireInvite(args.channelId, args.inviteId)
    if (invite.roomId !== nonBlank(args.roomId, 'room id')) {
      throw new ChannelError('identity_mismatch', 'Invite is not bound to this relay room')
    }
    if (
      invite.revokedAt !== undefined ||
      invite.consumedAt !== undefined ||
      invite.expiresAt <= args.now
    ) {
      throw new ChannelError('revoked', 'Invite is expired, consumed, or revoked')
    }
    if (!tokenHashMatches(nonBlank(args.inviteToken, 'invite token'), invite.tokenHash)) {
      throw new ChannelError('identity_mismatch', 'Invite proof is invalid')
    }
    return invite
  }

  private findChannel(channelId: string): Channel | undefined {
    return this.snapshot.channels.find((channel) => channel.channelId === channelId)
  }

  private requireChannel(channelId: string): Channel {
    this.assertHealthy()
    const id = nonBlank(channelId, 'channel id')
    if (this.channelRecoveryBlocked.has(id)) {
      throw new ChannelError('recovery_blocked', 'Channel metadata could not be recovered safely')
    }
    const channel = this.findChannel(id)
    if (!channel) throw new ChannelError('not_member', 'Channel was not found')
    return channel
  }

  private requireActiveChannel(channelId: string): Channel {
    const channel = this.requireChannel(channelId)
    if (channel.status !== 'active') throw new ChannelError('channel_closed', 'Channel is closed')
    return channel
  }

  private requireMember(channelId: string, memberId: string): ChannelMember {
    const member = this.snapshot.members.find(
      (candidate) => candidate.channelId === channelId && candidate.memberId === memberId
    )
    if (!member) throw new ChannelError('not_member', 'Member was not found')
    return member
  }

  private requireHumanMember(channelId: string, memberId: string): HumanChannelMember {
    const member = this.requireMember(channelId, memberId)
    if (member.kind !== 'human') {
      throw new ChannelError('human_only', 'Relay admissions are human-only')
    }
    return member
  }

  private requireInvite(channelId: string, inviteId: string): ChannelInvite {
    const id = nonBlank(inviteId, 'invite id')
    const invite = this.snapshot.invites.find(
      (candidate) => candidate.channelId === channelId && candidate.inviteId === id
    )
    if (!invite) throw new ChannelError('not_member', 'Invite was not found')
    return invite
  }

  private assertHealthy(): void {
    if (this.recoveryBlocked) {
      throw new ChannelError('recovery_blocked', 'Channel metadata could not be recovered safely')
    }
  }

  private load(): ChannelStoreSnapshot {
    if (!this.storagePath || !existsSync(this.storagePath)) {
      return {
        schemaVersion: CHANNEL_SCHEMA_VERSION,
        channels: [],
        members: [],
        invites: []
      }
    }
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as unknown
      const result = normalizeSnapshot(parsed)
      if (!result) throw new Error('invalid snapshot')
      for (const channelId of result.driftedChannelIds) {
        this.channelRecoveryBlocked.add(channelId)
      }
      return result.snapshot
    } catch {
      this.recoveryBlocked = true
      return {
        schemaVersion: CHANNEL_SCHEMA_VERSION,
        channels: [],
        members: [],
        invites: []
      }
    }
  }

  private persist(): void {
    if (!this.storagePath) return
    mkdirSync(dirname(this.storagePath), { recursive: true })
    const temporary = `${this.storagePath}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(this.snapshot), { encoding: 'utf8', mode: 0o600 })
    const descriptor = openSync(temporary, 'r')
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporary, this.storagePath)
    this.syncStorageDirectory()
  }

  private removeStaleTemporaryFiles(): void {
    if (!this.storagePath) return
    const directory = dirname(this.storagePath)
    if (!existsSync(directory)) return
    const prefix = `${basename(this.storagePath)}.`
    let deleted = false
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.tmp')) {
        continue
      }
      unlinkSync(join(directory, entry.name))
      deleted = true
    }
    if (deleted) this.syncStorageDirectory()
  }

  private syncStorageDirectory(): void {
    if (!this.storagePath) return
    try {
      const directoryDescriptor = openSync(dirname(this.storagePath), 'r')
      try {
        fsyncSync(directoryDescriptor)
      } finally {
        closeSync(directoryDescriptor)
      }
    } catch {
      // Some platforms do not allow directory fsync. The file itself is synced.
    }
  }
}

function hasInvalidAgentSeatHistory(members: readonly AgentChannelMember[]): boolean {
  const bySeat = new Map<string, AgentChannelMember[]>()
  for (const member of members) {
    const entries = bySeat.get(member.agentSeatId) ?? []
    entries.push(member)
    bySeat.set(member.agentSeatId, entries)
  }
  for (const entries of bySeat.values()) {
    entries.sort((left, right) => left.keyGeneration - right.keyGeneration)
    const publicKeys = new Set<string>()
    for (let index = 0; index < entries.length; index += 1) {
      const member = entries[index]!
      if (member.keyGeneration !== index + 1 || publicKeys.has(member.identityPublicKey)) {
        return true
      }
      publicKeys.add(member.identityPublicKey)
      const next = entries[index + 1]
      if (next && (member.status !== 'revoked' || member.revokedAt! > next.joinedAt)) return true
    }
    if (entries.slice(0, -1).some((member) => member.status !== 'revoked')) return true
  }
  return false
}

function normalizeSnapshot(
  value: unknown
): { snapshot: ChannelStoreSnapshot; driftedChannelIds: string[] } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const schemaVersion = raw.schemaVersion
  if (
    (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== CHANNEL_SCHEMA_VERSION) ||
    !Array.isArray(raw.channels) ||
    !Array.isArray(raw.members) ||
    (schemaVersion !== 1 && !Array.isArray(raw.invites))
  ) {
    return null
  }

  const channels: Channel[] = []
  const channelIds = new Set<string>()
  const chatIds = new Set<string>()
  const driftedChannelIds: string[] = []
  for (const candidate of raw.channels) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
    const channel = candidate as Record<string, unknown>
    if (
      typeof channel.channelId !== 'string' ||
      !channel.channelId ||
      channelIds.has(channel.channelId) ||
      typeof channel.chatId !== 'string' ||
      !channel.chatId ||
      chatIds.has(channel.chatId) ||
      typeof channel.ownerMemberId !== 'string' ||
      !channel.ownerMemberId ||
      !isChannelStatus(channel.status) ||
      !validTimestamp(channel.createdAt) ||
      !validTimestamp(channel.updatedAt) ||
      !Number.isInteger(channel.membershipRevision) ||
      (channel.membershipRevision as number) < 1 ||
      !Number.isInteger(channel.messageCount) ||
      (channel.messageCount as number) < 0 ||
      !channel.display ||
      typeof channel.display !== 'object' ||
      Array.isArray(channel.display)
    ) {
      return null
    }
    const display = channel.display as Record<string, unknown>
    const envelopeValid =
      typeof display.title === 'string' &&
      Boolean(display.title) &&
      display.title.length <= MAX_TITLE_LENGTH &&
      display.status === channel.status &&
      Number.isInteger(display.memberCount) &&
      (display.memberCount as number) >= 0 &&
      Number.isInteger(display.messageCount) &&
      display.messageCount === channel.messageCount &&
      (channel.reference === undefined || isReference(channel.reference))
    if (!envelopeValid) {
      driftedChannelIds.push(channel.channelId)
      continue
    }
    channelIds.add(channel.channelId)
    chatIds.add(channel.chatId)
    channels.push({
      channelId: channel.channelId,
      chatId: channel.chatId,
      ownerMemberId: channel.ownerMemberId,
      status: channel.status,
      createdAt: channel.createdAt as number,
      updatedAt: channel.updatedAt as number,
      membershipRevision: channel.membershipRevision as number,
      messageCount: channel.messageCount as number,
      ...(channel.reference ? { reference: clone(channel.reference as TaskWraithReference) } : {}),
      display: {
        title: display.title as string,
        status: display.status as ChannelStatus,
        memberCount: display.memberCount as number,
        messageCount: display.messageCount as number
      }
    })
  }

  const driftedSet = new Set(driftedChannelIds)
  const members: ChannelMember[] = []
  const memberIds = new Set<string>()
  const memberRoomIds = new Set<string>()
  for (const candidate of raw.members) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
    const member = candidate as Record<string, unknown>
    if (typeof member.channelId === 'string' && driftedSet.has(member.channelId)) continue
    if (
      typeof member.memberId !== 'string' ||
      !member.memberId ||
      memberIds.has(member.memberId) ||
      typeof member.channelId !== 'string' ||
      !channelIds.has(member.channelId) ||
      typeof member.displayName !== 'string' ||
      !member.displayName ||
      member.displayName.length > MAX_DISPLAY_NAME_LENGTH ||
      typeof member.identityPublicKey !== 'string' ||
      !member.identityPublicKey ||
      !isMemberStatus(member.status) ||
      !validTimestamp(member.joinedAt) ||
      (member.roomId !== undefined && (typeof member.roomId !== 'string' || !member.roomId)) ||
      (member.revokedAt !== undefined && !validTimestamp(member.revokedAt))
    ) {
      return null
    }
    let normalized: ChannelMember
    if (member.kind === 'human') {
      if (member.agentSeatId !== undefined || member.keyGeneration !== undefined) return null
      normalized = {
        memberId: member.memberId,
        channelId: member.channelId,
        kind: 'human',
        displayName: member.displayName,
        identityPublicKey: member.identityPublicKey,
        status: member.status,
        ...(member.roomId ? { roomId: member.roomId } : {}),
        joinedAt: member.joinedAt,
        ...(member.revokedAt !== undefined ? { revokedAt: member.revokedAt } : {})
      }
    } else if (
      member.kind === 'agent' &&
      schemaVersion === CHANNEL_SCHEMA_VERSION &&
      validBoundedIdentifier(member.memberId) &&
      member.status !== 'pending' &&
      member.roomId === undefined &&
      validBoundedIdentifier(member.agentSeatId) &&
      validAgentPublicKey(member.identityPublicKey) &&
      Number.isSafeInteger(member.keyGeneration) &&
      (member.keyGeneration as number) >= 1 &&
      Number.isSafeInteger(member.joinedAt) &&
      (member.revokedAt === undefined || Number.isSafeInteger(member.revokedAt)) &&
      (member.status === 'revoked') === (member.revokedAt !== undefined)
    ) {
      normalized = {
        memberId: member.memberId,
        channelId: member.channelId,
        kind: 'agent',
        displayName: member.displayName,
        identityPublicKey: member.identityPublicKey,
        status: member.status,
        agentSeatId: member.agentSeatId,
        keyGeneration: member.keyGeneration as number,
        joinedAt: member.joinedAt,
        ...(member.revokedAt !== undefined ? { revokedAt: member.revokedAt } : {})
      }
    } else {
      return null
    }
    if (normalized.roomId && memberRoomIds.has(normalized.roomId)) return null
    memberIds.add(member.memberId)
    if (normalized.roomId) memberRoomIds.add(normalized.roomId)
    members.push(normalized)
  }

  const invites: ChannelInvite[] = []
  const inviteIds = new Set<string>()
  const inviteRoomIds = new Set<string>()
  const rawInvites = schemaVersion === 1 ? [] : (raw.invites as unknown[])
  for (const candidate of rawInvites) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
    const invite = candidate as Record<string, unknown>
    if (typeof invite.channelId === 'string' && driftedSet.has(invite.channelId)) continue
    if (
      typeof invite.inviteId !== 'string' ||
      !invite.inviteId ||
      inviteIds.has(invite.inviteId) ||
      typeof invite.channelId !== 'string' ||
      !channelIds.has(invite.channelId) ||
      typeof invite.roomId !== 'string' ||
      !invite.roomId ||
      inviteRoomIds.has(invite.roomId) ||
      typeof invite.tokenHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(invite.tokenHash) ||
      !validTimestamp(invite.createdAt) ||
      !validTimestamp(invite.expiresAt) ||
      invite.expiresAt <= invite.createdAt ||
      (invite.memberId !== undefined &&
        (typeof invite.memberId !== 'string' || !memberIds.has(invite.memberId))) ||
      (invite.consumedAt !== undefined && !validTimestamp(invite.consumedAt)) ||
      (invite.revokedAt !== undefined && !validTimestamp(invite.revokedAt))
    ) {
      return null
    }
    if (invite.consumedAt !== undefined && invite.memberId === undefined) return null
    if (invite.memberId !== undefined) {
      const member = members.find(
        (entry) => entry.channelId === invite.channelId && entry.memberId === invite.memberId
      )
      if (!member || member.kind !== 'human' || member.roomId !== invite.roomId) return null
    } else if (memberRoomIds.has(invite.roomId)) {
      return null
    }
    inviteIds.add(invite.inviteId)
    inviteRoomIds.add(invite.roomId)
    invites.push({
      inviteId: invite.inviteId,
      channelId: invite.channelId,
      roomId: invite.roomId,
      tokenHash: invite.tokenHash,
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
      ...(invite.memberId ? { memberId: invite.memberId } : {}),
      ...(invite.consumedAt !== undefined ? { consumedAt: invite.consumedAt } : {}),
      ...(invite.revokedAt !== undefined ? { revokedAt: invite.revokedAt } : {})
    })
  }

  for (const channel of channels) {
    const channelMembers = members.filter((member) => member.channelId === channel.channelId)
    const agentMembers = channelMembers.filter(
      (member): member is AgentChannelMember => member.kind === 'agent'
    )
    const owners = channelMembers.filter((member) => member.memberId === channel.ownerMemberId)
    const activeCount = channelMembers.filter((member) => member.status === 'active').length
    const seatCount = channelMembers.filter((member) => member.status !== 'revoked').length
    const identityCount = new Set(channelMembers.map((member) => member.identityPublicKey)).size
    const owner = owners[0]
    if (
      owners.length !== 1 ||
      !owner ||
      owner.kind !== 'human' ||
      owner.status !== 'active' ||
      owner.roomId !== undefined ||
      activeCount > MAX_CHANNEL_MEMBERS ||
      seatCount > MAX_CHANNEL_MEMBERS ||
      identityCount !== channelMembers.length ||
      channel.display.memberCount !== activeCount ||
      channelMembers.some(
        (member) =>
          member.memberId !== channel.ownerMemberId &&
          ((member.kind === 'human' && !member.roomId) ||
            (member.kind === 'agent' && member.roomId !== undefined))
      ) ||
      hasInvalidAgentSeatHistory(agentMembers)
    ) {
      driftedSet.add(channel.channelId)
      driftedChannelIds.push(channel.channelId)
    }
  }

  return {
    snapshot: {
      schemaVersion: CHANNEL_SCHEMA_VERSION,
      channels: channels.filter((channel) => !driftedSet.has(channel.channelId)),
      members: members.filter((member) => !driftedSet.has(member.channelId)),
      invites: invites.filter((invite) => !driftedSet.has(invite.channelId))
    },
    driftedChannelIds: [...new Set(driftedChannelIds)]
  }
}
