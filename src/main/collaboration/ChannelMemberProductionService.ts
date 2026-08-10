import { existsSync } from 'fs'
import type { KeyPair } from '../../shared/e2ee/keys'
import { CHANNEL_WIRE_PROTOCOL } from '../../shared/collaboration/ChannelWireProtocol'
import type { ChannelHandshakeConfirmResult } from '../../shared/collaboration/ChannelWireProtocol'
import type { TransportSocketFactory } from '../remote/RemoteTransportClient'
import { wsTransportSocketFactory } from '../remote/wsTransportSocket'
import {
  HumanCollaborationIdentityStore,
  type HumanCollaborationSafeStorage
} from './HumanCollaborationIdentityStore'
import {
  ChannelMemberClient,
  ChannelRemoteError,
  type ChannelAdmissionInput,
  type ChannelMemberClientOptions,
  type ChannelReconnectInput
} from './ChannelMemberClient'
import type { ChannelMessage } from './ChannelMessageLog'
import {
  ChannelMemberReplicaError,
  ChannelMemberReplicaStore,
  MAX_CHANNEL_MEMBER_RELAY_URLS,
  channelMemberReplicaPaths,
  type ChannelMemberReplica,
  type ChannelMemberReplicaMember,
  type ChannelMemberReplicaSession
} from './ChannelMemberReplicaStore'

export type ChannelMemberProductionPhase =
  | 'idle'
  | 'connecting'
  | 'awaiting_sas'
  | 'connected'
  | 'disconnected'
  | 'revoked'
  | 'recovery_blocked'

export type ChannelMemberProductionErrorCode =
  | 'invalid_invite'
  | 'invite_expired'
  | 'host_unavailable'
  | 'identity_unavailable'
  | 'not_joined'
  | 'not_connected'
  | 'revoked'
  | 'recovery_blocked'
  | 'protocol_error'

export class ChannelMemberProductionError extends Error {
  constructor(
    readonly code: ChannelMemberProductionErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ChannelMemberProductionError'
  }
}

export interface ChannelMemberProductionChannelView {
  channelId: string
  hostChatId: string
  memberId: string
  displayName: string
  title: string
  status: 'active' | 'revoked'
  savedAt: number
  updatedAt: number
}

export interface ChannelMemberProductionSnapshot {
  phase: ChannelMemberProductionPhase
  connected: boolean
  channel: ChannelMemberProductionChannelView | null
  members: ChannelMemberReplicaMember[]
  records: ChannelMessage[]
  highWaterSequence: number
  error: { code: ChannelMemberProductionErrorCode; message: string } | null
}

export interface ChannelMemberProductionMembershipSummary extends ChannelMemberProductionChannelView {
  active: boolean
}

export interface ChannelMemberProductionJoinInput {
  protocol: string
  version: number
  channelId: string
  hostChatId: string
  inviteId: string
  inviteToken: string
  roomId: string
  relayUrls: readonly string[]
  displayName: string
  expiresAt: number
  title?: string
}

export interface ChannelMemberClientLike {
  readonly isConnected: boolean
  readonly isEstablished: boolean
  readonly highWaterSequence: number
  identityPublicKey(): string
  hostIdentityPublicKey(): string
  records(): ChannelMessage[]
  connect(relayUrl: string, roomId: string): void
  whenConnected(timeoutMs?: number): Promise<void>
  beginAdmission(input: ChannelAdmissionInput): Promise<{ confirmCode: string }>
  confirmAdmission(): Promise<ChannelHandshakeConfirmResult>
  reconnect(input: ChannelReconnectInput): Promise<ChannelHandshakeConfirmResult>
  append(
    content: string,
    clientMessageId?: string
  ): Promise<{ accepted: true; deduplicated: boolean; record: ChannelMessage }>
  resume(args?: {
    resumeAfter?: number
    maxRecords?: number
    maxBytes?: number
  }): Promise<{ highWaterSequence: number }>
  dispose(): void
}

export interface ChannelMemberReplicaStoreLike {
  dataPaths(): ReturnType<typeof channelMemberReplicaPaths>
  listSessions(): ChannelMemberReplicaSession[]
  readActive(): ChannelMemberReplica | null
  read(channelId: string): ChannelMemberReplica | null
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
  }): ChannelMemberReplica
  setActive(channelId: string): ChannelMemberReplica
  appendRecords(channelId: string, records: readonly ChannelMessage[]): ChannelMemberReplica
  updateMembers(args: {
    channelId: string
    membershipRevision: number
    members: readonly ChannelMemberReplicaMember[]
    now?: number
  }): ChannelMemberReplica
  markRevoked(channelId: string, now?: number): ChannelMemberReplica
  resetRecords(channelId: string): ChannelMemberReplica
  forget(channelId: string): void
  forgetAll(): void
}

export interface ChannelMemberProductionServiceOptions {
  userDataPath: string
  safeStorage: HumanCollaborationSafeStorage
  socketFactory?: TransportSocketFactory
  now?: () => number
  connectTimeoutMs?: number
  logger?: (line: string) => void
  onChange?: (snapshot: ChannelMemberProductionSnapshot) => void
  createClient?: (options: ChannelMemberClientOptions) => ChannelMemberClientLike
  createStore?: (userDataPath: string) => ChannelMemberReplicaStoreLike
}

export interface ChannelMemberProductionService {
  snapshot(): ChannelMemberProductionSnapshot
  listMemberships(): ChannelMemberProductionMembershipSummary[]
  beginJoin(input: ChannelMemberProductionJoinInput): Promise<{ confirmCode: string }>
  confirmJoin(): Promise<ChannelMemberProductionSnapshot>
  reconnect(channelId?: string): Promise<ChannelMemberProductionSnapshot>
  append(input: {
    content: string
    clientMessageId: string
  }): Promise<{ record: ChannelMessage; deduplicated: boolean }>
  resume(): Promise<ChannelMemberProductionSnapshot>
  disconnect(): void
  resetLocalHistory(channelId?: string): ChannelMemberProductionSnapshot
  forget(channelId?: string): void
  dispose(): void
}

interface NormalizedJoinInput {
  channelId: string
  hostChatId: string
  inviteId: string
  inviteToken: string
  roomId: string
  relayUrls: string[]
  displayName: string
  expiresAt: number
  title?: string
}

interface PendingJoin {
  input: NormalizedJoinInput
  client: ChannelMemberClientLike
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function productionError(
  code: ChannelMemberProductionErrorCode,
  message: string
): ChannelMemberProductionError {
  return new ChannelMemberProductionError(code, message)
}

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw productionError('invalid_invite', `${label} is missing.`)
  const normalized = value.trim()
  if (!normalized || normalized.length > max) {
    throw productionError('invalid_invite', `${label} is invalid.`)
  }
  return normalized
}

function pathIdentifier(value: unknown, label: string): string {
  const normalized = boundedText(value, label, 200)
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw productionError('invalid_invite', `${label} is invalid.`)
  }
  return normalized
}

function normalizeMessageText(value: unknown): string {
  if (typeof value !== 'string') {
    throw productionError('protocol_error', 'Channel message content is required.')
  }
  const normalized = value.trim()
  if (!normalized) throw productionError('protocol_error', 'Channel message content is empty.')
  if (Buffer.byteLength(normalized, 'utf8') > 8_000) {
    throw productionError('protocol_error', 'Channel message content exceeds the P2 limit.')
  }
  return normalized
}

function normalizeClientMessageId(value: unknown): string {
  if (typeof value !== 'string') {
    throw productionError('protocol_error', 'Channel message id is required.')
  }
  const normalized = value.trim()
  if (!normalized || normalized.length > 200) {
    throw productionError('protocol_error', 'Channel message id is invalid.')
  }
  return normalized
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
    throw productionError('invalid_invite', 'The Channel invite contains an invalid relay URL.')
  }
}

function normalizeJoinInput(
  input: ChannelMemberProductionJoinInput,
  now: number
): NormalizedJoinInput {
  if (!input || typeof input !== 'object') {
    throw productionError('invalid_invite', 'Paste a valid TaskWraith Channel invite.')
  }
  if (input.protocol !== CHANNEL_WIRE_PROTOCOL || input.version !== 1) {
    throw productionError('invalid_invite', 'This Channel invite uses an unsupported protocol.')
  }
  if (!Number.isFinite(input.expiresAt)) {
    throw productionError('invalid_invite', 'The Channel invite expiry is invalid.')
  }
  if (input.expiresAt <= now) {
    throw productionError(
      'invite_expired',
      'This Channel invite has expired. Ask the host for a fresh invite.'
    )
  }
  if (!Array.isArray(input.relayUrls)) {
    throw productionError('invalid_invite', 'This Channel invite has no relay URLs.')
  }
  const relayUrls = Array.from(new Set(input.relayUrls.map(normalizeRelayUrl)))
  if (relayUrls.length < 1 || relayUrls.length > MAX_CHANNEL_MEMBER_RELAY_URLS) {
    throw productionError('invalid_invite', 'This Channel invite has an invalid relay list.')
  }
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (title.length > 200) throw productionError('invalid_invite', 'The Channel title is invalid.')
  return {
    channelId: pathIdentifier(input.channelId, 'Channel id'),
    hostChatId: boundedText(input.hostChatId, 'Channel host chat id', 200),
    inviteId: pathIdentifier(input.inviteId, 'Channel invite id'),
    inviteToken: boundedText(input.inviteToken, 'Channel invite token', 512),
    roomId: pathIdentifier(input.roomId, 'Channel room id'),
    relayUrls,
    displayName: boundedText(input.displayName, 'Display name', 120),
    expiresAt: input.expiresAt,
    ...(title ? { title } : {})
  }
}

function retryableTransportError(error: unknown): boolean {
  if (error instanceof ChannelRemoteError) return false
  const message = error instanceof Error ? error.message : String(error)
  return /transport|connect timed out|timed out|socket|websocket|ECONN|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(
    message
  )
}

function publicRemoteError(error: unknown): ChannelMemberProductionError {
  if (error instanceof ChannelMemberProductionError) return error
  if (error instanceof ChannelMemberReplicaError) {
    return productionError(
      'recovery_blocked',
      'This Mac’s durable Channel replica needs recovery before it can reconnect.'
    )
  }
  if (error instanceof ChannelRemoteError) {
    if (error.code === 'revoked' || error.code === 'not_member') {
      return productionError('revoked', 'This Channel membership is no longer active.')
    }
    if (error.code === 'invalid_cursor') {
      return productionError(
        'recovery_blocked',
        'The local Channel history no longer matches the host. Reset it before reconnecting.'
      )
    }
    if (error.code === 'host_unavailable') {
      return productionError('host_unavailable', 'The Channel host is unavailable.')
    }
    return productionError('protocol_error', 'The Channel host rejected the request.')
  }
  if (retryableTransportError(error)) {
    return productionError('host_unavailable', 'The Channel host could not be reached.')
  }
  return productionError('protocol_error', 'The encrypted Channel session could not continue.')
}

function parseMembersSnapshot(
  value: unknown,
  expectedChannelId: string
): { membershipRevision: number; members: ChannelMemberReplicaMember[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChannelMemberReplicaError('Channel membership snapshot is invalid')
  }
  const raw = value as Record<string, unknown>
  if (
    raw.channelId !== expectedChannelId ||
    !Number.isSafeInteger(raw.membershipRevision) ||
    (raw.membershipRevision as number) < 0 ||
    !Array.isArray(raw.members) ||
    raw.members.length > 8
  ) {
    throw new ChannelMemberReplicaError('Channel membership snapshot is invalid')
  }
  const members = raw.members.map((value): ChannelMemberReplicaMember => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ChannelMemberReplicaError('Channel member snapshot is invalid')
    }
    const member = value as Record<string, unknown>
    if (
      member.kind !== 'human' ||
      member.status !== 'active' ||
      typeof member.memberId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(member.memberId) ||
      typeof member.displayName !== 'string' ||
      !member.displayName.trim() ||
      member.displayName.trim().length > 120 ||
      typeof member.joinedAt !== 'number' ||
      !Number.isFinite(member.joinedAt)
    ) {
      throw new ChannelMemberReplicaError('Channel member snapshot is invalid')
    }
    return {
      memberId: member.memberId,
      kind: 'human',
      displayName: member.displayName.trim(),
      status: 'active',
      joinedAt: member.joinedAt
    }
  })
  if (new Set(members.map((member) => member.memberId)).size !== members.length) {
    throw new ChannelMemberReplicaError('Channel membership snapshot contains duplicates')
  }
  return { membershipRevision: raw.membershipRevision as number, members }
}

function projectChannel(session: ChannelMemberReplicaSession): ChannelMemberProductionChannelView {
  return {
    channelId: session.channelId,
    hostChatId: session.hostChatId,
    memberId: session.memberId,
    displayName: session.displayName,
    title: session.title || 'Channel',
    status: session.status,
    savedAt: session.savedAt,
    updatedAt: session.updatedAt
  }
}

class ChannelMemberProductionServiceImpl implements ChannelMemberProductionService {
  private readonly store: ChannelMemberReplicaStoreLike
  private readonly socketFactory: TransportSocketFactory
  private readonly now: () => number
  private readonly createClient: (options: ChannelMemberClientOptions) => ChannelMemberClientLike
  private identity: KeyPair | null = null
  private client: ChannelMemberClientLike | null = null
  private pendingJoin: PendingJoin | null = null
  private replica: ChannelMemberReplica | null = null
  private phase: ChannelMemberProductionPhase = 'idle'
  private publicError: ChannelMemberProductionSnapshot['error'] = null
  private operationTail: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(private readonly options: ChannelMemberProductionServiceOptions) {
    this.store = (options.createStore ?? ((path) => new ChannelMemberReplicaStore(path)))(
      options.userDataPath
    )
    this.socketFactory = options.socketFactory ?? wsTransportSocketFactory
    this.now = options.now ?? Date.now
    this.createClient =
      options.createClient ?? ((clientOptions) => new ChannelMemberClient(clientOptions))
    try {
      this.replica = this.store.readActive()
      this.phase = this.replica
        ? this.replica.session.status === 'revoked'
          ? 'revoked'
          : 'disconnected'
        : 'idle'
    } catch (error) {
      this.enterRecoveryBlocked(error)
    }
  }

  snapshot(): ChannelMemberProductionSnapshot {
    return clone({
      phase: this.phase,
      connected: this.phase === 'connected' && Boolean(this.client?.isConnected),
      channel: this.replica ? projectChannel(this.replica.session) : null,
      members: this.replica?.session.members ?? [],
      records: this.replica?.records ?? [],
      highWaterSequence: this.replica?.highWaterSequence ?? 0,
      error: this.publicError
    })
  }

  listMemberships(): ChannelMemberProductionMembershipSummary[] {
    const activeChannelId = this.replica?.session.channelId ?? null
    try {
      return this.store.listSessions().map((session) => ({
        ...projectChannel(session),
        active: session.channelId === activeChannelId
      }))
    } catch (error) {
      this.enterRecoveryBlocked(error)
      return []
    }
  }

  beginJoin(input: ChannelMemberProductionJoinInput): Promise<{ confirmCode: string }> {
    return this.enqueue(async () => {
      const normalized = normalizeJoinInput(input, this.now())
      const existing = this.store.read(normalized.channelId)
      const identity = this.loadIdentity(true)
      this.detachClient()
      this.pendingJoin = null
      this.phase = 'connecting'
      this.publicError = null
      this.publish()

      let lastError: unknown = null
      for (const relayUrl of normalized.relayUrls) {
        const client = this.makeClient(identity, existing)
        this.client = client
        try {
          client.connect(relayUrl, normalized.roomId)
          await client.whenConnected(this.options.connectTimeoutMs ?? 10_000)
          this.assertCurrentClient(client)
          const result = await client.beginAdmission({
            channelId: normalized.channelId,
            inviteId: normalized.inviteId,
            inviteToken: normalized.inviteToken,
            displayName: normalized.displayName,
            ...(existing
              ? { expectedHostIdentityPubKeyB64: existing.session.hostIdentityPubKeyB64 }
              : {})
          })
          this.assertCurrentClient(client)
          this.pendingJoin = { input: normalized, client }
          this.phase = 'awaiting_sas'
          this.publish()
          return result
        } catch (error) {
          lastError = error
          if (this.client === client) this.client = null
          client.dispose()
          if (!retryableTransportError(error)) break
          this.options.logger?.(`[channels] member relay attempt failed for ${relayUrl}`)
        }
      }
      const failure = publicRemoteError(lastError)
      this.phase = this.replica ? 'disconnected' : 'idle'
      this.setError(failure)
      throw failure
    })
  }

  confirmJoin(): Promise<ChannelMemberProductionSnapshot> {
    return this.enqueue(async () => {
      const pending = this.pendingJoin
      if (!pending || pending.client !== this.client) {
        throw productionError('not_joined', 'No Channel admission is waiting for SAS confirmation.')
      }
      try {
        const established = await pending.client.confirmAdmission()
        this.assertCurrentClient(pending.client)
        this.replica = this.store.activate({
          channelId: established.channelId,
          hostChatId: pending.input.hostChatId,
          memberId: established.memberId,
          displayName: pending.input.displayName,
          ...(pending.input.title ? { title: pending.input.title } : {}),
          relayUrls: pending.input.relayUrls,
          roomId: pending.input.roomId,
          hostIdentityPubKeyB64: established.hostIdentityPubKeyB64,
          now: this.now()
        })
        this.replica = this.store.updateMembers({
          channelId: established.channelId,
          membershipRevision: established.membershipRevision,
          members: this.replica.session.members,
          now: this.now()
        })
        this.pendingJoin = null
        await pending.client.resume({ resumeAfter: this.replica.highWaterSequence })
        this.assertCurrentClient(pending.client)
        this.replica = this.store.read(established.channelId)!
        this.phase = 'connected'
        this.publicError = null
        this.publish()
        return this.snapshot()
      } catch (error) {
        this.pendingJoin = null
        const failure = this.operationFailure(error)
        if (failure.code === 'revoked' && this.replica) {
          this.replica = this.store.markRevoked(this.replica.session.channelId, this.now())
          this.phase = 'revoked'
        } else if (failure.code === 'recovery_blocked') {
          this.enterRecoveryBlocked(error)
        } else {
          this.phase = this.replica ? 'disconnected' : 'idle'
        }
        this.setError(failure)
        throw failure
      }
    })
  }

  reconnect(channelId?: string): Promise<ChannelMemberProductionSnapshot> {
    return this.enqueue(async () => {
      const replica = channelId ? this.store.setActive(channelId) : this.store.readActive()
      if (!replica) throw productionError('not_joined', 'No saved Channel membership is available.')
      if (replica.session.status === 'revoked') {
        this.detachClient()
        this.pendingJoin = null
        this.replica = replica
        this.phase = 'revoked'
        this.publicError = {
          code: 'revoked',
          message: 'This Channel membership is no longer active.'
        }
        this.publish()
        return this.snapshot()
      }
      this.replica = replica
      const identity = this.loadIdentity(false)
      this.detachClient()
      this.phase = 'connecting'
      this.publicError = null
      this.publish()

      let lastError: unknown = null
      for (const relayUrl of replica.session.relayUrls) {
        const client = this.makeClient(identity, replica)
        this.client = client
        try {
          client.connect(relayUrl, replica.session.roomId)
          await client.whenConnected(this.options.connectTimeoutMs ?? 10_000)
          this.assertCurrentClient(client)
          await client.reconnect({
            channelId: replica.session.channelId,
            memberId: replica.session.memberId,
            expectedHostIdentityPubKeyB64: replica.session.hostIdentityPubKeyB64
          })
          this.assertCurrentClient(client)
          await client.resume({ resumeAfter: replica.highWaterSequence })
          this.assertCurrentClient(client)
          this.replica = this.store.read(replica.session.channelId)!
          this.phase = 'connected'
          this.publicError = null
          this.publish()
          return this.snapshot()
        } catch (error) {
          lastError = error
          if (this.client === client) this.client = null
          client.dispose()
          if (!retryableTransportError(error)) break
          this.options.logger?.(`[channels] member reconnect relay failed for ${relayUrl}`)
        }
      }

      const failure = this.operationFailure(lastError)
      if (failure.code === 'revoked') {
        this.replica = this.store.markRevoked(replica.session.channelId, this.now())
        this.phase = 'revoked'
      } else if (failure.code === 'recovery_blocked') {
        this.enterRecoveryBlocked(lastError)
      } else {
        this.phase = 'disconnected'
      }
      this.setError(failure)
      throw failure
    })
  }

  append(input: {
    content: string
    clientMessageId: string
  }): Promise<{ record: ChannelMessage; deduplicated: boolean }> {
    return this.enqueue(async () => {
      const client = this.requireEstablishedClient()
      const content = normalizeMessageText(input?.content)
      const clientMessageId = normalizeClientMessageId(input?.clientMessageId)
      try {
        const result = await client.append(content, clientMessageId)
        this.assertCurrentClient(client)
        if (!this.replica) throw productionError('not_joined', 'No Channel membership is active.')
        this.replica = this.store.appendRecords(this.replica.session.channelId, [result.record])
        this.publish()
        return { record: clone(result.record), deduplicated: result.deduplicated }
      } catch (error) {
        const failure = this.operationFailure(error)
        this.setError(failure)
        throw failure
      }
    })
  }

  resume(): Promise<ChannelMemberProductionSnapshot> {
    return this.enqueue(async () => {
      const client = this.requireEstablishedClient()
      if (!this.replica) throw productionError('not_joined', 'No Channel membership is active.')
      try {
        await client.resume({ resumeAfter: this.replica.highWaterSequence })
        this.assertCurrentClient(client)
        this.replica = this.store.read(this.replica.session.channelId)!
        this.phase = 'connected'
        this.publicError = null
        this.publish()
        return this.snapshot()
      } catch (error) {
        const failure = this.operationFailure(error)
        this.setError(failure)
        throw failure
      }
    })
  }

  disconnect(): void {
    this.pendingJoin = null
    this.detachClient()
    if (this.phase === 'recovery_blocked') {
      this.publish()
      return
    }
    this.phase = this.replica
      ? this.replica.session.status === 'revoked'
        ? 'revoked'
        : 'disconnected'
      : 'idle'
    this.publicError = null
    this.publish()
  }

  resetLocalHistory(channelId?: string): ChannelMemberProductionSnapshot {
    const target = channelId ?? this.replica?.session.channelId
    if (!target) {
      throw productionError('not_joined', 'Choose a saved Channel membership to reset.')
    }
    try {
      if (this.replica?.session.channelId === target) this.detachClient()
      this.replica = this.store.resetRecords(target)
      this.replica = this.store.setActive(target)
      this.pendingJoin = null
      this.phase = this.replica.session.status === 'revoked' ? 'revoked' : 'disconnected'
      this.publicError = null
      this.publish()
      return this.snapshot()
    } catch (error) {
      this.enterRecoveryBlocked(error)
      throw publicRemoteError(error)
    }
  }

  forget(channelId?: string): void {
    try {
      const target = channelId ?? this.replica?.session.channelId
      if (!target) {
        if (this.phase !== 'recovery_blocked') return
        this.detachClient()
        this.store.forgetAll()
        this.replica = null
        this.pendingJoin = null
        this.phase = 'idle'
        this.publicError = null
        this.publish()
        return
      }
      if (this.replica?.session.channelId === target) this.detachClient()
      this.store.forget(target)
      this.replica = this.store.readActive()
      this.pendingJoin = null
      this.phase = this.replica
        ? this.replica.session.status === 'revoked'
          ? 'revoked'
          : 'disconnected'
        : 'idle'
      this.publicError = null
      this.publish()
    } catch (error) {
      this.enterRecoveryBlocked(error)
      throw publicRemoteError(error)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pendingJoin = null
    this.detachClient()
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationTail.then(async () => {
      if (this.disposed)
        throw productionError('not_connected', 'Channel member service has stopped.')
      try {
        return await operation()
      } catch (error) {
        if (error instanceof ChannelMemberReplicaError) {
          this.enterRecoveryBlocked(error)
          throw publicRemoteError(error)
        }
        throw error
      }
    })
    this.operationTail = run.catch(() => undefined)
    return run
  }

  private loadIdentity(create: boolean): KeyPair {
    if (this.identity) return this.identity
    const path = this.store.dataPaths().identity
    if (!create && !existsSync(path)) {
      throw productionError(
        'identity_unavailable',
        'The saved Channel identity is missing, so this membership cannot reconnect.'
      )
    }
    try {
      this.identity = new HumanCollaborationIdentityStore(path, this.options.safeStorage, (line) =>
        this.options.logger?.(line.replace('[human-collaboration]', '[channels]'))
      ).load()
      return this.identity
    } catch {
      throw productionError(
        'identity_unavailable',
        'The encrypted Channel identity is unavailable, so this membership cannot continue.'
      )
    }
  }

  private makeClient(
    identity: KeyPair,
    replica: ChannelMemberReplica | null
  ): ChannelMemberClientLike {
    const client = this.createClient({
      socketFactory: this.socketFactory,
      identity,
      ...(replica
        ? { initialRecords: replica.records, initialCursor: replica.highWaterSequence }
        : {}),
      onMembersSnapshot: (snapshot) => {
        if (this.client !== client || !this.replica) return
        try {
          const parsed = parseMembersSnapshot(snapshot, this.replica.session.channelId)
          this.replica = this.store.updateMembers({
            channelId: this.replica.session.channelId,
            ...parsed,
            now: this.now()
          })
          this.publish()
        } catch (error) {
          this.enterRecoveryBlocked(error)
        }
      },
      onRecords: (records) => {
        if (this.client !== client || !this.replica || records.length === 0) return
        try {
          this.replica = this.store.appendRecords(this.replica.session.channelId, records)
          this.publish()
        } catch (error) {
          this.enterRecoveryBlocked(error)
        }
      },
      onRevoked: () => {
        if (this.client !== client || !this.replica) return
        try {
          this.replica = this.store.markRevoked(this.replica.session.channelId, this.now())
          this.phase = 'revoked'
          this.publicError = {
            code: 'revoked',
            message: 'This Channel membership is no longer active.'
          }
          this.detachClient()
          this.publish()
        } catch (error) {
          this.enterRecoveryBlocked(error)
        }
      },
      onConnectionChange: (connected) => {
        if (this.client !== client || connected || this.phase === 'recovery_blocked') return
        if (this.phase === 'connected') {
          this.phase = this.replica?.session.status === 'revoked' ? 'revoked' : 'disconnected'
          this.publish()
        }
      },
      onError: (error) => {
        if (this.client !== client || this.phase === 'recovery_blocked') return
        const failure = publicRemoteError(error)
        this.detachClient()
        this.phase = this.replica ? 'disconnected' : 'idle'
        this.setError(failure)
      }
    })
    return client
  }

  private requireEstablishedClient(): ChannelMemberClientLike {
    if (!this.replica) throw productionError('not_joined', 'No Channel membership is active.')
    if (this.replica.session.status === 'revoked') {
      throw productionError('revoked', 'This Channel membership is no longer active.')
    }
    if (!this.client?.isConnected || !this.client.isEstablished || this.phase !== 'connected') {
      throw productionError('not_connected', 'Reconnect to the Channel before posting.')
    }
    return this.client
  }

  private assertCurrentClient(client: ChannelMemberClientLike): void {
    if (this.disposed || this.client !== client || !client.isConnected) {
      throw productionError('not_connected', 'The Channel connection ended before completion.')
    }
  }

  private operationFailure(error: unknown): ChannelMemberProductionError {
    if (this.phase === 'recovery_blocked') {
      return productionError(
        'recovery_blocked',
        this.publicError?.message ||
          'This Mac’s durable Channel replica needs recovery before it can continue.'
      )
    }
    return publicRemoteError(error)
  }

  private enterRecoveryBlocked(error: unknown): void {
    this.options.logger?.(
      `[channels] member replica recovery blocked: ${
        error instanceof Error ? error.message : 'unknown error'
      }`
    )
    this.detachClient()
    this.phase = 'recovery_blocked'
    this.publicError = {
      code: 'recovery_blocked',
      message: 'This Mac’s durable Channel replica needs recovery before it can continue.'
    }
    this.publish()
  }

  private setError(error: ChannelMemberProductionError): void {
    this.publicError = { code: error.code, message: error.message }
    this.publish()
  }

  private detachClient(): void {
    const client = this.client
    this.client = null
    client?.dispose()
  }

  private publish(): void {
    if (this.disposed) return
    try {
      this.options.onChange?.(this.snapshot())
    } catch {
      this.options.logger?.('[channels] member projection publication failed')
    }
  }
}

export function createChannelMemberProductionService(
  options: ChannelMemberProductionServiceOptions
): ChannelMemberProductionService {
  if (!options || typeof options !== 'object') {
    throw new Error('ChannelMemberProductionService requires an options object')
  }
  if (typeof options.userDataPath !== 'string' || !options.userDataPath.trim()) {
    throw new Error('ChannelMemberProductionService requires an injected userDataPath')
  }
  if (!options.safeStorage || typeof options.safeStorage !== 'object') {
    throw new Error('ChannelMemberProductionService requires safeStorage')
  }
  if (options.socketFactory !== undefined && typeof options.socketFactory !== 'function') {
    throw new Error('ChannelMemberProductionService socketFactory must be a function')
  }
  if (options.createClient !== undefined && typeof options.createClient !== 'function') {
    throw new Error('ChannelMemberProductionService createClient must be a function')
  }
  if (options.createStore !== undefined && typeof options.createStore !== 'function') {
    throw new Error('ChannelMemberProductionService createStore must be a function')
  }
  return new ChannelMemberProductionServiceImpl(options)
}
