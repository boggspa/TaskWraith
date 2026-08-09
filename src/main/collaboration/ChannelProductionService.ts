import { join, resolve as resolvePath } from 'path'
import type { KeyPair } from '../../shared/e2ee/keys'
import type { TransportSocketFactory } from '../remote/RemoteTransportClient'
import { wsTransportSocketFactory } from '../remote/wsTransportSocket'
import {
  ChannelAuditLog,
  type ChannelAuditEvent,
  type ChannelAuditInput,
  type ChannelAuditLike
} from './ChannelAuditLog'
import { ChannelHostTransport } from './ChannelHostTransport'
import {
  ChannelMessageLog,
  type ChannelAppendResult,
  type ChannelMessage
} from './ChannelMessageLog'
import { ChannelRuntime, type ChannelRuntimeOptions } from './ChannelRuntime'
import {
  ChannelError,
  ChannelStore,
  type Channel,
  type ChannelMember,
  type TaskWraithReference
} from './ChannelStore'

export interface ChannelProductionDataPaths {
  root: string
  metadata: string
  logs: string
  audit: string
}

export interface ChannelProductionRelayPort {
  hostRelayUrl: () => string
  inviteRelayUrls: () => readonly string[]
}

export interface ChannelProductionServiceOptions {
  userDataPath: string
  loadIdentity: () => KeyPair
  relay: ChannelProductionRelayPort
  socketFactory?: TransportSocketFactory
  logger?: (line: string) => void
  now?: () => number
  onAdmissionBegan?: ChannelRuntimeOptions['onAdmissionBegan']
  onChange?: (event: ChannelProductionChangeEvent) => void
}

export interface ChannelProductionChangeEvent {
  channelId: string
  reason: 'channel' | 'membership' | 'message'
}

export type ChannelProductionAvailability = 'ready' | 'recovery_blocked'

export interface ChannelProductionChannelView extends Channel {
  availability: ChannelProductionAvailability
}

export type ChannelProductionMemberView = Pick<
  ChannelMember,
  'memberId' | 'channelId' | 'kind' | 'displayName' | 'status' | 'joinedAt' | 'revokedAt'
>

export interface ChannelProductionReadResult {
  channel: ChannelProductionChannelView
  members: ChannelProductionMemberView[]
  records: ChannelMessage[]
  highWaterSequence: number
}

export interface ChannelProductionInviteResult {
  channelId: string
  inviteId: string
  inviteToken: string
  roomId: string
  expiresAt: number
  relayUrls: string[]
  hostRoomOpened: boolean
}

export interface ChannelProductionStatus {
  state: 'idle' | 'running' | 'stopping' | 'stopped'
  channelCount: number
  recoveryBlockedChannelCount: number
  openRoomCount: number
}

export interface ChannelProductionService {
  start(): ChannelProductionStatus
  stop(): Promise<void>
  status(): ChannelProductionStatus
  hostIdentityPublicKey(): string
  refreshRelayRooms(): number
  listChannels(): ChannelProductionChannelView[]
  readChannel(args: {
    channelId: string
    resumeAfter: number
    maxRecords?: number
    maxBytes?: number
  }): ChannelProductionReadResult
  listAudit(args?: { channelId?: string; limit?: number }): ChannelAuditEvent[]
  createChannel(args: {
    chatId: string
    title: string
    ownerDisplayName: string
    reference?: TaskWraithReference
  }): ChannelProductionChannelView
  issueInvite(args: { channelId: string; ttlMs?: number }): ChannelProductionInviteResult
  appendHost(args: {
    channelId: string
    clientMessageId: string
    content: string
  }): Promise<ChannelAppendResult>
  revokeMember(args: { channelId: string; memberId: string }): Promise<ChannelProductionMemberView>
  closeChannel(channelId: string): Promise<ChannelProductionChannelView>
}

interface RunningState {
  store: ChannelStore
  log: ChannelMessageLog
  audit: ChannelAuditLog
  runtime: ChannelRuntime
  transport: ChannelHostTransport
  recoveryBlockedChannelIds: Set<string>
}

const SERVICE_REGISTRY = new Map<string, ChannelProductionServiceImpl>()

export function channelProductionDataPaths(userDataPath: string): ChannelProductionDataPaths {
  const root = join(resolvePath(userDataPath), 'channels')
  return {
    root,
    metadata: join(root, 'channels.json'),
    logs: join(root, 'logs'),
    audit: join(root, 'audit.json')
  }
}

export function createChannelProductionService(
  options: ChannelProductionServiceOptions
): ChannelProductionService {
  validateOptions(options)
  const paths = channelProductionDataPaths(options.userDataPath)
  const existing = SERVICE_REGISTRY.get(paths.root)
  if (existing) return existing
  const service = new ChannelProductionServiceImpl(options, paths, () => {
    if (SERVICE_REGISTRY.get(paths.root) === service) SERVICE_REGISTRY.delete(paths.root)
  })
  SERVICE_REGISTRY.set(paths.root, service)
  return service
}

function validateOptions(options: ChannelProductionServiceOptions): void {
  if (!options || typeof options !== 'object') {
    throw new Error('ChannelProductionService requires an options object')
  }
  if (typeof options.userDataPath !== 'string' || !options.userDataPath.trim()) {
    throw new Error('ChannelProductionService requires an injected userDataPath')
  }
  if (typeof options.loadIdentity !== 'function') {
    throw new Error('ChannelProductionService requires an identity loader')
  }
  if (!options.relay || typeof options.relay !== 'object') {
    throw new Error('ChannelProductionService requires an injected relay port')
  }
  if (typeof options.relay.hostRelayUrl !== 'function') {
    throw new Error('ChannelProductionService requires relay.hostRelayUrl')
  }
  if (typeof options.relay.inviteRelayUrls !== 'function') {
    throw new Error('ChannelProductionService requires relay.inviteRelayUrls')
  }
  if (options.socketFactory !== undefined && typeof options.socketFactory !== 'function') {
    throw new Error('ChannelProductionService socketFactory must be a function')
  }
  if (options.logger !== undefined && typeof options.logger !== 'function') {
    throw new Error('ChannelProductionService logger must be a function')
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new Error('ChannelProductionService now must be a function')
  }
  if (options.onAdmissionBegan !== undefined && typeof options.onAdmissionBegan !== 'function') {
    throw new Error('ChannelProductionService onAdmissionBegan must be a function')
  }
  if (options.onChange !== undefined && typeof options.onChange !== 'function') {
    throw new Error('ChannelProductionService onChange must be a function')
  }
}

function normalizeRelayUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = new URL(value.trim())
    if (
      (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return null
    }
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function memberView(member: ChannelMember): ChannelProductionMemberView {
  return {
    memberId: member.memberId,
    channelId: member.channelId,
    kind: member.kind,
    displayName: member.displayName,
    status: member.status,
    joinedAt: member.joinedAt,
    ...(member.revokedAt === undefined ? {} : { revokedAt: member.revokedAt })
  }
}

function recoveryCode(error: unknown): boolean {
  return error instanceof ChannelError && error.code === 'recovery_blocked'
}

class ChannelProductionServiceImpl implements ChannelProductionService {
  private readonly now: () => number
  private state: RunningState | null = null
  private stopping = false
  private stopped = false
  private stopPromise: Promise<void> | null = null
  private readonly inFlight = new Set<Promise<unknown>>()
  private readonly channelTails = new Map<string, Promise<void>>()
  private readonly closingChannelIds = new Set<string>()

  constructor(
    private readonly options: ChannelProductionServiceOptions,
    private readonly paths: ChannelProductionDataPaths,
    private readonly releaseRegistry: () => void
  ) {
    this.now = options.now ?? Date.now
  }

  start(): ChannelProductionStatus {
    if (this.stopped || this.stopping) {
      throw new ChannelError('host_unavailable', 'Channels service has stopped')
    }
    if (this.state) return this.status()

    const store = new ChannelStore(this.paths.metadata)
    const log = new ChannelMessageLog(this.paths.logs, store)
    const audit = new ChannelAuditLog(this.paths.audit)
    const recoveryBlockedChannelIds = new Set<string>()
    for (const channel of store.listChannels()) {
      try {
        store.getDisplayEnvelope(channel.channelId)
        log.highWaterSequence(channel.channelId)
      } catch (error) {
        if (!recoveryCode(error)) throw error
        recoveryBlockedChannelIds.add(channel.channelId)
        this.options.logger?.(
          `[channels] recovery blocked for channel ${channel.channelId.slice(0, 64)}`
        )
      }
    }

    const auditSink: ChannelAuditLike = {
      append: (event) => {
        audit.append(event)
        this.notifyAuditChange(event)
      }
    }
    const runtime = new ChannelRuntime({
      identityKeyPair: this.options.loadIdentity(),
      store,
      log,
      audit: auditSink,
      now: this.now,
      ...(this.options.logger ? { logger: this.options.logger } : {}),
      ...(this.options.onAdmissionBegan ? { onAdmissionBegan: this.options.onAdmissionBegan } : {})
    })
    const transport = new ChannelHostTransport({
      socketFactory: this.options.socketFactory ?? wsTransportSocketFactory,
      runtime,
      ...(this.options.logger ? { logger: this.options.logger } : {})
    })
    this.state = { store, log, audit, runtime, transport, recoveryBlockedChannelIds }
    this.refreshRelayRooms()
    return this.status()
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopping = true
    this.stopPromise = this.stopInternal()
    return this.stopPromise
  }

  status(): ChannelProductionStatus {
    if (this.stopped) {
      return {
        state: 'stopped',
        channelCount: 0,
        recoveryBlockedChannelCount: 0,
        openRoomCount: 0
      }
    }
    if (this.stopping) {
      return {
        state: 'stopping',
        channelCount: this.state?.store.listChannels().length ?? 0,
        recoveryBlockedChannelCount: this.state?.recoveryBlockedChannelIds.size ?? 0,
        openRoomCount: this.state?.transport.listOpenRooms().length ?? 0
      }
    }
    if (!this.state) {
      return {
        state: 'idle',
        channelCount: 0,
        recoveryBlockedChannelCount: 0,
        openRoomCount: 0
      }
    }
    return {
      state: 'running',
      channelCount: this.state.store.listChannels().length,
      recoveryBlockedChannelCount: this.state.recoveryBlockedChannelIds.size,
      openRoomCount: this.state.transport.listOpenRooms().length
    }
  }

  hostIdentityPublicKey(): string {
    return this.requireRunning().runtime.hostIdentityPublicKey()
  }

  refreshRelayRooms(): number {
    const state = this.requireRunning()
    const hostRelayUrl = this.hostRelayUrl()
    if (!hostRelayUrl) return 0
    const openBefore = new Set(state.transport.listOpenRooms().map((room) => room.roomId))
    let opened = 0
    for (const binding of state.runtime.listRoomBindings()) {
      if (state.recoveryBlockedChannelIds.has(binding.channelId)) continue
      try {
        state.transport.openRoom(binding.channelId, binding.roomId, hostRelayUrl)
        if (!openBefore.has(binding.roomId)) opened += 1
      } catch (error) {
        this.options.logger?.(
          `[channels] relay room open failed: ${
            error instanceof Error ? error.message.slice(0, 160) : 'unknown error'
          }`
        )
      }
    }
    return opened
  }

  listChannels(): ChannelProductionChannelView[] {
    const state = this.requireRunning()
    return state.store.listChannels().map((channel) => this.channelView(channel, state))
  }

  readChannel(args: {
    channelId: string
    resumeAfter: number
    maxRecords?: number
    maxBytes?: number
  }): ChannelProductionReadResult {
    const state = this.requireReadyChannel(args.channelId)
    const channel = state.store.getChannel(args.channelId)
    if (!channel) throw new ChannelError('not_member', 'Channel was not found')
    const replay = state.log.replay({
      channelId: channel.channelId,
      resumeAfter: args.resumeAfter,
      ...(args.maxRecords === undefined ? {} : { maxRecords: args.maxRecords }),
      ...(args.maxBytes === undefined ? {} : { maxBytes: args.maxBytes })
    })
    return {
      channel: this.channelView(channel, state),
      members: state.store.listMembers(channel.channelId).map(memberView),
      records: replay.records,
      highWaterSequence: replay.highWaterSequence
    }
  }

  listAudit(args?: { channelId?: string; limit?: number }): ChannelAuditEvent[] {
    return this.requireRunning().audit.list(args)
  }

  createChannel(args: {
    chatId: string
    title: string
    ownerDisplayName: string
    reference?: TaskWraithReference
  }): ChannelProductionChannelView {
    const state = this.requireRunning()
    const created = state.runtime.createChannel({
      chatId: args.chatId,
      title: args.title,
      ownerDisplayName: args.ownerDisplayName,
      ...(args.reference ? { reference: args.reference } : {}),
      now: this.now()
    })
    return this.channelView(created.channel, state)
  }

  issueInvite(args: { channelId: string; ttlMs?: number }): ChannelProductionInviteResult {
    const state = this.requireReadyChannel(args.channelId)
    const hostRelayUrl = this.hostRelayUrl()
    if (!hostRelayUrl) {
      throw new ChannelError('host_unavailable', 'A host relay is not available')
    }
    const relayUrls = this.inviteRelayUrls(hostRelayUrl)
    if (relayUrls.length === 0) {
      throw new ChannelError('host_unavailable', 'No usable invite relay URL is available')
    }
    const issued = state.runtime.createInvite({
      channelId: args.channelId,
      ...(args.ttlMs === undefined ? {} : { ttlMs: args.ttlMs }),
      now: this.now()
    })
    let hostRoomOpened = true
    try {
      state.transport.openRoom(args.channelId, issued.invite.roomId, hostRelayUrl)
    } catch (error) {
      hostRoomOpened = false
      this.options.logger?.(
        `[channels] issued invite but host room open failed: ${
          error instanceof Error ? error.message.slice(0, 160) : 'unknown error'
        }`
      )
    }
    return {
      channelId: args.channelId,
      inviteId: issued.invite.inviteId,
      inviteToken: issued.inviteToken,
      roomId: issued.invite.roomId,
      expiresAt: issued.invite.expiresAt,
      relayUrls,
      hostRoomOpened
    }
  }

  appendHost(args: {
    channelId: string
    clientMessageId: string
    content: string
  }): Promise<ChannelAppendResult> {
    const state = this.requireReadyChannel(args.channelId)
    return this.track(
      this.enqueueChannel(args.channelId, () =>
        state.runtime.appendHost(args.channelId, {
          clientMessageId: args.clientMessageId,
          content: args.content,
          kind: 'human.text',
          now: this.now()
        })
      )
    )
  }

  revokeMember(args: {
    channelId: string
    memberId: string
  }): Promise<ChannelProductionMemberView> {
    const state = this.requireReadyChannel(args.channelId)
    return this.track(
      this.enqueueChannel(args.channelId, () =>
        state.runtime
          .revokeMember({ channelId: args.channelId, memberId: args.memberId, now: this.now() })
          .then(memberView)
      )
    )
  }

  closeChannel(channelId: string): Promise<ChannelProductionChannelView> {
    const state = this.requireReadyChannel(channelId)
    this.closingChannelIds.add(channelId)
    return this.track(
      this.enqueueChannel(channelId, async () => {
        try {
          const roomIds = state.runtime
            .listRoomBindings()
            .filter((binding) => binding.channelId === channelId)
            .map((binding) => binding.roomId)
          const closed = state.store.closeChannel({ channelId, now: this.now() })
          for (const roomId of roomIds) state.transport.close(roomId)
          this.notifyChange({ channelId, reason: 'channel' })
          return this.channelView(closed, state)
        } finally {
          this.closingChannelIds.delete(channelId)
        }
      })
    )
  }

  private async stopInternal(): Promise<void> {
    try {
      await Promise.allSettled([...this.inFlight])
      const state = this.state
      this.state = null
      if (state) {
        try {
          state.transport.dispose()
        } finally {
          state.runtime.dispose()
        }
      }
    } finally {
      this.stopping = false
      this.stopped = true
      this.releaseRegistry()
    }
  }

  private requireRunning(): RunningState {
    if (!this.state || this.stopping || this.stopped) {
      throw new ChannelError('host_unavailable', 'Channels service is not running')
    }
    return this.state
  }

  private requireReadyChannel(channelId: string): RunningState {
    const state = this.requireRunning()
    if (!state.store.getChannel(channelId)) {
      throw new ChannelError('not_member', 'Channel was not found')
    }
    if (this.closingChannelIds.has(channelId)) {
      throw new ChannelError('channel_closed', 'Channel is closing')
    }
    if (state.recoveryBlockedChannelIds.has(channelId)) {
      throw new ChannelError('recovery_blocked', 'Channel history could not be recovered safely')
    }
    return state
  }

  private channelView(channel: Channel, state: RunningState): ChannelProductionChannelView {
    return {
      ...channel,
      availability: state.recoveryBlockedChannelIds.has(channel.channelId)
        ? 'recovery_blocked'
        : 'ready'
    }
  }

  private hostRelayUrl(): string | null {
    try {
      return normalizeRelayUrl(this.options.relay.hostRelayUrl())
    } catch {
      return null
    }
  }

  private inviteRelayUrls(hostRelayUrl: string): string[] {
    let candidates: readonly string[] = []
    try {
      const supplied = this.options.relay.inviteRelayUrls()
      if (Array.isArray(supplied)) candidates = supplied
    } catch {
      candidates = []
    }
    return [
      ...new Set(
        [...candidates, hostRelayUrl]
          .map(normalizeRelayUrl)
          .filter((value): value is string => value !== null)
      )
    ]
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    if (this.stopping || this.stopped) {
      throw new ChannelError('host_unavailable', 'Channels service is stopping')
    }
    this.inFlight.add(operation)
    void operation.then(
      () => this.inFlight.delete(operation),
      () => this.inFlight.delete(operation)
    )
    return operation
  }

  private enqueueChannel<T>(channelId: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.channelTails.get(channelId) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.channelTails.set(channelId, tail)
    void tail.then(() => {
      if (this.channelTails.get(channelId) === tail) this.channelTails.delete(channelId)
    })
    return result
  }

  private notifyAuditChange(event: ChannelAuditInput): void {
    if (!event.channelId) return
    if (event.kind === 'channel.created') {
      this.notifyChange({ channelId: event.channelId, reason: 'channel' })
      return
    }
    if (
      event.kind === 'invite.created' ||
      event.kind === 'admission.confirmed' ||
      event.kind === 'member.revoked'
    ) {
      this.notifyChange({ channelId: event.channelId, reason: 'membership' })
      return
    }
    if (event.kind === 'message.accepted') {
      this.notifyChange({ channelId: event.channelId, reason: 'message' })
    }
  }

  private notifyChange(event: ChannelProductionChangeEvent): void {
    try {
      this.options.onChange?.(event)
    } catch {
      this.options.logger?.('[channels] change listener failed')
    }
  }
}
