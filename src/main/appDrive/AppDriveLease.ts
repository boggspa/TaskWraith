import { randomUUID } from 'node:crypto'

export const APP_DRIVE_LEASE_SCHEMA_VERSION = 1 as const
export const APP_DRIVE_DEFAULT_LEASE_TTL_MS = 15 * 60 * 1_000
export const APP_DRIVE_DEFAULT_STEP_BUDGET = 20
export const APP_DRIVE_MAX_LEASE_TTL_MS = 30 * 60 * 1_000
export const APP_DRIVE_MAX_STEP_BUDGET = 100

export type AppDriveLeaseSurfaceKind = 'web' | 'simulator'
export type AppDriveLeaseStatus = 'active' | 'revoked'
export type AppDriveLeaseRevocationReason =
  | 'navigation'
  | 'surface-closed'
  | 'human-takeover'
  | 'run-terminal'
  | 'chat-closed'
  | 'expired'
  | 'step-budget-exhausted'
  | 'replaced'
  | 'user-revoked'

export type AppDriveLeaseErrorCode =
  | 'invalid-input'
  | 'consent-required'
  | 'binding-mismatch'
  | 'verb-not-allowed'
  | 'expired'
  | 'step-budget-exhausted'

export interface AppDriveLeaseTarget {
  readonly canvasId?: string
  readonly origin?: string
  readonly udid?: string
  readonly bundleId?: string
}

export interface AppDriveLeaseSnapshot {
  readonly schemaVersion: typeof APP_DRIVE_LEASE_SCHEMA_VERSION
  readonly leaseId: string
  readonly surfaceId: string
  readonly surfaceKind: AppDriveLeaseSurfaceKind
  readonly chatId: string
  readonly runId: string
  readonly provider: string
  readonly participantId?: string
  readonly approvedBy: 'user'
  readonly approvalId?: string
  readonly approvedAt: number
  readonly expiresAt: number
  readonly allowedVerbs: readonly string[]
  readonly stepBudget: number
  readonly stepsUsed: number
  readonly stepsRemaining: number
  readonly target: Readonly<AppDriveLeaseTarget>
  readonly status: AppDriveLeaseStatus
  readonly revokedAt: number | null
  readonly revocationReason: AppDriveLeaseRevocationReason | null
  readonly updatedAt: number
}

export interface AuthorizeAppDriveLeaseInput {
  readonly surfaceId: string
  readonly surfaceKind: AppDriveLeaseSurfaceKind
  readonly chatId: string
  readonly runId: string
  readonly provider: string
  readonly participantId?: string
  readonly approvedBy: 'user'
  readonly approvalId?: string
  readonly approvedAt?: number
  readonly expiresAt?: number
  readonly allowedVerbs: readonly string[]
  readonly stepBudget?: number
  readonly target?: AppDriveLeaseTarget
}

export interface ConsumeAppDriveLeaseInput {
  readonly surfaceId: string
  readonly surfaceKind: AppDriveLeaseSurfaceKind
  readonly chatId: string
  readonly runId: string
  readonly provider: string
  readonly participantId?: string
  readonly verb: string
}

export type AppDriveLeaseAdmission =
  | { readonly ok: true; readonly lease: AppDriveLeaseSnapshot }
  | {
      readonly ok: false
      readonly code: AppDriveLeaseErrorCode
      readonly error: string
      readonly lease?: AppDriveLeaseSnapshot
    }

export interface AppDriveLeaseRegistryOptions {
  readonly now?: () => number
  readonly createLeaseId?: () => string
}

function canonical(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw new Error(`App Drive lease ${label} must be a canonical non-empty string.`)
  }
  return value
}

function optionalCanonical(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  return canonical(value, label)
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > maximum) {
    throw new Error(`App Drive lease ${label} must be an integer from 1 to ${maximum}.`)
  }
  return Number(value)
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`App Drive lease ${label} must be finite.`)
  }
  return value
}

function canonicalVerbs(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values)) throw new Error('App Drive lease allowedVerbs must be an array.')
  const verbs = Array.from(
    new Set(values.map((value) => canonical(value, 'verb')).filter((value) => value.length <= 64))
  )
  if (verbs.length === 0 || verbs.length > 32) {
    throw new Error('App Drive lease must allow between 1 and 32 verbs.')
  }
  return Object.freeze(verbs)
}

function freezeLease(value: AppDriveLeaseSnapshot): AppDriveLeaseSnapshot {
  return Object.freeze({
    ...value,
    allowedVerbs: Object.freeze([...value.allowedVerbs]),
    target: Object.freeze({ ...value.target })
  })
}

function denied(
  code: AppDriveLeaseErrorCode,
  error: string,
  lease?: AppDriveLeaseSnapshot
): AppDriveLeaseAdmission {
  return lease ? { ok: false, code, error, lease } : { ok: false, code, error }
}

/** Process-local, user-minted authority for one exact owned surface. */
export class AppDriveLeaseRegistry {
  private readonly now: () => number
  private readonly createLeaseId: () => string
  private readonly bySurface = new Map<string, AppDriveLeaseSnapshot>()

  constructor(options: AppDriveLeaseRegistryOptions = {}) {
    this.now = options.now ?? Date.now
    this.createLeaseId = options.createLeaseId ?? randomUUID
  }

  authorizeUserLease(input: AuthorizeAppDriveLeaseInput): AppDriveLeaseSnapshot {
    const now = this.now()
    if (input.approvedBy !== 'user') {
      throw new Error('App Drive leases can only be minted by a user approval.')
    }
    const surfaceId = canonical(input.surfaceId, 'surfaceId')
    const approvedAt = finiteNumber(input.approvedAt ?? now, 'approvedAt')
    const expiresAt = finiteNumber(
      input.expiresAt ?? approvedAt + APP_DRIVE_DEFAULT_LEASE_TTL_MS,
      'expiresAt'
    )
    if (expiresAt <= now || expiresAt - approvedAt > APP_DRIVE_MAX_LEASE_TTL_MS) {
      throw new Error('App Drive lease expiry must be live and within the maximum TTL.')
    }
    const stepBudget = positiveInteger(
      input.stepBudget ?? APP_DRIVE_DEFAULT_STEP_BUDGET,
      'stepBudget',
      APP_DRIVE_MAX_STEP_BUDGET
    )
    const previous = this.bySurface.get(surfaceId)
    if (previous?.status === 'active') {
      this.bySurface.set(surfaceId, this.revokeSnapshot(previous, 'replaced', now))
    }
    const lease = freezeLease({
      schemaVersion: APP_DRIVE_LEASE_SCHEMA_VERSION,
      leaseId: canonical(this.createLeaseId(), 'leaseId'),
      surfaceId,
      surfaceKind: input.surfaceKind,
      chatId: canonical(input.chatId, 'chatId'),
      runId: canonical(input.runId, 'runId'),
      provider: canonical(input.provider, 'provider'),
      ...(optionalCanonical(input.participantId, 'participantId')
        ? { participantId: input.participantId }
        : {}),
      approvedBy: 'user',
      ...(optionalCanonical(input.approvalId, 'approvalId')
        ? { approvalId: input.approvalId }
        : {}),
      approvedAt,
      expiresAt,
      allowedVerbs: canonicalVerbs(input.allowedVerbs),
      stepBudget,
      stepsUsed: 0,
      stepsRemaining: stepBudget,
      target: Object.freeze({ ...(input.target || {}) }),
      status: 'active',
      revokedAt: null,
      revocationReason: null,
      updatedAt: now
    })
    this.bySurface.set(surfaceId, lease)
    return lease
  }

  peek(surfaceId: string): AppDriveLeaseSnapshot | null {
    const key = typeof surfaceId === 'string' ? surfaceId.trim() : ''
    if (!key || key !== surfaceId) return null
    const lease = this.bySurface.get(key)
    if (!lease) return null
    if (lease.status === 'active' && lease.expiresAt <= this.now()) {
      const expired = this.revokeSnapshot(lease, 'expired', this.now())
      this.bySurface.set(key, expired)
      return expired
    }
    return lease
  }

  acquireAndConsume(input: ConsumeAppDriveLeaseInput): AppDriveLeaseAdmission {
    const surfaceId = canonical(input.surfaceId, 'surfaceId')
    const lease = this.peek(surfaceId)
    if (!lease || lease.status !== 'active') {
      const code = lease?.revocationReason === 'expired' ? 'expired' : 'consent-required'
      return denied(
        code,
        code === 'expired'
          ? 'App Drive lease expired; ask the user to approve this surface again.'
          : 'App Drive requires a current user-approved lease for this exact surface.',
        lease || undefined
      )
    }
    const participantId = optionalCanonical(input.participantId, 'participantId')
    if (
      lease.surfaceKind !== input.surfaceKind ||
      lease.chatId !== canonical(input.chatId, 'chatId') ||
      lease.runId !== canonical(input.runId, 'runId') ||
      lease.provider !== canonical(input.provider, 'provider') ||
      (lease.participantId !== undefined && lease.participantId !== participantId)
    ) {
      return denied('binding-mismatch', 'App Drive lease does not match this exact run.', lease)
    }
    const verb = canonical(input.verb, 'verb')
    if (!lease.allowedVerbs.includes(verb)) {
      return denied('verb-not-allowed', `App Drive lease does not allow ${verb}.`, lease)
    }
    if (lease.stepsUsed >= lease.stepBudget) {
      const exhausted = this.revokeSnapshot(lease, 'step-budget-exhausted', this.now())
      this.bySurface.set(surfaceId, exhausted)
      return denied(
        'step-budget-exhausted',
        'App Drive step budget is exhausted; ask the user to approve another bounded lease.',
        exhausted
      )
    }
    const stepsUsed = lease.stepsUsed + 1
    const next = freezeLease({
      ...lease,
      stepsUsed,
      stepsRemaining: lease.stepBudget - stepsUsed,
      updatedAt: this.now()
    })
    this.bySurface.set(surfaceId, next)
    return { ok: true, lease: next }
  }

  transfer(input: {
    surfaceId: string
    fromRunId: string
    toRunId: string
    toParticipantId?: string
  }): AppDriveLeaseAdmission {
    const surfaceId = canonical(input.surfaceId, 'surfaceId')
    const lease = this.peek(surfaceId)
    if (!lease || lease.status !== 'active') {
      return denied('consent-required', 'No active App Drive lease exists for this surface.')
    }
    if (lease.runId !== canonical(input.fromRunId, 'fromRunId')) {
      return denied('binding-mismatch', 'Only the holding run may transfer this lease.', lease)
    }
    const next = freezeLease({
      ...lease,
      runId: canonical(input.toRunId, 'toRunId'),
      ...(optionalCanonical(input.toParticipantId, 'toParticipantId')
        ? { participantId: input.toParticipantId }
        : { participantId: undefined }),
      updatedAt: this.now()
    })
    this.bySurface.set(surfaceId, next)
    return { ok: true, lease: next }
  }

  revokeSurface(
    surfaceId: string,
    reason: AppDriveLeaseRevocationReason
  ): AppDriveLeaseSnapshot | null {
    const lease = this.peek(surfaceId)
    if (!lease) return null
    if (lease.status === 'revoked') return lease
    const revoked = this.revokeSnapshot(lease, reason, this.now())
    this.bySurface.set(lease.surfaceId, revoked)
    return revoked
  }

  revokeForRun(runId: string, reason: AppDriveLeaseRevocationReason = 'run-terminal') {
    return this.revokeMatching((lease) => lease.runId === runId, reason)
  }

  revokeForChat(chatId: string, reason: AppDriveLeaseRevocationReason = 'chat-closed') {
    return this.revokeMatching((lease) => lease.chatId === chatId, reason)
  }

  private revokeMatching(
    predicate: (lease: AppDriveLeaseSnapshot) => boolean,
    reason: AppDriveLeaseRevocationReason
  ): AppDriveLeaseSnapshot[] {
    const revoked: AppDriveLeaseSnapshot[] = []
    for (const [surfaceId, lease] of this.bySurface) {
      if (lease.status !== 'active' || !predicate(lease)) continue
      const next = this.revokeSnapshot(lease, reason, this.now())
      this.bySurface.set(surfaceId, next)
      revoked.push(next)
    }
    return revoked
  }

  private revokeSnapshot(
    lease: AppDriveLeaseSnapshot,
    reason: AppDriveLeaseRevocationReason,
    at: number
  ): AppDriveLeaseSnapshot {
    return freezeLease({
      ...lease,
      status: 'revoked',
      revokedAt: at,
      revocationReason: reason,
      updatedAt: at
    })
  }
}
