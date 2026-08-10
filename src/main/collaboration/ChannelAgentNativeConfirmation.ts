import { createHash } from 'crypto'
import type { BrowserWindow } from 'electron'

import {
  confirmNativeWorkflowAuthority,
  type NativeWorkflowConfirmationOptions
} from '../NativeWorkflowConfirmation'
import type { AgenticServicePolicy, ExternalPathGrantAccess, ProviderId } from '../store/types'
import {
  CHANNEL_AGENT_MANAGED_MAX_DISPATCHES,
  CHANNEL_AGENT_MAX_GRANT_TTL_MS,
  CHANNEL_AGENT_MIN_GRANT_TTL_MS
} from './ChannelAgentManagementService'
import type { ChannelAgentGrantPermissionPresetId } from './ChannelAgentSeatAuthority'

const CONFIRMATION_DOMAIN = 'taskwraith.channel.agent-native-confirmation.v1'
const MAX_IDENTIFIER_LENGTH = 512
const MAX_LABEL_LENGTH = 240
const MAX_EXTERNAL_PATH_LENGTH = 4_096
const MAX_EXTERNAL_PATH_GRANTS = 32

const PROVIDERS: ReadonlySet<string> = new Set([
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

export interface ChannelAgentNativeSeatSummary {
  readonly agentSeatId: string
  readonly displayName: string
  /** Mutable descriptor only. Null keeps destructive cleanup available after roster removal. */
  readonly provider: ProviderId | null
  readonly model: string | null
  readonly role: string | null
}

export interface ChannelAgentNativeMentionerSummary {
  readonly memberId: string
  readonly displayName: string
}

export interface ChannelAgentNativeServicePolicy {
  readonly serviceId: string
  readonly policy: AgenticServicePolicy
}

export interface ChannelAgentNativeExternalPathGrant {
  readonly path: string
  readonly kind: 'file' | 'directory'
  readonly access: ExternalPathGrantAccess
  readonly duration: 'thisRun' | 'thisThread' | 'workspace'
}

export interface ChannelAgentNativeGrantAuthority {
  readonly permissionPresetId: ChannelAgentGrantPermissionPresetId
  readonly approvalMode: string
  readonly readOnly: boolean
  readonly networkAccess: 'allow' | 'deny'
  readonly agenticServices: readonly ChannelAgentNativeServicePolicy[]
  readonly externalPathGrants: readonly ChannelAgentNativeExternalPathGrant[]
  readonly workspaceLabel: string
  /** Exact hidden binding. Never rendered in the native sheet. */
  readonly workspaceIdentityHash: string
  /** Exact hidden binding. Never rendered in the native sheet. */
  readonly permissionPostureHash: string
}

interface ChannelAgentNativeActionBase {
  readonly operationId: string
  readonly channelId: string
  readonly channelTitle: string
  readonly seat: ChannelAgentNativeSeatSummary
}

export interface ChannelAgentNativeEnrollRequest extends ChannelAgentNativeActionBase {
  readonly kind: 'enroll'
  readonly existingKeyGeneration: number | null
}

export interface ChannelAgentNativeGrantRequest extends ChannelAgentNativeActionBase {
  readonly kind: 'grant'
  readonly agentMemberId: string
  readonly keyGeneration: number
  readonly allowedMentioners: readonly ChannelAgentNativeMentionerSummary[]
  readonly authority: ChannelAgentNativeGrantAuthority
  readonly ttlMs: number
  readonly maxDispatches: number
}

export interface ChannelAgentNativeRevokeRequest extends ChannelAgentNativeActionBase {
  readonly kind: 'revoke'
  readonly agentMemberId: string
  readonly keyGeneration: number
}

export interface ChannelAgentNativeRotationChannel {
  readonly channelId: string
  readonly channelTitle: string
}

export interface ChannelAgentNativeRotateRequest {
  readonly kind: 'rotate'
  readonly operationId: string
  readonly seat: ChannelAgentNativeSeatSummary
  readonly fromKeyGeneration: number
  readonly toKeyGeneration: number
  readonly channels: readonly ChannelAgentNativeRotationChannel[]
}

export type ChannelAgentNativeConfirmationRequest =
  | ChannelAgentNativeEnrollRequest
  | ChannelAgentNativeGrantRequest
  | ChannelAgentNativeRevokeRequest
  | ChannelAgentNativeRotateRequest

export type ChannelAgentNativeConfirmationDecision =
  | { readonly confirmed: false }
  | { readonly confirmed: true; readonly confirmationDigest: string }

export interface ChannelAgentNativeConfirmationDependencies {
  readonly confirm: (
    owner: BrowserWindow | null,
    options: NativeWorkflowConfirmationOptions
  ) => Promise<boolean>
}

const DEFAULT_DEPENDENCIES: ChannelAgentNativeConfirmationDependencies = {
  confirm: confirmNativeWorkflowAuthority
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

function safeLabel(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4_096
}

function safeHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function positiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= maximum
}

function validateSeat(
  value: unknown,
  requireAvailableDescriptor: boolean
): value is ChannelAgentNativeSeatSummary {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['agentSeatId', 'displayName', 'provider', 'model', 'role']) ||
    !safeIdentifier(value.agentSeatId) ||
    !value.agentSeatId.startsWith('pooled-agent-') ||
    !safeLabel(value.displayName)
  ) {
    return false
  }
  if (value.provider === null || value.role === null) {
    return (
      !requireAvailableDescriptor &&
      value.provider === null &&
      value.model === null &&
      value.role === null
    )
  }
  return (
    typeof value.provider === 'string' &&
    PROVIDERS.has(value.provider) &&
    (value.model === null || safeLabel(value.model)) &&
    safeLabel(value.role)
  )
}

function validateMentioners(
  value: unknown
): value is readonly ChannelAgentNativeMentionerSummary[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return false
  let previous = ''
  for (const entry of value) {
    if (
      !isPlainObject(entry) ||
      !hasExactKeys(entry, ['memberId', 'displayName']) ||
      !safeIdentifier(entry.memberId) ||
      !safeLabel(entry.displayName) ||
      entry.memberId <= previous
    ) {
      return false
    }
    previous = entry.memberId
  }
  return true
}

function validateServicePolicies(
  value: unknown
): value is readonly ChannelAgentNativeServicePolicy[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return false
  let previous = ''
  for (const entry of value) {
    if (
      !isPlainObject(entry) ||
      !hasExactKeys(entry, ['serviceId', 'policy']) ||
      !safeIdentifier(entry.serviceId) ||
      (entry.policy !== 'ask' &&
        entry.policy !== 'workspace' &&
        entry.policy !== 'allow' &&
        entry.policy !== 'deny') ||
      entry.serviceId <= previous
    ) {
      return false
    }
    previous = entry.serviceId
  }
  return true
}

function externalPathKey(value: ChannelAgentNativeExternalPathGrant): string {
  return `${value.path}\0${value.kind}\0${value.access}\0${value.duration}`
}

function validateExternalPathGrants(
  value: unknown
): value is readonly ChannelAgentNativeExternalPathGrant[] {
  if (!Array.isArray(value) || value.length > MAX_EXTERNAL_PATH_GRANTS) return false
  let previous = ''
  for (const entry of value) {
    if (
      !isPlainObject(entry) ||
      !hasExactKeys(entry, ['path', 'kind', 'access', 'duration']) ||
      typeof entry.path !== 'string' ||
      entry.path.trim() !== entry.path ||
      entry.path.length === 0 ||
      entry.path.length > MAX_EXTERNAL_PATH_LENGTH ||
      entry.path.includes('\0') ||
      (entry.kind !== 'file' && entry.kind !== 'directory') ||
      (entry.access !== 'read' && entry.access !== 'write') ||
      (entry.duration !== 'thisRun' &&
        entry.duration !== 'thisThread' &&
        entry.duration !== 'workspace')
    ) {
      return false
    }
    const key = externalPathKey(entry as unknown as ChannelAgentNativeExternalPathGrant)
    if (key <= previous) return false
    previous = key
  }
  return true
}

function validateAuthority(value: unknown): value is ChannelAgentNativeGrantAuthority {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'permissionPresetId',
      'approvalMode',
      'readOnly',
      'networkAccess',
      'agenticServices',
      'externalPathGrants',
      'workspaceLabel',
      'workspaceIdentityHash',
      'permissionPostureHash'
    ]) ||
    (value.permissionPresetId !== 'read_only' &&
      value.permissionPresetId !== 'plan' &&
      value.permissionPresetId !== 'default' &&
      value.permissionPresetId !== 'workspace_write' &&
      value.permissionPresetId !== 'full_access') ||
    !safeIdentifier(value.approvalMode) ||
    typeof value.readOnly !== 'boolean' ||
    (value.networkAccess !== 'allow' && value.networkAccess !== 'deny') ||
    !validateServicePolicies(value.agenticServices) ||
    !validateExternalPathGrants(value.externalPathGrants) ||
    !safeLabel(value.workspaceLabel) ||
    !safeHash(value.workspaceIdentityHash) ||
    !safeHash(value.permissionPostureHash)
  ) {
    return false
  }
  return true
}

function validateBase(
  value: Record<string, unknown>,
  requireAvailableDescriptor: boolean
): boolean {
  return (
    safeIdentifier(value.operationId) &&
    safeIdentifier(value.channelId) &&
    safeLabel(value.channelTitle) &&
    validateSeat(value.seat, requireAvailableDescriptor)
  )
}

function validateRotationChannels(
  value: unknown
): value is readonly ChannelAgentNativeRotationChannel[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return false
  let previous = ''
  for (const entry of value) {
    if (
      !isPlainObject(entry) ||
      !hasExactKeys(entry, ['channelId', 'channelTitle']) ||
      !safeIdentifier(entry.channelId) ||
      !safeLabel(entry.channelTitle) ||
      entry.channelId <= previous
    ) {
      return false
    }
    previous = entry.channelId
  }
  return true
}

function validateRequest(value: unknown): value is ChannelAgentNativeConfirmationRequest {
  if (!isPlainObject(value) || typeof value.kind !== 'string') return false
  if (value.kind === 'enroll') {
    return (
      hasExactKeys(value, [
        'kind',
        'operationId',
        'channelId',
        'channelTitle',
        'seat',
        'existingKeyGeneration'
      ]) &&
      validateBase(value, true) &&
      (value.existingKeyGeneration === null || positiveInteger(value.existingKeyGeneration))
    )
  }
  if (value.kind === 'grant') {
    return (
      hasExactKeys(value, [
        'kind',
        'operationId',
        'channelId',
        'channelTitle',
        'seat',
        'agentMemberId',
        'keyGeneration',
        'allowedMentioners',
        'authority',
        'ttlMs',
        'maxDispatches'
      ]) &&
      validateBase(value, true) &&
      safeIdentifier(value.agentMemberId) &&
      positiveInteger(value.keyGeneration) &&
      validateMentioners(value.allowedMentioners) &&
      validateAuthority(value.authority) &&
      positiveInteger(value.ttlMs, CHANNEL_AGENT_MAX_GRANT_TTL_MS) &&
      value.ttlMs >= CHANNEL_AGENT_MIN_GRANT_TTL_MS &&
      positiveInteger(value.maxDispatches, CHANNEL_AGENT_MANAGED_MAX_DISPATCHES)
    )
  }
  if (value.kind === 'revoke') {
    return (
      hasExactKeys(value, [
        'kind',
        'operationId',
        'channelId',
        'channelTitle',
        'seat',
        'agentMemberId',
        'keyGeneration'
      ]) &&
      validateBase(value, false) &&
      safeIdentifier(value.agentMemberId) &&
      positiveInteger(value.keyGeneration)
    )
  }
  if (value.kind === 'rotate') {
    return (
      hasExactKeys(value, [
        'kind',
        'operationId',
        'seat',
        'fromKeyGeneration',
        'toKeyGeneration',
        'channels'
      ]) &&
      safeIdentifier(value.operationId) &&
      validateSeat(value.seat, false) &&
      positiveInteger(value.fromKeyGeneration) &&
      positiveInteger(value.toKeyGeneration) &&
      value.toKeyGeneration === value.fromKeyGeneration + 1 &&
      validateRotationChannels(value.channels)
    )
  }
  return false
}

function requireRequest(value: unknown): ChannelAgentNativeConfirmationRequest {
  if (!validateRequest(value)) {
    throw new TypeError('Channel agent native confirmation request is invalid')
  }
  return value
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

function compact(value: string, maximum = MAX_LABEL_LENGTH): string {
  let safe = ''
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    const disguised =
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x00ad ||
      codePoint === 0x034f ||
      codePoint === 0x061c ||
      codePoint === 0x180e ||
      (codePoint >= 0x200b && codePoint <= 0x200f) ||
      (codePoint >= 0x2028 && codePoint <= 0x202e) ||
      codePoint === 0x2060 ||
      (codePoint >= 0x2066 && codePoint <= 0x2069) ||
      codePoint === 0xfeff
    safe += disguised ? ' ' : character
  }
  const normalized = safe.replace(/\s+/g, ' ').trim()
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`
}

function seatLines(seat: ChannelAgentNativeSeatSummary): string[] {
  if (seat.provider === null) {
    return [
      `Agent: ${compact(seat.displayName)}`,
      `Stable seat: ${compact(seat.agentSeatId)}`,
      'Provider/model/role: unavailable (cleanup uses the durable signed seat binding)'
    ]
  }
  return [
    `Agent: ${compact(seat.displayName)}`,
    `Stable seat: ${compact(seat.agentSeatId)}`,
    `Provider/model: ${seat.provider} / ${compact(seat.model ?? 'provider default')}`,
    `Role: ${compact(seat.role ?? 'unavailable')}`
  ]
}

function durationLabel(ttlMs: number): string {
  if (ttlMs % 60_000 !== 0) return `${ttlMs} milliseconds`
  const minutes = ttlMs / 60_000
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = minutes / 60
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`
  const days = hours / 24
  return `${days} day${days === 1 ? '' : 's'}`
}

function grantDetail(request: ChannelAgentNativeGrantRequest): string {
  const services = request.authority.agenticServices
    .map((entry) => `${entry.serviceId}=${entry.policy}`)
    .join(', ')
  const paths = request.authority.externalPathGrants.length
    ? request.authority.externalPathGrants
        .map(
          (grant) =>
            `  • ${grant.access} ${grant.kind}: ${compact(grant.path, 512)} (${grant.duration})`
        )
        .join('\n')
    : '  • none'
  const mentioners = request.allowedMentioners
    .map((member) => `${compact(member.displayName)} [${compact(member.memberId)}]`)
    .join(', ')
  return [
    `Channel: ${compact(request.channelTitle)} [${compact(request.channelId)}]`,
    ...seatLines(request.seat),
    `Agent member: ${compact(request.agentMemberId)} (key generation ${request.keyGeneration})`,
    `Allowed human mentioners: ${mentioners}`,
    `Workspace: ${compact(request.authority.workspaceLabel)}`,
    `Permission: ${request.authority.permissionPresetId}; approval=${request.authority.approvalMode}; read-only=${request.authority.readOnly ? 'yes' : 'no'}; network=${request.authority.networkAccess}`,
    `Agentic services: ${services}`,
    'External path grants:',
    paths,
    `Lifetime: ${durationLabel(request.ttlMs)}`,
    `Budget: ${request.maxDispatches} automatic dispatch${request.maxDispatches === 1 ? '' : 'es'}`,
    '',
    'A valid mention can start this seat without another local confirmation. The grant follows the stable seat if its mutable model, role, or instructions are later edited; changing workspace or permission authority invalidates dispatch.'
  ].join('\n')
}

export function hashChannelAgentNativeConfirmation(
  value: ChannelAgentNativeConfirmationRequest
): string {
  const request = requireRequest(value)
  return createHash('sha256')
    .update(`${CONFIRMATION_DOMAIN}\n${stableJson(request)}`, 'utf8')
    .digest('hex')
}

export function buildChannelAgentNativeConfirmationOptions(
  value: ChannelAgentNativeConfirmationRequest
): NativeWorkflowConfirmationOptions {
  const request = requireRequest(value)
  if (request.kind === 'grant') {
    return {
      title: 'Authorize Channel Agent',
      message: `Allow ${compact(request.seat.displayName)} to run from Channel mentions?`,
      detail: grantDetail(request),
      confirmLabel: 'Authorize Mentions'
    }
  }
  if (request.kind === 'enroll') {
    return {
      title: 'Enroll Channel Agent',
      message: `Enroll ${compact(request.seat.displayName)} in this Channel?`,
      detail: [
        `Channel: ${compact(request.channelTitle)} [${compact(request.channelId)}]`,
        ...seatLines(request.seat),
        `Key: ${
          request.existingKeyGeneration === null
            ? 'create a new main-owned stable key'
            : `reuse stable key generation ${request.existingKeyGeneration}`
        }`,
        '',
        'This signs Channel membership and post/dispatch delegation. Enrollment alone does not authorize automatic runs; that requires a separate mention grant.'
      ].join('\n'),
      confirmLabel: 'Enroll Agent'
    }
  }
  if (request.kind === 'revoke') {
    return {
      title: 'Remove Channel Agent',
      message: `Remove ${compact(request.seat.displayName)} from this Channel?`,
      detail: [
        `Channel: ${compact(request.channelTitle)} [${compact(request.channelId)}]`,
        ...seatLines(request.seat),
        `Agent member: ${compact(request.agentMemberId)} (key generation ${request.keyGeneration})`,
        '',
        'TaskWraith will sign and persist key revocation before removing membership. Future dispatch and posts stop; signed history remains verifiable. Re-enrollment requires key rotation.'
      ].join('\n'),
      confirmLabel: 'Remove Agent'
    }
  }
  return {
    title: 'Rotate Channel Agent Key',
    message: `Rotate the stable key for ${compact(request.seat.displayName)}?`,
    detail: [
      ...seatLines(request.seat),
      `Key generation: ${request.fromKeyGeneration} → ${request.toKeyGeneration}`,
      'Affected Channels:',
      ...request.channels.map(
        (channel) => `  • ${compact(channel.channelTitle)} [${compact(channel.channelId)}]`
      ),
      '',
      'TaskWraith will revoke the old key in every listed active Channel before replacing private custody. Membership is re-delegated with the new generation; old mention grants remain revoked and must be reissued.'
    ].join('\n'),
    confirmLabel: 'Rotate Key'
  }
}

export async function confirmChannelAgentManagement(
  owner: BrowserWindow | null,
  value: ChannelAgentNativeConfirmationRequest,
  dependencies: ChannelAgentNativeConfirmationDependencies = DEFAULT_DEPENDENCIES
): Promise<ChannelAgentNativeConfirmationDecision> {
  const request = requireRequest(value)
  let liveOwner = false
  try {
    liveOwner = Boolean(owner && !owner.isDestroyed())
  } catch {
    liveOwner = false
  }
  if (!liveOwner) return { confirmed: false }
  const confirmationDigest = hashChannelAgentNativeConfirmation(request)
  try {
    const confirmed = await dependencies.confirm(
      owner,
      buildChannelAgentNativeConfirmationOptions(request)
    )
    return confirmed ? { confirmed: true, confirmationDigest } : { confirmed: false }
  } catch {
    return { confirmed: false }
  }
}
