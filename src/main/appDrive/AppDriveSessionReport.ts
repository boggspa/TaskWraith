import { randomUUID } from 'node:crypto'

export const APP_DRIVE_SESSION_REPORT_SCHEMA_VERSION = 1 as const
export const APP_DRIVE_SESSION_REPORT_MAX_ACTIONS = 100
export const APP_DRIVE_SESSION_REPORT_MAX_SESSIONS = 128

export type AppDriveReportSurfaceKind = 'web' | 'simulator' | 'native'
export type AppDriveReportStatus = 'active' | 'ended'
export type AppDriveActionReportStatus =
  | 'pending'
  | 'awaiting-verification'
  | 'verified'
  | 'not-verified'
  | 'refused'
  | 'indeterminate'
export type AppDriveVerificationVerdict = 'confirmed' | 'not-confirmed' | 'inconclusive'
export type AppDriveSurfaceVerification = 'changed' | 'unchanged' | 'unknown'

export interface AppDriveReportActor {
  readonly runId: string
  readonly provider: string
  readonly participantId: string | null
}

export interface AppDriveReportVerifier extends AppDriveReportActor {
  readonly kind: 'participant'
  readonly verdict: AppDriveVerificationVerdict
  readonly verifiedAt: number
}

export interface AppDriveSurfaceVerifier {
  readonly kind: 'surface'
  readonly verdict: AppDriveVerificationVerdict
  readonly verifiedAt: number
}

export interface AppDriveActionReport {
  readonly actionId: string
  readonly sequence: number
  readonly verb: string
  readonly actor: AppDriveReportActor
  readonly independentVerificationRequired: boolean
  readonly status: AppDriveActionReportStatus
  readonly startedAt: number
  readonly completedAt: number | null
  readonly executed: boolean | null
  readonly refusalCode: string | null
  readonly surfaceVerification: AppDriveSurfaceVerification | null
  readonly surfaceVerifier: AppDriveSurfaceVerifier | null
  readonly participantVerifier: AppDriveReportVerifier | null
}

export interface AppDriveSessionReportCounts {
  readonly total: number
  readonly pending: number
  readonly awaitingVerification: number
  readonly verified: number
  readonly notVerified: number
  readonly refused: number
  readonly indeterminate: number
}

/**
 * Bounded, value-free projection of one AppDrive authority session.
 *
 * It deliberately omits target labels, typed values, URLs, approval ids,
 * native handles, PIDs, process receipts, and page content. Surface identity
 * plus actor/verifier attribution is the complete public boundary.
 */
export interface AppDriveSessionReport {
  readonly schemaVersion: typeof APP_DRIVE_SESSION_REPORT_SCHEMA_VERSION
  readonly reportId: string
  readonly leaseId: string
  readonly surfaceId: string
  readonly surfaceKind: AppDriveReportSurfaceKind
  readonly status: AppDriveReportStatus
  readonly chatId: string
  readonly holder: AppDriveReportActor
  readonly approvedAt: number
  readonly expiresAt: number
  readonly stepBudget: number
  readonly stepsUsed: number
  readonly stepsRemaining: number
  readonly independentVerificationRequired: boolean
  readonly startedAt: number
  readonly endedAt: number | null
  readonly endReason: string | null
  readonly updatedAt: number
  readonly counts: AppDriveSessionReportCounts
  readonly actions: readonly AppDriveActionReport[]
}

export interface StartAppDriveSessionReportInput {
  readonly leaseId: string
  readonly surfaceId: string
  readonly surfaceKind: AppDriveReportSurfaceKind
  readonly chatId: string
  readonly holder: AppDriveReportActor
  readonly approvedAt: number
  readonly expiresAt: number
  readonly stepBudget: number
  readonly stepsUsed?: number
  readonly independentVerificationRequired?: boolean
}

export interface BeginAppDriveActionReportInput {
  readonly leaseId: string
  readonly verb: string
  readonly actor: AppDriveReportActor
  readonly independentVerificationRequired?: boolean
}

export interface CompleteAppDriveActionReportInput {
  readonly leaseId: string
  readonly actionId: string
  readonly actor: AppDriveReportActor
  readonly executed: boolean | null
  readonly surfaceVerification: AppDriveSurfaceVerification
  readonly refusalCode?: string
}

export interface UpdateAppDriveSurfaceVerificationInput {
  readonly leaseId: string
  readonly actionId: string
  readonly actor: AppDriveReportActor
  readonly surfaceVerification: AppDriveSurfaceVerification
}

export interface AppDriveObservationReceipt {
  readonly observationId: string
  readonly reportId: string
  readonly actionId: string
  readonly surfaceId: string
  readonly observer: AppDriveReportActor
  readonly observedAt: number
}

export interface RecordAppDriveObservationInput {
  readonly chatId: string
  readonly observer: AppDriveReportActor
  readonly reportId?: string
  readonly surfaceId?: string
  readonly surfaceKind?: AppDriveReportSurfaceKind
  readonly actionId?: string
}

export interface VerifyAppDriveActionReportInput {
  readonly reportId: string
  readonly actionId: string
  readonly surfaceId: string
  readonly observationId: string
  readonly chatId: string
  readonly verifier: AppDriveReportActor
  readonly verdict: AppDriveVerificationVerdict
}

export interface AppDriveSessionReportQuery {
  readonly chatId: string
  readonly reportId?: string
  readonly surfaceId?: string
  readonly limit?: number
}

export type AppDriveSessionReportErrorCode =
  | 'invalid-input'
  | 'not-found'
  | 'binding-mismatch'
  | 'invalid-state'
  | 'independent-verifier-required'

export class AppDriveSessionReportError extends Error {
  constructor(
    readonly code: AppDriveSessionReportErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'AppDriveSessionReportError'
  }
}

export interface AppDriveSessionReportStoreOptions {
  readonly now?: () => number
  readonly createReportId?: () => string
  readonly createActionId?: () => string
  readonly createObservationId?: () => string
  readonly maxSessions?: number
}

interface MutableActionReport {
  actionId: string
  sequence: number
  verb: string
  actor: AppDriveReportActor
  independentVerificationRequired: boolean
  status: AppDriveActionReportStatus
  startedAt: number
  completedAt: number | null
  executed: boolean | null
  refusalCode: string | null
  surfaceVerification: AppDriveSurfaceVerification | null
  surfaceVerifier: AppDriveSurfaceVerifier | null
  participantVerifier: AppDriveReportVerifier | null
}

interface MutableSessionReport {
  schemaVersion: typeof APP_DRIVE_SESSION_REPORT_SCHEMA_VERSION
  reportId: string
  leaseId: string
  surfaceId: string
  surfaceKind: AppDriveReportSurfaceKind
  status: AppDriveReportStatus
  chatId: string
  holder: AppDriveReportActor
  approvedAt: number
  expiresAt: number
  stepBudget: number
  stepsUsed: number
  stepsRemaining: number
  independentVerificationRequired: boolean
  startedAt: number
  endedAt: number | null
  endReason: string | null
  updatedAt: number
  actions: MutableActionReport[]
}

interface MutableObservationReceipt extends AppDriveObservationReceipt {}

function fail(code: AppDriveSessionReportErrorCode, message: string): never {
  throw new AppDriveSessionReportError(code, message)
}

function canonical(value: unknown, label: string, max = 512): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > max) {
    fail('invalid-input', `AppDrive report ${label} must be a canonical non-empty string.`)
  }
  return value
}

function optionalCanonical(value: unknown, label: string, max = 512): string | null {
  if (value === undefined || value === null) return null
  return canonical(value, label, max)
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('invalid-input', `AppDrive report ${label} must be finite.`)
  }
  return value
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail(
      'invalid-input',
      `AppDrive report ${label} must be an integer from ${minimum} to ${maximum}.`
    )
  }
  return Number(value)
}

function actor(value: AppDriveReportActor, label: string): AppDriveReportActor {
  return Object.freeze({
    runId: canonical(value?.runId, `${label}.runId`),
    provider: canonical(value?.provider, `${label}.provider`),
    participantId: optionalCanonical(value?.participantId, `${label}.participantId`)
  })
}

function sameActor(left: AppDriveReportActor, right: AppDriveReportActor): boolean {
  return (
    left.runId === right.runId &&
    left.provider === right.provider &&
    left.participantId === right.participantId
  )
}

function surfaceVerdict(value: AppDriveSurfaceVerification): AppDriveVerificationVerdict {
  if (value === 'changed') return 'confirmed'
  return value === 'unchanged' ? 'not-confirmed' : 'inconclusive'
}

function actionStatus(action: MutableActionReport): AppDriveActionReportStatus {
  if (action.executed === false) return 'refused'
  if (action.executed === null) return 'indeterminate'
  if (action.participantVerifier) {
    if (action.participantVerifier.verdict === 'confirmed') return 'verified'
    if (action.participantVerifier.verdict === 'not-confirmed') return 'not-verified'
    return 'indeterminate'
  }
  if (action.independentVerificationRequired) return 'awaiting-verification'
  if (action.surfaceVerification === 'changed') return 'verified'
  return action.surfaceVerification === 'unchanged' ? 'not-verified' : 'awaiting-verification'
}

function cloneAction(action: MutableActionReport): AppDriveActionReport {
  return Object.freeze({
    ...action,
    actor: Object.freeze({ ...action.actor }),
    surfaceVerifier: action.surfaceVerifier ? Object.freeze({ ...action.surfaceVerifier }) : null,
    participantVerifier: action.participantVerifier
      ? Object.freeze({ ...action.participantVerifier })
      : null
  })
}

function counts(actions: readonly MutableActionReport[]): AppDriveSessionReportCounts {
  const result = {
    total: actions.length,
    pending: 0,
    awaitingVerification: 0,
    verified: 0,
    notVerified: 0,
    refused: 0,
    indeterminate: 0
  }
  for (const action of actions) {
    if (action.status === 'pending') result.pending += 1
    else if (action.status === 'awaiting-verification') result.awaitingVerification += 1
    else if (action.status === 'verified') result.verified += 1
    else if (action.status === 'not-verified') result.notVerified += 1
    else if (action.status === 'refused') result.refused += 1
    else result.indeterminate += 1
  }
  return Object.freeze(result)
}

function snapshot(report: MutableSessionReport): AppDriveSessionReport {
  return Object.freeze({
    ...report,
    holder: Object.freeze({ ...report.holder }),
    counts: counts(report.actions),
    actions: Object.freeze(report.actions.map(cloneAction))
  })
}

/** Process-local, bounded drive-session report ledger shared by every surface adapter. */
export class AppDriveSessionReportStore {
  private readonly now: () => number
  private readonly createReportId: () => string
  private readonly createActionId: () => string
  private readonly createObservationId: () => string
  private readonly maxSessions: number
  private readonly byReportId = new Map<string, MutableSessionReport>()
  private readonly byLeaseId = new Map<string, MutableSessionReport>()
  private readonly latestBySurface = new Map<string, MutableSessionReport>()
  private readonly insertionOrder: string[] = []
  private readonly observations = new Map<string, MutableObservationReceipt>()
  private readonly observationOrder: string[] = []

  constructor(options: AppDriveSessionReportStoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.createReportId = options.createReportId ?? randomUUID
    this.createActionId = options.createActionId ?? randomUUID
    this.createObservationId = options.createObservationId ?? randomUUID
    this.maxSessions = boundedInteger(
      options.maxSessions ?? APP_DRIVE_SESSION_REPORT_MAX_SESSIONS,
      'maxSessions',
      1,
      1_024
    )
  }

  start(input: StartAppDriveSessionReportInput): AppDriveSessionReport {
    const leaseId = canonical(input.leaseId, 'leaseId')
    const existing = this.byLeaseId.get(leaseId)
    if (existing) return snapshot(existing)

    const now = this.now()
    const approvedAt = finiteNumber(input.approvedAt, 'approvedAt')
    const expiresAt = finiteNumber(input.expiresAt, 'expiresAt')
    if (expiresAt <= approvedAt || expiresAt <= now) {
      fail('invalid-input', 'AppDrive report expiry must follow approval and still be live.')
    }
    const stepBudget = boundedInteger(
      input.stepBudget,
      'stepBudget',
      1,
      APP_DRIVE_SESSION_REPORT_MAX_ACTIONS
    )
    const stepsUsed = boundedInteger(input.stepsUsed ?? 0, 'stepsUsed', 0, stepBudget)
    const independentVerificationRequired = input.independentVerificationRequired === true
    const reportHolder = actor(input.holder, 'holder')
    if (independentVerificationRequired && !reportHolder.participantId) {
      fail(
        'independent-verifier-required',
        'Independent AppDrive verification requires an Ensemble participant holder.'
      )
    }
    const surfaceId = canonical(input.surfaceId, 'surfaceId')
    const previous = this.latestBySurface.get(surfaceId)
    if (previous?.status === 'active') this.end(previous.leaseId, 'replaced', now)

    const report: MutableSessionReport = {
      schemaVersion: APP_DRIVE_SESSION_REPORT_SCHEMA_VERSION,
      reportId: canonical(this.createReportId(), 'reportId'),
      leaseId,
      surfaceId,
      surfaceKind: input.surfaceKind,
      status: 'active',
      chatId: canonical(input.chatId, 'chatId'),
      holder: reportHolder,
      approvedAt,
      expiresAt,
      stepBudget,
      stepsUsed,
      stepsRemaining: stepBudget - stepsUsed,
      independentVerificationRequired,
      startedAt: now,
      endedAt: null,
      endReason: null,
      updatedAt: now,
      actions: []
    }
    this.byReportId.set(report.reportId, report)
    this.byLeaseId.set(report.leaseId, report)
    this.latestBySurface.set(report.surfaceId, report)
    this.insertionOrder.push(report.reportId)
    this.prune()
    return snapshot(report)
  }

  updateBudget(
    leaseId: string,
    input: { stepsUsed: number; stepsRemaining: number; expiresAt?: number }
  ): AppDriveSessionReport {
    const report = this.requireLease(leaseId)
    const stepsUsed = boundedInteger(input.stepsUsed, 'stepsUsed', 0, report.stepBudget)
    const stepsRemaining = boundedInteger(
      input.stepsRemaining,
      'stepsRemaining',
      0,
      report.stepBudget
    )
    if (stepsUsed + stepsRemaining !== report.stepBudget) {
      fail('invalid-input', 'AppDrive report budget projection does not add up.')
    }
    report.stepsUsed = stepsUsed
    report.stepsRemaining = stepsRemaining
    if (input.expiresAt !== undefined) report.expiresAt = finiteNumber(input.expiresAt, 'expiresAt')
    report.updatedAt = this.now()
    return snapshot(report)
  }

  transfer(leaseId: string, holder: AppDriveReportActor): AppDriveSessionReport {
    const report = this.requireLease(leaseId)
    if (report.status !== 'active') fail('invalid-state', 'Ended AppDrive report cannot transfer.')
    const nextHolder = actor(holder, 'holder')
    if (report.independentVerificationRequired && !nextHolder.participantId) {
      fail(
        'independent-verifier-required',
        'This AppDrive report requires an Ensemble participant holder.'
      )
    }
    report.holder = nextHolder
    report.updatedAt = this.now()
    return snapshot(report)
  }

  beginAction(input: BeginAppDriveActionReportInput): AppDriveActionReport {
    const report = this.requireLease(input.leaseId)
    if (report.status === 'active' && report.expiresAt <= this.now()) {
      this.end(report.leaseId, 'expired', this.now())
    }
    if (report.status !== 'active') fail('invalid-state', 'Ended AppDrive report cannot act.')
    if (report.actions.length >= APP_DRIVE_SESSION_REPORT_MAX_ACTIONS) {
      fail('invalid-state', 'AppDrive report action bound is exhausted.')
    }
    const actionActor = actor(input.actor, 'actor')
    if (!sameActor(actionActor, report.holder)) {
      fail('binding-mismatch', 'AppDrive report actor does not hold this session.')
    }
    const independentVerificationRequired =
      report.independentVerificationRequired || input.independentVerificationRequired === true
    if (independentVerificationRequired && !actionActor.participantId) {
      fail(
        'independent-verifier-required',
        'Independent AppDrive verification requires an Ensemble participant actor.'
      )
    }
    const now = this.now()
    const action: MutableActionReport = {
      actionId: canonical(this.createActionId(), 'actionId'),
      sequence: report.actions.length + 1,
      verb: canonical(input.verb, 'verb', 64),
      actor: actionActor,
      independentVerificationRequired,
      status: 'pending',
      startedAt: now,
      completedAt: null,
      executed: null,
      refusalCode: null,
      surfaceVerification: null,
      surfaceVerifier: null,
      participantVerifier: null
    }
    report.actions.push(action)
    report.updatedAt = now
    return cloneAction(action)
  }

  completeAction(input: CompleteAppDriveActionReportInput): AppDriveActionReport {
    const report = this.requireLease(input.leaseId)
    const action = this.requireAction(report, input.actionId)
    if (!sameActor(action.actor, actor(input.actor, 'actor'))) {
      fail('binding-mismatch', 'AppDrive action completion belongs to another actor.')
    }
    if (action.status !== 'pending') return cloneAction(action)
    const now = this.now()
    action.executed = input.executed
    action.surfaceVerification = input.surfaceVerification
    action.surfaceVerifier = Object.freeze({
      kind: 'surface',
      verdict: surfaceVerdict(input.surfaceVerification),
      verifiedAt: now
    })
    action.refusalCode = optionalCanonical(input.refusalCode, 'refusalCode', 96)
    action.completedAt = now
    action.status = actionStatus(action)
    report.updatedAt = now
    return cloneAction(action)
  }

  updateSurfaceVerification(input: UpdateAppDriveSurfaceVerificationInput): AppDriveActionReport {
    const report = this.requireLease(input.leaseId)
    const action = this.requireAction(report, input.actionId)
    if (!sameActor(action.actor, actor(input.actor, 'actor'))) {
      fail('binding-mismatch', 'AppDrive surface verification belongs to another actor.')
    }
    if (action.status === 'pending' || action.executed !== true) {
      fail('invalid-state', 'Only an executed AppDrive action can receive surface verification.')
    }
    const now = this.now()
    action.surfaceVerification = input.surfaceVerification
    action.surfaceVerifier = Object.freeze({
      kind: 'surface',
      verdict: surfaceVerdict(input.surfaceVerification),
      verifiedAt: now
    })
    action.status = actionStatus(action)
    report.updatedAt = now
    return cloneAction(action)
  }

  recordObservation(input: RecordAppDriveObservationInput): AppDriveObservationReceipt | null {
    this.expireActiveReports()
    const chatId = canonical(input.chatId, 'chatId')
    const reportId = optionalCanonical(input.reportId, 'reportId')
    const surfaceId = optionalCanonical(input.surfaceId, 'surfaceId')
    const actionId = optionalCanonical(input.actionId, 'actionId')
    let report: MutableSessionReport | undefined
    for (let index = this.insertionOrder.length - 1; index >= 0; index -= 1) {
      const candidate = this.byReportId.get(this.insertionOrder[index])
      if (!candidate || candidate.chatId !== chatId) continue
      if (reportId && candidate.reportId !== reportId) continue
      if (surfaceId && candidate.surfaceId !== surfaceId) continue
      if (input.surfaceKind && candidate.surfaceKind !== input.surfaceKind) continue
      report = candidate
      break
    }
    if (!report) return null
    const action = [...report.actions]
      .reverse()
      .find(
        (candidate) =>
          candidate.completedAt !== null &&
          candidate.executed === true &&
          (!actionId || candidate.actionId === actionId)
      )
    if (!action || action.completedAt === null) return null
    const observedAt = this.now()
    if (observedAt < action.completedAt) return null
    const receipt: MutableObservationReceipt = Object.freeze({
      observationId: canonical(this.createObservationId(), 'observationId'),
      reportId: report.reportId,
      actionId: action.actionId,
      surfaceId: report.surfaceId,
      observer: actor(input.observer, 'observer'),
      observedAt
    })
    this.observations.set(receipt.observationId, receipt)
    this.observationOrder.push(receipt.observationId)
    while (this.observationOrder.length > 512) {
      const oldest = this.observationOrder.shift()
      if (oldest) this.observations.delete(oldest)
    }
    return receipt
  }

  verifyAction(input: VerifyAppDriveActionReportInput): AppDriveActionReport {
    this.expireActiveReports()
    const report = this.byReportId.get(canonical(input.reportId, 'reportId'))
    if (!report) fail('not-found', 'AppDrive report is not available.')
    if (report.chatId !== canonical(input.chatId, 'chatId')) {
      fail('binding-mismatch', 'AppDrive report belongs to another chat.')
    }
    if (report.surfaceId !== canonical(input.surfaceId, 'surfaceId')) {
      fail('binding-mismatch', 'AppDrive verification names another surface.')
    }
    const action = this.requireAction(report, input.actionId)
    if (action.status === 'pending' || action.executed !== true) {
      fail('invalid-state', 'This AppDrive action is not eligible for postcondition verification.')
    }
    if (action.participantVerifier) return cloneAction(action)
    if (
      input.verdict !== 'confirmed' &&
      input.verdict !== 'not-confirmed' &&
      input.verdict !== 'inconclusive'
    ) {
      fail('invalid-input', 'AppDrive verifier verdict is invalid.')
    }
    const verifier = actor(input.verifier, 'verifier')
    const observationId = canonical(input.observationId, 'observationId')
    const observation = this.observations.get(observationId)
    if (
      !observation ||
      observation.reportId !== report.reportId ||
      observation.actionId !== action.actionId ||
      observation.surfaceId !== report.surfaceId ||
      !sameActor(observation.observer, verifier) ||
      observation.observedAt < (action.completedAt ?? Number.POSITIVE_INFINITY)
    ) {
      fail(
        'binding-mismatch',
        'AppDrive verification requires this actor’s trusted post-action observation receipt.'
      )
    }
    if (action.independentVerificationRequired) {
      if (!verifier.participantId || verifier.participantId === action.actor.participantId) {
        fail(
          'independent-verifier-required',
          'This AppDrive action requires a different Ensemble participant to verify it.'
        )
      }
    }
    const now = this.now()
    action.participantVerifier = Object.freeze({
      ...verifier,
      kind: 'participant',
      verdict: input.verdict,
      verifiedAt: now
    })
    action.status = actionStatus(action)
    report.updatedAt = now
    this.observations.delete(observationId)
    return cloneAction(action)
  }

  end(leaseId: string, reason: string, at = this.now()): AppDriveSessionReport | null {
    const report = this.byLeaseId.get(typeof leaseId === 'string' ? leaseId : '')
    if (!report) return null
    if (report.status === 'ended') return snapshot(report)
    report.status = 'ended'
    report.endedAt = finiteNumber(at, 'endedAt')
    report.endReason = canonical(reason, 'endReason', 96)
    for (const action of report.actions) {
      if (action.status === 'pending') {
        action.executed = null
        action.surfaceVerification = 'unknown'
        action.surfaceVerifier = Object.freeze({
          kind: 'surface',
          verdict: 'inconclusive',
          verifiedAt: report.endedAt
        })
        action.refusalCode = 'session_ended'
        action.completedAt = report.endedAt
        action.status = 'indeterminate'
      } else if (action.status === 'awaiting-verification') {
        action.status = 'indeterminate'
      }
    }
    report.updatedAt = report.endedAt
    this.prune()
    return snapshot(report)
  }

  query(input: AppDriveSessionReportQuery): readonly AppDriveSessionReport[] {
    this.expireActiveReports()
    const chatId = canonical(input.chatId, 'chatId')
    const reportId = optionalCanonical(input.reportId, 'reportId')
    const surfaceId = optionalCanonical(input.surfaceId, 'surfaceId')
    const limit = boundedInteger(input.limit ?? 20, 'limit', 1, 50)
    const reports: AppDriveSessionReport[] = []
    for (let index = this.insertionOrder.length - 1; index >= 0; index -= 1) {
      const report = this.byReportId.get(this.insertionOrder[index])
      if (!report || report.chatId !== chatId) continue
      if (reportId && report.reportId !== reportId) continue
      if (surfaceId && report.surfaceId !== surfaceId) continue
      reports.push(snapshot(report))
      if (reports.length >= limit) break
    }
    return Object.freeze(reports)
  }

  private requireLease(leaseId: string): MutableSessionReport {
    const report = this.byLeaseId.get(canonical(leaseId, 'leaseId'))
    if (!report) fail('not-found', 'AppDrive report lease is not available.')
    return report
  }

  private requireAction(report: MutableSessionReport, actionId: string): MutableActionReport {
    const canonicalActionId = canonical(actionId, 'actionId')
    const action = report.actions.find((candidate) => candidate.actionId === canonicalActionId)
    if (!action) fail('not-found', 'AppDrive action report is not available.')
    return action
  }

  private expireActiveReports(): void {
    const now = this.now()
    for (const report of this.byReportId.values()) {
      if (report.status === 'active' && report.expiresAt <= now) {
        this.end(report.leaseId, 'expired', now)
      }
    }
  }

  private prune(): void {
    if (this.byReportId.size <= this.maxSessions) return
    for (let index = 0; index < this.insertionOrder.length; index += 1) {
      if (this.byReportId.size <= this.maxSessions) break
      const reportId = this.insertionOrder[index]
      const report = this.byReportId.get(reportId)
      if (
        !report ||
        report.status === 'active' ||
        report.actions.some((action) => action.status === 'pending')
      ) {
        continue
      }
      this.byReportId.delete(reportId)
      this.byLeaseId.delete(report.leaseId)
      if (this.latestBySurface.get(report.surfaceId)?.reportId === reportId) {
        this.latestBySurface.delete(report.surfaceId)
      }
      this.insertionOrder.splice(index, 1)
      index -= 1
    }
  }
}
