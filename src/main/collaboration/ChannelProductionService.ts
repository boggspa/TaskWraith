import { createHash } from 'crypto'
import { join, resolve as resolvePath } from 'path'
import { importRawEd25519PublicKey, type KeyPair } from '../../shared/e2ee/keys'
import type { TransportSocketFactory } from '../remote/RemoteTransportClient'
import { wsTransportSocketFactory } from '../remote/wsTransportSocket'
import {
  ChannelAuditLog,
  type ChannelAuditEvent,
  type ChannelAuditInput,
  type ChannelAuditLike
} from './ChannelAuditLog'
import { ChannelAgentAuthorityStore } from './ChannelAgentAuthorityStore'
import {
  ChannelAgentManagementService,
  type ChannelAgentDispatchGrantResult,
  type ChannelAgentEnrollmentResult,
  type ChannelAgentRevocationResult,
  type ChannelAgentRotationResult
} from './ChannelAgentManagementService'
import {
  ChannelAgentIdentityStore,
  type ChannelAgentIdentitySafeStorage
} from './ChannelAgentIdentityStore'
import { admitAcceptedChannelAgentMentions } from './ChannelAgentMentionAdmission'
import type { ChannelAgentSeatCandidate } from './ChannelAgentSeatAuthority'
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
  type AgentChannelMember,
  type Channel,
  type ChannelMember,
  type TaskWraithReference
} from './ChannelStore'

export interface ChannelProductionDataPaths {
  root: string
  metadata: string
  logs: string
  audit: string
  agentIdentities: string
  agentAuthority: string
}

export interface ChannelProductionRelayPort {
  hostRelayUrl: () => string
  inviteRelayUrls: () => readonly string[]
}

export interface ChannelProductionServiceOptions {
  userDataPath: string
  loadIdentity: () => KeyPair
  safeStorage: ChannelAgentIdentitySafeStorage
  relay: ChannelProductionRelayPort
  socketFactory?: TransportSocketFactory
  logger?: (line: string) => void
  now?: () => number
  onAdmissionBegan?: ChannelRuntimeOptions['onAdmissionBegan']
  onChange?: (event: ChannelProductionChangeEvent) => void
}

export interface ChannelProductionChangeEvent {
  channelId: string
  /** Main-process routing authority. Never project this field to a renderer. */
  chatId: string
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

export interface ChannelProductionPendingAdmissionView {
  channelId: string
  memberId: string
  displayName: string
  confirmCode: string
  expiresAt: number
}

export interface ChannelProductionReadResult {
  channel: ChannelProductionChannelView
  members: ChannelProductionMemberView[]
  pendingAdmissions: ChannelProductionPendingAdmissionView[]
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

export type ChannelProductionHistoryDeletionScope =
  | { kind: 'chat' | 'workspace' | 'truncate'; chatIds: readonly string[] }
  | { kind: 'global' }

export interface ChannelProductionHistoryDeletionResult {
  kind: ChannelProductionHistoryDeletionScope['kind']
  purgedChannelIds: string[]
  preservedChannelIds: string[]
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
  enrollAgent(args: {
    channelId: string
    seat: Pick<ChannelAgentSeatCandidate, 'agentSeatId' | 'displayName'>
    operationId: string
  }): Promise<ChannelAgentEnrollmentResult>
  grantAgentDispatch(args: {
    channelId: string
    agentSeatId: string
    operationId: string
    allowedMentionerMemberIds: readonly string[]
    workspaceIdentityHash: string
    permissionPostureHash: string
    ttlMs?: number
    maxDispatches?: number
  }): Promise<ChannelAgentDispatchGrantResult>
  revokeAgent(args: {
    channelId: string
    agentSeatId: string
    operationId: string
  }): Promise<ChannelAgentRevocationResult>
  rotateAgentKey(args: {
    agentSeatId: string
    operationId: string
    reEnrollChannelIds?: readonly string[]
  }): Promise<ChannelAgentRotationResult>
  closeChannel(channelId: string): Promise<ChannelProductionChannelView>
  purgeForHistoryDeletionScope(
    scope: ChannelProductionHistoryDeletionScope
  ): Promise<ChannelProductionHistoryDeletionResult>
}

interface RunningState {
  store: ChannelStore
  log: ChannelMessageLog
  audit: ChannelAuditLog
  agentIdentities: ChannelAgentIdentityStore
  agentAuthority: ChannelAgentAuthorityStore
  agentManagement: ChannelAgentManagementService
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
    audit: join(root, 'audit.json'),
    agentIdentities: join(root, 'agent-identities'),
    agentAuthority: join(root, 'agent-authority')
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
  if (!options.safeStorage || typeof options.safeStorage !== 'object') {
    throw new Error('ChannelProductionService requires injected safeStorage')
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
  private agentManagementTail: Promise<void> = Promise.resolve()
  private readonly closingChannelIds = new Set<string>()
  private readonly pendingAdmissions = new Map<string, ChannelProductionPendingAdmissionView>()
  private readonly pendingAdmissionTimers = new Map<string, ReturnType<typeof setTimeout>>()

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
    const agentIdentities = new ChannelAgentIdentityStore({
      storageDirectory: this.paths.agentIdentities,
      safeStorage: this.options.safeStorage,
      now: this.now,
      ...(this.options.logger ? { logger: this.options.logger } : {})
    })
    const agentAuthority = new ChannelAgentAuthorityStore({
      storageDirectory: this.paths.agentAuthority,
      resolveOwnerPublicKey: (channelId, ownerMemberId) => {
        const channel = store.getChannel(channelId)
        const owner = store.getMember(channelId, ownerMemberId)
        if (
          !channel ||
          channel.ownerMemberId !== ownerMemberId ||
          !owner ||
          owner.kind !== 'human'
        ) {
          return null
        }
        try {
          return importRawEd25519PublicKey(Buffer.from(owner.identityPublicKey, 'base64'))
        } catch {
          return null
        }
      },
      now: this.now,
      ...(this.options.logger ? { logger: this.options.logger } : {})
    })
    const log = new ChannelMessageLog(this.paths.logs, store, undefined, agentAuthority)
    const audit = new ChannelAuditLog(this.paths.audit)
    const agentManagement = new ChannelAgentManagementService({
      channels: store,
      identities: agentIdentities,
      authority: agentAuthority,
      loadOwnerIdentity: this.options.loadIdentity,
      now: this.now
    })
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
        this.reconcilePendingAdmission(event, store)
        this.notifyAuditChange(event, store)
      }
    }
    const runtime = new ChannelRuntime({
      identityKeyPair: this.options.loadIdentity(),
      store,
      log,
      audit: auditSink,
      now: this.now,
      ...(this.options.logger ? { logger: this.options.logger } : {}),
      onAdmissionBegan: (info) => this.recordPendingAdmission(info, store),
      afterDurableCommit: (result) =>
        this.recordAcceptedAgentMentionAdmission(result, store, auditSink)
    })
    const transport = new ChannelHostTransport({
      socketFactory: this.options.socketFactory ?? wsTransportSocketFactory,
      runtime,
      ...(this.options.logger ? { logger: this.options.logger } : {})
    })
    this.state = {
      store,
      log,
      audit,
      agentIdentities,
      agentAuthority,
      agentManagement,
      runtime,
      transport,
      recoveryBlockedChannelIds
    }
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
      if (this.closingChannelIds.has(binding.channelId)) continue
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
      pendingAdmissions: this.listPendingAdmissions(channel.channelId),
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
        Promise.resolve().then(() => {
          const member = state.store.getMember(args.channelId, args.memberId)
          if (member?.kind === 'agent') {
            throw new ChannelError('human_only', 'Agent removal requires signed owner revocation')
          }
          return state.runtime
            .revokeMember({ channelId: args.channelId, memberId: args.memberId, now: this.now() })
            .then(memberView)
        })
      )
    )
  }

  enrollAgent(args: {
    channelId: string
    seat: Pick<ChannelAgentSeatCandidate, 'agentSeatId' | 'displayName'>
    operationId: string
  }): Promise<ChannelAgentEnrollmentResult> {
    const state = this.requireReadyChannel(args.channelId)
    return this.track(
      this.enqueueAgentManagement(() =>
        this.enqueueChannel(args.channelId, () => {
          const result = state.agentManagement.enrollAgent(args)
          this.notifyMembershipChange(state, args.channelId)
          return result
        })
      )
    )
  }

  grantAgentDispatch(args: {
    channelId: string
    agentSeatId: string
    operationId: string
    allowedMentionerMemberIds: readonly string[]
    workspaceIdentityHash: string
    permissionPostureHash: string
    ttlMs?: number
    maxDispatches?: number
  }): Promise<ChannelAgentDispatchGrantResult> {
    const state = this.requireReadyChannel(args.channelId)
    return this.track(
      this.enqueueAgentManagement(() =>
        this.enqueueChannel(args.channelId, () => {
          const result = state.agentManagement.grantDispatch(args)
          this.notifyMembershipChange(state, args.channelId)
          return result
        })
      )
    )
  }

  revokeAgent(args: {
    channelId: string
    agentSeatId: string
    operationId: string
  }): Promise<ChannelAgentRevocationResult> {
    const state = this.requireReadyChannel(args.channelId)
    return this.track(
      this.enqueueAgentManagement(() =>
        this.enqueueChannel(args.channelId, () => {
          const result = state.agentManagement.revokeAgent(args)
          this.notifyMembershipChange(state, args.channelId)
          return result
        })
      )
    )
  }

  rotateAgentKey(args: {
    agentSeatId: string
    operationId: string
    reEnrollChannelIds?: readonly string[]
  }): Promise<ChannelAgentRotationResult> {
    const state = this.requireRunning()
    return this.track(
      this.enqueueAgentManagement(async () => {
        const channels = state.store.listChannels()
        const blockedTarget = channels.find(
          (channel) =>
            state.recoveryBlockedChannelIds.has(channel.channelId) &&
            state.store
              .listMembers(channel.channelId)
              .some((member) => member.kind === 'agent' && member.agentSeatId === args.agentSeatId)
        )
        if (blockedTarget) {
          throw new ChannelError(
            'recovery_blocked',
            'Agent rotation cannot change a recovery-blocked Channel'
          )
        }
        await Promise.all(
          channels.map((channel) => this.enqueueChannel(channel.channelId, () => undefined))
        )
        const result = state.agentManagement.rotateAgentKey(args)
        for (const enrollment of result.channels) {
          this.notifyMembershipChange(state, enrollment.member.channelId)
        }
        return result
      })
    )
  }

  closeChannel(channelId: string): Promise<ChannelProductionChannelView> {
    const state = this.requireReadyChannel(channelId)
    this.closingChannelIds.add(channelId)
    return this.track(
      this.enqueueAgentManagement(() =>
        this.enqueueChannel(channelId, async () => {
          try {
            await state.runtime.quiesceChannel(channelId)
            const agents = state.store
              .listMembers(channelId)
              .filter(
                (member): member is AgentChannelMember =>
                  member.kind === 'agent' && member.status === 'active'
              )
            for (const member of agents) {
              const digest = createHash('sha256')
                .update(`taskwraith.channel.close-agent.v1\n${channelId}\n${member.memberId}`)
                .digest('hex')
              state.agentManagement.revokeAgent({
                channelId,
                agentSeatId: member.agentSeatId,
                operationId: `channel-close-${digest}`,
                reason: 'channel_closed'
              })
            }
            const closed = state.store.closeChannel({ channelId, now: this.now() })
            this.clearPendingAdmissions(channelId)
            this.notifyChange({ channelId, chatId: closed.chatId, reason: 'channel' })
            return this.channelView(closed, state)
          } finally {
            this.closingChannelIds.delete(channelId)
          }
        })
      )
    )
  }

  purgeForHistoryDeletionScope(
    scope: ChannelProductionHistoryDeletionScope
  ): Promise<ChannelProductionHistoryDeletionResult> {
    const state = this.requireRunning()
    const channels = state.store.listChannels()
    let targets: Channel[]
    if (scope.kind === 'global') {
      targets = channels
    } else {
      if (
        !Array.isArray(scope.chatIds) ||
        scope.chatIds.some((chatId) => typeof chatId !== 'string' || !chatId.trim())
      ) {
        throw new ChannelError('protocol_unsupported', 'History deletion chat ids are invalid')
      }
      const chatIds = new Set(scope.chatIds)
      targets = channels.filter((channel) => chatIds.has(channel.chatId))
    }
    const channelIds = targets.map((channel) => channel.channelId)
    const chatIdByChannelId = new Map(
      targets.map((channel) => [channel.channelId, channel.chatId] as const)
    )
    if (scope.kind === 'truncate') {
      return Promise.resolve({
        kind: scope.kind,
        purgedChannelIds: [],
        preservedChannelIds: channelIds
      })
    }
    if (channelIds.length === 0 && scope.kind !== 'global') {
      return Promise.resolve({
        kind: scope.kind,
        purgedChannelIds: [],
        preservedChannelIds: []
      })
    }

    for (const channelId of channelIds) this.closingChannelIds.add(channelId)
    const quiesced = Promise.all(
      channelIds.map((channelId) =>
        this.enqueueChannel(channelId, () => state.runtime.quiesceChannel(channelId))
      )
    )
    const operation = quiesced.then(() => {
      if (scope.kind === 'global') {
        state.log.purgeAll()
        state.audit.purgeAll()
        state.agentAuthority.purgeAll()
        state.agentIdentities.purgeAll()
        state.store.purgeAllChannels()
      } else {
        state.log.purgeChannels(channelIds)
        state.audit.purgeChannels(channelIds)
        for (const channelId of channelIds) state.agentAuthority.eraseChannel(channelId)
        state.store.purgeChannels(channelIds)
      }
      for (const channelId of channelIds) {
        const chatId = chatIdByChannelId.get(channelId)
        this.clearPendingAdmissions(channelId)
        state.recoveryBlockedChannelIds.delete(channelId)
        this.closingChannelIds.delete(channelId)
        if (chatId) this.notifyChange({ channelId, chatId, reason: 'channel' })
      }
      return {
        kind: scope.kind,
        purgedChannelIds: channelIds,
        preservedChannelIds: []
      }
    })
    return this.track(operation)
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
      this.clearPendingAdmissions()
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

  private enqueueAgentManagement<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.agentManagementTail.catch(() => undefined).then(operation)
    this.agentManagementTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
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

  private notifyMembershipChange(state: RunningState, channelId: string): void {
    const chatId = state.store.getChannel(channelId)?.chatId
    if (chatId) this.notifyChange({ channelId, chatId, reason: 'membership' })
  }

  private notifyAuditChange(event: ChannelAuditInput, store: ChannelStore): void {
    if (!event.channelId) return
    const chatId = store.getChannel(event.channelId)?.chatId
    if (!chatId) return
    if (event.kind === 'channel.created') {
      this.notifyChange({ channelId: event.channelId, chatId, reason: 'channel' })
      return
    }
    if (
      event.kind === 'invite.created' ||
      event.kind === 'admission.confirmed' ||
      event.kind === 'member.revoked'
    ) {
      this.notifyChange({ channelId: event.channelId, chatId, reason: 'membership' })
      return
    }
    if (event.kind === 'message.accepted') {
      this.notifyChange({ channelId: event.channelId, chatId, reason: 'message' })
    }
  }

  private recordAcceptedAgentMentionAdmission(
    result: ChannelAppendResult,
    store: ChannelStore,
    audit: ChannelAuditLike
  ): void {
    try {
      const admission = admitAcceptedChannelAgentMentions({
        record: result.record,
        members: store.listMembers(result.record.channelId)
      })
      if (admission.kind === 'ignored') return
      for (const ambiguity of admission.ambiguities) {
        audit.append({
          kind: 'agent.mention.rejected',
          channelId: result.record.channelId,
          code: 'ambiguous_agent_mention',
          contentHash: result.record.contentHash,
          detail: `candidate_count:${ambiguity.candidateMemberIds.length}`,
          at: result.record.acceptedAt
        })
      }
      if (admission.kind === 'rejected') {
        if (admission.reason === 'ambiguous_agent_mention') return
        audit.append({
          kind: 'agent.mention.rejected',
          channelId: result.record.channelId,
          code: admission.reason,
          contentHash: result.record.contentHash,
          at: result.record.acceptedAt
        })
        return
      }
      for (const target of admission.targets) {
        audit.append({
          kind: 'agent.dispatch.blocked',
          channelId: result.record.channelId,
          memberId: target.memberId,
          code: admission.code,
          contentHash: result.record.contentHash,
          detail: admission.reviewId,
          at: result.record.acceptedAt
        })
      }
    } catch {
      // The human record is already durable. Audit failure must not turn an
      // accepted append into a retry that could duplicate downstream effects.
      this.options.logger?.('[channels] agent mention admission audit failed')
    }
  }

  private pendingAdmissionKey(channelId: string, memberId: string): string {
    return `${channelId}\u0000${memberId}`
  }

  private recordPendingAdmission(
    info: Parameters<NonNullable<ChannelRuntimeOptions['onAdmissionBegan']>>[0],
    store: ChannelStore
  ): void {
    try {
      this.options.onAdmissionBegan?.(info)
    } catch {
      this.options.logger?.('[channels] admission observer failed')
    }
    if (info.mode !== 'admission') return
    const channel = store.getChannel(info.channelId)
    if (!channel) return
    const admission: ChannelProductionPendingAdmissionView = {
      channelId: info.channelId,
      memberId: info.memberId,
      displayName: info.displayName,
      confirmCode: info.confirmCode,
      expiresAt: info.expiresAt
    }
    const key = this.pendingAdmissionKey(info.channelId, info.memberId)
    this.clearPendingAdmission(key)
    this.pendingAdmissions.set(key, admission)
    const timer = setTimeout(
      () => {
        if (this.pendingAdmissions.get(key)?.expiresAt !== admission.expiresAt) return
        this.clearPendingAdmission(key)
        this.notifyChange({
          channelId: admission.channelId,
          chatId: channel.chatId,
          reason: 'membership'
        })
      },
      Math.max(0, admission.expiresAt - this.now())
    )
    timer.unref?.()
    this.pendingAdmissionTimers.set(key, timer)
    this.notifyChange({
      channelId: admission.channelId,
      chatId: channel.chatId,
      reason: 'membership'
    })
  }

  private listPendingAdmissions(channelId: string): ChannelProductionPendingAdmissionView[] {
    const now = this.now()
    for (const [key, admission] of this.pendingAdmissions) {
      if (admission.expiresAt <= now) this.clearPendingAdmission(key)
    }
    return [...this.pendingAdmissions.values()]
      .filter((admission) => admission.channelId === channelId)
      .sort((left, right) => left.expiresAt - right.expiresAt)
  }

  private reconcilePendingAdmission(event: ChannelAuditInput, store: ChannelStore): void {
    if (!event.channelId || !event.memberId) return
    if (
      event.kind !== 'admission.confirmed' &&
      event.kind !== 'admission.failed' &&
      event.kind !== 'member.revoked'
    ) {
      return
    }
    const key = this.pendingAdmissionKey(event.channelId, event.memberId)
    if (!this.pendingAdmissions.has(key)) return
    this.clearPendingAdmission(key)
    const chatId =
      event.kind === 'admission.failed' ? store.getChannel(event.channelId)?.chatId : null
    if (chatId) {
      this.notifyChange({ channelId: event.channelId, chatId, reason: 'membership' })
    }
  }

  private clearPendingAdmission(key: string): void {
    this.pendingAdmissions.delete(key)
    const timer = this.pendingAdmissionTimers.get(key)
    if (timer) clearTimeout(timer)
    this.pendingAdmissionTimers.delete(key)
  }

  private clearPendingAdmissions(channelId?: string): void {
    for (const [key, admission] of this.pendingAdmissions) {
      if (channelId === undefined || admission.channelId === channelId) {
        this.clearPendingAdmission(key)
      }
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
