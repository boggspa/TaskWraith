import { randomUUID } from 'node:crypto'
import {
  AppDriveSessionReportError,
  AppDriveSessionReportStore,
  type AppDriveActionReport,
  type AppDriveObservationReceipt,
  type AppDriveReportActor,
  type AppDriveSessionReport,
  type AppDriveSessionReportQuery,
  type CompleteAppDriveActionReportInput,
  type RecordAppDriveObservationInput,
  type UpdateAppDriveSurfaceVerificationInput,
  type VerifyAppDriveActionReportInput
} from './AppDriveSessionReport'

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
  | 'independent-verifier-required'

export interface AppDriveLeaseTarget {
  readonly canvasId?: string
  readonly origin?: string
  readonly udid?: string
  readonly bundleId?: string
}

export interface AppDriveLeaseSnapshot {
  readonly schemaVersion: typeof APP_DRIVE_LEASE_SCHEMA_VERSION
  readonly leaseId: string
  readonly reportId: string
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
  readonly independentVerificationRequired: boolean
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
  readonly independentVerificationRequired?: boolean
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
  readonly independentVerificationRequired?: boolean
}

export type AppDriveLeaseDenial = {
  readonly ok: false
  readonly code: AppDriveLeaseErrorCode
  readonly error: string
  readonly lease?: AppDriveLeaseSnapshot
}

export type AppDriveLeaseAdmission =
  | {
      readonly ok: true
      readonly lease: AppDriveLeaseSnapshot
      readonly reportId: string
      readonly actionId: string
      readonly independentVerificationRequired: boolean
    }
  | AppDriveLeaseDenial

export type AppDriveLeaseTransferResult =
  | { readonly ok: true; readonly lease: AppDriveLeaseSnapshot }
  | AppDriveLeaseDenial

export interface AppDriveLeaseRegistryOptions {
  readonly now?: () => number
  readonly createLeaseId?: () => string
  readonly reports?: AppDriveSessionReportStore
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
): AppDriveLeaseDenial {
  return lease ? { ok: false, code, error, lease } : { ok: false, code, error }
}

/** Process-local, user-minted authority for one exact owned surface. */
export class AppDriveLeaseRegistry {
  private readonly now: () => number
  private readonly createLeaseId: () => string
  private readonly reports: AppDriveSessionReportStore
  private readonly bySurface = new Map<string, AppDriveLeaseSnapshot>()

  constructor(options: AppDriveLeaseRegistryOptions = {}) {
    this.now = options.now ?? Date.now
    this.createLeaseId = options.createLeaseId ?? randomUUID
    this.reports = options.reports ?? new AppDriveSessionReportStore({ now: this.now })
  }

  authorizeUserLease(input: AuthorizeAppDriveLeaseInput): AppDriveLeaseSnapshot {
    const now = this.now()
    if (input.approvedBy !== 'user') {
      throw new Error('App Drive leases can only be minted by a user approval.')
    }
    const surfaceId = canonical(input.surfaceId, 'surfaceId')
    if (input.surfaceKind !== 'web' && input.surfaceKind !== 'simulator') {
      throw new Error('App Drive lease surfaceKind must be web or simulator.')
    }
    const chatId = canonical(input.chatId, 'chatId')
    const runId = canonical(input.runId, 'runId')
    const provider = canonical(input.provider, 'provider')
    const participantId = optionalCanonical(input.participantId, 'participantId')
    const approvalId = optionalCanonical(input.approvalId, 'approvalId')
    const allowedVerbs = canonicalVerbs(input.allowedVerbs)
    if (
      input.target !== undefined &&
      (!input.target || typeof input.target !== 'object' || Array.isArray(input.target))
    ) {
      throw new Error('App Drive lease target must be an object.')
    }
    const target = Object.freeze({ ...(input.target || {}) })
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
    if (input.independentVerificationRequired === true && !participantId) {
      throw new Error('Independent App Drive verification requires an Ensemble participant holder.')
    }
    const leaseId = canonical(this.createLeaseId(), 'leaseId')
    const holder = this.reportActor({
      runId,
      provider,
      participantId
    })
    const report = this.reports.start({
      leaseId,
      surfaceId,
      surfaceKind: input.surfaceKind,
      chatId,
      holder,
      approvedAt,
      expiresAt,
      stepBudget,
      independentVerificationRequired: input.independentVerificationRequired === true
    })
    const previous = this.bySurface.get(surfaceId)
    if (previous?.status === 'active') {
      this.bySurface.set(surfaceId, this.revokeSnapshot(previous, 'replaced', now))
    }
    const lease = freezeLease({
      schemaVersion: APP_DRIVE_LEASE_SCHEMA_VERSION,
      leaseId,
      reportId: report.reportId,
      surfaceId,
      surfaceKind: input.surfaceKind,
      chatId,
      runId,
      provider,
      ...(participantId ? { participantId } : {}),
      approvedBy: 'user',
      ...(approvalId ? { approvalId } : {}),
      approvedAt,
      expiresAt,
      allowedVerbs,
      stepBudget,
      stepsUsed: 0,
      stepsRemaining: stepBudget,
      independentVerificationRequired: input.independentVerificationRequired === true,
      target,
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
    const independentVerificationRequired =
      lease.independentVerificationRequired || input.independentVerificationRequired === true
    if (independentVerificationRequired && !participantId) {
      return denied(
        'independent-verifier-required',
        'Independent App Drive verification requires an Ensemble participant actor.',
        lease
      )
    }
    let action: AppDriveActionReport
    try {
      action = this.reports.beginAction({
        leaseId: lease.leaseId,
        verb,
        actor: this.reportActor({
          runId: lease.runId,
          provider: lease.provider,
          participantId: lease.participantId
        }),
        independentVerificationRequired
      })
    } catch (error) {
      if (
        error instanceof AppDriveSessionReportError &&
        error.code === 'independent-verifier-required'
      ) {
        return denied('independent-verifier-required', error.message, lease)
      }
      throw error
    }
    const stepsUsed = lease.stepsUsed + 1
    const next = freezeLease({
      ...lease,
      stepsUsed,
      stepsRemaining: lease.stepBudget - stepsUsed,
      updatedAt: this.now()
    })
    this.bySurface.set(surfaceId, next)
    this.reports.updateBudget(next.leaseId, {
      stepsUsed: next.stepsUsed,
      stepsRemaining: next.stepsRemaining,
      expiresAt: next.expiresAt
    })
    return {
      ok: true,
      lease: next,
      reportId: next.reportId,
      actionId: action.actionId,
      independentVerificationRequired: action.independentVerificationRequired
    }
  }

  transfer(input: {
    surfaceId: string
    fromRunId: string
    fromProvider: string
    toRunId: string
    toProvider: string
    toParticipantId?: string
  }): AppDriveLeaseTransferResult {
    const surfaceId = canonical(input.surfaceId, 'surfaceId')
    const lease = this.peek(surfaceId)
    if (!lease || lease.status !== 'active') {
      return denied('consent-required', 'No active App Drive lease exists for this surface.')
    }
    if (
      lease.runId !== canonical(input.fromRunId, 'fromRunId') ||
      lease.provider !== canonical(input.fromProvider, 'fromProvider')
    ) {
      return denied('binding-mismatch', 'Only the holding run may transfer this lease.', lease)
    }
    const toParticipantId = optionalCanonical(input.toParticipantId, 'toParticipantId')
    if (lease.independentVerificationRequired && !toParticipantId) {
      return denied(
        'independent-verifier-required',
        'This App Drive lease requires an Ensemble participant holder.',
        lease
      )
    }
    const next = freezeLease({
      ...lease,
      runId: canonical(input.toRunId, 'toRunId'),
      provider: canonical(input.toProvider, 'toProvider'),
      ...(toParticipantId ? { participantId: toParticipantId } : { participantId: undefined }),
      updatedAt: this.now()
    })
    this.bySurface.set(surfaceId, next)
    this.reports.transfer(
      next.leaseId,
      this.reportActor({
        runId: next.runId,
        provider: next.provider,
        participantId: next.participantId
      })
    )
    return { ok: true, lease: next }
  }

  completeAction(input: CompleteAppDriveActionReportInput): AppDriveActionReport {
    return this.reports.completeAction(input)
  }

  updateSurfaceVerification(input: UpdateAppDriveSurfaceVerificationInput): AppDriveActionReport {
    return this.reports.updateSurfaceVerification(input)
  }

  recordObservation(input: RecordAppDriveObservationInput): AppDriveObservationReceipt | null {
    return this.reports.recordObservation(input)
  }

  queryReports(input: AppDriveSessionReportQuery): readonly AppDriveSessionReport[] {
    return this.reports.query(input)
  }

  verifyAction(input: VerifyAppDriveActionReportInput): AppDriveActionReport {
    return this.reports.verifyAction(input)
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
    const revoked = freezeLease({
      ...lease,
      status: 'revoked',
      revokedAt: at,
      revocationReason: reason,
      updatedAt: at
    })
    this.reports.end(lease.leaseId, reason, at)
    return revoked
  }

  private reportActor(input: {
    runId: string
    provider: string
    participantId?: string
  }): AppDriveReportActor {
    return {
      runId: canonical(input.runId, 'runId'),
      provider: canonical(input.provider, 'provider'),
      participantId: optionalCanonical(input.participantId, 'participantId') ?? null
    }
  }
}
