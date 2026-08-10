import { createHash } from 'crypto'

import {
  CHANNEL_AGENT_MAX_POST_BYTES,
  CHANNEL_AGENT_SIGNATURE_DOMAINS,
  canonicalChannelAgentStatement,
  channelAgentPublicKeyFingerprint,
  hashChannelAgentContent,
  parseSignedChannelAgentPost,
  type SignedChannelAgentPost
} from '../../shared/collaboration/ChannelAgentProtocol'
import { importRawEd25519PublicKey, verifyEd25519 } from '../../shared/e2ee/keys'
import {
  CHANNEL_AGENT_AUTHORITY_STATE_VERSION,
  type ChannelAgentDispatchConsumption
} from './ChannelAgentAuthorityState'
import {
  CHANNEL_AGENT_RUN_AUTHORITY_VERSION,
  hashChannelAgentRunAuthoritySeal,
  type ChannelAgentDispatchPlan,
  type ChannelAgentRunAuthoritySeal
} from './ChannelAgentDispatchAuthority'
import {
  MAX_CHANNEL_MESSAGE_BYTES,
  redactChannelContent,
  type AgentChannelMessage
} from './ChannelMessageLog'

export const CHANNEL_AGENT_DISPATCH_JOURNAL_VERSION = 1 as const
export const CHANNEL_AGENT_DISPATCH_ID_DOMAIN = 'taskwraith.channel.agent-dispatch-id.v1'
export const CHANNEL_AGENT_RUN_ID_DOMAIN = 'taskwraith.channel.agent-dispatch-run-id.v1'

const MAX_IDENTIFIER_LENGTH = 512
const MAX_JOURNAL_EVENTS = 8
const PROVIDERS = new Set([
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'antigravity',
  'pi',
  'mistral'
])

export type ChannelAgentDispatchJournalPhase =
  | 'reserved'
  | 'consuming'
  | 'consumed'
  | 'launching'
  | 'launched'
  | 'terminal'
  | 'signed'
  | 'posted'
  | 'abandoned'

export type ChannelAgentDispatchRecoveryDirective =
  | 'retry_before_consumption'
  | 'inspect_atomic_consumption'
  | 'abandon_consumed_without_launch'
  | 'reconcile_exact_run_without_redispatch'
  | 'sign_terminal_post'
  | 'append_signed_post'
  | 'complete'

export type ChannelAgentDispatchTerminalStatus = 'succeeded' | 'failed' | 'cancelled'

export type ChannelAgentDispatchAbandonReason =
  | 'preflight_declined'
  | 'consumed_before_launch_recovery'
  | 'launch_outcome_unknown'
  | 'run_terminal_unavailable'
  | 'post_authority_unavailable'

export type ChannelAgentDispatchJournalStateErrorCode =
  | 'binding_mismatch'
  | 'illegal_transition'
  | 'invalid_input'
  | 'invalid_snapshot'

export class ChannelAgentDispatchJournalStateError extends Error {
  constructor(
    readonly code: ChannelAgentDispatchJournalStateErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ChannelAgentDispatchJournalStateError'
  }
}

export interface ChannelAgentDispatchJournalBinding {
  readonly dispatchId: string
  readonly runId: string
  readonly channelId: string
  readonly chatId: string
  readonly ownerMemberId: string
  readonly agentMemberId: string
  readonly agentSeatId: string
  readonly agentPublicKeyFingerprint: string
  readonly keyGeneration: number
  readonly delegationId: string
  readonly delegationNotBefore: number
  readonly delegationExpiresAt: number
  readonly maxPostBytes: number
  readonly dispatchGrantId: string
  readonly dispatchGrantNotBefore: number
  readonly dispatchGrantExpiresAt: number
  readonly triggerMessageId: string
  readonly triggerContentHash: string
  readonly mentionerMemberId: string
  readonly workspaceIdentityHash: string
  readonly permissionPostureHash: string
  readonly reservedAt: number
}

export interface ChannelAgentConsumptionIntentEvent {
  readonly kind: 'consumption.intent'
  readonly sequence: number
  readonly at: number
  readonly authorityRevision: number
  readonly expectedDispatchOrdinal: number
}

export interface ChannelAgentConsumptionCommittedEvent {
  readonly kind: 'consumption.committed'
  readonly sequence: number
  readonly at: number
  readonly consumption: ChannelAgentDispatchConsumption
}

export interface ChannelAgentLaunchIntentEvent {
  readonly kind: 'launch.intent'
  readonly sequence: number
  readonly at: number
  readonly seal: ChannelAgentRunAuthoritySeal
  readonly sealHash: string
}

export interface ChannelAgentLaunchConfirmedEvent {
  readonly kind: 'launch.confirmed'
  readonly sequence: number
  readonly at: number
}

export interface ChannelAgentRunTerminalEvent {
  readonly kind: 'run.terminal'
  readonly sequence: number
  readonly at: number
  readonly status: ChannelAgentDispatchTerminalStatus
  readonly exitCode: number | null
  readonly content: string
  readonly contentHash: string
}

export interface ChannelAgentPostSignedEvent {
  readonly kind: 'post.signed'
  readonly sequence: number
  readonly at: number
  readonly signedPost: SignedChannelAgentPost
}

export interface ChannelAgentPostCommittedEvent {
  readonly kind: 'post.committed'
  readonly sequence: number
  readonly at: number
  readonly messageId: string
  readonly messageSequence: number
  readonly deduplicated: boolean
}

export interface ChannelAgentDispatchAbandonedEvent {
  readonly kind: 'dispatch.abandoned'
  readonly sequence: number
  readonly at: number
  readonly reason: ChannelAgentDispatchAbandonReason
}

export type ChannelAgentDispatchJournalEvent =
  | ChannelAgentConsumptionIntentEvent
  | ChannelAgentConsumptionCommittedEvent
  | ChannelAgentLaunchIntentEvent
  | ChannelAgentLaunchConfirmedEvent
  | ChannelAgentRunTerminalEvent
  | ChannelAgentPostSignedEvent
  | ChannelAgentPostCommittedEvent
  | ChannelAgentDispatchAbandonedEvent

export interface ChannelAgentDispatchJournalSnapshot {
  readonly schemaVersion: typeof CHANNEL_AGENT_DISPATCH_JOURNAL_VERSION
  readonly binding: ChannelAgentDispatchJournalBinding
  readonly events: readonly ChannelAgentDispatchJournalEvent[]
}

export interface ChannelAgentDispatchTerminalInput {
  readonly status: ChannelAgentDispatchTerminalStatus
  readonly exitCode: number | null
  /** Provider-derived terminal copy. It is scrubbed before entering the journal. */
  readonly content: string
  readonly at: number
}

export interface ChannelAgentDispatchIdBindings {
  readonly channelId: string
  readonly agentMemberId: string
  readonly agentSeatId: string
  readonly agentPublicKeyFingerprint: string
  readonly keyGeneration: number
  readonly dispatchGrantId: string
  readonly triggerMessageId: string
}

function stateError(
  code: ChannelAgentDispatchJournalStateErrorCode,
  message: string
): ChannelAgentDispatchJournalStateError {
  return new ChannelAgentDispatchJournalStateError(code, message)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  if (actual.length !== expected.length) return false
  const keys = new Set(expected)
  return actual.every((key) => keys.has(key))
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

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1
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

export function channelAgentDispatchJournalId(input: ChannelAgentDispatchIdBindings): string {
  if (
    !isIdentifier(input?.channelId) ||
    !isIdentifier(input.agentMemberId) ||
    !isIdentifier(input.agentSeatId) ||
    !isHash(input.agentPublicKeyFingerprint) ||
    !isPositiveInteger(input.keyGeneration) ||
    !isIdentifier(input.dispatchGrantId) ||
    !isIdentifier(input.triggerMessageId)
  ) {
    throw stateError('invalid_input', 'Channel agent dispatch identity is invalid')
  }
  return `channel-agent-dispatch-${digest(CHANNEL_AGENT_DISPATCH_ID_DOMAIN, {
    channelId: input.channelId,
    agentMemberId: input.agentMemberId,
    agentSeatId: input.agentSeatId,
    agentPublicKeyFingerprint: input.agentPublicKeyFingerprint,
    keyGeneration: input.keyGeneration,
    dispatchGrantId: input.dispatchGrantId,
    triggerMessageId: input.triggerMessageId
  })}`
}

export function channelAgentRunIdForDispatch(dispatchId: string): string {
  if (!isIdentifier(dispatchId)) {
    throw stateError('invalid_input', 'Channel agent dispatch id is invalid')
  }
  return `channel-agent-run-${digest(CHANNEL_AGENT_RUN_ID_DOMAIN, dispatchId)}`
}

export function channelAgentPostClientMessageId(dispatchId: string): string {
  if (!isIdentifier(dispatchId)) {
    throw stateError('invalid_input', 'Channel agent dispatch id is invalid')
  }
  return `channel-agent-post-${digest('taskwraith.channel.agent-post-id.v1', dispatchId)}`
}

function expectedDispatchId(binding: ChannelAgentDispatchIdBindings): string {
  return channelAgentDispatchJournalId(binding)
}

function publicKeyFingerprint(value: string): string | null {
  try {
    return channelAgentPublicKeyFingerprint(value)
  } catch {
    return null
  }
}

function parseBinding(value: unknown): ChannelAgentDispatchJournalBinding | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'dispatchId',
      'runId',
      'channelId',
      'chatId',
      'ownerMemberId',
      'agentMemberId',
      'agentSeatId',
      'agentPublicKeyFingerprint',
      'keyGeneration',
      'delegationId',
      'delegationNotBefore',
      'delegationExpiresAt',
      'maxPostBytes',
      'dispatchGrantId',
      'dispatchGrantNotBefore',
      'dispatchGrantExpiresAt',
      'triggerMessageId',
      'triggerContentHash',
      'mentionerMemberId',
      'workspaceIdentityHash',
      'permissionPostureHash',
      'reservedAt'
    ]) ||
    !isIdentifier(value.dispatchId) ||
    !isIdentifier(value.runId) ||
    !isIdentifier(value.channelId) ||
    !isIdentifier(value.chatId) ||
    !isIdentifier(value.ownerMemberId) ||
    !isIdentifier(value.agentMemberId) ||
    !isIdentifier(value.agentSeatId) ||
    !isHash(value.agentPublicKeyFingerprint) ||
    !isPositiveInteger(value.keyGeneration) ||
    !isIdentifier(value.delegationId) ||
    !isTimestamp(value.delegationNotBefore) ||
    !isTimestamp(value.delegationExpiresAt) ||
    (value.delegationExpiresAt as number) <= (value.delegationNotBefore as number) ||
    !isPositiveInteger(value.maxPostBytes) ||
    (value.maxPostBytes as number) > CHANNEL_AGENT_MAX_POST_BYTES ||
    !isIdentifier(value.dispatchGrantId) ||
    !isTimestamp(value.dispatchGrantNotBefore) ||
    !isTimestamp(value.dispatchGrantExpiresAt) ||
    (value.dispatchGrantExpiresAt as number) <= (value.dispatchGrantNotBefore as number) ||
    !isIdentifier(value.triggerMessageId) ||
    !isHash(value.triggerContentHash) ||
    !isIdentifier(value.mentionerMemberId) ||
    !isHash(value.workspaceIdentityHash) ||
    !isHash(value.permissionPostureHash) ||
    !isTimestamp(value.reservedAt)
  ) {
    return null
  }
  const binding = clone(value) as unknown as ChannelAgentDispatchJournalBinding
  if (
    binding.dispatchId !== expectedDispatchId(binding) ||
    binding.runId !== channelAgentRunIdForDispatch(binding.dispatchId) ||
    binding.reservedAt < binding.delegationNotBefore ||
    binding.reservedAt < binding.dispatchGrantNotBefore ||
    binding.reservedAt >= binding.delegationExpiresAt ||
    binding.reservedAt >= binding.dispatchGrantExpiresAt
  ) {
    return null
  }
  return binding
}

function parseConsumption(value: unknown): ChannelAgentDispatchConsumption | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'recordedRevision',
      'channelId',
      'grantId',
      'triggerMessageId',
      'mentionerMemberId',
      'workspaceIdentityHash',
      'permissionPostureHash',
      'dispatchOrdinal',
      'consumedAt'
    ]) ||
    value.schemaVersion !== CHANNEL_AGENT_AUTHORITY_STATE_VERSION ||
    !isPositiveInteger(value.recordedRevision) ||
    !isIdentifier(value.channelId) ||
    !isIdentifier(value.grantId) ||
    !isIdentifier(value.triggerMessageId) ||
    !isIdentifier(value.mentionerMemberId) ||
    !isHash(value.workspaceIdentityHash) ||
    !isHash(value.permissionPostureHash) ||
    !isPositiveInteger(value.dispatchOrdinal) ||
    !isTimestamp(value.consumedAt)
  ) {
    return null
  }
  return clone(value) as unknown as ChannelAgentDispatchConsumption
}

function parseSeal(value: unknown): ChannelAgentRunAuthoritySeal | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'channelId',
      'chatId',
      'ownerMemberId',
      'agentMemberId',
      'agentSeatId',
      'keyGeneration',
      'delegationId',
      'dispatchGrantId',
      'triggerMessageId',
      'mentionerMemberId',
      'consumptionRevision',
      'dispatchOrdinal',
      'runId',
      'provider',
      'scope',
      'workspaceIdentityHash',
      'permissionPostureHash',
      'promptHash',
      'launchPayloadHash',
      'launchedAt'
    ]) ||
    value.schemaVersion !== CHANNEL_AGENT_RUN_AUTHORITY_VERSION ||
    !isIdentifier(value.channelId) ||
    !isIdentifier(value.chatId) ||
    !isIdentifier(value.ownerMemberId) ||
    !isIdentifier(value.agentMemberId) ||
    !isIdentifier(value.agentSeatId) ||
    !isPositiveInteger(value.keyGeneration) ||
    !isIdentifier(value.delegationId) ||
    !isIdentifier(value.dispatchGrantId) ||
    !isIdentifier(value.triggerMessageId) ||
    !isIdentifier(value.mentionerMemberId) ||
    !isPositiveInteger(value.consumptionRevision) ||
    !isPositiveInteger(value.dispatchOrdinal) ||
    !isIdentifier(value.runId) ||
    !PROVIDERS.has(String(value.provider)) ||
    (value.scope !== 'workspace' && value.scope !== 'global') ||
    !isHash(value.workspaceIdentityHash) ||
    !isHash(value.permissionPostureHash) ||
    !isHash(value.promptHash) ||
    !isHash(value.launchPayloadHash) ||
    !isTimestamp(value.launchedAt)
  ) {
    return null
  }
  return clone(value) as unknown as ChannelAgentRunAuthoritySeal
}

function terminalContent(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const redacted = redactChannelContent(value).trim()
  if (
    !redacted ||
    redacted !== value ||
    Buffer.byteLength(redacted, 'utf8') > MAX_CHANNEL_MESSAGE_BYTES
  ) {
    return null
  }
  return redacted
}

function parseEvent(value: unknown): ChannelAgentDispatchJournalEvent | null {
  if (!isPlainObject(value) || !isPositiveInteger(value.sequence) || !isTimestamp(value.at)) {
    return null
  }
  switch (value.kind) {
    case 'consumption.intent':
      return hasExactKeys(value, [
        'kind',
        'sequence',
        'at',
        'authorityRevision',
        'expectedDispatchOrdinal'
      ]) &&
        Number.isSafeInteger(value.authorityRevision) &&
        (value.authorityRevision as number) >= 0 &&
        isPositiveInteger(value.expectedDispatchOrdinal)
        ? (clone(value) as unknown as ChannelAgentConsumptionIntentEvent)
        : null
    case 'consumption.committed': {
      const consumption = parseConsumption(value.consumption)
      return hasExactKeys(value, ['kind', 'sequence', 'at', 'consumption']) && consumption
        ? { kind: value.kind, sequence: value.sequence, at: value.at, consumption }
        : null
    }
    case 'launch.intent': {
      const seal = parseSeal(value.seal)
      return hasExactKeys(value, ['kind', 'sequence', 'at', 'seal', 'sealHash']) &&
        seal &&
        isHash(value.sealHash) &&
        value.sealHash === hashChannelAgentRunAuthoritySeal(seal)
        ? {
            kind: value.kind,
            sequence: value.sequence,
            at: value.at,
            seal,
            sealHash: value.sealHash
          }
        : null
    }
    case 'launch.confirmed':
      return hasExactKeys(value, ['kind', 'sequence', 'at'])
        ? (clone(value) as unknown as ChannelAgentLaunchConfirmedEvent)
        : null
    case 'run.terminal': {
      const content = terminalContent(value.content)
      return hasExactKeys(value, [
        'kind',
        'sequence',
        'at',
        'status',
        'exitCode',
        'content',
        'contentHash'
      ]) &&
        (value.status === 'succeeded' ||
          value.status === 'failed' ||
          value.status === 'cancelled') &&
        (value.exitCode === null || Number.isSafeInteger(value.exitCode)) &&
        content &&
        isHash(value.contentHash) &&
        value.contentHash === hashChannelAgentContent(content)
        ? {
            kind: value.kind,
            sequence: value.sequence,
            at: value.at,
            status: value.status,
            exitCode: value.exitCode as number | null,
            content,
            contentHash: value.contentHash
          }
        : null
    }
    case 'post.signed': {
      const signedPost = parseSignedChannelAgentPost(value.signedPost)
      return hasExactKeys(value, ['kind', 'sequence', 'at', 'signedPost']) && signedPost
        ? { kind: value.kind, sequence: value.sequence, at: value.at, signedPost }
        : null
    }
    case 'post.committed':
      return hasExactKeys(value, [
        'kind',
        'sequence',
        'at',
        'messageId',
        'messageSequence',
        'deduplicated'
      ]) &&
        isIdentifier(value.messageId) &&
        isPositiveInteger(value.messageSequence) &&
        typeof value.deduplicated === 'boolean'
        ? (clone(value) as unknown as ChannelAgentPostCommittedEvent)
        : null
    case 'dispatch.abandoned':
      return hasExactKeys(value, ['kind', 'sequence', 'at', 'reason']) &&
        (value.reason === 'preflight_declined' ||
          value.reason === 'consumed_before_launch_recovery' ||
          value.reason === 'launch_outcome_unknown' ||
          value.reason === 'run_terminal_unavailable' ||
          value.reason === 'post_authority_unavailable')
        ? (clone(value) as unknown as ChannelAgentDispatchAbandonedEvent)
        : null
    default:
      return null
  }
}

function phaseFromEvents(
  events: readonly ChannelAgentDispatchJournalEvent[]
): ChannelAgentDispatchJournalPhase {
  const last = events.at(-1)
  if (!last) return 'reserved'
  switch (last.kind) {
    case 'consumption.intent':
      return 'consuming'
    case 'consumption.committed':
      return 'consumed'
    case 'launch.intent':
      return 'launching'
    case 'launch.confirmed':
      return 'launched'
    case 'run.terminal':
      return 'terminal'
    case 'post.signed':
      return 'signed'
    case 'post.committed':
      return 'posted'
    case 'dispatch.abandoned':
      return 'abandoned'
  }
}

function signingKeyMatchesPost(
  binding: ChannelAgentDispatchJournalBinding,
  value: SignedChannelAgentPost
): boolean {
  try {
    if (publicKeyFingerprint(value.post.agentPublicKeyB64) !== binding.agentPublicKeyFingerprint) {
      return false
    }
    const publicKey = importRawEd25519PublicKey(Buffer.from(value.post.agentPublicKeyB64, 'base64'))
    return verifyEd25519(
      publicKey,
      canonicalChannelAgentStatement(CHANNEL_AGENT_SIGNATURE_DOMAINS.post, value.post),
      Buffer.from(value.agentSignatureB64, 'base64')
    )
  } catch {
    return false
  }
}

export class ChannelAgentDispatchJournalState {
  private constructor(
    private readonly bindingValue: ChannelAgentDispatchJournalBinding,
    private readonly eventValues: ChannelAgentDispatchJournalEvent[] = []
  ) {}

  static reserve(plan: ChannelAgentDispatchPlan, at: number): ChannelAgentDispatchJournalState {
    if (!isTimestamp(at)) {
      throw stateError('invalid_input', 'Channel agent dispatch reservation time is invalid')
    }
    const agentPublicKeyFingerprint = publicKeyFingerprint(plan.member.identityPublicKey)
    if (!agentPublicKeyFingerprint) {
      throw stateError('invalid_input', 'Channel agent dispatch member key is invalid')
    }
    const identity: ChannelAgentDispatchIdBindings = {
      channelId: plan.channelId,
      agentMemberId: plan.member.memberId,
      agentSeatId: plan.member.agentSeatId,
      agentPublicKeyFingerprint,
      keyGeneration: plan.member.keyGeneration,
      dispatchGrantId: plan.dispatchGrant.grant.grantId,
      triggerMessageId: plan.triggerMessageId
    }
    const dispatchId = channelAgentDispatchJournalId(identity)
    const binding: ChannelAgentDispatchJournalBinding = {
      dispatchId,
      runId: channelAgentRunIdForDispatch(dispatchId),
      channelId: plan.channelId,
      chatId: plan.chatId,
      ownerMemberId: plan.ownerMemberId,
      agentMemberId: plan.member.memberId,
      agentSeatId: plan.member.agentSeatId,
      agentPublicKeyFingerprint,
      keyGeneration: plan.member.keyGeneration,
      delegationId: plan.delegation.delegation.delegationId,
      delegationNotBefore: plan.delegation.delegation.notBefore,
      delegationExpiresAt: plan.delegation.delegation.expiresAt,
      maxPostBytes: plan.delegation.delegation.maxPostBytes,
      dispatchGrantId: plan.dispatchGrant.grant.grantId,
      dispatchGrantNotBefore: plan.dispatchGrant.grant.notBefore,
      dispatchGrantExpiresAt: plan.dispatchGrant.grant.expiresAt,
      triggerMessageId: plan.triggerMessageId,
      triggerContentHash: plan.triggerContentHash,
      mentionerMemberId: plan.mentionerMemberId,
      workspaceIdentityHash: plan.workspaceIdentityHash,
      permissionPostureHash: plan.permissionPostureHash,
      reservedAt: at
    }
    const parsed = parseBinding(binding)
    if (!parsed || !this.planMatchesBinding(plan, parsed)) {
      throw stateError('invalid_input', 'Channel agent dispatch plan binding is invalid')
    }
    return new ChannelAgentDispatchJournalState(parsed)
  }

  static restore(value: unknown): ChannelAgentDispatchJournalState {
    if (
      !isPlainObject(value) ||
      !hasExactKeys(value, ['schemaVersion', 'binding', 'events']) ||
      value.schemaVersion !== CHANNEL_AGENT_DISPATCH_JOURNAL_VERSION ||
      !Array.isArray(value.events) ||
      value.events.length > MAX_JOURNAL_EVENTS
    ) {
      throw stateError('invalid_snapshot', 'Channel agent dispatch journal snapshot is invalid')
    }
    const binding = parseBinding(value.binding)
    if (!binding) {
      throw stateError('invalid_snapshot', 'Channel agent dispatch journal binding is invalid')
    }
    const state = new ChannelAgentDispatchJournalState(binding)
    try {
      for (const candidate of value.events) {
        const event = parseEvent(candidate)
        if (!event) throw new Error('invalid event')
        state.append(event)
      }
    } catch {
      throw stateError('invalid_snapshot', 'Channel agent dispatch journal history is invalid')
    }
    return state
  }

  private static planMatchesBinding(
    plan: ChannelAgentDispatchPlan,
    binding: ChannelAgentDispatchJournalBinding
  ): boolean {
    const delegation = plan.delegation.delegation
    const grant = plan.dispatchGrant.grant
    return (
      plan.channelId === binding.channelId &&
      plan.chatId === binding.chatId &&
      plan.ownerMemberId === binding.ownerMemberId &&
      plan.member.channelId === binding.channelId &&
      plan.member.memberId === binding.agentMemberId &&
      plan.member.agentSeatId === binding.agentSeatId &&
      plan.member.keyGeneration === binding.keyGeneration &&
      publicKeyFingerprint(plan.member.identityPublicKey) === binding.agentPublicKeyFingerprint &&
      plan.target.memberId === binding.agentMemberId &&
      plan.target.agentSeatId === binding.agentSeatId &&
      plan.target.keyGeneration === binding.keyGeneration &&
      delegation.delegationId === binding.delegationId &&
      delegation.notBefore === binding.delegationNotBefore &&
      delegation.expiresAt === binding.delegationExpiresAt &&
      delegation.maxPostBytes === binding.maxPostBytes &&
      delegation.channelId === binding.channelId &&
      delegation.ownerMemberId === binding.ownerMemberId &&
      delegation.agentMemberId === binding.agentMemberId &&
      delegation.agentSeatId === binding.agentSeatId &&
      delegation.agentPublicKeyB64 === plan.member.identityPublicKey &&
      delegation.keyGeneration === binding.keyGeneration &&
      grant.grantId === binding.dispatchGrantId &&
      grant.notBefore === binding.dispatchGrantNotBefore &&
      grant.expiresAt === binding.dispatchGrantExpiresAt &&
      grant.channelId === binding.channelId &&
      grant.ownerMemberId === binding.ownerMemberId &&
      grant.agentMemberId === binding.agentMemberId &&
      grant.agentSeatId === binding.agentSeatId &&
      grant.agentPublicKeyB64 === plan.member.identityPublicKey &&
      grant.keyGeneration === binding.keyGeneration &&
      grant.delegationId === binding.delegationId &&
      plan.triggerMessageId === binding.triggerMessageId &&
      plan.triggerContentHash === binding.triggerContentHash &&
      plan.mentionerMemberId === binding.mentionerMemberId &&
      plan.workspaceIdentityHash === binding.workspaceIdentityHash &&
      plan.permissionPostureHash === binding.permissionPostureHash &&
      grant.workspaceIdentityHash === binding.workspaceIdentityHash &&
      grant.permissionPostureHash === binding.permissionPostureHash &&
      plan.consumeInput.grantId === binding.dispatchGrantId &&
      plan.consumeInput.triggerMessageId === binding.triggerMessageId &&
      plan.consumeInput.mentionerMemberId === binding.mentionerMemberId &&
      plan.consumeInput.workspaceIdentityHash === binding.workspaceIdentityHash &&
      plan.consumeInput.permissionPostureHash === binding.permissionPostureHash
    )
  }

  snapshot(): ChannelAgentDispatchJournalSnapshot {
    return clone({
      schemaVersion: CHANNEL_AGENT_DISPATCH_JOURNAL_VERSION,
      binding: this.bindingValue,
      events: this.eventValues
    })
  }

  binding(): ChannelAgentDispatchJournalBinding {
    return clone(this.bindingValue)
  }

  phase(): ChannelAgentDispatchJournalPhase {
    return phaseFromEvents(this.eventValues)
  }

  recoveryDirective(): ChannelAgentDispatchRecoveryDirective {
    switch (this.phase()) {
      case 'reserved':
        return 'retry_before_consumption'
      case 'consuming':
        return 'inspect_atomic_consumption'
      case 'consumed':
        return 'abandon_consumed_without_launch'
      case 'launching':
      case 'launched':
        return 'reconcile_exact_run_without_redispatch'
      case 'terminal':
        return 'sign_terminal_post'
      case 'signed':
        return 'append_signed_post'
      case 'posted':
      case 'abandoned':
        return 'complete'
    }
  }

  beginConsumption(plan: ChannelAgentDispatchPlan, at: number): ChannelAgentConsumptionIntentEvent {
    if (!ChannelAgentDispatchJournalState.planMatchesBinding(plan, this.bindingValue)) {
      throw stateError('binding_mismatch', 'Channel agent dispatch plan changed before consumption')
    }
    const event: ChannelAgentConsumptionIntentEvent = {
      kind: 'consumption.intent',
      sequence: this.eventValues.length + 1,
      at,
      authorityRevision: plan.authorityRevision,
      expectedDispatchOrdinal: plan.expectedDispatchOrdinal
    }
    this.appendInput(event)
    return clone(event)
  }

  commitConsumption(
    consumption: ChannelAgentDispatchConsumption
  ): ChannelAgentConsumptionCommittedEvent {
    const parsed = parseConsumption(consumption)
    if (!parsed) {
      throw stateError('invalid_input', 'Channel agent dispatch consumption is invalid')
    }
    const event: ChannelAgentConsumptionCommittedEvent = {
      kind: 'consumption.committed',
      sequence: this.eventValues.length + 1,
      at: parsed.consumedAt,
      consumption: parsed
    }
    this.appendInput(event)
    return clone(event)
  }

  beginLaunch(seal: ChannelAgentRunAuthoritySeal): ChannelAgentLaunchIntentEvent {
    const parsed = parseSeal(seal)
    if (!parsed) throw stateError('invalid_input', 'Channel agent run authority seal is invalid')
    const event: ChannelAgentLaunchIntentEvent = {
      kind: 'launch.intent',
      sequence: this.eventValues.length + 1,
      at: parsed.launchedAt,
      seal: parsed,
      sealHash: hashChannelAgentRunAuthoritySeal(parsed)
    }
    this.appendInput(event)
    return clone(event)
  }

  confirmLaunch(at: number): ChannelAgentLaunchConfirmedEvent {
    const event: ChannelAgentLaunchConfirmedEvent = {
      kind: 'launch.confirmed',
      sequence: this.eventValues.length + 1,
      at
    }
    this.appendInput(event)
    return clone(event)
  }

  recordTerminal(input: ChannelAgentDispatchTerminalInput): ChannelAgentRunTerminalEvent {
    if (!isTimestamp(input?.at) || typeof input.content !== 'string') {
      throw stateError('invalid_input', 'Channel agent terminal evidence is invalid')
    }
    const content = redactChannelContent(input.content).trim()
    if (!content || Buffer.byteLength(content, 'utf8') > MAX_CHANNEL_MESSAGE_BYTES) {
      throw stateError('invalid_input', 'Channel agent terminal content is invalid')
    }
    const event: ChannelAgentRunTerminalEvent = {
      kind: 'run.terminal',
      sequence: this.eventValues.length + 1,
      at: input.at,
      status: input.status,
      exitCode: input.exitCode,
      content,
      contentHash: hashChannelAgentContent(content)
    }
    this.appendInput(event)
    return clone(event)
  }

  recordSignedPost(value: SignedChannelAgentPost): ChannelAgentPostSignedEvent {
    const signedPost = parseSignedChannelAgentPost(value)
    if (!signedPost) throw stateError('invalid_input', 'Channel agent signed post is invalid')
    const event: ChannelAgentPostSignedEvent = {
      kind: 'post.signed',
      sequence: this.eventValues.length + 1,
      at: signedPost.post.createdAt,
      signedPost
    }
    this.appendInput(event)
    return clone(event)
  }

  recordPosted(record: AgentChannelMessage, deduplicated: boolean): ChannelAgentPostCommittedEvent {
    const signed = this.eventValues.at(-1)
    if (
      signed?.kind !== 'post.signed' ||
      record.kind !== 'agent.text' ||
      record.channelId !== this.bindingValue.channelId ||
      record.authorMemberId !== this.bindingValue.agentMemberId ||
      record.clientMessageId !== channelAgentPostClientMessageId(this.bindingValue.dispatchId) ||
      record.content !== signed.signedPost.post.content ||
      record.contentHash !== signed.signedPost.post.contentHash ||
      !sameJson(record.agentProof.signedPost, signed.signedPost) ||
      typeof deduplicated !== 'boolean'
    ) {
      throw stateError(
        'binding_mismatch',
        'Channel agent committed post does not match its journal'
      )
    }
    const event: ChannelAgentPostCommittedEvent = {
      kind: 'post.committed',
      sequence: this.eventValues.length + 1,
      at: record.acceptedAt,
      messageId: record.messageId,
      messageSequence: record.sequence,
      deduplicated
    }
    this.appendInput(event)
    return clone(event)
  }

  abandon(
    reason: ChannelAgentDispatchAbandonReason,
    at: number
  ): ChannelAgentDispatchAbandonedEvent {
    const event: ChannelAgentDispatchAbandonedEvent = {
      kind: 'dispatch.abandoned',
      sequence: this.eventValues.length + 1,
      at,
      reason
    }
    this.appendInput(event)
    return clone(event)
  }

  private appendInput(event: ChannelAgentDispatchJournalEvent): void {
    const parsed = parseEvent(event)
    if (!parsed)
      throw stateError('invalid_input', 'Channel agent dispatch journal event is invalid')
    this.append(parsed)
  }

  private append(event: ChannelAgentDispatchJournalEvent): void {
    if (event.sequence !== this.eventValues.length + 1) {
      throw stateError('illegal_transition', 'Channel agent dispatch journal sequence is invalid')
    }
    const priorAt = this.eventValues.at(-1)?.at ?? this.bindingValue.reservedAt
    if (event.at < priorAt) {
      throw stateError('illegal_transition', 'Channel agent dispatch journal time regressed')
    }
    const phase = this.phase()
    if (phase === 'posted' || phase === 'abandoned') {
      throw stateError('illegal_transition', 'Channel agent dispatch journal is terminal')
    }
    switch (event.kind) {
      case 'consumption.intent':
        if (phase !== 'reserved') this.illegal(event.kind)
        if (
          event.at < this.bindingValue.delegationNotBefore ||
          event.at < this.bindingValue.dispatchGrantNotBefore ||
          event.at >= this.bindingValue.delegationExpiresAt ||
          event.at >= this.bindingValue.dispatchGrantExpiresAt
        ) {
          throw stateError('binding_mismatch', 'Channel agent dispatch authority is not current')
        }
        break
      case 'consumption.committed':
        if (phase !== 'consuming') this.illegal(event.kind)
        this.assertConsumption(event.consumption)
        break
      case 'launch.intent':
        if (phase !== 'consumed') this.illegal(event.kind)
        this.assertLaunchSeal(event)
        break
      case 'launch.confirmed':
        if (phase !== 'launching') this.illegal(event.kind)
        break
      case 'run.terminal':
        if (phase !== 'launching' && phase !== 'launched') this.illegal(event.kind)
        if (Buffer.byteLength(event.content, 'utf8') > this.bindingValue.maxPostBytes) {
          throw stateError('binding_mismatch', 'Channel agent terminal content exceeds authority')
        }
        break
      case 'post.signed':
        if (phase !== 'terminal') this.illegal(event.kind)
        this.assertSignedPost(event.signedPost)
        break
      case 'post.committed':
        if (phase !== 'signed') this.illegal(event.kind)
        this.assertPostReceipt(event)
        break
      case 'dispatch.abandoned':
        break
    }
    this.eventValues.push(clone(event))
  }

  private assertConsumption(consumption: ChannelAgentDispatchConsumption): void {
    const intent = this.eventValues.at(-1)
    if (
      intent?.kind !== 'consumption.intent' ||
      consumption.channelId !== this.bindingValue.channelId ||
      consumption.grantId !== this.bindingValue.dispatchGrantId ||
      consumption.triggerMessageId !== this.bindingValue.triggerMessageId ||
      consumption.mentionerMemberId !== this.bindingValue.mentionerMemberId ||
      consumption.workspaceIdentityHash !== this.bindingValue.workspaceIdentityHash ||
      consumption.permissionPostureHash !== this.bindingValue.permissionPostureHash ||
      consumption.recordedRevision !== intent.authorityRevision + 1 ||
      consumption.dispatchOrdinal !== intent.expectedDispatchOrdinal ||
      consumption.consumedAt !== intent.at
    ) {
      throw stateError('binding_mismatch', 'Channel agent dispatch consumption changed')
    }
  }

  private assertLaunchSeal(event: ChannelAgentLaunchIntentEvent): void {
    const consumptionEvent = this.eventValues.at(-1)
    const consumption =
      consumptionEvent?.kind === 'consumption.committed' ? consumptionEvent.consumption : null
    const seal = event.seal
    if (
      !consumption ||
      event.sealHash !== hashChannelAgentRunAuthoritySeal(seal) ||
      seal.channelId !== this.bindingValue.channelId ||
      seal.chatId !== this.bindingValue.chatId ||
      seal.ownerMemberId !== this.bindingValue.ownerMemberId ||
      seal.agentMemberId !== this.bindingValue.agentMemberId ||
      seal.agentSeatId !== this.bindingValue.agentSeatId ||
      seal.keyGeneration !== this.bindingValue.keyGeneration ||
      seal.delegationId !== this.bindingValue.delegationId ||
      seal.dispatchGrantId !== this.bindingValue.dispatchGrantId ||
      seal.triggerMessageId !== this.bindingValue.triggerMessageId ||
      seal.mentionerMemberId !== this.bindingValue.mentionerMemberId ||
      seal.consumptionRevision !== consumption.recordedRevision ||
      seal.dispatchOrdinal !== consumption.dispatchOrdinal ||
      seal.runId !== this.bindingValue.runId ||
      seal.workspaceIdentityHash !== this.bindingValue.workspaceIdentityHash ||
      seal.permissionPostureHash !== this.bindingValue.permissionPostureHash ||
      seal.launchedAt !== consumption.consumedAt ||
      event.at !== seal.launchedAt
    ) {
      throw stateError('binding_mismatch', 'Channel agent launch seal changed')
    }
  }

  private assertSignedPost(signedPost: SignedChannelAgentPost): void {
    const terminal = this.eventValues.at(-1)
    const launch = this.eventValues.find(
      (event): event is ChannelAgentLaunchIntentEvent => event.kind === 'launch.intent'
    )
    const post = signedPost.post
    if (
      terminal?.kind !== 'run.terminal' ||
      !launch ||
      !signingKeyMatchesPost(this.bindingValue, signedPost) ||
      post.channelId !== this.bindingValue.channelId ||
      post.agentMemberId !== this.bindingValue.agentMemberId ||
      post.agentSeatId !== this.bindingValue.agentSeatId ||
      post.keyGeneration !== this.bindingValue.keyGeneration ||
      post.delegationId !== this.bindingValue.delegationId ||
      post.dispatchGrantId !== this.bindingValue.dispatchGrantId ||
      post.triggerMessageId !== this.bindingValue.triggerMessageId ||
      post.runId !== this.bindingValue.runId ||
      post.runAuthorityHash !== launch.sealHash ||
      post.clientMessageId !== channelAgentPostClientMessageId(this.bindingValue.dispatchId) ||
      post.kind !== 'agent.text' ||
      post.content !== terminal.content ||
      post.contentHash !== terminal.contentHash ||
      post.createdAt < terminal.at ||
      post.createdAt < this.bindingValue.delegationNotBefore ||
      post.createdAt >= this.bindingValue.delegationExpiresAt ||
      Buffer.byteLength(post.content, 'utf8') > this.bindingValue.maxPostBytes
    ) {
      throw stateError('binding_mismatch', 'Channel agent signed post changed')
    }
  }

  private assertPostReceipt(event: ChannelAgentPostCommittedEvent): void {
    const signed = this.eventValues.at(-1)
    if (
      signed?.kind !== 'post.signed' ||
      event.at < signed.signedPost.post.createdAt ||
      event.at >= this.bindingValue.delegationExpiresAt ||
      !isIdentifier(event.messageId) ||
      !isPositiveInteger(event.messageSequence)
    ) {
      throw stateError('binding_mismatch', 'Channel agent post receipt changed')
    }
  }

  private illegal(kind: ChannelAgentDispatchJournalEvent['kind']): never {
    throw stateError('illegal_transition', `Channel agent dispatch cannot apply ${kind}`)
  }
}
