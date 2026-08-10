import { createHash } from 'crypto'
import type { BrowserWindow } from 'electron'

import type { AppSettings, ChatRecord, ProviderId } from '../store/types'
import {
  CHANNEL_AGENT_DEFAULT_GRANT_TTL_MS,
  CHANNEL_AGENT_DEFAULT_MAX_DISPATCHES,
  CHANNEL_AGENT_MANAGED_MAX_DISPATCHES,
  CHANNEL_AGENT_MAX_GRANT_TTL_MS,
  CHANNEL_AGENT_MIN_GRANT_TTL_MS
} from './ChannelAgentManagementService'
import {
  confirmChannelAgentManagement,
  hashChannelAgentNativeConfirmation,
  type ChannelAgentNativeConfirmationDecision,
  type ChannelAgentNativeConfirmationRequest,
  type ChannelAgentNativeGrantAuthority,
  type ChannelAgentNativeMentionerSummary,
  type ChannelAgentNativeSeatSummary
} from './ChannelAgentNativeConfirmation'
import {
  CHANNEL_AGENT_GRANT_PERMISSION_PRESETS,
  listChannelAgentSeatCandidates,
  resolveChannelAgentGrantAuthority,
  resolveChannelAgentSeat,
  type ChannelAgentGrantPermissionPresetId,
  type ChannelAgentSeatCandidate,
  type ChannelAgentWorkspacePrincipal
} from './ChannelAgentSeatAuthority'
import type {
  ChannelProductionChannelView,
  ChannelProductionReadResult,
  ChannelProductionService
} from './ChannelProductionService'
import { ChannelError } from './ChannelStore'

const OPERATION_ID_DOMAIN = 'taskwraith.channel.agent-management-operation.v1'
const MAX_IDENTIFIER_LENGTH = 512
const MAX_WORKSPACE_LABEL_LENGTH = 4_096
const MAX_ROTATION_CHANNELS = 64

export interface ChannelAgentManagementMembershipInspection {
  readonly channelId: string
  readonly memberId: string
  readonly displayName: string
  readonly keyGeneration: number
  readonly status: 'active' | 'revoked'
}

export interface ChannelAgentManagementSeatInspection {
  readonly agentSeatId: string
  readonly currentKeyGeneration: number | null
  readonly memberships: readonly ChannelAgentManagementMembershipInspection[]
}

export interface ChannelAgentManagementControllerPort extends Pick<
  ChannelProductionService,
  | 'listChannels'
  | 'readChannel'
  | 'enrollAgent'
  | 'grantAgentDispatch'
  | 'revokeAgent'
  | 'rotateAgentKey'
> {
  inspectAgentSeat(agentSeatId: string): ChannelAgentManagementSeatInspection
  inspectChannelAgentSeats(channelId: string): readonly ChannelAgentManagementSeatInspection[]
}

export interface ChannelAgentWorkspaceResolution {
  readonly principal: ChannelAgentWorkspacePrincipal
  readonly label: string
}

export interface ChannelAgentManagementControllerDependencies {
  readonly service: ChannelAgentManagementControllerPort
  readonly getChat: (chatId: string) => ChatRecord | null
  readonly getSettings: () => AppSettings
  readonly providerAllowed: (provider: ProviderId, settings: AppSettings) => boolean
  readonly resolveWorkspace: (chat: ChatRecord) => ChannelAgentWorkspaceResolution | null
  readonly confirm?: (
    owner: BrowserWindow | null,
    request: ChannelAgentNativeConfirmationRequest
  ) => Promise<ChannelAgentNativeConfirmationDecision>
}

export interface ChannelAgentManagementOverviewSeat {
  readonly seat: ChannelAgentNativeSeatSummary
  readonly currentKeyGeneration: number | null
  readonly membership?: ChannelAgentManagementMembershipInspection
}

export interface ChannelAgentManagementOverview {
  readonly channelId: string
  readonly seats: readonly ChannelAgentManagementOverviewSeat[]
  readonly allowedMentioners: readonly ChannelAgentNativeMentionerSummary[]
  readonly permissionPresetIds: readonly ChannelAgentGrantPermissionPresetId[]
  readonly grantLimits: {
    readonly defaultTtlMs: number
    readonly minimumTtlMs: number
    readonly maximumTtlMs: number
    readonly defaultMaxDispatches: number
    readonly maximumDispatches: number
  }
}

interface ChannelAgentActionInput {
  readonly requestId: string
  readonly channelId: string
  readonly agentSeatId: string
}

export interface ChannelAgentEnrollInput extends ChannelAgentActionInput {}

export interface ChannelAgentGrantInput extends ChannelAgentActionInput {
  readonly permissionPresetId: ChannelAgentGrantPermissionPresetId
  readonly allowedMentionerMemberIds?: readonly string[]
  readonly ttlMs?: number
  readonly maxDispatches?: number
}

export interface ChannelAgentRevokeInput extends ChannelAgentActionInput {}

export interface ChannelAgentRotateInput extends ChannelAgentActionInput {
  readonly reEnrollChannelIds?: readonly string[]
}

export interface ChannelAgentAppliedMemberView {
  readonly channelId: string
  readonly memberId: string
  readonly status: 'active' | 'revoked'
  readonly keyGeneration: number
}

export type ChannelAgentManagementAppliedView =
  | {
      readonly kind: 'enroll'
      readonly agentSeatId: string
      readonly member: ChannelAgentAppliedMemberView
    }
  | {
      readonly kind: 'grant'
      readonly agentSeatId: string
      readonly member: ChannelAgentAppliedMemberView
      readonly allowedMentionerMemberIds: readonly string[]
      readonly permissionPresetId: ChannelAgentGrantPermissionPresetId
      readonly expiresAt: number
      readonly maxDispatches: number
    }
  | {
      readonly kind: 'revoke'
      readonly agentSeatId: string
      readonly member: ChannelAgentAppliedMemberView
      readonly alreadyRevoked: boolean
    }
  | {
      readonly kind: 'rotate'
      readonly agentSeatId: string
      readonly fromKeyGeneration: number
      readonly toKeyGeneration: number
      readonly members: readonly ChannelAgentAppliedMemberView[]
      readonly resumed: boolean
    }

export type ChannelAgentManagementOutcome =
  | { readonly status: 'declined' }
  | { readonly status: 'stale' }
  | { readonly status: 'applied'; readonly value: ChannelAgentManagementAppliedView }

interface ChannelContext {
  readonly channel: ChannelProductionChannelView
  readonly read: ChannelProductionReadResult
  readonly chat: ChatRecord | null
}

function fail(code: ConstructorParameters<typeof ChannelError>[0], message: string): never {
  throw new ChannelError(code, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function requireOnlyKeys(value: unknown, allowed: readonly string[], label: string): void {
  if (!isRecord(value)) fail('protocol_unsupported', `${label} must be an object`)
  const known = new Set(allowed)
  if (Object.keys(value).some((key) => !known.has(key))) {
    fail('protocol_unsupported', `${label} contains an unknown field`)
  }
}

function safeIdentifier(value: unknown): value is string {
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

function requireIdentifier(value: unknown, label: string): string {
  if (!safeIdentifier(value)) fail('protocol_unsupported', `${label} is invalid`)
  return value
}

function requireInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail('protocol_unsupported', `${label} is invalid`)
  }
  return Number(value)
}

function requireIdentifierSet(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty: boolean
): string[] {
  if (!Array.isArray(value) || value.length > maximum || (!allowEmpty && value.length === 0)) {
    fail('protocol_unsupported', `${label} is invalid`)
  }
  const identifiers = value.map((entry) => requireIdentifier(entry, label))
  if (new Set(identifiers).size !== identifiers.length) {
    fail('protocol_unsupported', `${label} contains a duplicate`)
  }
  return identifiers.sort()
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`
}

function operationId(kind: string, intent: unknown): string {
  const digest = createHash('sha256')
    .update(`${OPERATION_ID_DOMAIN}\n${kind}\n${stableJson(intent)}`, 'utf8')
    .digest('hex')
  return `channel-agent-${kind}-${digest}`
}

function seatSummary(seat: ChannelAgentSeatCandidate): ChannelAgentNativeSeatSummary {
  return {
    agentSeatId: seat.agentSeatId,
    displayName: seat.displayName,
    provider: seat.provider,
    model: seat.model ?? null,
    role: seat.role
  }
}

function memberView(member: {
  channelId: string
  memberId: string
  status: string
  keyGeneration: number
}): ChannelAgentAppliedMemberView {
  if (member.status !== 'active' && member.status !== 'revoked') {
    fail('recovery_blocked', 'Channel agent mutation returned an invalid member status')
  }
  return {
    channelId: member.channelId,
    memberId: member.memberId,
    status: member.status,
    keyGeneration: member.keyGeneration
  }
}

function compareMembership(
  left: ChannelAgentManagementMembershipInspection,
  right: ChannelAgentManagementMembershipInspection
): number {
  return left.keyGeneration - right.keyGeneration || left.memberId.localeCompare(right.memberId)
}

export class ChannelAgentManagementController {
  private readonly confirm: NonNullable<ChannelAgentManagementControllerDependencies['confirm']>

  constructor(private readonly deps: ChannelAgentManagementControllerDependencies) {
    if (
      !deps ||
      !deps.service ||
      typeof deps.service.listChannels !== 'function' ||
      typeof deps.service.readChannel !== 'function' ||
      typeof deps.service.inspectAgentSeat !== 'function' ||
      typeof deps.service.inspectChannelAgentSeats !== 'function' ||
      typeof deps.service.enrollAgent !== 'function' ||
      typeof deps.service.grantAgentDispatch !== 'function' ||
      typeof deps.service.revokeAgent !== 'function' ||
      typeof deps.service.rotateAgentKey !== 'function' ||
      typeof deps.getChat !== 'function' ||
      typeof deps.getSettings !== 'function' ||
      typeof deps.providerAllowed !== 'function' ||
      typeof deps.resolveWorkspace !== 'function' ||
      (deps.confirm !== undefined && typeof deps.confirm !== 'function')
    ) {
      throw new Error('ChannelAgentManagementController requires main-owned dependencies')
    }
    this.confirm = deps.confirm ?? confirmChannelAgentManagement
  }

  describeChannel(channelId: string): ChannelAgentManagementOverview {
    const context = this.channelContext(requireIdentifier(channelId, 'Channel id'))
    const chat = this.requireChat(context)
    const settings = this.settings()
    const candidates = listChannelAgentSeatCandidates(chat, (provider) =>
      this.deps.providerAllowed(provider, settings)
    )
    const candidatesBySeat = new Map(
      candidates.map((candidate) => [candidate.agentSeatId, candidate])
    )
    const inspectionsBySeat = new Map<string, ChannelAgentManagementSeatInspection>()
    const enrolled = this.deps.service.inspectChannelAgentSeats(context.channel.channelId)
    if (!Array.isArray(enrolled) || enrolled.length > 8) {
      fail('recovery_blocked', 'Channel agent roster inspection is invalid')
    }
    for (const raw of enrolled) {
      const inspectedSeatId = requireIdentifier(raw?.agentSeatId, 'Inspected agent seat id')
      const inspection = this.validateInspection(inspectedSeatId, raw)
      if (!this.latestChannelMembership(inspection, context.channel.channelId)) {
        fail('recovery_blocked', 'Channel agent roster inspection is inconsistent')
      }
      if (inspectionsBySeat.has(inspectedSeatId)) {
        fail('recovery_blocked', 'Channel agent roster inspection is ambiguous')
      }
      inspectionsBySeat.set(inspectedSeatId, inspection)
    }
    const seatIds = [...new Set([...candidatesBySeat.keys(), ...inspectionsBySeat.keys()])]
    const seats = seatIds
      .map((agentSeatId) => {
        const candidate = candidatesBySeat.get(agentSeatId)
        const inspection = inspectionsBySeat.get(agentSeatId) ?? this.inspect(agentSeatId)
        const membership = this.latestChannelMembership(inspection, context.channel.channelId)
        if (membership) this.assertMembershipProjected(context, membership)
        return {
          seat: candidate
            ? seatSummary(candidate)
            : {
                agentSeatId,
                displayName: membership!.displayName,
                provider: null,
                model: null,
                role: null
              },
          currentKeyGeneration: inspection.currentKeyGeneration,
          ...(membership ? { membership } : {})
        }
      })
      .sort(
        (left, right) =>
          left.seat.displayName.localeCompare(right.seat.displayName) ||
          left.seat.agentSeatId.localeCompare(right.seat.agentSeatId)
      )
    return {
      channelId: context.channel.channelId,
      seats,
      allowedMentioners: this.activeHumanMentioners(context),
      permissionPresetIds: [...CHANNEL_AGENT_GRANT_PERMISSION_PRESETS],
      grantLimits: {
        defaultTtlMs: CHANNEL_AGENT_DEFAULT_GRANT_TTL_MS,
        minimumTtlMs: CHANNEL_AGENT_MIN_GRANT_TTL_MS,
        maximumTtlMs: CHANNEL_AGENT_MAX_GRANT_TTL_MS,
        defaultMaxDispatches: CHANNEL_AGENT_DEFAULT_MAX_DISPATCHES,
        maximumDispatches: CHANNEL_AGENT_MANAGED_MAX_DISPATCHES
      }
    }
  }

  enroll(
    owner: BrowserWindow | null,
    input: ChannelAgentEnrollInput
  ): Promise<ChannelAgentManagementOutcome> {
    requireOnlyKeys(input, ['requestId', 'channelId', 'agentSeatId'], 'Channel agent enrollment')
    const normalized = this.baseInput(input)
    const managedOperationId = operationId('enroll', normalized)
    return this.confirmAndApply(
      owner,
      () => this.enrollRequest(normalized, managedOperationId),
      async (request) => {
        if (request.kind !== 'enroll') fail('recovery_blocked', 'Enrollment intent changed')
        const result = await this.deps.service.enrollAgent({
          channelId: request.channelId,
          seat: {
            agentSeatId: request.seat.agentSeatId,
            displayName: request.seat.displayName
          },
          operationId: request.operationId
        })
        return {
          kind: 'enroll',
          agentSeatId: request.seat.agentSeatId,
          member: memberView(result.member)
        }
      }
    )
  }

  grant(
    owner: BrowserWindow | null,
    input: ChannelAgentGrantInput
  ): Promise<ChannelAgentManagementOutcome> {
    requireOnlyKeys(
      input,
      [
        'requestId',
        'channelId',
        'agentSeatId',
        'permissionPresetId',
        'allowedMentionerMemberIds',
        'ttlMs',
        'maxDispatches'
      ],
      'Channel agent grant'
    )
    const normalized = {
      ...this.baseInput(input),
      permissionPresetId: this.permissionPreset(input.permissionPresetId),
      allowedMentionerMemberIds:
        input.allowedMentionerMemberIds === undefined
          ? undefined
          : requireIdentifierSet(
              input.allowedMentionerMemberIds,
              'Allowed mentioner member ids',
              8,
              false
            ),
      ttlMs:
        input.ttlMs === undefined
          ? CHANNEL_AGENT_DEFAULT_GRANT_TTL_MS
          : requireInteger(
              input.ttlMs,
              CHANNEL_AGENT_MIN_GRANT_TTL_MS,
              CHANNEL_AGENT_MAX_GRANT_TTL_MS,
              'Grant lifetime'
            ),
      maxDispatches:
        input.maxDispatches === undefined
          ? CHANNEL_AGENT_DEFAULT_MAX_DISPATCHES
          : requireInteger(
              input.maxDispatches,
              1,
              CHANNEL_AGENT_MANAGED_MAX_DISPATCHES,
              'Grant dispatch budget'
            )
    }
    const managedOperationId = operationId('grant', normalized)
    return this.confirmAndApply(
      owner,
      () => this.grantRequest(normalized, managedOperationId),
      async (request) => {
        if (request.kind !== 'grant') fail('recovery_blocked', 'Grant intent changed')
        const result = await this.deps.service.grantAgentDispatch({
          channelId: request.channelId,
          agentSeatId: request.seat.agentSeatId,
          operationId: request.operationId,
          allowedMentionerMemberIds: request.allowedMentioners.map((member) => member.memberId),
          workspaceIdentityHash: request.authority.workspaceIdentityHash,
          permissionPostureHash: request.authority.permissionPostureHash,
          ttlMs: request.ttlMs,
          maxDispatches: request.maxDispatches
        })
        return {
          kind: 'grant',
          agentSeatId: request.seat.agentSeatId,
          member: memberView(result.member),
          allowedMentionerMemberIds: request.allowedMentioners.map((member) => member.memberId),
          permissionPresetId: request.authority.permissionPresetId,
          expiresAt: result.signedDispatchGrant.grant.expiresAt,
          maxDispatches: result.signedDispatchGrant.grant.maxDispatches
        }
      }
    )
  }

  revoke(
    owner: BrowserWindow | null,
    input: ChannelAgentRevokeInput
  ): Promise<ChannelAgentManagementOutcome> {
    requireOnlyKeys(input, ['requestId', 'channelId', 'agentSeatId'], 'Channel agent revocation')
    const normalized = this.baseInput(input)
    const managedOperationId = operationId('revoke', normalized)
    return this.confirmAndApply(
      owner,
      () => this.revokeRequest(normalized, managedOperationId),
      async (request) => {
        if (request.kind !== 'revoke') fail('recovery_blocked', 'Revocation intent changed')
        const result = await this.deps.service.revokeAgent({
          channelId: request.channelId,
          agentSeatId: request.seat.agentSeatId,
          operationId: request.operationId
        })
        return {
          kind: 'revoke',
          agentSeatId: request.seat.agentSeatId,
          member: memberView(result.member),
          alreadyRevoked: result.alreadyRevoked
        }
      }
    )
  }

  rotate(
    owner: BrowserWindow | null,
    input: ChannelAgentRotateInput
  ): Promise<ChannelAgentManagementOutcome> {
    requireOnlyKeys(
      input,
      ['requestId', 'channelId', 'agentSeatId', 'reEnrollChannelIds'],
      'Channel agent rotation'
    )
    const normalized = {
      ...this.baseInput(input),
      reEnrollChannelIds:
        input.reEnrollChannelIds === undefined
          ? []
          : requireIdentifierSet(
              input.reEnrollChannelIds,
              'Re-enrollment Channel ids',
              MAX_ROTATION_CHANNELS,
              true
            )
    }
    const managedOperationId = operationId('rotate', normalized)
    return this.confirmAndApply(
      owner,
      () => this.rotateRequest(normalized, managedOperationId),
      async (request) => {
        if (request.kind !== 'rotate') fail('recovery_blocked', 'Rotation intent changed')
        const result = await this.deps.service.rotateAgentKey({
          agentSeatId: request.seat.agentSeatId,
          operationId: request.operationId,
          ...(normalized.reEnrollChannelIds.length > 0
            ? { reEnrollChannelIds: normalized.reEnrollChannelIds }
            : {})
        })
        if (result.identity.keyGeneration !== request.toKeyGeneration) {
          fail('recovery_blocked', 'Rotated agent generation did not match confirmed authority')
        }
        return {
          kind: 'rotate',
          agentSeatId: request.seat.agentSeatId,
          fromKeyGeneration: request.fromKeyGeneration,
          toKeyGeneration: result.identity.keyGeneration,
          members: result.channels.map((entry) => memberView(entry.member)),
          resumed: result.resumed
        }
      }
    )
  }

  private baseInput(input: ChannelAgentActionInput): ChannelAgentActionInput {
    return {
      requestId: requireIdentifier(input?.requestId, 'Request id'),
      channelId: requireIdentifier(input?.channelId, 'Channel id'),
      agentSeatId: requireIdentifier(input?.agentSeatId, 'Agent seat id')
    }
  }

  private permissionPreset(value: unknown): ChannelAgentGrantPermissionPresetId {
    if (!(CHANNEL_AGENT_GRANT_PERMISSION_PRESETS as readonly unknown[]).includes(value)) {
      fail('protocol_unsupported', 'Channel agent permission preset is invalid')
    }
    return value as ChannelAgentGrantPermissionPresetId
  }

  private settings(): AppSettings {
    const settings = this.deps.getSettings()
    if (!settings || typeof settings !== 'object') {
      fail('recovery_blocked', 'Channel agent settings are unavailable')
    }
    return settings
  }

  private channelContext(channelId: string): ChannelContext {
    const matches = this.deps.service
      .listChannels()
      .filter((candidate) => candidate.channelId === channelId)
    if (matches.length === 0) fail('not_member', 'Channel was not found')
    if (matches.length !== 1) fail('recovery_blocked', 'Channel identity is ambiguous')
    const channel = matches[0]
    if (channel.status !== 'active') fail('channel_closed', 'Channel is closed')
    if (channel.availability !== 'ready') {
      fail('recovery_blocked', 'Channel agent authority requires recovery')
    }
    const read = this.deps.service.readChannel({
      channelId,
      resumeAfter: 0,
      maxRecords: 1,
      maxBytes: 1
    })
    if (read.channel.channelId !== channelId || read.channel.chatId !== channel.chatId) {
      fail('recovery_blocked', 'Channel projection changed during management')
    }
    const chat = this.deps.getChat(channel.chatId)
    if (chat && chat.appChatId !== channel.chatId) {
      fail('recovery_blocked', 'Channel chat identity is inconsistent')
    }
    return { channel, read, chat }
  }

  private requireChat(context: ChannelContext): ChatRecord {
    if (!context.chat) fail('not_member', 'Channel chat was not found')
    if (context.chat.archived) fail('channel_closed', 'Archived chats cannot manage agents')
    return context.chat
  }

  private inspect(agentSeatId: string): ChannelAgentManagementSeatInspection {
    return this.validateInspection(agentSeatId, this.deps.service.inspectAgentSeat(agentSeatId))
  }

  private validateInspection(
    agentSeatId: string,
    inspection: ChannelAgentManagementSeatInspection
  ): ChannelAgentManagementSeatInspection {
    if (
      !inspection ||
      inspection.agentSeatId !== agentSeatId ||
      (inspection.currentKeyGeneration !== null &&
        (!Number.isSafeInteger(inspection.currentKeyGeneration) ||
          inspection.currentKeyGeneration < 1)) ||
      !Array.isArray(inspection.memberships) ||
      inspection.memberships.length > 1_024
    ) {
      fail('recovery_blocked', 'Channel agent inspection is invalid')
    }
    const memberships = inspection.memberships.map((member) => {
      if (
        !member ||
        !safeIdentifier(member.channelId) ||
        !safeIdentifier(member.memberId) ||
        typeof member.displayName !== 'string' ||
        !member.displayName.trim() ||
        member.displayName.length > 4_096 ||
        !Number.isSafeInteger(member.keyGeneration) ||
        member.keyGeneration < 1 ||
        (member.status !== 'active' && member.status !== 'revoked')
      ) {
        fail('recovery_blocked', 'Channel agent membership inspection is invalid')
      }
      return { ...member }
    })
    if (inspection.currentKeyGeneration === null && memberships.length > 0) {
      fail('recovery_blocked', 'Channel agent membership has no stable identity')
    }
    return {
      agentSeatId,
      currentKeyGeneration: inspection.currentKeyGeneration,
      memberships: memberships.sort(compareMembership)
    }
  }

  private latestChannelMembership(
    inspection: ChannelAgentManagementSeatInspection,
    channelId: string
  ): ChannelAgentManagementMembershipInspection | undefined {
    return inspection.memberships.filter((member) => member.channelId === channelId).at(-1)
  }

  private assertMembershipProjected(
    context: ChannelContext,
    membership: ChannelAgentManagementMembershipInspection
  ): void {
    const projected = context.read.members.find((member) => member.memberId === membership.memberId)
    if (
      !projected ||
      projected.kind !== 'agent' ||
      projected.channelId !== membership.channelId ||
      projected.status !== membership.status
    ) {
      fail('recovery_blocked', 'Channel agent membership projection is inconsistent')
    }
  }

  private activeHumanMentioners(context: ChannelContext): ChannelAgentNativeMentionerSummary[] {
    return context.read.members
      .filter((member) => member.kind === 'human' && member.status === 'active')
      .map((member) => ({ memberId: member.memberId, displayName: member.displayName }))
      .sort((left, right) => left.memberId.localeCompare(right.memberId))
  }

  private availableSeat(
    context: ChannelContext,
    agentSeatId: string,
    settings: AppSettings
  ): ChannelAgentSeatCandidate {
    const chat = this.requireChat(context)
    const seat = resolveChannelAgentSeat(chat, agentSeatId, (provider) =>
      this.deps.providerAllowed(provider, settings)
    )
    if (!seat) fail('not_member', 'Channel agent seat is unavailable in this chat')
    return seat
  }

  private cleanupSeat(
    context: ChannelContext,
    inspection: ChannelAgentManagementSeatInspection
  ): ChannelAgentNativeSeatSummary {
    const current = context.chat
      ? resolveChannelAgentSeat(context.chat, inspection.agentSeatId, () => true)
      : null
    if (current) return seatSummary(current)
    const membership = this.latestChannelMembership(inspection, context.channel.channelId)
    if (!membership) fail('not_member', 'Channel agent is not enrolled in this Channel')
    this.assertMembershipProjected(context, membership)
    return {
      agentSeatId: inspection.agentSeatId,
      displayName: membership.displayName,
      provider: null,
      model: null,
      role: null
    }
  }

  private activeBinding(
    context: ChannelContext,
    inspection: ChannelAgentManagementSeatInspection
  ): ChannelAgentManagementMembershipInspection {
    if (inspection.currentKeyGeneration === null) {
      fail('not_member', 'Channel agent has no stable identity')
    }
    const matches = inspection.memberships.filter(
      (member) =>
        member.channelId === context.channel.channelId &&
        member.keyGeneration === inspection.currentKeyGeneration &&
        member.status === 'active'
    )
    if (matches.length === 0) fail('not_member', 'Channel agent is not actively enrolled')
    if (matches.length !== 1) fail('recovery_blocked', 'Channel agent membership is ambiguous')
    this.assertMembershipProjected(context, matches[0])
    return matches[0]
  }

  private enrollRequest(
    input: ChannelAgentActionInput,
    managedOperationId: string
  ): ChannelAgentNativeConfirmationRequest {
    const context = this.channelContext(input.channelId)
    const inspection = this.inspect(input.agentSeatId)
    const seat = this.availableSeat(context, input.agentSeatId, this.settings())
    const latest = this.latestChannelMembership(inspection, input.channelId)
    if (latest?.status === 'revoked' && latest.keyGeneration === inspection.currentKeyGeneration) {
      fail('identity_mismatch', 'Removed Channel agents require explicit key rotation')
    }
    return {
      kind: 'enroll',
      operationId: managedOperationId,
      channelId: context.channel.channelId,
      channelTitle: context.channel.display.title,
      seat: seatSummary(seat),
      existingKeyGeneration: inspection.currentKeyGeneration
    }
  }

  private grantRequest(
    input: ChannelAgentActionInput & {
      permissionPresetId: ChannelAgentGrantPermissionPresetId
      allowedMentionerMemberIds?: readonly string[]
      ttlMs: number
      maxDispatches: number
    },
    managedOperationId: string
  ): ChannelAgentNativeConfirmationRequest {
    const context = this.channelContext(input.channelId)
    const settings = this.settings()
    const seat = this.availableSeat(context, input.agentSeatId, settings)
    const inspection = this.inspect(input.agentSeatId)
    const binding = this.activeBinding(context, inspection)
    const allMentioners = this.activeHumanMentioners(context)
    const requestedIds = input.allowedMentionerMemberIds ?? [context.channel.ownerMemberId]
    const mentioners = requestedIds.map((memberId) => {
      const member = allMentioners.find((candidate) => candidate.memberId === memberId)
      if (!member) fail('not_member', 'Allowed mentioner is not an active human member')
      return member
    })
    mentioners.sort((left, right) => left.memberId.localeCompare(right.memberId))
    const workspace = this.deps.resolveWorkspace(this.requireChat(context))
    if (
      !workspace ||
      typeof workspace.label !== 'string' ||
      !workspace.label.trim() ||
      workspace.label.length > MAX_WORKSPACE_LABEL_LENGTH
    ) {
      fail('recovery_blocked', 'Channel agent workspace authority is unavailable')
    }
    const authority = resolveChannelAgentGrantAuthority({
      chat: this.requireChat(context),
      agentSeatId: input.agentSeatId,
      permissionPresetId: input.permissionPresetId,
      workspacePrincipal: workspace.principal,
      settings,
      providerAllowed: (provider) => this.deps.providerAllowed(provider, settings)
    })
    return {
      kind: 'grant',
      operationId: managedOperationId,
      channelId: context.channel.channelId,
      channelTitle: context.channel.display.title,
      seat: seatSummary(seat),
      agentMemberId: binding.memberId,
      keyGeneration: binding.keyGeneration,
      allowedMentioners: mentioners,
      authority: this.nativeAuthority(authority, workspace.label),
      ttlMs: input.ttlMs,
      maxDispatches: input.maxDispatches
    }
  }

  private nativeAuthority(
    authority: ReturnType<typeof resolveChannelAgentGrantAuthority>,
    workspaceLabel: string
  ): ChannelAgentNativeGrantAuthority {
    return {
      permissionPresetId: authority.permissionPresetId,
      approvalMode: authority.effectivePermissions.approvalMode,
      readOnly: authority.effectivePermissions.readOnly,
      networkAccess: authority.effectivePermissions.networkAccess,
      agenticServices: Object.entries(authority.effectivePermissions.agenticServices)
        .map(([serviceId, policy]) => ({ serviceId, policy }))
        .sort((left, right) => left.serviceId.localeCompare(right.serviceId)),
      externalPathGrants: authority.effectivePermissions.externalPathGrants
        .map((grant) => ({
          path: grant.path,
          kind: grant.kind,
          access: grant.access,
          duration: grant.duration
        }))
        .sort((left, right) =>
          `${left.path}\0${left.kind}\0${left.access}\0${left.duration}`.localeCompare(
            `${right.path}\0${right.kind}\0${right.access}\0${right.duration}`
          )
        ),
      workspaceLabel,
      workspaceIdentityHash: authority.workspaceIdentityHash,
      permissionPostureHash: authority.permissionPostureHash
    }
  }

  private revokeRequest(
    input: ChannelAgentActionInput,
    managedOperationId: string
  ): ChannelAgentNativeConfirmationRequest {
    const context = this.channelContext(input.channelId)
    const inspection = this.inspect(input.agentSeatId)
    const membership = this.latestChannelMembership(inspection, input.channelId)
    if (!membership) fail('not_member', 'Channel agent is not enrolled in this Channel')
    this.assertMembershipProjected(context, membership)
    return {
      kind: 'revoke',
      operationId: managedOperationId,
      channelId: context.channel.channelId,
      channelTitle: context.channel.display.title,
      seat: this.cleanupSeat(context, inspection),
      agentMemberId: membership.memberId,
      keyGeneration: membership.keyGeneration
    }
  }

  private rotateRequest(
    input: ChannelAgentActionInput & { reEnrollChannelIds: readonly string[] },
    managedOperationId: string
  ): ChannelAgentNativeConfirmationRequest {
    const source = this.channelContext(input.channelId)
    const inspection = this.inspect(input.agentSeatId)
    const generation = inspection.currentKeyGeneration
    if (generation === null || generation >= Number.MAX_SAFE_INTEGER) {
      fail('not_member', 'Channel agent has no rotatable stable identity')
    }
    if (!this.latestChannelMembership(inspection, input.channelId)) {
      fail('not_member', 'Channel agent is not enrolled in the source Channel')
    }
    const channels = this.deps.service.listChannels()
    const byId = new Map(channels.map((channel) => [channel.channelId, channel] as const))
    const requested = new Set(input.reEnrollChannelIds)
    const targets = new Map<string, ChannelProductionChannelView>()
    for (const membership of inspection.memberships) {
      const channel = byId.get(membership.channelId)
      if (!channel) fail('recovery_blocked', 'Agent membership Channel is unavailable')
      if (channel.availability !== 'ready') {
        fail('recovery_blocked', 'Agent rotation cannot change a recovery-blocked Channel')
      }
      if (channel.status !== 'active' || membership.keyGeneration !== generation) continue
      if (membership.status === 'active' || requested.has(channel.channelId)) {
        targets.set(channel.channelId, channel)
        requested.delete(channel.channelId)
      }
    }
    if (requested.size > 0) {
      fail('not_member', 'Requested re-enrollment Channel has no matching agent generation')
    }
    if (targets.size === 0 || targets.size > MAX_ROTATION_CHANNELS) {
      fail('not_member', 'Channel agent has no bounded rotation target')
    }
    return {
      kind: 'rotate',
      operationId: managedOperationId,
      seat: this.cleanupSeat(source, inspection),
      fromKeyGeneration: generation,
      toKeyGeneration: generation + 1,
      channels: [...targets.values()]
        .sort((left, right) => left.channelId.localeCompare(right.channelId))
        .map((channel) => ({
          channelId: channel.channelId,
          channelTitle: channel.display.title
        }))
    }
  }

  private async confirmAndApply(
    owner: BrowserWindow | null,
    resolveRequest: () => ChannelAgentNativeConfirmationRequest,
    apply: (
      request: ChannelAgentNativeConfirmationRequest
    ) => Promise<ChannelAgentManagementAppliedView>
  ): Promise<ChannelAgentManagementOutcome> {
    const request = resolveRequest()
    const decision = await this.confirm(owner, request)
    if (!decision.confirmed) return { status: 'declined' }
    let current: ChannelAgentNativeConfirmationRequest
    try {
      current = resolveRequest()
    } catch {
      return { status: 'stale' }
    }
    if (hashChannelAgentNativeConfirmation(current) !== decision.confirmationDigest) {
      return { status: 'stale' }
    }
    return { status: 'applied', value: await apply(current) }
  }
}
