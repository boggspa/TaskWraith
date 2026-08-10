import { createHash } from 'crypto'

import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { AppSettings, ChatRecord, EffectiveRunPermissions, ProviderId } from '../store/types'
import { hashChannelAgentContent } from '../../shared/collaboration/ChannelAgentProtocol'
import {
  CHANNEL_AGENT_AUTHORITY_STATE_VERSION,
  type ChannelAgentAuthoritySnapshot,
  type ChannelAgentDispatchConsumption,
  type ConsumeChannelAgentDispatchInput,
  type RecordedChannelAgentDelegation,
  type RecordedChannelAgentDispatchGrant,
  type RecordedChannelAgentRevocation
} from './ChannelAgentAuthorityState'
import type { ChannelAgentMentionTarget } from './ChannelAgentMentionAdmission'
import {
  CHANNEL_AGENT_GRANT_PERMISSION_PRESETS,
  resolveChannelAgentGrantAuthority,
  type ChannelAgentGrantPermissionPresetId,
  type ChannelAgentSeatCandidate,
  type ChannelAgentWorkspacePrincipal
} from './ChannelAgentSeatAuthority'
import { wrapExternalContribution } from './ExternalContributionContext'
import type { HumanChannelMessage } from './ChannelMessageLog'
import type { AgentChannelMember, Channel, ChannelMember, HumanChannelMember } from './ChannelStore'

export const CHANNEL_AGENT_RUN_AUTHORITY_VERSION = 1 as const
export const CHANNEL_AGENT_RUN_AUTHORITY_DOMAIN = 'taskwraith.channel.agent-run-authority.v1'

const MAX_IDENTIFIER_LENGTH = 512

export type ChannelAgentDispatchPlanDenialReason =
  | 'authority_expired'
  | 'authority_not_yet_valid'
  | 'authority_revoked'
  | 'binding_mismatch'
  | 'dispatch_budget_exhausted'
  | 'dispatch_grant_ambiguous'
  | 'dispatch_grant_missing'
  | 'duplicate_trigger'
  | 'mentioner_not_allowed'
  | 'permission_posture_mismatch'
  | 'seat_unavailable'
  | 'workspace_identity_mismatch'

export interface ChannelAgentDispatchPlan {
  readonly channelId: string
  readonly chatId: string
  readonly ownerMemberId: string
  readonly triggerMessageId: string
  readonly triggerContentHash: string
  readonly mentionerMemberId: string
  readonly target: ChannelAgentMentionTarget
  readonly member: AgentChannelMember
  readonly seat: ChannelAgentSeatCandidate
  readonly permissionPresetId: ChannelAgentGrantPermissionPresetId
  readonly effectivePermissions: EffectiveRunPermissions
  readonly workspacePrincipal: ChannelAgentWorkspacePrincipal
  readonly workspacePath: string | null
  readonly workspaceIdentityHash: string
  readonly permissionPostureHash: string
  /** Exact replay-verified prefix against which this plan was selected. */
  readonly authorityRevision: number
  /** Exact next use of the selected grant in that replay-verified prefix. */
  readonly expectedDispatchOrdinal: number
  readonly delegation: RecordedChannelAgentDelegation['signedDelegation']
  readonly dispatchGrant: RecordedChannelAgentDispatchGrant['signedDispatchGrant']
  /** Authority fields frozen provisionally; `at` is minted only at launch. */
  readonly consumeInput: Omit<ConsumeChannelAgentDispatchInput, 'at'>
  /** The only trigger bytes that may enter provider composition. */
  readonly wrappedPrompt: string
}

export type ChannelAgentDispatchPlanResult =
  | { readonly kind: 'authorized'; readonly plan: ChannelAgentDispatchPlan }
  | { readonly kind: 'denied'; readonly reason: ChannelAgentDispatchPlanDenialReason }

export interface ResolveChannelAgentDispatchPlanInput {
  readonly channel: Channel
  readonly trigger: HumanChannelMessage
  readonly target: ChannelAgentMentionTarget
  readonly members: readonly ChannelMember[]
  readonly chat: ChatRecord
  readonly workspacePrincipal: ChannelAgentWorkspacePrincipal
  readonly settings: Pick<AppSettings, 'agenticServices' | 'agenticWorkspaceGrants'>
  readonly providerAllowed: (provider: ProviderId) => boolean
  /** Replay-verified snapshot returned by ChannelAgentAuthorityStore. */
  readonly authority: ChannelAgentAuthoritySnapshot | null
  /** Main launch/admission time, not renderer or relay time. */
  readonly at: number
}

export interface ChannelAgentRunLaunchProjection {
  readonly provider: ProviderId
  readonly scope: AgentRunPayload['scope']
  readonly workspace: string | null
  readonly prompt: string
  readonly appRunId: string
  readonly appChatId: string
  readonly model: string | null
  readonly reasoningEffort: string | null
  readonly serviceTier: string | null
  readonly claudeReasoningEffort: string | null
  readonly claudeFastMode: boolean | null
  readonly kimiThinking: boolean | null
  readonly approvalMode: string
  readonly workflowMode: AgentRunPayload['workflowMode'] | null
  readonly runtimeProfileId: string | null
  readonly geminiAuthProfileId: string | null
  readonly taskWraithMcpProfileId: string | null
  readonly taskWraithMcpAdvertised: boolean
  readonly effectivePermissions: EffectiveRunPermissions
}

export interface ChannelAgentRunAuthoritySeal {
  readonly schemaVersion: typeof CHANNEL_AGENT_RUN_AUTHORITY_VERSION
  readonly channelId: string
  readonly chatId: string
  readonly ownerMemberId: string
  readonly agentMemberId: string
  readonly agentSeatId: string
  readonly keyGeneration: number
  readonly delegationId: string
  readonly dispatchGrantId: string
  readonly triggerMessageId: string
  readonly mentionerMemberId: string
  readonly consumptionRevision: number
  readonly dispatchOrdinal: number
  readonly runId: string
  readonly provider: ProviderId
  readonly scope: AgentRunPayload['scope']
  readonly workspaceIdentityHash: string
  readonly permissionPostureHash: string
  readonly promptHash: string
  readonly launchPayloadHash: string
  readonly launchedAt: number
}

export interface CreateChannelAgentRunAuthoritySealInput {
  readonly plan: ChannelAgentDispatchPlan
  readonly consumption: ChannelAgentDispatchConsumption
  /** Exact main-owned projection retained after generic normalization. */
  readonly expectedPayload: AgentRunPayload
  /** Normalized, runtime-profile-applied payload observed at the adapter launch barrier. */
  readonly launchPayload: AgentRunPayload
  readonly launchedAt: number
}

export type ChannelAgentRunAuthorityErrorCode =
  | 'consumption_mismatch'
  | 'launch_payload_forbidden'
  | 'launch_payload_mismatch'

export class ChannelAgentRunAuthorityError extends Error {
  constructor(
    readonly code: ChannelAgentRunAuthorityErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ChannelAgentRunAuthorityError'
  }
}

interface GrantCandidate {
  readonly delegation: RecordedChannelAgentDelegation
  readonly grant: RecordedChannelAgentDispatchGrant
  readonly preset: ReturnType<typeof resolveChannelAgentGrantAuthority>
}

function isIdentifier(value: unknown): value is string {
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

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right)
}

function digest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(`${domain}\n${stableJson(value)}`, 'utf8')
    .digest('hex')
}

function textDigest(domain: string, value: string): string {
  return createHash('sha256').update(`${domain}\n${value}`, 'utf8').digest('hex')
}

function activeHumanAuthor(input: ResolveChannelAgentDispatchPlanInput): HumanChannelMember | null {
  const matches = input.members.filter(
    (member) =>
      member.channelId === input.channel.channelId &&
      member.memberId === input.trigger.authorMemberId
  )
  if (matches.length !== 1) return null
  const author = matches[0]
  return author?.kind === 'human' && author.status === 'active' ? author : null
}

function exactAgentMember(input: ResolveChannelAgentDispatchPlanInput): AgentChannelMember | null {
  const matches = input.members.filter(
    (candidate) =>
      candidate.channelId === input.channel.channelId &&
      candidate.memberId === input.target.memberId
  )
  if (matches.length !== 1) return null
  const member = matches[0]
  return member?.kind === 'agent' &&
    member.status === 'active' &&
    member.agentSeatId === input.target.agentSeatId &&
    member.keyGeneration === input.target.keyGeneration
    ? member
    : null
}

function rootBindingsMatch(input: ResolveChannelAgentDispatchPlanInput): boolean {
  return (
    input.channel.status === 'active' &&
    input.channel.channelId === input.trigger.channelId &&
    input.channel.chatId === input.chat.appChatId &&
    input.trigger.kind === 'human.text' &&
    isTimestamp(input.trigger.acceptedAt) &&
    input.trigger.acceptedAt <= input.at &&
    input.trigger.contentHash === hashChannelAgentContent(input.trigger.content)
  )
}

function delegationForGrant(
  snapshot: ChannelAgentAuthoritySnapshot,
  grant: RecordedChannelAgentDispatchGrant
): RecordedChannelAgentDelegation | null {
  return (
    snapshot.delegations.find(
      (candidate) =>
        candidate.signedDelegation.delegation.delegationId ===
        grant.signedDispatchGrant.grant.delegationId
    ) ?? null
  )
}

function revocationMatchesDelegation(
  record: RecordedChannelAgentRevocation,
  delegation: RecordedChannelAgentDelegation
): boolean {
  const revocation = record.signedRevocation.revocation
  const value = delegation.signedDelegation.delegation
  if (
    revocation.channelId !== value.channelId ||
    revocation.ownerMemberId !== value.ownerMemberId ||
    revocation.agentSeatId !== value.agentSeatId ||
    revocation.keyGeneration !== value.keyGeneration
  ) {
    return false
  }
  if (revocation.targetKind === 'delegation') {
    return revocation.targetId === value.delegationId
  }
  if (revocation.targetKind === 'agent_key') {
    return (
      revocation.targetId ===
      createHash('sha256').update(Buffer.from(value.agentPublicKeyB64, 'base64')).digest('hex')
    )
  }
  return true
}

function authorityRevoked(
  snapshot: ChannelAgentAuthoritySnapshot,
  delegation: RecordedChannelAgentDelegation,
  grantId: string,
  at: number
): boolean {
  const prospectiveRevision = snapshot.revision + 1
  return snapshot.revocations.some((record) => {
    const revocation = record.signedRevocation.revocation
    if (!revocationMatchesDelegation(record, delegation)) return false
    if (revocation.targetKind === 'dispatch_grant' && revocation.targetId !== grantId) return false
    return (
      revocation.revokedAt < at ||
      (revocation.revokedAt === at && record.recordedRevision < prospectiveRevision)
    )
  })
}

function grantBindingMatches(
  input: ResolveChannelAgentDispatchPlanInput,
  member: AgentChannelMember,
  delegation: RecordedChannelAgentDelegation,
  grant: RecordedChannelAgentDispatchGrant
): boolean {
  const delegationValue = delegation.signedDelegation.delegation
  const grantValue = grant.signedDispatchGrant.grant
  return (
    delegationValue.channelId === input.channel.channelId &&
    delegationValue.ownerMemberId === input.channel.ownerMemberId &&
    delegationValue.agentMemberId === member.memberId &&
    delegationValue.agentSeatId === member.agentSeatId &&
    delegationValue.agentPublicKeyB64 === member.identityPublicKey &&
    delegationValue.keyGeneration === member.keyGeneration &&
    delegationValue.scopes.includes('channel.dispatch') &&
    delegationValue.scopes.includes('channel.post') &&
    grantValue.channelId === input.channel.channelId &&
    grantValue.ownerMemberId === input.channel.ownerMemberId &&
    grantValue.agentMemberId === member.memberId &&
    grantValue.agentSeatId === member.agentSeatId &&
    grantValue.agentPublicKeyB64 === member.identityPublicKey &&
    grantValue.keyGeneration === member.keyGeneration &&
    grantValue.delegationId === delegationValue.delegationId &&
    grantValue.trigger === 'mention'
  )
}

function matchingPreset(
  input: ResolveChannelAgentDispatchPlanInput,
  agentSeatId: string,
  grant: RecordedChannelAgentDispatchGrant
): ReturnType<typeof resolveChannelAgentGrantAuthority> | null {
  const grantValue = grant.signedDispatchGrant.grant
  for (const permissionPresetId of CHANNEL_AGENT_GRANT_PERMISSION_PRESETS) {
    let authority: ReturnType<typeof resolveChannelAgentGrantAuthority>
    try {
      authority = resolveChannelAgentGrantAuthority({
        chat: input.chat,
        agentSeatId,
        permissionPresetId,
        workspacePrincipal: input.workspacePrincipal,
        settings: input.settings,
        providerAllowed: input.providerAllowed
      })
    } catch {
      return null
    }
    if (
      authority.workspaceIdentityHash === grantValue.workspaceIdentityHash &&
      authority.permissionPostureHash === grantValue.permissionPostureHash
    ) {
      return authority
    }
  }
  return null
}

function denialFromObservedFailures(failures: ReadonlySet<ChannelAgentDispatchPlanDenialReason>) {
  const priority: readonly ChannelAgentDispatchPlanDenialReason[] = [
    'duplicate_trigger',
    'authority_revoked',
    'authority_not_yet_valid',
    'authority_expired',
    'mentioner_not_allowed',
    'workspace_identity_mismatch',
    'permission_posture_mismatch',
    'dispatch_budget_exhausted',
    'dispatch_grant_missing'
  ]
  return priority.find((reason) => failures.has(reason)) ?? 'dispatch_grant_missing'
}

/**
 * Resolve one accepted human record to one current signed grant without spending
 * it. The caller must mint `createChannelAgentDispatchConsumptionInput` at the
 * adapter launch barrier and pass that value to the durable authority store;
 * planning alone never grants provider authority.
 */
export function resolveChannelAgentDispatchPlan(
  input: ResolveChannelAgentDispatchPlanInput
): ChannelAgentDispatchPlanResult {
  if (!isTimestamp(input?.at) || !rootBindingsMatch(input) || !activeHumanAuthor(input)) {
    return { kind: 'denied', reason: 'binding_mismatch' }
  }
  const member = exactAgentMember(input)
  if (!member) return { kind: 'denied', reason: 'binding_mismatch' }

  let canonicalSeat: ChannelAgentSeatCandidate | null = null
  try {
    canonicalSeat = resolveChannelAgentGrantAuthority({
      chat: input.chat,
      agentSeatId: member.agentSeatId,
      permissionPresetId: 'read_only',
      workspacePrincipal: input.workspacePrincipal,
      settings: input.settings,
      providerAllowed: input.providerAllowed
    }).seat
  } catch {
    return { kind: 'denied', reason: 'seat_unavailable' }
  }

  const snapshot = input.authority
  if (!snapshot) return { kind: 'denied', reason: 'dispatch_grant_missing' }
  if (
    snapshot.channelId !== input.channel.channelId ||
    snapshot.ownerMemberId !== input.channel.ownerMemberId
  ) {
    return { kind: 'denied', reason: 'binding_mismatch' }
  }
  const failures = new Set<ChannelAgentDispatchPlanDenialReason>()
  const candidates: GrantCandidate[] = []
  for (const grant of snapshot.dispatchGrants) {
    const grantValue = grant.signedDispatchGrant.grant
    if (
      grantValue.channelId !== input.channel.channelId ||
      grantValue.agentMemberId !== member.memberId ||
      grantValue.agentSeatId !== member.agentSeatId ||
      grantValue.keyGeneration !== member.keyGeneration
    ) {
      continue
    }
    const delegation = delegationForGrant(snapshot, grant)
    if (!delegation || !grantBindingMatches(input, member, delegation, grant)) {
      failures.add('binding_mismatch')
      continue
    }
    if (
      snapshot.consumptions.some(
        (consumption) =>
          consumption.grantId === grantValue.grantId &&
          consumption.triggerMessageId === input.trigger.messageId
      )
    ) {
      failures.add('duplicate_trigger')
      continue
    }
    if (authorityRevoked(snapshot, delegation, grantValue.grantId, input.at)) {
      failures.add('authority_revoked')
      continue
    }
    if (
      input.trigger.acceptedAt < delegation.signedDelegation.delegation.notBefore ||
      input.trigger.acceptedAt < grantValue.notBefore ||
      input.at < delegation.signedDelegation.delegation.notBefore ||
      input.at < grantValue.notBefore
    ) {
      failures.add('authority_not_yet_valid')
      continue
    }
    if (
      input.at >= delegation.signedDelegation.delegation.expiresAt ||
      input.at >= grantValue.expiresAt
    ) {
      failures.add('authority_expired')
      continue
    }
    if (!grantValue.allowedMentionerMemberIds.includes(input.trigger.authorMemberId)) {
      failures.add('mentioner_not_allowed')
      continue
    }
    const consumed = snapshot.consumptions.filter(
      (consumption) => consumption.grantId === grantValue.grantId
    ).length
    if (consumed >= grantValue.maxDispatches) {
      failures.add('dispatch_budget_exhausted')
      continue
    }
    const preset = matchingPreset(input, member.agentSeatId, grant)
    if (!preset) {
      let currentWorkspaceHash: string | null = null
      try {
        currentWorkspaceHash = resolveChannelAgentGrantAuthority({
          chat: input.chat,
          agentSeatId: member.agentSeatId,
          permissionPresetId: 'read_only',
          workspacePrincipal: input.workspacePrincipal,
          settings: input.settings,
          providerAllowed: input.providerAllowed
        }).workspaceIdentityHash
      } catch {
        // The seat was resolved immediately above; a later failure is a posture mismatch.
      }
      failures.add(
        currentWorkspaceHash !== grantValue.workspaceIdentityHash
          ? 'workspace_identity_mismatch'
          : 'permission_posture_mismatch'
      )
      continue
    }
    candidates.push({ delegation, grant, preset })
  }

  if (candidates.length === 0) {
    return { kind: 'denied', reason: denialFromObservedFailures(failures) }
  }
  if (candidates.length !== 1) {
    return { kind: 'denied', reason: 'dispatch_grant_ambiguous' }
  }
  const candidate = candidates[0]
  const grant = candidate.grant.signedDispatchGrant.grant
  const wrappedPrompt = wrapExternalContribution(input.trigger.content, {
    senderDisplayName: activeHumanAuthor(input)!.displayName,
    shareId: input.channel.channelId,
    collaboratorId: input.trigger.authorMemberId,
    messageId: input.trigger.messageId,
    timestamp: new Date(input.trigger.acceptedAt).toISOString(),
    review: 'unreviewed'
  })
  return {
    kind: 'authorized',
    plan: {
      channelId: input.channel.channelId,
      chatId: input.chat.appChatId,
      ownerMemberId: input.channel.ownerMemberId,
      triggerMessageId: input.trigger.messageId,
      triggerContentHash: input.trigger.contentHash,
      mentionerMemberId: input.trigger.authorMemberId,
      target: clone(input.target),
      member: clone(member),
      seat: clone(canonicalSeat),
      permissionPresetId: candidate.preset.permissionPresetId,
      effectivePermissions: clone(candidate.preset.effectivePermissions),
      workspacePrincipal: clone(input.workspacePrincipal),
      workspacePath:
        input.workspacePrincipal.kind === 'workspace' ? (input.chat.workspacePath ?? null) : null,
      workspaceIdentityHash: candidate.preset.workspaceIdentityHash,
      permissionPostureHash: candidate.preset.permissionPostureHash,
      authorityRevision: snapshot.revision,
      expectedDispatchOrdinal:
        snapshot.consumptions.filter((consumption) => consumption.grantId === grant.grantId)
          .length + 1,
      delegation: clone(candidate.delegation.signedDelegation),
      dispatchGrant: clone(candidate.grant.signedDispatchGrant),
      consumeInput: {
        grantId: grant.grantId,
        triggerMessageId: input.trigger.messageId,
        mentionerMemberId: input.trigger.authorMemberId,
        workspaceIdentityHash: candidate.preset.workspaceIdentityHash,
        permissionPostureHash: candidate.preset.permissionPostureHash
      },
      wrappedPrompt
    }
  }
}

/**
 * Mint the only timestamp accepted by the durable launch consumption. The
 * signed windows are checked here; the store remains authoritative for the
 * current revision, revocations, duplicate trigger, and remaining budget.
 */
export function createChannelAgentDispatchConsumptionInput(
  plan: ChannelAgentDispatchPlan,
  at: number
): ConsumeChannelAgentDispatchInput {
  if (!isTimestamp(at)) {
    throw new ChannelAgentRunAuthorityError(
      'consumption_mismatch',
      'Channel agent dispatch consumption time is invalid'
    )
  }
  const delegation = plan.delegation.delegation
  const grant = plan.dispatchGrant.grant
  if (
    at < delegation.notBefore ||
    at < grant.notBefore ||
    at >= delegation.expiresAt ||
    at >= grant.expiresAt
  ) {
    throw new ChannelAgentRunAuthorityError(
      'consumption_mismatch',
      'Channel agent dispatch authority is not current at launch'
    )
  }
  return { ...clone(plan.consumeInput), at }
}

function forbiddenLaunchField(payload: AgentRunPayload): boolean {
  const extended = payload as AgentRunPayload & Record<string, unknown>
  return Boolean(
    payload.providerReroute ||
    payload.resumeFallbackPrompt ||
    payload.activeGoal ||
    payload.failoverHopCount !== undefined ||
    payload.ensembleRun ||
    payload.auditRun ||
    payload.handoffSourceRunId ||
    payload.projectReferenceContext ||
    payload.geminiWorktree ||
    payload.sessionTrust ||
    payload.usagePromptText !== undefined ||
    payload.imageAttachmentWarning !== undefined ||
    payload.ollamaRunProfile !== undefined ||
    (payload.providerSessionId !== undefined && payload.providerSessionId !== null) ||
    (payload.imagePaths?.length ?? 0) > 0 ||
    (payload.externalPathGrants?.length ?? 0) > 0 ||
    Object.prototype.hasOwnProperty.call(extended, 'scheduledTaskId')
  )
}

function launchProjection(payload: AgentRunPayload): ChannelAgentRunLaunchProjection {
  if (forbiddenLaunchField(payload)) {
    throw new ChannelAgentRunAuthorityError(
      'launch_payload_forbidden',
      'Channel agent launch payload carries an unrelated run authority'
    )
  }
  if (
    !isIdentifier(payload.appRunId) ||
    !isIdentifier(payload.appChatId) ||
    typeof payload.prompt !== 'string' ||
    !payload.prompt ||
    !payload.effectivePermissions ||
    !isIdentifier(payload.approvalMode)
  ) {
    throw new ChannelAgentRunAuthorityError(
      'launch_payload_mismatch',
      'Channel agent launch payload is incomplete'
    )
  }
  return {
    provider: payload.provider,
    scope: payload.scope,
    workspace: payload.workspace ?? null,
    prompt: payload.prompt,
    appRunId: payload.appRunId,
    appChatId: payload.appChatId,
    model: payload.model ?? null,
    reasoningEffort: payload.reasoningEffort ?? null,
    serviceTier: payload.serviceTier ?? null,
    claudeReasoningEffort: payload.claudeReasoningEffort ?? null,
    claudeFastMode: payload.claudeFastMode ?? null,
    kimiThinking: payload.kimiThinking ?? null,
    approvalMode: payload.approvalMode,
    workflowMode: payload.workflowMode ?? null,
    runtimeProfileId: payload.runtimeProfileId ?? null,
    geminiAuthProfileId: payload.geminiAuthProfileId ?? null,
    taskWraithMcpProfileId: payload.taskWraithMcpProfileId ?? null,
    taskWraithMcpAdvertised: payload.taskWraithMcpAdvertised === true,
    effectivePermissions: clone(payload.effectivePermissions)
  }
}

function assertConsumptionMatchesPlan(
  plan: ChannelAgentDispatchPlan,
  consumption: ChannelAgentDispatchConsumption
): void {
  if (
    consumption.schemaVersion !== CHANNEL_AGENT_AUTHORITY_STATE_VERSION ||
    consumption.channelId !== plan.channelId ||
    consumption.grantId !== plan.dispatchGrant.grant.grantId ||
    consumption.triggerMessageId !== plan.triggerMessageId ||
    consumption.mentionerMemberId !== plan.mentionerMemberId ||
    consumption.workspaceIdentityHash !== plan.workspaceIdentityHash ||
    consumption.permissionPostureHash !== plan.permissionPostureHash ||
    consumption.recordedRevision !== plan.authorityRevision + 1 ||
    consumption.consumedAt < plan.delegation.delegation.notBefore ||
    consumption.consumedAt < plan.dispatchGrant.grant.notBefore ||
    consumption.consumedAt >= plan.delegation.delegation.expiresAt ||
    consumption.consumedAt >= plan.dispatchGrant.grant.expiresAt ||
    consumption.dispatchOrdinal !== plan.expectedDispatchOrdinal ||
    !Number.isSafeInteger(consumption.recordedRevision) ||
    consumption.recordedRevision < 1 ||
    !Number.isSafeInteger(consumption.dispatchOrdinal) ||
    consumption.dispatchOrdinal < 1
  ) {
    throw new ChannelAgentRunAuthorityError(
      'consumption_mismatch',
      'Channel agent dispatch consumption does not match its plan'
    )
  }
}

/**
 * Bind the replay-verified consumption to the exact main-owned payload retained
 * after generic normalization and runtime-profile application. Any later
 * reroute, session inheritance, attachment, prompt mutation, or posture drift
 * fails before the provider adapter receives the request.
 */
export function createChannelAgentRunAuthoritySeal(
  input: CreateChannelAgentRunAuthoritySealInput
): ChannelAgentRunAuthoritySeal {
  if (!isTimestamp(input?.launchedAt)) {
    throw new ChannelAgentRunAuthorityError(
      'launch_payload_mismatch',
      'Channel agent launch timestamp is invalid'
    )
  }
  assertConsumptionMatchesPlan(input.plan, input.consumption)
  const expected = launchProjection(input.expectedPayload)
  const launched = launchProjection(input.launchPayload)
  const wrappedPromptOccurrences = launched.prompt.split(input.plan.wrappedPrompt).length - 1
  const expectedScope = input.plan.workspacePrincipal.kind === 'workspace' ? 'workspace' : 'global'
  if (
    !sameJson(expected, launched) ||
    launched.provider !== input.plan.seat.provider ||
    launched.scope !== expectedScope ||
    launched.workspace !== input.plan.workspacePath ||
    launched.appChatId !== input.plan.chatId ||
    (input.plan.seat.model !== undefined && launched.model !== input.plan.seat.model) ||
    launched.runtimeProfileId !== (input.plan.seat.runtimeProfileId ?? null) ||
    launched.geminiAuthProfileId !== (input.plan.seat.geminiAuthProfileId ?? null) ||
    launched.approvalMode !== input.plan.effectivePermissions.approvalMode ||
    !sameJson(launched.effectivePermissions, input.plan.effectivePermissions) ||
    wrappedPromptOccurrences !== 1 ||
    input.launchedAt !== input.consumption.consumedAt
  ) {
    throw new ChannelAgentRunAuthorityError(
      'launch_payload_mismatch',
      'Channel agent launch payload changed after authorization'
    )
  }
  const grant = input.plan.dispatchGrant.grant
  const seal: ChannelAgentRunAuthoritySeal = {
    schemaVersion: CHANNEL_AGENT_RUN_AUTHORITY_VERSION,
    channelId: input.plan.channelId,
    chatId: input.plan.chatId,
    ownerMemberId: input.plan.ownerMemberId,
    agentMemberId: input.plan.member.memberId,
    agentSeatId: input.plan.member.agentSeatId,
    keyGeneration: input.plan.member.keyGeneration,
    delegationId: input.plan.delegation.delegation.delegationId,
    dispatchGrantId: grant.grantId,
    triggerMessageId: input.plan.triggerMessageId,
    mentionerMemberId: input.plan.mentionerMemberId,
    consumptionRevision: input.consumption.recordedRevision,
    dispatchOrdinal: input.consumption.dispatchOrdinal,
    runId: launched.appRunId,
    provider: launched.provider,
    scope: launched.scope,
    workspaceIdentityHash: input.plan.workspaceIdentityHash,
    permissionPostureHash: input.plan.permissionPostureHash,
    promptHash: textDigest('taskwraith.channel.agent-run-prompt.v1', launched.prompt),
    launchPayloadHash: digest('taskwraith.channel.agent-launch-payload.v1', launched),
    launchedAt: input.launchedAt
  }
  return seal
}

export function hashChannelAgentRunAuthoritySeal(seal: ChannelAgentRunAuthoritySeal): string {
  return digest(CHANNEL_AGENT_RUN_AUTHORITY_DOMAIN, seal)
}
