import { createHash, randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

import type { ProviderId, TaskWraithMcpProfileId } from '../store/types'
import type { TaskWraithMcpToolName } from '../TaskWraithMcpTools'
import { isTaskWraithMcpToolName } from './McpResultHelpers'

/** Main-owned expiry for a permission opportunity that has not been cleared by run lifecycle. */
export const PERMISSION_OPPORTUNITY_TTL_MS = 5 * 60 * 1_000
export const PERMISSION_OPPORTUNITY_MAX_ENTRIES = 128
export const PERMISSION_OPPORTUNITY_MAX_ENTRIES_PER_RUN = 8
export const PERMISSION_OPPORTUNITY_MAX_ARGUMENT_BYTES = 64 * 1_024
export const PERMISSION_OPPORTUNITY_MAX_FAILURE_LENGTH = 4_000

const MAX_PERMISSION_OPPORTUNITY_TTL_MS = 60 * 60 * 1_000
const MAX_PERMISSION_OPPORTUNITY_ENTRIES = 1_024
const MAX_PERMISSION_OPPORTUNITY_ENTRIES_PER_RUN = 64
const OPPORTUNITY_ID_PREFIX = 'twp_'
const RESERVATION_ID_PREFIX = 'twpr_'
const OPPORTUNITY_ID_PATTERN = /^twp_[A-Za-z0-9_-]{43}$/
const RESERVATION_ID_PATTERN = /^twpr_[A-Za-z0-9_-]{43}$/

/**
 * Main classifies an eligible boundary before minting an opportunity. Redemption
 * must not re-parse potentially provider-authored failure prose.
 */
export const PERMISSION_OPPORTUNITY_BOUNDARY_CODES = Object.freeze([
  'policy_denied',
  'approval_timeout',
  'workspace_lock_denied',
  'unscoped_process',
  'sandbox_containment'
] as const)

export type PermissionOpportunityBoundaryCode =
  (typeof PERMISSION_OPPORTUNITY_BOUNDARY_CODES)[number]

export interface PermissionOpportunityBinding {
  provider: ProviderId
  runId: string
  chatId: string
  profileId: TaskWraithMcpProfileId
  /** `null` is the exact global-scope binding, not an omitted check. */
  workspaceId: string | null
  workspacePath: string | null
  /** Main-resolved real workspace identity, distinct from a display/path alias. */
  workspaceRealPath: string | null
  /** Exact worktree in which the target would execute. */
  effectiveWorktreePath: string | null
  /** `null` is the exact no-native-session binding for a fresh provider turn. */
  providerSessionId: string | null
  /** Both remain exact-null for a solo run. */
  participantId: string | null
  laneId: string | null
  /** Signed/effective permission posture identity from main. */
  postureFingerprint: string | null
  /** Server-derived fixed-tool ceiling identity (for example Pi's credential). */
  fixedToolAllowlistFingerprint: string | null
}

/** A canonical request already admitted as an eligible boundary by Electron main. */
export interface PermissionOpportunityValidatedRequest {
  toolName: TaskWraithMcpToolName
  arguments: Record<string, unknown>
  failure: string
  boundaryCode: PermissionOpportunityBoundaryCode
}

/** Metadata safe for a transient UI/card projection; no raw target arguments or failure prose. */
export interface PermissionOpportunitySafeDisplay {
  scope: 'one_exact_invocation'
  targetToolName: TaskWraithMcpToolName
  boundaryCode: PermissionOpportunityBoundaryCode
}

export interface PermissionOpportunityIssueInput {
  binding: PermissionOpportunityBinding
  request: PermissionOpportunityValidatedRequest
}

export interface IssuedPermissionOpportunity {
  permissionOpportunityId: string
  display: PermissionOpportunitySafeDisplay
}

export interface RedeemedPermissionOpportunity {
  binding: PermissionOpportunityBinding
  request: PermissionOpportunityValidatedRequest
  targetArgumentsSha256: string
  display: PermissionOpportunitySafeDisplay
  issuedAt: number
  expiresAt: number
}

export interface PermissionOpportunityReservation {
  permissionOpportunityId: string
  reservationId: string
  opportunity: RedeemedPermissionOpportunity
}

export type PermissionOpportunityIssueErrorCode =
  | 'per_run_quota_exhausted'
  | 'registry_capacity_exhausted'

export type PermissionOpportunityIssueResult =
  | { ok: true; opportunity: IssuedPermissionOpportunity; deduplicated: boolean }
  | { ok: false; code: PermissionOpportunityIssueErrorCode; error: string }

export type PermissionOpportunityTakeErrorCode =
  | 'invalid_opportunity_id'
  | 'opportunity_not_found'
  | 'opportunity_expired'
  | 'opportunity_binding_mismatch'
  | 'opportunity_already_reserved'
  | 'opportunity_already_redeemed'
  | 'opportunity_reservation_mismatch'

export type PermissionOpportunityReserveResult =
  | { ok: true; reservation: PermissionOpportunityReservation }
  | { ok: false; code: PermissionOpportunityTakeErrorCode; error: string }

export type PermissionOpportunityTakeResult =
  | { ok: true; opportunity: RedeemedPermissionOpportunity }
  | { ok: false; code: PermissionOpportunityTakeErrorCode; error: string }

export type PermissionOpportunityReleaseResult =
  | { ok: true }
  | { ok: false; code: PermissionOpportunityTakeErrorCode; error: string }

export interface PermissionOpportunityRegistryOptions {
  now?: () => number
  createId?: () => string
  createReservationId?: () => string
  ttlMs?: number
  maxEntries?: number
  maxEntriesPerRun?: number
}

export type PermissionOpportunityState = 'pending' | 'reserved' | 'consumed'

/** A target-free inspection result suitable for diagnostics/audit. */
export interface PermissionOpportunitySafeStatus {
  state: PermissionOpportunityState
  bindingSha256: string
  targetArgumentsSha256: string
  display: PermissionOpportunitySafeDisplay
  issuedAt: number
  expiresAt: number
  reservedAt?: number
  consumedAt?: number
}

interface StoredPermissionOpportunity {
  permissionOpportunityId: string
  binding: PermissionOpportunityBinding
  /** Undefined after consumption: the retained tombstone is target-free. */
  request?: PermissionOpportunityValidatedRequest
  targetArgumentsSha256: string
  display: PermissionOpportunitySafeDisplay
  issuedAt: number
  expiresAt: number
  state: PermissionOpportunityState
  reservationId?: string
  reservedAt?: number
  consumedAt?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function canonicalPath(value: string | null | undefined): string | null {
  const path = nonEmptyText(value)
  return path ? resolve(path) : null
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) return fallback
  return Math.min(Number(value), maximum)
}

export function isPermissionOpportunityBoundaryCode(
  value: unknown
): value is PermissionOpportunityBoundaryCode {
  return (PERMISSION_OPPORTUNITY_BOUNDARY_CODES as readonly string[]).includes(String(value))
}

function cloneArguments(value: Record<string, unknown>): {
  arguments: Record<string, unknown>
  fingerprint: string
} {
  if (!isRecord(value)) {
    throw new TypeError('Permission opportunity target arguments must be an object.')
  }
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new TypeError('Permission opportunity target arguments must be JSON-serializable.')
  }
  if (
    !serialized ||
    Buffer.byteLength(serialized, 'utf8') > PERMISSION_OPPORTUNITY_MAX_ARGUMENT_BYTES
  ) {
    throw new TypeError(
      `Permission opportunity target arguments must be JSON-serializable and no larger than ${PERMISSION_OPPORTUNITY_MAX_ARGUMENT_BYTES} bytes.`
    )
  }
  let cloned: unknown
  try {
    cloned = JSON.parse(serialized)
  } catch {
    throw new TypeError('Permission opportunity target arguments must be JSON-serializable.')
  }
  if (!isRecord(cloned)) {
    throw new TypeError('Permission opportunity target arguments must be an object.')
  }
  return {
    arguments: cloned,
    fingerprint: createHash('sha256').update(serialized).digest('hex')
  }
}

function cloneBinding(binding: PermissionOpportunityBinding): PermissionOpportunityBinding {
  const provider = nonEmptyText(binding.provider)
  const runId = nonEmptyText(binding.runId)
  const chatId = nonEmptyText(binding.chatId)
  const profileId = nonEmptyText(binding.profileId)
  if (!provider || !runId || !chatId || !profileId) {
    throw new TypeError(
      'Permission opportunity binding requires provider, run, chat, and profile identity.'
    )
  }
  return {
    provider: provider as ProviderId,
    runId,
    chatId,
    profileId: profileId as TaskWraithMcpProfileId,
    workspaceId: nonEmptyText(binding.workspaceId),
    workspacePath: canonicalPath(binding.workspacePath),
    workspaceRealPath: canonicalPath(binding.workspaceRealPath),
    effectiveWorktreePath: canonicalPath(binding.effectiveWorktreePath),
    providerSessionId: nonEmptyText(binding.providerSessionId),
    participantId: nonEmptyText(binding.participantId),
    laneId: nonEmptyText(binding.laneId),
    postureFingerprint: nonEmptyText(binding.postureFingerprint),
    fixedToolAllowlistFingerprint: nonEmptyText(binding.fixedToolAllowlistFingerprint)
  }
}

function bindingsMatch(
  expected: PermissionOpportunityBinding,
  actual: PermissionOpportunityBinding
): boolean {
  return (
    expected.provider === actual.provider &&
    expected.runId === actual.runId &&
    expected.chatId === actual.chatId &&
    expected.profileId === actual.profileId &&
    expected.workspaceId === actual.workspaceId &&
    expected.workspacePath === actual.workspacePath &&
    expected.workspaceRealPath === actual.workspaceRealPath &&
    expected.effectiveWorktreePath === actual.effectiveWorktreePath &&
    expected.providerSessionId === actual.providerSessionId &&
    expected.participantId === actual.participantId &&
    expected.laneId === actual.laneId &&
    expected.postureFingerprint === actual.postureFingerprint &&
    expected.fixedToolAllowlistFingerprint === actual.fixedToolAllowlistFingerprint
  )
}

function cloneValidatedRequest(request: PermissionOpportunityValidatedRequest): {
  request: PermissionOpportunityValidatedRequest
  fingerprint: string
} {
  const toolName = nonEmptyText(request.toolName)
  const failure = nonEmptyText(request.failure)
  if (!toolName || !isTaskWraithMcpToolName(toolName) || !failure) {
    throw new TypeError('Permission opportunity requires a canonical target and failure evidence.')
  }
  if (failure.length > PERMISSION_OPPORTUNITY_MAX_FAILURE_LENGTH) {
    throw new TypeError(
      `Permission opportunity failure evidence must be no longer than ${PERMISSION_OPPORTUNITY_MAX_FAILURE_LENGTH} characters.`
    )
  }
  if (!isPermissionOpportunityBoundaryCode(request.boundaryCode)) {
    throw new TypeError('Permission opportunity requires a recognised host boundary code.')
  }
  const cloned = cloneArguments(request.arguments)
  return {
    request: {
      toolName,
      arguments: cloned.arguments,
      failure,
      boundaryCode: request.boundaryCode
    },
    fingerprint: cloned.fingerprint
  }
}

function cloneRedeemedOpportunity(
  entry: StoredPermissionOpportunity
): RedeemedPermissionOpportunity {
  if (!entry.request) throw new Error('Consumed permission opportunity has no target request.')
  const request = cloneValidatedRequest(entry.request)
  return {
    binding: { ...entry.binding },
    request: request.request,
    targetArgumentsSha256: entry.targetArgumentsSha256,
    display: { ...entry.display },
    issuedAt: entry.issuedAt,
    expiresAt: entry.expiresAt
  }
}

function safeStatus(entry: StoredPermissionOpportunity): PermissionOpportunitySafeStatus {
  return {
    state: entry.state,
    bindingSha256: createHash('sha256').update(JSON.stringify(entry.binding)).digest('hex'),
    targetArgumentsSha256: entry.targetArgumentsSha256,
    display: { ...entry.display },
    issuedAt: entry.issuedAt,
    expiresAt: entry.expiresAt,
    ...(entry.reservedAt !== undefined ? { reservedAt: entry.reservedAt } : {}),
    ...(entry.consumedAt !== undefined ? { consumedAt: entry.consumedAt } : {})
  }
}

function bindingMismatch(): {
  ok: false
  code: 'opportunity_binding_mismatch'
  error: string
} {
  return {
    ok: false,
    code: 'opportunity_binding_mismatch',
    error: 'This permission opportunity does not belong to the current provider run.'
  }
}

/**
 * Main-owned, in-memory hand-off for retryable permission boundaries. The
 * registry deliberately stores no raw target once a reservation is consumed.
 */
export class PermissionOpportunityRegistry {
  private readonly entries = new Map<string, StoredPermissionOpportunity>()
  private readonly now: () => number
  private readonly createId: () => string
  private readonly createReservationId: () => string
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly maxEntriesPerRun: number

  constructor(options: PermissionOpportunityRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.createId =
      options.createId ?? (() => `${OPPORTUNITY_ID_PREFIX}${randomBytes(32).toString('base64url')}`)
    this.createReservationId =
      options.createReservationId ??
      (() => `${RESERVATION_ID_PREFIX}${randomBytes(32).toString('base64url')}`)
    this.ttlMs = boundedPositiveInteger(
      options.ttlMs,
      PERMISSION_OPPORTUNITY_TTL_MS,
      MAX_PERMISSION_OPPORTUNITY_TTL_MS
    )
    this.maxEntries = boundedPositiveInteger(
      options.maxEntries,
      PERMISSION_OPPORTUNITY_MAX_ENTRIES,
      MAX_PERMISSION_OPPORTUNITY_ENTRIES
    )
    this.maxEntriesPerRun = boundedPositiveInteger(
      options.maxEntriesPerRun,
      PERMISSION_OPPORTUNITY_MAX_ENTRIES_PER_RUN,
      MAX_PERMISSION_OPPORTUNITY_ENTRIES_PER_RUN
    )
  }

  issue(input: PermissionOpportunityIssueInput): PermissionOpportunityIssueResult {
    const now = this.now()
    const binding = cloneBinding(input.binding)
    const request = cloneValidatedRequest(input.request)
    this.pruneExpired(now)

    const duplicate = [...this.entries.values()].find(
      (entry) =>
        entry.state === 'pending' &&
        entry.request?.toolName === request.request.toolName &&
        entry.request?.boundaryCode === request.request.boundaryCode &&
        entry.targetArgumentsSha256 === request.fingerprint &&
        bindingsMatch(entry.binding, binding)
    )
    if (duplicate) {
      return {
        ok: true,
        opportunity: {
          permissionOpportunityId: duplicate.permissionOpportunityId,
          display: { ...duplicate.display }
        },
        deduplicated: true
      }
    }
    if (this.countForRun(binding.runId) >= this.maxEntriesPerRun) {
      return {
        ok: false,
        code: 'per_run_quota_exhausted',
        error: 'This run already has the maximum number of live permission opportunities.'
      }
    }
    if (!this.evictToCapacity()) {
      return {
        ok: false,
        code: 'registry_capacity_exhausted',
        error: 'Permission opportunity capacity is occupied by active reservations.'
      }
    }
    const permissionOpportunityId = this.nextOpportunityId()
    const display: PermissionOpportunitySafeDisplay = {
      scope: 'one_exact_invocation',
      targetToolName: request.request.toolName,
      boundaryCode: request.request.boundaryCode
    }
    this.entries.set(permissionOpportunityId, {
      permissionOpportunityId,
      binding,
      request: request.request,
      targetArgumentsSha256: request.fingerprint,
      display,
      issuedAt: now,
      expiresAt: now + this.ttlMs,
      state: 'pending'
    })
    return {
      ok: true,
      opportunity: { permissionOpportunityId, display: { ...display } },
      deduplicated: false
    }
  }

  /** Reserve without consuming, so a pre-approval failure can release safely. */
  reserve(input: {
    permissionOpportunityId: unknown
    binding: PermissionOpportunityBinding
  }): PermissionOpportunityReserveResult {
    const resolved = this.resolveForBinding(input)
    if (!resolved.ok) return resolved
    const { entry, now } = resolved
    if (entry.state === 'reserved') {
      return {
        ok: false,
        code: 'opportunity_already_reserved',
        error: 'This permission opportunity is already being redeemed.'
      }
    }
    if (entry.state === 'consumed') {
      return {
        ok: false,
        code: 'opportunity_already_redeemed',
        error: 'This permission opportunity was already redeemed.'
      }
    }
    const reservationId = this.nextReservationId()
    entry.state = 'reserved'
    entry.reservationId = reservationId
    entry.reservedAt = now
    return {
      ok: true,
      reservation: {
        permissionOpportunityId: entry.permissionOpportunityId,
        reservationId,
        opportunity: cloneRedeemedOpportunity(entry)
      }
    }
  }

  /** Consume an exact reservation and replace its retained target with a tombstone. */
  consume(input: {
    permissionOpportunityId: unknown
    reservationId: unknown
    binding: PermissionOpportunityBinding
  }): PermissionOpportunityTakeResult {
    const resolved = this.resolveForBinding(input)
    if (!resolved.ok) return resolved
    const reservationId = nonEmptyText(input.reservationId)
    if (!reservationId || !RESERVATION_ID_PATTERN.test(reservationId)) {
      return {
        ok: false,
        code: 'opportunity_reservation_mismatch',
        error: 'This permission opportunity reservation is unavailable.'
      }
    }
    const { entry, now } = resolved
    if (entry.state === 'consumed') {
      return {
        ok: false,
        code: 'opportunity_already_redeemed',
        error: 'This permission opportunity was already redeemed.'
      }
    }
    if (entry.state !== 'reserved' || entry.reservationId !== reservationId) {
      return {
        ok: false,
        code: 'opportunity_reservation_mismatch',
        error: 'This permission opportunity reservation is unavailable.'
      }
    }
    const opportunity = cloneRedeemedOpportunity(entry)
    entry.state = 'consumed'
    entry.consumedAt = now
    delete entry.request
    delete entry.reservationId
    return { ok: true, opportunity }
  }

  /** Return a held reservation to pending only when its exact server token still matches. */
  release(input: {
    permissionOpportunityId: unknown
    reservationId: unknown
    binding: PermissionOpportunityBinding
  }): PermissionOpportunityReleaseResult {
    const resolved = this.resolveForBinding(input)
    if (!resolved.ok) return resolved
    const reservationId = nonEmptyText(input.reservationId)
    const { entry } = resolved
    if (!reservationId || !RESERVATION_ID_PATTERN.test(reservationId)) {
      return {
        ok: false,
        code: 'opportunity_reservation_mismatch',
        error: 'This permission opportunity reservation is unavailable.'
      }
    }
    if (entry.state === 'consumed') {
      return {
        ok: false,
        code: 'opportunity_already_redeemed',
        error: 'This permission opportunity was already redeemed.'
      }
    }
    if (entry.state !== 'reserved' || entry.reservationId !== reservationId) {
      return {
        ok: false,
        code: 'opportunity_reservation_mismatch',
        error: 'This permission opportunity reservation is unavailable.'
      }
    }
    entry.state = 'pending'
    delete entry.reservationId
    delete entry.reservedAt
    return { ok: true }
  }

  /** Convenience atomic reserve + consume path for callers that need no release window. */
  take(input: {
    permissionOpportunityId: unknown
    binding: PermissionOpportunityBinding
  }): PermissionOpportunityTakeResult {
    const reservation = this.reserve(input)
    if (!reservation.ok) return reservation
    return this.consume({
      permissionOpportunityId: reservation.reservation.permissionOpportunityId,
      reservationId: reservation.reservation.reservationId,
      binding: input.binding
    })
  }

  clearForRun(runId: string | null | undefined): number {
    const normalizedRunId = nonEmptyText(runId)
    if (!normalizedRunId) return 0
    return this.clearWhere((entry) => entry.binding.runId === normalizedRunId)
  }

  clearForChat(chatId: string | null | undefined): number {
    const normalizedChatId = nonEmptyText(chatId)
    if (!normalizedChatId) return 0
    return this.clearWhere((entry) => entry.binding.chatId === normalizedChatId)
  }

  clearForWorkspace(workspacePath: string | null | undefined): number {
    if (workspacePath === null || workspacePath === undefined) return 0
    const normalizedWorkspacePath = canonicalPath(workspacePath)
    if (!normalizedWorkspacePath) return 0
    return this.clearWhere((entry) =>
      [
        entry.binding.workspacePath,
        entry.binding.workspaceRealPath,
        entry.binding.effectiveWorktreePath
      ].includes(normalizedWorkspacePath)
    )
  }

  pruneExpired(now = this.now()): number {
    return this.clearWhere((entry) => now >= entry.expiresAt)
  }

  size(): number {
    this.pruneExpired()
    return this.entries.size
  }

  status(permissionOpportunityId: unknown): PermissionOpportunitySafeStatus | null {
    const id = nonEmptyText(permissionOpportunityId)
    if (!id) return null
    const entry = this.entries.get(id)
    if (!entry || this.now() >= entry.expiresAt) return null
    return safeStatus(entry)
  }

  private resolveForBinding(input: {
    permissionOpportunityId: unknown
    binding: PermissionOpportunityBinding
  }):
    | { ok: true; entry: StoredPermissionOpportunity; now: number }
    | { ok: false; code: PermissionOpportunityTakeErrorCode; error: string } {
    const permissionOpportunityId = nonEmptyText(input.permissionOpportunityId)
    if (!permissionOpportunityId || !OPPORTUNITY_ID_PATTERN.test(permissionOpportunityId)) {
      return {
        ok: false,
        code: 'invalid_opportunity_id',
        error: 'The permission opportunity identifier is malformed.'
      }
    }
    const entry = this.entries.get(permissionOpportunityId)
    if (!entry) {
      return {
        ok: false,
        code: 'opportunity_not_found',
        error: 'This permission opportunity is unavailable.'
      }
    }
    const now = this.now()
    if (now >= entry.expiresAt) {
      this.entries.delete(permissionOpportunityId)
      return {
        ok: false,
        code: 'opportunity_expired',
        error: 'This permission opportunity expired before it could be redeemed.'
      }
    }
    let binding: PermissionOpportunityBinding
    try {
      binding = cloneBinding(input.binding)
    } catch {
      return bindingMismatch()
    }
    if (!bindingsMatch(entry.binding, binding)) return bindingMismatch()
    return { ok: true, entry, now }
  }

  private countForRun(runId: string): number {
    return [...this.entries.values()].filter(
      (entry) => entry.binding.runId === runId && entry.state !== 'consumed'
    ).length
  }

  private evictToCapacity(): boolean {
    while (this.entries.size >= this.maxEntries) {
      const candidate = [...this.entries.values()]
        .filter((entry) => entry.state !== 'reserved')
        .sort((left, right) => {
          const stateRank = (entry: StoredPermissionOpportunity) =>
            entry.state === 'consumed' ? 0 : 1
          return stateRank(left) - stateRank(right) || left.issuedAt - right.issuedAt
        })[0]
      if (!candidate) return false
      this.entries.delete(candidate.permissionOpportunityId)
    }
    return true
  }

  private nextOpportunityId(): string {
    return this.nextId(this.createId, OPPORTUNITY_ID_PATTERN, 'Permission opportunity')
  }

  private nextReservationId(): string {
    return this.nextId(
      this.createReservationId,
      RESERVATION_ID_PATTERN,
      'Permission opportunity reservation'
    )
  }

  private nextId(factory: () => string, pattern: RegExp, label: string): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = factory()
      if (!pattern.test(candidate)) {
        throw new TypeError(`${label} id factory did not provide a high-entropy identifier.`)
      }
      if (
        !this.entries.has(candidate) &&
        ![...this.entries.values()].some((entry) => entry.reservationId === candidate)
      ) {
        return candidate
      }
    }
    throw new Error(`${label} id factory produced repeated identifiers.`)
  }

  private clearWhere(predicate: (entry: StoredPermissionOpportunity) => boolean): number {
    let removed = 0
    for (const [id, entry] of this.entries) {
      if (!predicate(entry)) continue
      this.entries.delete(id)
      removed += 1
    }
    return removed
  }
}
