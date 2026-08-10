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
import { validateChannelAgentDispatchJournalSnapshot } from './ChannelAgentDispatchJournalAuthority'
import { ChannelAgentDispatchJournalStore } from './ChannelAgentDispatchJournalStore'
import type {
  ChannelAgentManagementMembershipInspection,
  ChannelAgentManagementSeatInspection
} from './ChannelAgentManagementController'
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
import {
  createChannelAgentProductionComposition,
  type ChannelAgentProductionCompositionOptions
} from './ChannelAgentProductionComposition'
import type { ChannelAgentProductionService } from './ChannelAgentProductionService'
import type { ChannelAgentSeatCandidate } from './ChannelAgentSeatAuthority'
import { ChannelHostTransport } from './ChannelHostTransport'
import {
  ChannelHumanPolicyError,
  ChannelHumanPolicyStore,
  channelHumanPolicyPath
} from './ChannelHumanPolicyStore'
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
  agentDispatchJournal: string
  humanPolicies: string
}

export interface ChannelProductionRelayPort {
  hostRelayUrl: () => string
  inviteRelayUrls: () => readonly string[]
}

export type ChannelProductionAgentExecutionOptions = Pick<
  ChannelAgentProductionCompositionOptions,
  | 'getChat'
  | 'resolveWorkspacePrincipal'
  | 'getSettings'
  | 'providerAllowed'
  | 'composeMainOwnedChannelAgentRun'
  | 'dispatch'
  | 'subscribeRunEvents'
  | 'subscribeRunSessions'
  | 'claimRunAudience'
  | 'reconcileRun'
>

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
  agentExecution?: ChannelProductionAgentExecutionOptions
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
  startAgentExecution(): void
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
  inspectAgentSeat(agentSeatId: string): ChannelAgentManagementSeatInspection
  inspectChannelAgentSeats(channelId: string): readonly ChannelAgentManagementSeatInspection[]
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
  agentDispatchJournal: ChannelAgentDispatchJournalStore
  humanPolicies: ChannelHumanPolicyStore
  agentManagement: ChannelAgentManagementService
  agentProduction: ChannelAgentProductionService | null
  runtime: ChannelRuntime
  transport: ChannelHostTransport
  recoveryBlockedChannelIds: Set<string>
}

const SERVICE_REGISTRY = new Map<string, ChannelProductionServiceImpl>()
const AGENT_MANAGEMENT_AUDIT_DOMAIN = 'taskwraith.channel.agent-management-audit.v1'

function agentManagementAuditDedupeKey(kind: string, signedObjectId: string): string {
  return createHash('sha256')
    .update(`${AGENT_MANAGEMENT_AUDIT_DOMAIN}\n${kind}\n${signedObjectId}`, 'utf8')
    .digest('hex')
}

export function channelProductionDataPaths(userDataPath: string): ChannelProductionDataPaths {
  const root = join(resolvePath(userDataPath), 'channels')
  return {
    root,
    metadata: join(root, 'channels.json'),
    logs: join(root, 'logs'),
    audit: join(root, 'audit.json'),
    agentIdentities: join(root, 'agent-identities'),
    agentAuthority: join(root, 'agent-authority'),
    agentDispatchJournal: join(root, 'agent-dispatch-journal'),
    humanPolicies: channelHumanPolicyPath(userDataPath)
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
  if (options.agentExecution !== undefined) {
    const execution = options.agentExecution
    if (
      !execution ||
      typeof execution !== 'object' ||
      typeof execution.getChat !== 'function' ||
      typeof execution.resolveWorkspacePrincipal !== 'function' ||
      typeof execution.getSettings !== 'function' ||
      typeof execution.providerAllowed !== 'function' ||
      typeof execution.composeMainOwnedChannelAgentRun !== 'function' ||
      typeof execution.dispatch !== 'function' ||
      typeof execution.subscribeRunEvents !== 'function' ||
      typeof execution.subscribeRunSessions !== 'function' ||
      typeof execution.claimRunAudience !== 'function' ||
      typeof execution.reconcileRun !== 'function'
    ) {
      throw new Error('ChannelProductionService agent execution ports are unavailable')
    }
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

function requireAgentSeatId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('pooled-agent-') ||
    value.length <= 'pooled-agent-'.length ||
    value.length > 512 ||
    value.trim() !== value
  ) {
    throw new ChannelError('protocol_unsupported', 'Channel agent seat id is invalid')
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) {
      throw new ChannelError('protocol_unsupported', 'Channel agent seat id is invalid')
    }
  }
  return value
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
    const humanPolicies = new ChannelHumanPolicyStore(this.paths.humanPolicies)
    let humanPoliciesHealthy = true
    try {
      humanPolicies.list()
    } catch (error) {
      if (!(error instanceof ChannelHumanPolicyError)) throw error
      humanPoliciesHealthy = false
      this.options.logger?.('[channels] migrated human policy recovery is blocked')
    }
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
    const agentDispatchJournal = new ChannelAgentDispatchJournalStore({
      storageDirectory: this.paths.agentDispatchJournal,
      validateSnapshot: (snapshot) =>
        validateChannelAgentDispatchJournalSnapshot(
          { channels: store, authority: agentAuthority },
          snapshot
        ),
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
      if (!humanPoliciesHealthy) {
        recoveryBlockedChannelIds.add(channel.channelId)
        continue
      }
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
    let agentProduction: ChannelAgentProductionService | null = null
    const runtime = new ChannelRuntime({
      identityKeyPair: this.options.loadIdentity(),
      store,
      log,
      audit: auditSink,
      humanPolicy: humanPolicies,
      now: this.now,
      ...(this.options.logger ? { logger: this.options.logger } : {}),
      onAdmissionBegan: (info) => this.recordPendingAdmission(info, store),
      afterDurableCommit: (result) => {
        if (agentProduction) {
          this.scheduleAcceptedAgentAppend(agentProduction, result)
          return
        }
        this.recordAcceptedAgentMentionAdmission(result, store, auditSink)
      }
    })
    const transport = new ChannelHostTransport({
      socketFactory: this.options.socketFactory ?? wsTransportSocketFactory,
      runtime,
      ...(this.options.logger ? { logger: this.options.logger } : {})
    })
    if (this.options.agentExecution) {
      try {
        agentProduction = createChannelAgentProductionComposition({
          journal: agentDispatchJournal,
          authority: agentAuthority,
          identities: agentIdentities,
          channels: store,
          messages: log,
          runtime,
          audit: auditSink,
          ...this.options.agentExecution,
          now: this.now,
          ...(this.options.logger ? { logger: this.options.logger } : {})
        })
      } catch {
        void agentProduction?.stop().catch(() => undefined)
        try {
          transport.dispose()
        } finally {
          runtime.dispose()
        }
        throw new ChannelError(
          'host_unavailable',
          'Channel agent production service could not start'
        )
      }
    }
    this.state = {
      store,
      log,
      audit,
      agentIdentities,
      agentAuthority,
      agentDispatchJournal,
      humanPolicies,
      agentManagement,
      agentProduction,
      runtime,
      transport,
      recoveryBlockedChannelIds
    }
    this.refreshRelayRooms()
    return this.status()
  }

  startAgentExecution(): void {
    const state = this.requireRunning()
    state.agentProduction?.start(
      state.store
        .listChannels()
        .filter(
          (channel) =>
            channel.status === 'active' && !state.recoveryBlockedChannelIds.has(channel.channelId)
        )
        .map((channel) => channel.channelId)
    )
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

  inspectAgentSeat(agentSeatId: string): ChannelAgentManagementSeatInspection {
    return this.agentSeatInspection(this.requireRunning(), requireAgentSeatId(agentSeatId))
  }

  inspectChannelAgentSeats(channelId: string): readonly ChannelAgentManagementSeatInspection[] {
    const state = this.requireReadyChannel(channelId)
    const seatIds = [
      ...new Set(
        state.store
          .listMembers(channelId)
          .filter((member): member is AgentChannelMember => member.kind === 'agent')
          .map((member) => member.agentSeatId)
      )
    ].sort()
    return seatIds.map((agentSeatId) => this.agentSeatInspection(state, agentSeatId))
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
      this.enqueueAgentManagement(() =>
        this.enqueueChannel(args.channelId, async () => {
          await state.agentProduction?.drainChannel(args.channelId)
          const member = state.store.getMember(args.channelId, args.memberId)
          if (member?.kind === 'agent') {
            throw new ChannelError('human_only', 'Agent removal requires signed owner revocation')
          }
          return memberView(
            await state.runtime.revokeMember({
              channelId: args.channelId,
              memberId: args.memberId,
              now: this.now()
            })
          )
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
        this.enqueueChannel(args.channelId, async () => {
          await state.agentProduction?.drainChannel(args.channelId)
          const result = state.agentManagement.enrollAgent(args)
          this.appendAgentManagementAudit(state, {
            kind: 'agent.enrolled',
            channelId: args.channelId,
            memberId: result.member.memberId,
            code: 'owner_delegation',
            detail: `generation=${result.identity.keyGeneration}`,
            dedupeKey: agentManagementAuditDedupeKey(
              'agent.enrolled',
              result.signedDelegation.delegation.delegationId
            ),
            at: result.signedDelegation.delegation.issuedAt
          })
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
        this.enqueueChannel(args.channelId, async () => {
          await state.agentProduction?.drainChannel(args.channelId)
          const result = state.agentManagement.grantDispatch(args)
          this.appendAgentManagementAudit(state, {
            kind: 'agent.grant.issued',
            channelId: args.channelId,
            memberId: result.member.memberId,
            code: 'mention',
            detail: `generation=${result.identity.keyGeneration};budget=${result.signedDispatchGrant.grant.maxDispatches};expires_at=${result.signedDispatchGrant.grant.expiresAt}`,
            dedupeKey: agentManagementAuditDedupeKey(
              'agent.grant.issued',
              result.signedDispatchGrant.grant.grantId
            ),
            at: result.signedDispatchGrant.grant.issuedAt
          })
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
        this.enqueueChannel(args.channelId, async () => {
          await state.agentProduction?.drainChannel(args.channelId)
          const result = state.agentManagement.revokeAgent(args)
          this.appendAgentManagementAudit(state, {
            kind: 'agent.revoked',
            channelId: args.channelId,
            memberId: result.member.memberId,
            code: result.signedRevocation.revocation.reason,
            detail: `generation=${result.member.keyGeneration}`,
            dedupeKey: agentManagementAuditDedupeKey(
              'agent.revoked',
              result.signedRevocation.revocation.revocationId
            ),
            at: result.signedRevocation.revocation.revokedAt
          })
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
          channels.map((channel) =>
            this.enqueueChannel(channel.channelId, () =>
              state.agentProduction?.drainChannel(channel.channelId)
            )
          )
        )
        const result = state.agentManagement.rotateAgentKey(args)
        for (const enrollment of result.channels) {
          this.appendAgentManagementAudit(state, {
            kind: 'agent.key.rotated',
            channelId: enrollment.member.channelId,
            memberId: enrollment.member.memberId,
            code: 'key_rotated',
            detail: `generation=${result.identity.keyGeneration}`,
            dedupeKey: agentManagementAuditDedupeKey(
              'agent.key.rotated',
              enrollment.signedDelegation.delegation.delegationId
            ),
            at: enrollment.signedDelegation.delegation.issuedAt
          })
          this.notifyMembershipChange(state, enrollment.member.channelId)
        }
        return result
      })
    )
  }

  closeChannel(channelId: string): Promise<ChannelProductionChannelView> {
    const state = this.requireReadyChannel(channelId)
    this.closingChannelIds.add(channelId)
    let agentQuiescence: Promise<void>
    try {
      agentQuiescence = state.agentProduction?.quiesceChannel(channelId) ?? Promise.resolve()
    } catch (error) {
      this.closingChannelIds.delete(channelId)
      throw error
    }
    return this.track(
      this.enqueueAgentManagement(() =>
        this.enqueueChannel(channelId, async () => {
          try {
            await agentQuiescence
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
              const result = state.agentManagement.revokeAgent({
                channelId,
                agentSeatId: member.agentSeatId,
                operationId: `channel-close-${digest}`,
                reason: 'channel_closed'
              })
              this.appendAgentManagementAudit(state, {
                kind: 'agent.revoked',
                channelId,
                memberId: result.member.memberId,
                code: result.signedRevocation.revocation.reason,
                detail: `generation=${result.member.keyGeneration}`,
                dedupeKey: agentManagementAuditDedupeKey(
                  'agent.revoked',
                  result.signedRevocation.revocation.revocationId
                ),
                at: result.signedRevocation.revocation.revokedAt
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
    const humanPolicyChannelIds =
      scope.kind === 'global'
        ? state.humanPolicies.list().map((record) => record.channelId)
        : channelIds
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
    const agentQuiescence = new Map(
      channelIds.map((channelId) => [
        channelId,
        state.agentProduction?.quiesceChannel(channelId) ?? Promise.resolve()
      ])
    )
    const operation = this.enqueueAgentManagement(async () => {
      await Promise.all(
        channelIds.map((channelId) =>
          this.enqueueChannel(channelId, async () => {
            await agentQuiescence.get(channelId)
            await state.runtime.quiesceChannel(channelId)
          })
        )
      )
      if (scope.kind === 'global') {
        state.log.purgeAll()
        state.audit.purgeAll()
        state.agentDispatchJournal.purgeAll()
        state.agentAuthority.purgeAll()
        state.agentIdentities.purgeAll()
        state.store.purgeAllChannels()
        // Delete policy only after Channel authority is gone. A late persistence
        // failure may leave an orphaned policy, but can never widen a live member.
        state.humanPolicies.purgeChannels(humanPolicyChannelIds)
      } else {
        state.log.purgeChannels(channelIds)
        state.audit.purgeChannels(channelIds)
        for (const channelId of channelIds) {
          state.agentDispatchJournal.eraseChannel(channelId)
          state.agentAuthority.eraseChannel(channelId)
        }
        state.store.purgeChannels(channelIds)
        state.humanPolicies.purgeChannels(humanPolicyChannelIds)
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
      while (this.inFlight.size > 0) {
        await Promise.allSettled([...this.inFlight])
      }
      const state = this.state
      this.state = null
      if (state) {
        try {
          await state.agentProduction?.stop()
        } finally {
          try {
            state.transport.dispose()
          } finally {
            state.runtime.dispose()
          }
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

  private scheduleAcceptedAgentAppend(
    agentProduction: ChannelAgentProductionService,
    result: ChannelAppendResult
  ): void {
    try {
      const operation = this.enqueueAgentManagement(() =>
        this.enqueueChannel(result.record.channelId, () =>
          agentProduction.handleDurableAppend(result)
        )
      )
      this.inFlight.add(operation)
      void operation.then(
        () => this.inFlight.delete(operation),
        () => {
          this.inFlight.delete(operation)
          this.options.logger?.('[channels] durable agent mention handling failed')
        }
      )
    } catch {
      // The human record is already durable. Never reject the accepted append
      // or expose execution details if the asynchronous handoff is unavailable.
      this.options.logger?.('[channels] durable agent mention handling failed')
    }
  }

  private agentSeatInspection(
    state: RunningState,
    agentSeatId: string
  ): ChannelAgentManagementSeatInspection {
    const history = state.agentIdentities.publicHistory(agentSeatId)
    const memberships: ChannelAgentManagementMembershipInspection[] = []
    for (const channel of state.store.listChannels()) {
      for (const member of state.store.listMembers(channel.channelId)) {
        if (member.kind !== 'agent' || member.agentSeatId !== agentSeatId) continue
        if (member.status !== 'active' && member.status !== 'revoked') {
          throw new ChannelError(
            'recovery_blocked',
            'Channel agent membership has an invalid inspection status'
          )
        }
        memberships.push({
          channelId: channel.channelId,
          memberId: member.memberId,
          displayName: member.displayName,
          keyGeneration: member.keyGeneration,
          status: member.status
        })
      }
    }
    memberships.sort(
      (left, right) =>
        left.channelId.localeCompare(right.channelId) ||
        left.keyGeneration - right.keyGeneration ||
        left.memberId.localeCompare(right.memberId)
    )
    return {
      agentSeatId,
      currentKeyGeneration: history?.current.keyGeneration ?? null,
      memberships
    }
  }

  private appendAgentManagementAudit(state: RunningState, event: ChannelAuditInput): void {
    try {
      state.audit.append(event)
    } catch {
      this.options.logger?.('[channels] agent management audit failed')
    }
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
      if (admission.kind === 'admitted') {
        // The immutable review gate is still false in this slice. The next
        // production-composition slice replaces this fail-closed exhaustiveness
        // branch with the separately proven ChannelAgentProductionService.
        throw new Error('Channel agent production execution is not attached')
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
