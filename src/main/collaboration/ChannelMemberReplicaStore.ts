import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'fs'
import { createHash, randomUUID } from 'crypto'
import { basename, dirname, join, resolve as resolvePath } from 'path'
import { verifyChannelAgentMessageProof } from '../../shared/collaboration/ChannelAgentMessageProof'
import {
  channelMemberPublicPresentation,
  isChannelMemberPresentation,
  type ChannelMemberPublicPresentation
} from '../../shared/collaboration/ChannelMemberPresentation'
import type { ChannelMessage } from './ChannelMessageLog'
import {
  MAX_CHANNEL_LOG_BYTES,
  MAX_CHANNEL_MESSAGE_BYTES,
  MAX_CLIENT_MESSAGE_ID_LENGTH
} from './ChannelMessageLog'

export const CHANNEL_MEMBER_REPLICA_SCHEMA_VERSION = 3
const PREVIOUS_CHANNEL_MEMBER_REPLICA_SCHEMA_VERSION = 2
const LEGACY_CHANNEL_MEMBER_REPLICA_SCHEMA_VERSION = 1
export const MAX_CHANNEL_MEMBER_REPLICAS = 64
export const MAX_CHANNEL_MEMBER_RELAY_URLS = 8

export interface ChannelMemberReplicaPaths {
  root: string
  identity: string
  memberships: string
  records: string
}

interface ChannelMemberReplicaMemberBase {
  memberId: string
  displayName: string
  status: 'active'
  joinedAt: number
  presentation?: ChannelMemberPublicPresentation
}

export type ChannelMemberReplicaMember = ChannelMemberReplicaMemberBase & {
  kind: 'human' | 'agent'
}

export interface ChannelMemberReplicaSession {
  channelId: string
  hostChatId: string
  memberId: string
  displayName: string
  title?: string
  relayUrls: string[]
  roomId: string
  hostIdentityPubKeyB64: string
  status: 'active' | 'revoked'
  membershipRevision: number
  members: ChannelMemberReplicaMember[]
  savedAt: number
  updatedAt: number
}

export interface ChannelMemberReplica {
  session: ChannelMemberReplicaSession
  records: ChannelMessage[]
  highWaterSequence: number
}

export class ChannelMemberReplicaError extends Error {
  readonly code = 'recovery_blocked'

  constructor(message: string) {
    super(message)
    this.name = 'ChannelMemberReplicaError'
  }
}

interface PersistedMembershipIndexPayload {
  schemaVersion:
    | typeof LEGACY_CHANNEL_MEMBER_REPLICA_SCHEMA_VERSION
    | typeof PREVIOUS_CHANNEL_MEMBER_REPLICA_SCHEMA_VERSION
    | typeof CHANNEL_MEMBER_REPLICA_SCHEMA_VERSION
  activeChannelId: string | null
  sessions: ChannelMemberReplicaSession[]
}

interface PersistedMembershipIndex extends PersistedMembershipIndexPayload {
  checksum: string
}

interface PersistedReplicaRecordPayload {
  schemaVersion:
    | typeof LEGACY_CHANNEL_MEMBER_REPLICA_SCHEMA_VERSION
    | typeof PREVIOUS_CHANNEL_MEMBER_REPLICA_SCHEMA_VERSION
    | typeof CHANNEL_MEMBER_REPLICA_SCHEMA_VERSION
  record: ChannelMessage
}

interface PersistedReplicaRecord extends PersistedReplicaRecordPayload {
  checksum: string
}

interface LoadedMembershipIndex {
  activeChannelId: string | null
  sessions: ChannelMemberReplicaSession[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function checksum(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function recoveryBlocked(message: string): ChannelMemberReplicaError {
  return new ChannelMemberReplicaError(message)
}

function boundedText(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string') throw recoveryBlocked(`${label} is invalid`)
  const normalized = value.trim()
  if (!normalized || normalized.length > max) throw recoveryBlocked(`${label} is invalid`)
  return normalized
}

function pathIdentifier(value: unknown, label: string): string {
  const normalized = boundedText(value, label)
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) throw recoveryBlocked(`${label} is invalid`)
  return normalized
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw recoveryBlocked(`${label} is invalid`)
  }
  return value
}

function normalizeRelayUrl(value: unknown): string {
  const raw = boundedText(value, 'Channel relay URL', 2_048)
  try {
    const parsed = new URL(raw)
    if (
      (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('invalid relay URL')
    }
    return parsed.toString().replace(/\/$/, '')
  } catch {
    throw recoveryBlocked('Channel relay URL is invalid')
  }
}

function validateRawPublicKey(value: unknown): string {
  const encoded = boundedText(value, 'Channel host identity', 256)
  try {
    if (Buffer.from(encoded, 'base64').length !== 32) throw new Error('invalid key')
  } catch {
    throw recoveryBlocked('Channel host identity is invalid')
  }
  return encoded
}

function validateMember(
  value: unknown,
  options: { allowAgent: boolean; allowPresentation: boolean } = {
    allowAgent: true,
    allowPresentation: true
  }
): ChannelMemberReplicaMember {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw recoveryBlocked('Channel member replica is invalid')
  }
  const raw = value as Record<string, unknown>
  if (
    (raw.kind !== 'human' && raw.kind !== 'agent') ||
    (!options.allowAgent && raw.kind !== 'human') ||
    raw.status !== 'active'
  ) {
    throw recoveryBlocked('Channel member replica is invalid')
  }
  if (
    raw.presentation !== undefined &&
    (!options.allowPresentation ||
      !isChannelMemberPresentation(raw.presentation, { allowSeatDisabled: false }))
  ) {
    throw recoveryBlocked('Channel member presentation is invalid')
  }
  const presentation = channelMemberPublicPresentation(raw.presentation)
  return {
    memberId: pathIdentifier(raw.memberId, 'Channel member id'),
    kind: raw.kind,
    displayName: boundedText(raw.displayName, 'Channel member display name', 120),
    status: 'active',
    joinedAt: timestamp(raw.joinedAt, 'Channel member join time'),
    ...(presentation ? { presentation } : {})
  }
}

function validateSession(
  value: unknown,
  options: { allowAgent: boolean; allowPresentation: boolean } = {
    allowAgent: true,
    allowPresentation: true
  }
): ChannelMemberReplicaSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw recoveryBlocked('Channel membership replica is invalid')
  }
  const raw = value as Record<string, unknown>
  if (
    (raw.status !== 'active' && raw.status !== 'revoked') ||
    !Number.isSafeInteger(raw.membershipRevision) ||
    (raw.membershipRevision as number) < 0 ||
    !Array.isArray(raw.members) ||
    raw.members.length > 8 ||
    (raw.title !== undefined && typeof raw.title !== 'string')
  ) {
    throw recoveryBlocked('Channel membership replica is invalid')
  }
  const relayUrls = Array.from(
    new Set((raw.relayUrls as unknown[] | undefined)?.map(normalizeRelayUrl) ?? [])
  )
  if (relayUrls.length < 1 || relayUrls.length > MAX_CHANNEL_MEMBER_RELAY_URLS) {
    throw recoveryBlocked('Channel membership relay list is invalid')
  }
  const members = raw.members.map((member) => validateMember(member, options))
  if (new Set(members.map((member) => member.memberId)).size !== members.length) {
    throw recoveryBlocked('Channel membership contains duplicate members')
  }
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (title.length > 200) throw recoveryBlocked('Channel title is invalid')
  return {
    channelId: pathIdentifier(raw.channelId, 'Channel id'),
    hostChatId: boundedText(raw.hostChatId, 'Channel host chat id'),
    memberId: pathIdentifier(raw.memberId, 'Channel member id'),
    displayName: boundedText(raw.displayName, 'Channel member display name', 120),
    ...(title ? { title } : {}),
    relayUrls,
    roomId: pathIdentifier(raw.roomId, 'Channel room id'),
    hostIdentityPubKeyB64: validateRawPublicKey(raw.hostIdentityPubKeyB64),
    status: raw.status,
    membershipRevision: raw.membershipRevision as number,
    members,
    savedAt: timestamp(raw.savedAt, 'Channel membership save time'),
    updatedAt: timestamp(raw.updatedAt, 'Channel membership update time')
  }
}

function validateRecord(
  value: unknown,
  channelId: string,
  hostIdentityPubKeyB64: string
): ChannelMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw recoveryBlocked('Channel replica record is invalid')
  }
  const raw = value as Record<string, unknown>
  if (
    raw.channelId !== channelId ||
    !Number.isSafeInteger(raw.sequence) ||
    (raw.sequence as number) < 1 ||
    (raw.kind !== 'human.text' && raw.kind !== 'agent.text') ||
    typeof raw.content !== 'string' ||
    !raw.content ||
    Buffer.byteLength(raw.content, 'utf8') > MAX_CHANNEL_MESSAGE_BYTES ||
    typeof raw.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(raw.contentHash) ||
    contentHash(raw.content) !== raw.contentHash
  ) {
    throw recoveryBlocked('Channel replica record is invalid')
  }
  const clientMessageId = boundedText(
    raw.clientMessageId,
    'Channel client message id',
    MAX_CLIENT_MESSAGE_ID_LENGTH
  )
  const prefix = {
    channelId,
    sequence: raw.sequence as number,
    messageId: pathIdentifier(raw.messageId, 'Channel message id'),
    authorMemberId: pathIdentifier(raw.authorMemberId, 'Channel author member id'),
    clientMessageId
  }
  const suffix = {
    content: raw.content,
    acceptedAt: timestamp(raw.acceptedAt, 'Channel message acceptance time'),
    contentHash: raw.contentHash
  }
  if (raw.kind === 'human.text') {
    if (raw.agentProof !== undefined) {
      throw recoveryBlocked('Human Channel replica record contains agent proof')
    }
    return { ...prefix, kind: 'human.text', ...suffix }
  }
  const verified = verifyChannelAgentMessageProof({
    ownerPublicKeyB64: hostIdentityPubKeyB64,
    proof: raw.agentProof,
    acceptedAt: suffix.acceptedAt
  })
  if (!verified.ok) throw recoveryBlocked('Channel agent replica proof is invalid')
  const post = verified.value.signedPost.post
  if (
    post.channelId !== channelId ||
    post.agentMemberId !== prefix.authorMemberId ||
    post.clientMessageId !== clientMessageId ||
    post.content !== suffix.content ||
    post.contentHash !== suffix.contentHash
  ) {
    throw recoveryBlocked('Channel agent replica proof does not match its record')
  }
  return { ...prefix, kind: 'agent.text', ...suffix, agentProof: verified.value }
}

function syncFile(path: string): void {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function syncDirectory(path: string): void {
  try {
    const fd = openSync(path, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // Windows and some filesystems do not permit directory fsync. Each file
    // itself is still synced before rename/return.
  }
}

function atomicWrite(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  try {
    syncFile(temporary)
    renameSync(temporary, path)
    syncDirectory(dirname(path))
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

export function channelMemberReplicaPaths(userDataPath: string): ChannelMemberReplicaPaths {
  if (typeof userDataPath !== 'string' || !userDataPath.trim()) {
    throw new Error('Channel member replica requires an injected userDataPath')
  }
  const root = join(resolvePath(userDataPath), 'channel-memberships')
  return {
    root,
    identity: join(root, 'identity.json'),
    memberships: join(root, 'memberships.json'),
    records: join(root, 'records')
  }
}

/**
 * Durable, local replica of Channels this Mac joined as a human member.
 *
 * The host remains authoritative. Replica logs are append-only and retain only
 * host-redacted human.text records and publicly verifiable agent.text proof.
 * Invite tokens and live session keys never
 * enter this store; the Ed25519 member identity lives in the separate
 * safeStorage-backed identity path.
 */
export class ChannelMemberReplicaStore {
  private readonly paths: ChannelMemberReplicaPaths
  private indexCache: LoadedMembershipIndex | null = null
  private readonly recordCache = new Map<string, ChannelMessage[]>()

  constructor(userDataPath: string) {
    this.paths = channelMemberReplicaPaths(userDataPath)
    this.removeStaleMembershipTemporaries()
  }

  dataPaths(): ChannelMemberReplicaPaths {
    return clone(this.paths)
  }

  listSessions(): ChannelMemberReplicaSession[] {
    return this.loadIndex()
      .sessions.map(clone)
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  readActive(): ChannelMemberReplica | null {
    const activeChannelId = this.loadIndex().activeChannelId
    return activeChannelId ? this.read(activeChannelId) : null
  }

  read(channelId: string): ChannelMemberReplica | null {
    const normalizedChannelId = pathIdentifier(channelId, 'Channel id')
    const session = this.loadIndex().sessions.find(
      (candidate) => candidate.channelId === normalizedChannelId
    )
    if (!session) return null
    const records = this.loadRecords(normalizedChannelId, session.hostIdentityPubKeyB64)
    return {
      session: clone(session),
      records: records.map(clone),
      highWaterSequence: records.length
    }
  }

  activate(input: {
    channelId: string
    hostChatId: string
    memberId: string
    displayName: string
    title?: string
    relayUrls: readonly string[]
    roomId: string
    hostIdentityPubKeyB64: string
    now?: number
  }): ChannelMemberReplica {
    const index = this.loadIndex()
    const now = input.now ?? Date.now()
    const candidate = validateSession({
      channelId: input.channelId,
      hostChatId: input.hostChatId,
      memberId: input.memberId,
      displayName: input.displayName,
      ...(input.title ? { title: input.title } : {}),
      relayUrls: [...input.relayUrls],
      roomId: input.roomId,
      hostIdentityPubKeyB64: input.hostIdentityPubKeyB64,
      status: 'active',
      membershipRevision: 0,
      members: [],
      savedAt: now,
      updatedAt: now
    })
    const existing = index.sessions.find((session) => session.channelId === candidate.channelId)
    if (existing && existing.hostIdentityPubKeyB64 !== candidate.hostIdentityPubKeyB64) {
      throw recoveryBlocked('Channel id is already pinned to a different host identity')
    }
    this.loadRecords(candidate.channelId, candidate.hostIdentityPubKeyB64)
    const session: ChannelMemberReplicaSession = existing
      ? {
          ...candidate,
          membershipRevision: existing.membershipRevision,
          members: existing.members
        }
      : candidate
    const nextSessions = index.sessions.filter((stored) => stored.channelId !== candidate.channelId)
    if (!existing && nextSessions.length >= MAX_CHANNEL_MEMBER_REPLICAS) {
      throw recoveryBlocked('Too many local Channel membership replicas')
    }
    nextSessions.push(session)
    this.persistIndex({ activeChannelId: session.channelId, sessions: nextSessions })
    return this.read(session.channelId)!
  }

  setActive(channelId: string): ChannelMemberReplica {
    const normalized = pathIdentifier(channelId, 'Channel id')
    const index = this.loadIndex()
    if (!index.sessions.some((session) => session.channelId === normalized)) {
      throw recoveryBlocked('Channel membership replica was not found')
    }
    if (index.activeChannelId !== normalized) {
      this.persistIndex({ ...index, activeChannelId: normalized })
    }
    return this.read(normalized)!
  }

  appendRecords(channelId: string, incoming: readonly ChannelMessage[]): ChannelMemberReplica {
    const normalized = pathIdentifier(channelId, 'Channel id')
    const replica = this.read(normalized)
    if (!replica) throw recoveryBlocked('Channel membership replica was not found')
    if (incoming.length === 0) return replica

    const current = this.loadRecords(normalized, replica.session.hostIdentityPubKeyB64)
    const accepted: ChannelMessage[] = []
    for (const value of incoming) {
      const record = validateRecord(value, normalized, replica.session.hostIdentityPubKeyB64)
      const existing =
        current[record.sequence - 1] ?? accepted[record.sequence - current.length - 1]
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(record)) {
          throw recoveryBlocked('Channel replica conflicts with an applied sequence')
        }
        continue
      }
      if (record.sequence !== current.length + accepted.length + 1) {
        throw recoveryBlocked('Channel replica sequence is not contiguous')
      }
      accepted.push(record)
    }

    if (accepted.length > 0) {
      const serialized = accepted
        .map((record) => {
          const payload: PersistedReplicaRecordPayload = {
            schemaVersion: CHANNEL_MEMBER_REPLICA_SCHEMA_VERSION,
            record
          }
          return JSON.stringify({ ...payload, checksum: checksum(payload) })
        })
        .join('\n')
      const path = this.recordPath(normalized)
      mkdirSync(this.paths.records, { recursive: true })
      const currentBytes = existsSync(path) ? statSync(path).size : 0
      const appended = `${serialized}\n`
      if (currentBytes + Buffer.byteLength(appended, 'utf8') > MAX_CHANNEL_LOG_BYTES) {
        throw recoveryBlocked('Channel replica exceeds the local history limit')
      }
      const fd = openSync(path, 'a', 0o600)
      try {
        writeSync(fd, appended)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      syncDirectory(this.paths.records)
      current.push(...accepted.map(clone))
    }
    return {
      session: clone(replica.session),
      records: current.map(clone),
      highWaterSequence: current.length
    }
  }

  updateMembers(args: {
    channelId: string
    membershipRevision: number
    members: readonly ChannelMemberReplicaMember[]
    now?: number
  }): ChannelMemberReplica {
    const channelId = pathIdentifier(args.channelId, 'Channel id')
    const index = this.loadIndex()
    const position = index.sessions.findIndex((session) => session.channelId === channelId)
    if (position < 0) throw recoveryBlocked('Channel membership replica was not found')
    const current = index.sessions[position]
    if (!Number.isSafeInteger(args.membershipRevision) || args.membershipRevision < 0) {
      throw recoveryBlocked('Channel membership revision is invalid')
    }
    if (args.membershipRevision < current.membershipRevision) return this.read(channelId)!
    const members = args.members.map((member) => validateMember(member))
    if (
      members.length > 8 ||
      new Set(members.map((member) => member.memberId)).size !== members.length
    ) {
      throw recoveryBlocked('Channel membership snapshot is invalid')
    }
    if (
      args.membershipRevision === current.membershipRevision &&
      current.members.length > 0 &&
      JSON.stringify(current.members) !== JSON.stringify(members)
    ) {
      throw recoveryBlocked('Channel membership revision conflicts with the local replica')
    }
    const next = clone(index)
    next.sessions[position] = {
      ...current,
      membershipRevision: args.membershipRevision,
      members,
      updatedAt: args.now ?? Date.now()
    }
    this.persistIndex(next)
    return this.read(channelId)!
  }

  markRevoked(channelId: string, now = Date.now()): ChannelMemberReplica {
    const normalized = pathIdentifier(channelId, 'Channel id')
    const index = this.loadIndex()
    const position = index.sessions.findIndex((session) => session.channelId === normalized)
    if (position < 0) throw recoveryBlocked('Channel membership replica was not found')
    const next = clone(index)
    next.sessions[position] = {
      ...next.sessions[position],
      status: 'revoked',
      updatedAt: now
    }
    this.persistIndex(next)
    return this.read(normalized)!
  }

  resetRecords(channelId: string): ChannelMemberReplica {
    const normalized = pathIdentifier(channelId, 'Channel id')
    const session = this.loadIndex().sessions.find(
      (candidate) => candidate.channelId === normalized
    )
    if (!session) throw recoveryBlocked('Channel membership replica was not found')
    const path = this.recordPath(normalized)
    mkdirSync(this.paths.records, { recursive: true })
    const fd = openSync(path, 'w', 0o600)
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    syncDirectory(this.paths.records)
    this.recordCache.set(normalized, [])
    return { session: clone(session), records: [], highWaterSequence: 0 }
  }

  forget(channelId: string): void {
    const normalized = pathIdentifier(channelId, 'Channel id')
    const index = this.loadIndex()
    if (!index.sessions.some((session) => session.channelId === normalized)) return
    const sessions = index.sessions.filter((session) => session.channelId !== normalized)
    const activeChannelId =
      index.activeChannelId === normalized
        ? ([...sessions].sort((left, right) => right.updatedAt - left.updatedAt)[0]?.channelId ??
          null)
        : index.activeChannelId
    this.persistIndex({ activeChannelId, sessions })
    const path = this.recordPath(normalized)
    if (existsSync(path)) {
      unlinkSync(path)
      syncDirectory(this.paths.records)
    }
    this.recordCache.delete(normalized)
  }

  /** Explicit local recovery: remove replicas, but retain the pinned member identity. */
  forgetAll(): void {
    this.persistIndex({ activeChannelId: null, sessions: [] })
    if (existsSync(this.paths.records)) {
      for (const entry of readdirSync(this.paths.records, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          unlinkSync(join(this.paths.records, entry.name))
        }
      }
      syncDirectory(this.paths.records)
    }
    this.recordCache.clear()
  }

  private recordPath(channelId: string): string {
    return join(this.paths.records, `${pathIdentifier(channelId, 'Channel id')}.jsonl`)
  }

  private removeStaleMembershipTemporaries(): void {
    if (!existsSync(this.paths.root)) return
    const prefix = `${basename(this.paths.memberships)}.`
    let deleted = false
    for (const entry of readdirSync(this.paths.root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.tmp')) {
        continue
      }
      unlinkSync(join(this.paths.root, entry.name))
      deleted = true
    }
    if (deleted) syncDirectory(this.paths.root)
  }

  private loadIndex(): LoadedMembershipIndex {
    if (this.indexCache) return this.indexCache
    if (!existsSync(this.paths.memberships)) {
      this.indexCache = { activeChannelId: null, sessions: [] }
      return this.indexCache
    }
    try {
      const parsed = JSON.parse(
        readFileSync(this.paths.memberships, 'utf8')
      ) as PersistedMembershipIndex
      const payload: PersistedMembershipIndexPayload = {
        schemaVersion: parsed.schemaVersion,
        activeChannelId: parsed.activeChannelId,
        sessions: parsed.sessions
      }
      if (
        (parsed.schemaVersion !== LEGACY_CHANNEL_MEMBER_REPLICA_SCHEMA_VERSION &&
          parsed.schemaVersion !== PREVIOUS_CHANNEL_MEMBER_REPLICA_SCHEMA_VERSION &&
          parsed.schemaVersion !== CHANNEL_MEMBER_REPLICA_SCHEMA_VERSION) ||
        typeof parsed.checksum !== 'string' ||
        checksum(payload) !== parsed.checksum ||
        !Array.isArray(parsed.sessions) ||
        parsed.sessions.length > MAX_CHANNEL_MEMBER_REPLICAS
      ) {
        throw new Error('membership index checksum or schema is invalid')
      }
      const sessions = parsed.sessions.map((session) =>
        validateSession(session, {
          allowAgent: parsed.schemaVersion !== LEGACY_CHANNEL_MEMBER_REPLICA_SCHEMA_VERSION,
          allowPresentation: parsed.schemaVersion === CHANNEL_MEMBER_REPLICA_SCHEMA_VERSION
        })
      )
      if (new Set(sessions.map((session) => session.channelId)).size !== sessions.length) {
        throw new Error('membership index contains duplicate Channels')
      }
      const activeChannelId =
        parsed.activeChannelId === null
          ? null
          : pathIdentifier(parsed.activeChannelId, 'Active Channel id')
      if (activeChannelId && !sessions.some((session) => session.channelId === activeChannelId)) {
        throw new Error('active Channel membership does not exist')
      }
      this.indexCache = { activeChannelId, sessions }
      return this.indexCache
    } catch (error) {
      if (error instanceof ChannelMemberReplicaError) throw error
      throw recoveryBlocked(
        `Channel membership metadata cannot be recovered (${error instanceof Error ? error.message : 'unknown error'})`
      )
    }
  }

  private persistIndex(index: LoadedMembershipIndex): void {
    const sessions = index.sessions.map((session) => validateSession(session))
    const payload: PersistedMembershipIndexPayload = {
      schemaVersion: CHANNEL_MEMBER_REPLICA_SCHEMA_VERSION,
      activeChannelId: index.activeChannelId,
      sessions
    }
    atomicWrite(
      this.paths.memberships,
      JSON.stringify(
        { ...payload, checksum: checksum(payload) } satisfies PersistedMembershipIndex,
        null,
        2
      )
    )
    this.indexCache = { activeChannelId: index.activeChannelId, sessions: sessions.map(clone) }
  }

  private loadRecords(channelId: string, hostIdentityPubKeyB64: string): ChannelMessage[] {
    const cached = this.recordCache.get(channelId)
    if (cached) return cached
    const path = this.recordPath(channelId)
    if (!existsSync(path)) {
      this.recordCache.set(channelId, [])
      return this.recordCache.get(channelId)!
    }
    try {
      let bytes = readFileSync(path)
      if (bytes.length > MAX_CHANNEL_LOG_BYTES) {
        throw new Error('replica log exceeds the local history limit')
      }
      if (bytes.length > 0 && bytes.at(-1) !== 0x0a) {
        const lastNewline = bytes.lastIndexOf(0x0a)
        const retainedBytes = lastNewline < 0 ? 0 : lastNewline + 1
        truncateSync(path, retainedBytes)
        syncFile(path)
        syncDirectory(this.paths.records)
        bytes = bytes.subarray(0, retainedBytes)
      }
      const records: ChannelMessage[] = []
      const lines = bytes.toString('utf8').split('\n').filter(Boolean)
      for (const line of lines) {
        const parsed = JSON.parse(line) as PersistedReplicaRecord
        const payload: PersistedReplicaRecordPayload = {
          schemaVersion: parsed.schemaVersion,
          record: parsed.record
        }
        if (
          (parsed.schemaVersion !== LEGACY_CHANNEL_MEMBER_REPLICA_SCHEMA_VERSION &&
            parsed.schemaVersion !== PREVIOUS_CHANNEL_MEMBER_REPLICA_SCHEMA_VERSION &&
            parsed.schemaVersion !== CHANNEL_MEMBER_REPLICA_SCHEMA_VERSION) ||
          typeof parsed.checksum !== 'string' ||
          checksum(payload) !== parsed.checksum
        ) {
          throw new Error('replica record checksum or schema is invalid')
        }
        if (
          parsed.schemaVersion === LEGACY_CHANNEL_MEMBER_REPLICA_SCHEMA_VERSION &&
          parsed.record?.kind !== 'human.text'
        ) {
          throw new Error('legacy replica record contains unsupported message kind')
        }
        const record = validateRecord(parsed.record, channelId, hostIdentityPubKeyB64)
        if (record.sequence !== records.length + 1) {
          throw new Error('replica record sequence is not contiguous')
        }
        records.push(record)
      }
      this.recordCache.set(channelId, records)
      return records
    } catch (error) {
      if (error instanceof ChannelMemberReplicaError) throw error
      throw recoveryBlocked(
        `Channel member history cannot be recovered (${error instanceof Error ? error.message : 'unknown error'})`
      )
    }
  }
}
