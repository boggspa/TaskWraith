/**
 * Main-owned Foreground App Drive session lifecycle overlay.
 *
 * This module productizes pause / resume / takeover / stop chrome over an
 * already-granted exact-run/window control projection. It deliberately:
 *
 * - does **not** mint, broaden, persist, or revoke native control authority
 * - is owned by NativeWindowCoordinator as an admission overlay, while the
 *   existing lease registry remains the sole control authority
 * - labels the only shipped mode as **Foreground Drive** with current-launch
 *   **View & Control** disclosure — never Background / Isolated claims
 * - refuses new actions while paused, in takeover, stopped, idle, or expired
 *
 * Authority remains the existing user-approved control lease. This class only
 * answers whether the agent may attempt an action right now given session chrome.
 *
 * Canonical lifecycle literals (stable for dock / driver consumers):
 * `idle | active | paused | takeover | stopped`.
 */

export const APP_DRIVE_SESSION_SCHEMA_VERSION = 1 as const

/** Canonical session lifecycle. Do not invent alternate chrome state names. */
export const APP_DRIVE_SESSION_LIFECYCLES = [
  'idle',
  'active',
  'paused',
  'takeover',
  'stopped'
] as const

/** Only the shipped product mode. Background / Isolated stay out of this type. */
export type AppDriveMode = 'foreground'

/**
 * Current-launch View & Control disclosure. Not persistent app-keyed trust and
 * not a bundle-ID authority claim.
 */
export type AppDrivePermissionLabel = 'view-and-control'

export type AppDriveSessionLifecycle = (typeof APP_DRIVE_SESSION_LIFECYCLES)[number]

export type AppDriveControlVerb = 'observe' | 'inspect' | 'click' | 'fill'

export type AppDriveStopReason =
  | 'user-stop'
  | 'user-detach'
  | 'binding-cleared'
  | 'expired'
  | 'replaced'

export type AppDriveSessionErrorCode =
  | 'invalid-input'
  | 'no-active-session'
  | 'session-not-active'
  | 'session-paused'
  | 'session-takeover'
  | 'session-stopped'
  | 'session-expired'
  | 'invalid-transition'
  | 'step-budget-exhausted'
  | 'binding-mismatch'

/** Display-only target fields. Never treated as authority. */
export interface AppDriveSessionTargetDisclosure {
  readonly applicationName: string | null
  readonly windowTitle: string | null
  /** UX disclosure only — never an authority key. */
  readonly bundleID: string | null
}

/**
 * Binding inputs mirrored from an already-granted control projection.
 * Callers must not invent authority here: every field should come from the
 * existing main-owned control lease / observation status.
 */
export interface AppDriveSessionBinding {
  readonly chatId: string
  readonly runId: string
  readonly provider: string
  readonly launchAttemptId: string
  readonly approvedAt: number
  readonly allowedVerbs: readonly AppDriveControlVerb[]
  readonly expiresAt: number
  readonly stepBudget: number
  readonly stepsUsed: number
  readonly target?: {
    readonly applicationName?: string | null
    readonly windowTitle?: string | null
    readonly bundleID?: string | null
  } | null
}

/** Main-only snapshot. Safe enough to freeze; still not a renderer contract. */
export interface AppDriveSessionSnapshot {
  readonly schemaVersion: typeof APP_DRIVE_SESSION_SCHEMA_VERSION
  readonly sessionId: string
  readonly mode: AppDriveMode
  readonly permissionLabel: AppDrivePermissionLabel
  readonly lifecycle: Exclude<AppDriveSessionLifecycle, 'idle'>
  readonly chatId: string
  readonly runId: string
  readonly provider: string
  readonly launchAttemptId: string
  readonly approvedAt: number
  readonly allowedVerbs: readonly AppDriveControlVerb[]
  readonly expiresAt: number
  readonly stepBudget: number
  readonly stepsUsed: number
  readonly stepsRemaining: number
  readonly target: AppDriveSessionTargetDisclosure | null
  readonly pausedAt: number | null
  readonly takeoverAt: number | null
  readonly stoppedAt: number | null
  readonly stopReason: AppDriveStopReason | null
  readonly updatedAt: number
}

export interface AppDriveSessionControls {
  readonly canPause: boolean
  readonly canResume: boolean
  readonly canTakeOver: boolean
  readonly canStop: boolean
}

/**
 * Safe renderer / dock projection. Omits no secret authority tokens because
 * this module never holds handles, consent epochs, PIDs, or process-birth
 * receipts. Bundle ID is disclosure-only.
 */
export interface AppDriveSessionRendererStatus {
  readonly schemaVersion: typeof APP_DRIVE_SESSION_SCHEMA_VERSION
  readonly sessionId: string | null
  readonly mode: AppDriveMode | null
  /** Human-facing mode honesty label. */
  readonly modeLabel: 'Foreground Drive' | null
  readonly permissionLabel: 'View & Control' | null
  readonly lifecycle: AppDriveSessionLifecycle
  /** True only when lifecycle is active and the mirrored lease is not expired. */
  readonly canAdmitActions: boolean
  readonly chatId: string | null
  readonly runId: string | null
  readonly provider: string | null
  readonly launchAttemptId: string | null
  readonly approvedAt: number | null
  readonly allowedVerbs: readonly AppDriveControlVerb[]
  readonly expiresAt: number | null
  readonly stepBudget: number | null
  readonly stepsUsed: number | null
  readonly stepsRemaining: number | null
  readonly target: AppDriveSessionTargetDisclosure | null
  readonly pausedAt: number | null
  readonly takeoverAt: number | null
  readonly stoppedAt: number | null
  readonly stopReason: AppDriveStopReason | null
  readonly controls: AppDriveSessionControls
  readonly updatedAt: number
}

export interface AppDriveBindResult {
  readonly session: AppDriveSessionSnapshot
  /** Prior non-terminal session, if bind replaced it. */
  readonly replaced: AppDriveSessionSnapshot | null
}

/**
 * Fail-closed chrome admission for the CanvasWindowDriver gate.
 *
 * When `admitted` is true, session chrome allows an action attempt — the real
 * exact-run/window/secret/audit gates remain external prerequisites. When
 * false, integrators must refuse without falling back to foreground control.
 */
export type AppDriveAdmissionResult =
  | {
      readonly admitted: true
      readonly lifecycle: 'active'
      readonly code: null
      readonly message: null
      readonly sessionId: string
      readonly allowedVerbs: readonly AppDriveControlVerb[]
      readonly expiresAt: number
      readonly stepsRemaining: number
      readonly stopReason: null
      /** Chrome gate only — never sufficient control authority by itself. */
      readonly chromeOnly: true
      readonly requiresCoordinatorAuthority: true
    }
  | {
      readonly admitted: false
      readonly lifecycle: AppDriveSessionLifecycle
      readonly code: AppDriveSessionErrorCode
      readonly message: string
      readonly sessionId: string | null
      readonly allowedVerbs: readonly AppDriveControlVerb[]
      readonly expiresAt: number | null
      readonly stepsRemaining: number | null
      readonly stopReason: AppDriveStopReason | null
      readonly chromeOnly: true
      readonly requiresCoordinatorAuthority: true
    }

export interface AppDriveSessionOptions {
  readonly now?: () => number
  readonly createSessionId?: () => string
}

export class AppDriveSessionError extends Error {
  constructor(
    readonly code: AppDriveSessionErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'AppDriveSessionError'
  }
}

const EMPTY_VERBS: readonly AppDriveControlVerb[] = Object.freeze([])

const CONTROL_VERBS = new Set<AppDriveControlVerb>(['observe', 'inspect', 'click', 'fill'])

interface ActiveSession {
  session: AppDriveSessionSnapshot
}

/**
 * One-session-at-a-time lifecycle store for Foreground Drive chrome.
 * Process-local only: no disk persistence, no authority minting.
 */
export class AppDriveSession {
  private readonly now: () => number
  private readonly createSessionId: () => string
  private active: ActiveSession | null = null

  constructor(options: AppDriveSessionOptions = {}) {
    this.now = options.now ?? Date.now
    this.createSessionId = options.createSessionId ?? defaultSessionId
  }

  /**
   * Bind session chrome to an already-granted control projection.
   * Does not create a lease; rejects empty identity / non-user budget shapes.
   */
  bind(binding: AppDriveSessionBinding): AppDriveBindResult {
    const now = this.now()
    const candidate = normalizeBinding(binding, now)
    const sessionId = requiredString(this.createSessionId(), 'sessionId')
    const previous = this.active?.session ?? null

    const session = freezeSession({
      schemaVersion: APP_DRIVE_SESSION_SCHEMA_VERSION,
      sessionId,
      mode: 'foreground',
      permissionLabel: 'view-and-control',
      lifecycle: 'active',
      chatId: candidate.chatId,
      runId: candidate.runId,
      provider: candidate.provider,
      launchAttemptId: candidate.launchAttemptId,
      approvedAt: candidate.approvedAt,
      allowedVerbs: candidate.allowedVerbs,
      expiresAt: candidate.expiresAt,
      stepBudget: candidate.stepBudget,
      stepsUsed: candidate.stepsUsed,
      stepsRemaining: candidate.stepBudget - candidate.stepsUsed,
      target: candidate.target,
      pausedAt: null,
      takeoverAt: null,
      stoppedAt: null,
      stopReason: null,
      updatedAt: now
    })

    this.active = { session }

    const replaced =
      previous && previous.lifecycle !== 'stopped'
        ? freezeSession({
            ...previous,
            lifecycle: 'stopped',
            stoppedAt: now,
            stopReason: 'replaced',
            updatedAt: now,
            pausedAt: previous.pausedAt,
            takeoverAt: previous.takeoverAt
          })
        : null

    return Object.freeze({ session, replaced })
  }

  /**
   * Mirror budget/expiry updates from the real lease without owning them.
   * Identity fields must still match the bound session.
   */
  mirrorControlBudget(
    update: Pick<
      AppDriveSessionBinding,
      'chatId' | 'runId' | 'launchAttemptId' | 'expiresAt' | 'stepBudget' | 'stepsUsed'
    > & { readonly allowedVerbs?: readonly AppDriveControlVerb[] }
  ): AppDriveSessionSnapshot {
    const current = this.requireLiveSession()
    assertBindingIdentity(current, update)
    const now = this.now()
    if (current.expiresAt <= now || update.expiresAt <= now) {
      return this.markExpired(current, now)
    }

    const stepBudget = nonNegativeInteger(update.stepBudget, 'stepBudget')
    const stepsUsed = nonNegativeInteger(update.stepsUsed, 'stepsUsed')
    if (stepsUsed > stepBudget) {
      fail('invalid-input', 'stepsUsed cannot exceed stepBudget.')
    }
    const allowedVerbs =
      update.allowedVerbs !== undefined
        ? normalizeAllowedVerbs(update.allowedVerbs)
        : current.allowedVerbs

    const session = freezeSession({
      ...current,
      allowedVerbs,
      expiresAt: finiteNumber(update.expiresAt, 'expiresAt'),
      stepBudget,
      stepsUsed,
      stepsRemaining: stepBudget - stepsUsed,
      updatedAt: now
    })
    this.active = { session }
    return session
  }

  pause(): AppDriveSessionSnapshot {
    const current = this.requireLiveSession()
    this.expireIfNeeded(current)
    const live = this.requireLiveSession()
    if (live.lifecycle === 'paused') return live
    if (live.lifecycle === 'takeover') {
      fail('invalid-transition', 'A takeover session is already human-held; pause is redundant.')
    }
    if (live.lifecycle !== 'active') {
      fail('invalid-transition', 'Only an active Foreground Drive session can be paused.')
    }
    const now = this.now()
    const session = freezeSession({
      ...live,
      lifecycle: 'paused',
      pausedAt: now,
      updatedAt: now
    })
    this.active = { session }
    return session
  }

  /**
   * Resume agent-driving chrome after pause or explicit takeover.
   * Does not re-mint authority — the mirrored control binding stays unchanged.
   */
  resume(): AppDriveSessionSnapshot {
    const current = this.requireLiveSession()
    this.expireIfNeeded(current)
    const live = this.requireLiveSession()
    if (live.lifecycle === 'active') return live
    if (live.lifecycle !== 'paused' && live.lifecycle !== 'takeover') {
      fail('invalid-transition', 'Only a paused or takeover Foreground Drive session can resume.')
    }
    const now = this.now()
    const session = freezeSession({
      ...live,
      lifecycle: 'active',
      pausedAt: null,
      takeoverAt: null,
      updatedAt: now
    })
    this.active = { session }
    return session
  }

  takeOver(): AppDriveSessionSnapshot {
    const current = this.requireLiveSession()
    this.expireIfNeeded(current)
    const live = this.requireLiveSession()
    if (live.lifecycle === 'takeover') return live
    if (live.lifecycle !== 'active' && live.lifecycle !== 'paused') {
      fail(
        'invalid-transition',
        'Only an active or paused Foreground Drive session can enter takeover.'
      )
    }
    const now = this.now()
    const session = freezeSession({
      ...live,
      lifecycle: 'takeover',
      takeoverAt: now,
      updatedAt: now
    })
    this.active = { session }
    return session
  }

  /**
   * Stop session **chrome only**.
   *
   * This does **not** revoke the underlying NativeWindowCoordinator control
   * lease, process ownership, consent epoch, or exact-run window binding.
   * Integrators MUST call the coordinator revoke/detach path separately after
   * `stop()` (or in the same user gesture). Stop alone is insufficient to end
   * real control authority.
   */
  stop(reason: AppDriveStopReason = 'user-stop'): AppDriveSessionSnapshot | null {
    if (!this.active) return null
    const current = this.active.session
    if (current.lifecycle === 'stopped') return current
    const now = this.now()
    const session = freezeSession({
      ...current,
      lifecycle: 'stopped',
      stoppedAt: now,
      stopReason: reason,
      updatedAt: now
    })
    this.active = { session }
    return session
  }

  /**
   * Clear a stopped or absent session so status returns idle. Live sessions
   * must be stopped first (or use stop()). Still does not revoke coordinator
   * authority — that remains an external integrator duty.
   */
  clearStopped(): void {
    if (!this.active) return
    if (this.active.session.lifecycle !== 'stopped') {
      fail('invalid-transition', 'Clear only a stopped Foreground Drive session.')
    }
    this.active = null
  }

  /**
   * Gate for integrators before admitting any new drive action.
   * Paused, takeover, stopped, idle, and expired sessions all refuse.
   */
  canAdmitActions(): boolean {
    return this.evaluateAdmission().admitted
  }

  /**
   * Fail-closed admission result for the CanvasWindowDriver gate.
   * Never throws for lifecycle refusal; only throws for unknown verb shapes
   * when callers pass a verb that is not in the control catalogue at all.
   * Prefer this over boolean-only checks when the driver needs a typed code
   * (especially `session-expired` vs `session-stopped`).
   */
  evaluateAdmission(verb?: AppDriveControlVerb): AppDriveAdmissionResult {
    if (verb !== undefined && !CONTROL_VERBS.has(verb)) {
      fail('invalid-input', `Unknown App Drive verb: ${String(verb)}`)
    }

    if (!this.active) {
      return denyAdmission({
        lifecycle: 'idle',
        code: 'no-active-session',
        message: 'No Foreground Drive session is bound.',
        sessionId: null,
        allowedVerbs: EMPTY_VERBS,
        expiresAt: null,
        stepsRemaining: null,
        stopReason: null
      })
    }

    const session = this.active.session
    const now = this.now()

    // Prefer session-expired when already projected or about to project.
    if (session.lifecycle === 'stopped' && session.stopReason === 'expired') {
      return denyAdmission({
        lifecycle: 'stopped',
        code: 'session-expired',
        message: 'Foreground Drive session binding expired; new actions are refused.',
        sessionId: session.sessionId,
        allowedVerbs: session.allowedVerbs,
        expiresAt: session.expiresAt,
        stepsRemaining: session.stepsRemaining,
        stopReason: 'expired'
      })
    }

    if (session.lifecycle === 'stopped') {
      return denyAdmission({
        lifecycle: 'stopped',
        code: 'session-stopped',
        message: 'Foreground Drive session is stopped; new actions are refused.',
        sessionId: session.sessionId,
        allowedVerbs: session.allowedVerbs,
        expiresAt: session.expiresAt,
        stepsRemaining: session.stepsRemaining,
        stopReason: session.stopReason
      })
    }

    if (session.expiresAt <= now) {
      const expired = this.markExpired(session, now)
      return denyAdmission({
        lifecycle: 'stopped',
        code: 'session-expired',
        message: 'Foreground Drive session binding expired; new actions are refused.',
        sessionId: expired.sessionId,
        allowedVerbs: expired.allowedVerbs,
        expiresAt: expired.expiresAt,
        stepsRemaining: expired.stepsRemaining,
        stopReason: 'expired'
      })
    }

    if (session.lifecycle === 'paused') {
      return denyAdmission({
        lifecycle: 'paused',
        code: 'session-paused',
        message: 'Foreground Drive session is paused; new actions are refused.',
        sessionId: session.sessionId,
        allowedVerbs: session.allowedVerbs,
        expiresAt: session.expiresAt,
        stepsRemaining: session.stepsRemaining,
        stopReason: null
      })
    }

    if (session.lifecycle === 'takeover') {
      return denyAdmission({
        lifecycle: 'takeover',
        code: 'session-takeover',
        message: 'User has taken over; agent actions are refused until resume.',
        sessionId: session.sessionId,
        allowedVerbs: session.allowedVerbs,
        expiresAt: session.expiresAt,
        stepsRemaining: session.stepsRemaining,
        stopReason: null
      })
    }

    if (session.lifecycle !== 'active') {
      return denyAdmission({
        lifecycle: session.lifecycle,
        code: 'session-not-active',
        message: 'Foreground Drive session is not active; new actions are refused.',
        sessionId: session.sessionId,
        allowedVerbs: session.allowedVerbs,
        expiresAt: session.expiresAt,
        stepsRemaining: session.stepsRemaining,
        stopReason: session.stopReason
      })
    }

    if (session.stepsRemaining <= 0) {
      return denyAdmission({
        lifecycle: 'active',
        code: 'step-budget-exhausted',
        message: 'Foreground Drive step budget is exhausted; new actions are refused.',
        sessionId: session.sessionId,
        allowedVerbs: session.allowedVerbs,
        expiresAt: session.expiresAt,
        stepsRemaining: session.stepsRemaining,
        stopReason: null
      })
    }

    if (verb !== undefined && !session.allowedVerbs.includes(verb)) {
      return denyAdmission({
        lifecycle: 'active',
        code: 'invalid-input',
        message: `Verb "${verb}" is not in the bound allowedVerbs set.`,
        sessionId: session.sessionId,
        allowedVerbs: session.allowedVerbs,
        expiresAt: session.expiresAt,
        stepsRemaining: session.stepsRemaining,
        stopReason: null
      })
    }

    return Object.freeze({
      admitted: true as const,
      lifecycle: 'active' as const,
      code: null,
      message: null,
      sessionId: session.sessionId,
      allowedVerbs: session.allowedVerbs,
      expiresAt: session.expiresAt,
      stepsRemaining: session.stepsRemaining,
      stopReason: null,
      chromeOnly: true as const,
      requiresCoordinatorAuthority: true as const
    })
  }

  assertCanAdmitActions(verb?: AppDriveControlVerb): void {
    const result = this.evaluateAdmission(verb)
    if (!result.admitted) {
      fail(result.code, result.message)
    }
  }

  getSnapshot(): AppDriveSessionSnapshot | null {
    if (!this.active) return null
    this.expireIfNeeded(this.active.session)
    return this.active?.session ?? null
  }

  status(): AppDriveSessionRendererStatus {
    if (this.active) {
      this.expireIfNeeded(this.active.session)
    }
    const session = this.active?.session ?? null
    if (!session) {
      return idleRendererStatus(this.now())
    }
    if (session.lifecycle === 'stopped') {
      // Keep terminal state visible until clearStopped; never admit actions.
      return rendererStatusFromSession(session, false)
    }
    const canAdmit =
      session.lifecycle === 'active' && session.expiresAt > this.now() && session.stepsRemaining > 0
    return rendererStatusFromSession(session, canAdmit)
  }

  private requireLiveSession(): AppDriveSessionSnapshot {
    if (!this.active) {
      fail('no-active-session', 'No Foreground Drive session is bound.')
    }
    if (this.active.session.lifecycle === 'stopped') {
      fail('session-stopped', 'Foreground Drive session is stopped.')
    }
    return this.active.session
  }

  private expireIfNeeded(session: AppDriveSessionSnapshot): void {
    if (session.lifecycle === 'stopped') return
    if (session.expiresAt > this.now()) return
    this.markExpired(session, this.now())
  }

  private markExpired(session: AppDriveSessionSnapshot, now: number): AppDriveSessionSnapshot {
    if (session.lifecycle === 'stopped' && session.stopReason === 'expired') {
      return session
    }
    const next = freezeSession({
      ...session,
      lifecycle: 'stopped',
      stoppedAt: now,
      stopReason: 'expired',
      updatedAt: now
    })
    this.active = { session: next }
    return next
  }
}

function denyAdmission(input: {
  lifecycle: AppDriveSessionLifecycle
  code: AppDriveSessionErrorCode
  message: string
  sessionId: string | null
  allowedVerbs: readonly AppDriveControlVerb[]
  expiresAt: number | null
  stepsRemaining: number | null
  stopReason: AppDriveStopReason | null
}): AppDriveAdmissionResult {
  return Object.freeze({
    admitted: false as const,
    lifecycle: input.lifecycle,
    code: input.code,
    message: input.message,
    sessionId: input.sessionId,
    allowedVerbs: input.allowedVerbs,
    expiresAt: input.expiresAt,
    stepsRemaining: input.stepsRemaining,
    stopReason: input.stopReason,
    chromeOnly: true as const,
    requiresCoordinatorAuthority: true as const
  })
}

function idleRendererStatus(updatedAt: number): AppDriveSessionRendererStatus {
  return Object.freeze({
    schemaVersion: APP_DRIVE_SESSION_SCHEMA_VERSION,
    sessionId: null,
    mode: null,
    modeLabel: null,
    permissionLabel: null,
    lifecycle: 'idle',
    canAdmitActions: false,
    chatId: null,
    runId: null,
    provider: null,
    launchAttemptId: null,
    approvedAt: null,
    allowedVerbs: EMPTY_VERBS,
    expiresAt: null,
    stepBudget: null,
    stepsUsed: null,
    stepsRemaining: null,
    target: null,
    pausedAt: null,
    takeoverAt: null,
    stoppedAt: null,
    stopReason: null,
    controls: Object.freeze({
      canPause: false,
      canResume: false,
      canTakeOver: false,
      canStop: false
    }),
    updatedAt
  })
}

function rendererStatusFromSession(
  session: AppDriveSessionSnapshot,
  canAdmitActions: boolean
): AppDriveSessionRendererStatus {
  const lifecycle = session.lifecycle
  return Object.freeze({
    schemaVersion: APP_DRIVE_SESSION_SCHEMA_VERSION,
    sessionId: session.sessionId,
    mode: 'foreground',
    modeLabel: 'Foreground Drive',
    permissionLabel: 'View & Control',
    lifecycle,
    canAdmitActions,
    chatId: session.chatId,
    runId: session.runId,
    provider: session.provider,
    launchAttemptId: session.launchAttemptId,
    approvedAt: session.approvedAt,
    allowedVerbs: session.allowedVerbs,
    expiresAt: session.expiresAt,
    stepBudget: session.stepBudget,
    stepsUsed: session.stepsUsed,
    stepsRemaining: session.stepsRemaining,
    target: session.target,
    pausedAt: session.pausedAt,
    takeoverAt: session.takeoverAt,
    stoppedAt: session.stoppedAt,
    stopReason: session.stopReason,
    controls: Object.freeze({
      canPause: lifecycle === 'active',
      canResume: lifecycle === 'paused' || lifecycle === 'takeover',
      canTakeOver: lifecycle === 'active' || lifecycle === 'paused',
      canStop: lifecycle === 'active' || lifecycle === 'paused' || lifecycle === 'takeover'
    }),
    updatedAt: session.updatedAt
  })
}

function normalizeBinding(
  binding: AppDriveSessionBinding,
  now: number
): {
  chatId: string
  runId: string
  provider: string
  launchAttemptId: string
  approvedAt: number
  allowedVerbs: readonly AppDriveControlVerb[]
  expiresAt: number
  stepBudget: number
  stepsUsed: number
  target: AppDriveSessionTargetDisclosure | null
} {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    fail('invalid-input', 'App Drive session binding must be an object.')
  }
  const expiresAt = finiteNumber(binding.expiresAt, 'expiresAt')
  if (expiresAt <= now) {
    fail('invalid-input', 'App Drive session binding expiry must be in the future.')
  }
  const approvedAt = nonNegativeInteger(binding.approvedAt, 'approvedAt')
  if (approvedAt > now) {
    fail('invalid-input', 'App Drive approval cannot be in the future.')
  }
  const stepBudget = nonNegativeInteger(binding.stepBudget, 'stepBudget')
  const stepsUsed = nonNegativeInteger(binding.stepsUsed, 'stepsUsed')
  if (stepsUsed > stepBudget) {
    fail('invalid-input', 'stepsUsed cannot exceed stepBudget.')
  }
  return {
    chatId: requiredString(binding.chatId, 'chatId'),
    runId: requiredString(binding.runId, 'runId'),
    provider: requiredString(binding.provider, 'provider'),
    launchAttemptId: requiredString(binding.launchAttemptId, 'launchAttemptId'),
    approvedAt,
    allowedVerbs: normalizeAllowedVerbs(binding.allowedVerbs),
    expiresAt,
    stepBudget,
    stepsUsed,
    target: normalizeTarget(binding.target)
  }
}

function normalizeTarget(
  target: AppDriveSessionBinding['target']
): AppDriveSessionTargetDisclosure | null {
  if (target == null) return null
  if (typeof target !== 'object' || Array.isArray(target)) {
    fail('invalid-input', 'App Drive target disclosure must be an object or null.')
  }
  return Object.freeze({
    applicationName: optionalDisclosure(target.applicationName),
    windowTitle: optionalDisclosure(target.windowTitle),
    bundleID: optionalDisclosure(target.bundleID)
  })
}

function normalizeAllowedVerbs(
  verbs: readonly AppDriveControlVerb[]
): readonly AppDriveControlVerb[] {
  if (!Array.isArray(verbs) || verbs.length === 0) {
    fail('invalid-input', 'allowedVerbs must be a non-empty array.')
  }
  const out: AppDriveControlVerb[] = []
  const seen = new Set<string>()
  for (const verb of verbs) {
    if (!CONTROL_VERBS.has(verb as AppDriveControlVerb)) {
      fail('invalid-input', `Unknown App Drive verb: ${String(verb)}`)
    }
    if (seen.has(verb)) continue
    seen.add(verb)
    out.push(verb as AppDriveControlVerb)
  }
  return Object.freeze(out)
}

function assertBindingIdentity(
  session: AppDriveSessionSnapshot,
  update: Pick<AppDriveSessionBinding, 'chatId' | 'runId' | 'launchAttemptId'>
): void {
  if (
    requiredString(update.chatId, 'chatId') !== session.chatId ||
    requiredString(update.runId, 'runId') !== session.runId ||
    requiredString(update.launchAttemptId, 'launchAttemptId') !== session.launchAttemptId
  ) {
    fail(
      'binding-mismatch',
      'Control budget mirror must match the bound chat/run/launchAttempt identity.'
    )
  }
}

function freezeSession(session: AppDriveSessionSnapshot): AppDriveSessionSnapshot {
  return Object.freeze({
    ...session,
    allowedVerbs: Object.freeze([...session.allowedVerbs]),
    target: session.target ? Object.freeze({ ...session.target }) : null
  })
}

function defaultSessionId(): string {
  return `appdrive-session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    fail('invalid-input', `${field} is required.`)
  }
  return value.trim()
}

function optionalDisclosure(value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== 'string') {
    fail('invalid-input', 'Target disclosure fields must be strings or null.')
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('invalid-input', `${field} must be a finite number.`)
  }
  return value
}

function nonNegativeInteger(value: unknown, field: string): number {
  const n = finiteNumber(value, field)
  if (!Number.isInteger(n) || n < 0) {
    fail('invalid-input', `${field} must be a non-negative integer.`)
  }
  return n
}

function fail(code: AppDriveSessionErrorCode, message: string): never {
  throw new AppDriveSessionError(code, message)
}
