import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { dirname } from 'path'

export const CHANNEL_SCHEMA_VERSION = 1
export const MAX_CHANNEL_MEMBERS = 8

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
export type ChannelMemberStatus = 'active' | 'revoked'
export type ChannelMemberKind = 'human'
export type ChannelMessageKind = 'human.text'

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

export interface ChannelMember {
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

export interface ChannelStoreSnapshot {
  schemaVersion: typeof CHANNEL_SCHEMA_VERSION
  channels: Channel[]
  members: ChannelMember[]
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
  if (typeof value !== 'string')
    throw new ChannelError('protocol_unsupported', `${label} is required`)
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
  return value === 'active' || value === 'revoked'
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function buildEnvelope(
  channel: Pick<Channel, 'display' | 'status' | 'messageCount'>,
  memberCount: number
) {
  return {
    title: channel.display.title,
    status: channel.status,
    memberCount,
    messageCount: channel.messageCount
  } satisfies ChannelDisplayEnvelope
}

/**
 * Main-owned metadata authority for the Channels P1 substrate. It deliberately
 * owns no transport, IPC, renderer state, provider history, or agent action.
 */
export class ChannelStore {
  private snapshot: ChannelStoreSnapshot = {
    schemaVersion: CHANNEL_SCHEMA_VERSION,
    channels: [],
    members: []
  }
  private recoveryBlocked = false

  constructor(private readonly storagePath?: string) {
    this.snapshot = this.load()
  }

  createChannel(args: {
    chatId: string
    owner: { displayName: string; identityPublicKey: string }
    title: string
    reference?: TaskWraithReference
    now?: number
  }): { channel: Channel; owner: ChannelMember } {
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
    const owner: ChannelMember = {
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

  listMembers(channelId: string): ChannelMember[] {
    return this.snapshot.members
      .filter((member) => member.channelId === channelId)
      .map((member) => clone(member))
  }

  admitMember(args: {
    channelId: string
    displayName: string
    identityPublicKey: string
    roomId: string
    now?: number
  }): ChannelMember {
    const channel = this.requireActiveChannel(args.channelId)
    const identityPublicKey = nonBlank(args.identityPublicKey, 'identity public key')
    const existing = this.snapshot.members.find(
      (member) =>
        member.channelId === channel.channelId && member.identityPublicKey === identityPublicKey
    )
    if (existing) {
      if (existing.status === 'revoked') {
        throw new ChannelError('revoked', 'This pinned identity has been revoked')
      }
      return clone(existing)
    }

    const activeCount = this.activeMembers(channel.channelId).length
    if (activeCount >= MAX_CHANNEL_MEMBERS) {
      throw new ChannelError('quota_exceeded', 'Channel member limit reached')
    }

    const admitted: ChannelMember = {
      memberId: randomUUID(),
      channelId: channel.channelId,
      kind: 'human',
      displayName: nonBlank(args.displayName, 'display name', MAX_DISPLAY_NAME_LENGTH),
      identityPublicKey,
      status: 'active',
      roomId: nonBlank(args.roomId, 'room id'),
      joinedAt: nowOr(args)
    }
    this.snapshot.members.push(admitted)
    this.bumpMembership(channel, admitted.joinedAt)
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
    channel.display = buildEnvelope(channel, this.activeMembers(channel.channelId).length)
    this.persist()
    return clone(channel)
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
  }): ChannelMember {
    const channel = this.requireActiveChannel(args.channelId)
    const member = this.requireMember(channel.channelId, args.memberId)
    if (member.status !== 'active') throw new ChannelError('revoked', 'Member is revoked')
    if (member.kind !== 'human')
      throw new ChannelError('human_only', 'Only human members are supported')
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
  recordCommittedMessage(channelId: string, now = Date.now()): Channel {
    const channel = this.requireActiveChannel(channelId)
    channel.messageCount += 1
    channel.updatedAt = now
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

  private bumpMembership(channel: Channel, now: number) {
    channel.membershipRevision += 1
    channel.updatedAt = now
    channel.display = buildEnvelope(channel, this.activeMembers(channel.channelId).length)
  }

  private findChannel(channelId: string): Channel | undefined {
    return this.snapshot.channels.find((channel) => channel.channelId === channelId)
  }

  private requireChannel(channelId: string): Channel {
    this.assertHealthy()
    const channel = this.findChannel(nonBlank(channelId, 'channel id'))
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

  private assertHealthy() {
    if (this.recoveryBlocked) {
      throw new ChannelError('recovery_blocked', 'Channel metadata could not be recovered safely')
    }
  }

  private load(): ChannelStoreSnapshot {
    if (!this.storagePath || !existsSync(this.storagePath)) {
      return { schemaVersion: CHANNEL_SCHEMA_VERSION, channels: [], members: [] }
    }
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as unknown
      const normalized = normalizeSnapshot(parsed)
      if (!normalized) throw new Error('invalid snapshot')
      return normalized
    } catch {
      this.recoveryBlocked = true
      return { schemaVersion: CHANNEL_SCHEMA_VERSION, channels: [], members: [] }
    }
  }

  private persist() {
    if (!this.storagePath) return
    mkdirSync(dirname(this.storagePath), { recursive: true })
    const temporary = `${this.storagePath}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(this.snapshot), 'utf8')
    renameSync(temporary, this.storagePath)
  }
}

function normalizeSnapshot(value: unknown): ChannelStoreSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (
    raw.schemaVersion !== CHANNEL_SCHEMA_VERSION ||
    !Array.isArray(raw.channels) ||
    !Array.isArray(raw.members)
  ) {
    return null
  }

  const channels: Channel[] = []
  const channelIds = new Set<string>()
  for (const candidate of raw.channels) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
    const channel = candidate as Record<string, unknown>
    if (
      typeof channel.channelId !== 'string' ||
      !channel.channelId ||
      channelIds.has(channel.channelId) ||
      typeof channel.chatId !== 'string' ||
      !channel.chatId ||
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
    if (
      typeof display.title !== 'string' ||
      !display.title ||
      display.title.length > MAX_TITLE_LENGTH ||
      display.status !== channel.status ||
      !Number.isInteger(display.memberCount) ||
      (display.memberCount as number) < 0 ||
      !Number.isInteger(display.messageCount) ||
      display.messageCount !== channel.messageCount ||
      (channel.reference !== undefined && !isReference(channel.reference))
    ) {
      return null
    }
    channelIds.add(channel.channelId)
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
        title: display.title,
        status: display.status as ChannelStatus,
        memberCount: display.memberCount as number,
        messageCount: display.messageCount as number
      }
    })
  }

  const members: ChannelMember[] = []
  const memberIds = new Set<string>()
  for (const candidate of raw.members) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
    const member = candidate as Record<string, unknown>
    if (
      typeof member.memberId !== 'string' ||
      !member.memberId ||
      memberIds.has(member.memberId) ||
      typeof member.channelId !== 'string' ||
      !channelIds.has(member.channelId) ||
      member.kind !== 'human' ||
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
    memberIds.add(member.memberId)
    members.push({
      memberId: member.memberId,
      channelId: member.channelId,
      kind: 'human',
      displayName: member.displayName,
      identityPublicKey: member.identityPublicKey,
      status: member.status,
      ...(member.roomId ? { roomId: member.roomId } : {}),
      joinedAt: member.joinedAt,
      ...(member.revokedAt !== undefined ? { revokedAt: member.revokedAt } : {})
    })
  }

  for (const channel of channels) {
    const owners = members.filter(
      (member) =>
        member.channelId === channel.channelId && member.memberId === channel.ownerMemberId
    )
    const activeCount = members.filter(
      (member) => member.channelId === channel.channelId && member.status === 'active'
    ).length
    if (owners.length !== 1 || owners[0]?.kind !== 'human' || activeCount > MAX_CHANNEL_MEMBERS)
      return null
  }

  return { schemaVersion: CHANNEL_SCHEMA_VERSION, channels, members }
}
