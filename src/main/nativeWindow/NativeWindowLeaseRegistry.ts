import { randomUUID } from 'node:crypto'

/**
 * Process-local authority for one user-consented native application window.
 *
 * This registry deliberately knows nothing about Electron, ScreenCaptureKit, or
 * Accessibility. The attachment manager owns those effects and uses this class
 * as its synchronous authorization boundary:
 *
 * 1. After an in-app consent sheet and the system picker succeed, main validates
 *    the selected PID against the active LaunchAttempt and calls
 *    `grantOrReplace`.
 * 2. Before every capture or native-control bridge call, the executor calls
 *    `resolveForExecutor` (or `consumeControlStep` for an actuation). The
 *    final permitted control action leaves already-approved read authority live
 *    so the caller can observe and verify its effect.
 * 3. Every terminal Run/LaunchAttempt event calls the matching revoke method and
 *    detaches the returned `windowHandleId` in a `finally` block.
 *
 * The renderer receives only `NativeWindowLeaseRendererProjection`; it must
 * never receive `windowHandleId`, `consentEpoch`, or `instanceEpoch`.
 */

export const NATIVE_WINDOW_LEASE_SCHEMA_VERSION = 1 as const

export type NativeWindowLeaseVerb = 'observe' | 'inspect' | 'click' | 'fill'
export type NativeWindowLeaseReadVerb = Extract<NativeWindowLeaseVerb, 'observe' | 'inspect'>
export type NativeWindowLeaseControlVerb = Extract<NativeWindowLeaseVerb, 'click' | 'fill'>

export type NativeWindowLeaseRevocationReason =
  | 'chat-changed'
  | 'daemon-stopped'
  | 'expired'
  | 'instance-restarted'
  | 'launch-terminal'
  | 'ownership-invalid'
  | 'replaced'
  | 'run-terminal'
  | 'step-budget-exhausted'
  | 'system-permission-lost'
  | 'user-control-stopped'
  | 'user-detached'

export type NativeWindowLeaseErrorCode =
  | 'async-ownership-validator'
  | 'consent-replay'
  | 'instance-epoch-mismatch'
  | 'invalid-input'
  | 'lease-id-replay'
  | 'lease-expired'
  | 'no-active-lease'
  | 'owner-mismatch'
  | 'ownership-validation-failed'
  | 'reentrant-validation'
  | 'stale-consent-generation'
  | 'step-budget-exhausted'
  | 'verb-not-allowed'

export class NativeWindowLeaseError extends Error {
  constructor(
    readonly code: NativeWindowLeaseErrorCode,
    message: string,
    readonly revocation?: NativeWindowLeaseRevocation
  ) {
    super(message)
    this.name = 'NativeWindowLeaseError'
  }
}

/**
 * Local copy of the ownership vocabulary. The pure ownership gate keeps its own
 * lease projection for the same reason: neither module may import the other.
 */
export type NativeWindowLeaseOwnershipKind = 'exact' | 'descendant'

export interface NativeWindowLeaseGrantInput {
  /** Main-owned process epoch. A lease never crosses an app restart. */
  instanceEpoch: string
  chatId: string
  runId: string
  /** Null means the lease is intentionally not provider-bound. */
  provider?: string | null
  /** Null means this is a solo run rather than an Ensemble participant. */
  participantId?: string | null
  launchAttemptId: string
  /** PID recorded on the active LaunchAttempt. */
  expectedPid: number
  /** PID of the exact window process selected through ScreenCaptureKit. */
  selectedPid: number
  /**
   * How the selected process earned the launch's authority. Defaults to
   * `exact`, which keeps the equality rule; `descendant` is only legitimate
   * once a verified ancestry chain has been checked by the ownership gate.
   */
  ownership?: NativeWindowLeaseOwnershipKind
  /** Start identity of the selected process; closes PID-reuse ambiguity. */
  selectedProcessStartedAt: string
  /** ScreenCaptureKit window id, bound alongside the opaque daemon handle. */
  windowId: number
  /** Opaque daemon handle. Main-only; never project it through preload. */
  windowHandleId: string
  /** Fresh value minted by the user-consent flow, never an agent tool call. */
  consentEpoch: string
  /** Monotonic, process-local picker/consent generation. */
  consentGeneration: number
  /** Absolute epoch milliseconds. */
  expiresAt: number
  /** Timestamp at which the human approved this exact attachment/control scope. */
  approvedAt: number
  /** Native-window consent is always a human approval, never an agent grant. */
  approvedBy: 'user'
  /** Exact capabilities selected by the human; no ambient native-window verbs. */
  allowedVerbs: readonly NativeWindowLeaseVerb[]
  /** Maximum native-control actions. Observation does not consume this budget. */
  stepBudget: number
}

export interface NativeWindowLeaseExecutorContext {
  instanceEpoch: string
  chatId: string
  runId: string
  provider?: string | null
  participantId?: string | null
}

export interface NativeWindowLeaseSnapshot {
  readonly schemaVersion: typeof NATIVE_WINDOW_LEASE_SCHEMA_VERSION
  readonly leaseId: string
  readonly instanceEpoch: string
  readonly chatId: string
  readonly runId: string
  readonly provider: string | null
  readonly participantId: string | null
  readonly launchAttemptId: string
  readonly expectedPid: number
  readonly selectedPid: number
  readonly ownership: NativeWindowLeaseOwnershipKind
  readonly selectedProcessStartedAt: string
  readonly windowId: number
  readonly windowHandleId: string
  readonly consentEpoch: string
  readonly consentGeneration: number
  readonly grantedAt: number
  readonly expiresAt: number
  readonly approvedAt: number
  readonly approvedBy: 'user'
  readonly allowedVerbs: readonly NativeWindowLeaseVerb[]
  readonly stepBudget: number
  readonly stepsUsed: number
}

/** Safe to send over preload/status IPC. Omits the handle and both private epochs. */
export interface NativeWindowLeaseRendererProjection {
  readonly schemaVersion: typeof NATIVE_WINDOW_LEASE_SCHEMA_VERSION
  /** Opaque version used only to make a stale Detach click harmless. */
  readonly leaseId: string
  readonly chatId: string
  readonly runId: string
  readonly provider: string | null
  readonly participantId: string | null
  readonly launchAttemptId: string
  readonly expectedPid: number
  readonly windowId: number
  readonly consentGeneration: number
  readonly approvedAt: number
  readonly approvedBy: 'user'
  readonly trustState: 'user-approved'
  readonly allowedVerbs: readonly NativeWindowLeaseVerb[]
  readonly expiresAt: number
  readonly stepBudget: number
  readonly stepsUsed: number
  readonly stepsRemaining: number
}

export interface NativeWindowLeaseRevocation {
  readonly lease: NativeWindowLeaseSnapshot
  readonly reason: NativeWindowLeaseRevocationReason
  readonly revokedAt: number
}

export interface NativeWindowLeaseGrantResult {
  readonly lease: NativeWindowLeaseSnapshot
  /** Main must detach this old handle after it has cleared any related UI state. */
  readonly replaced: NativeWindowLeaseRevocation | null
}

export interface NativeWindowLeaseStepGrant {
  /** Main-only snapshot to use for the one control bridge call. */
  readonly lease: NativeWindowLeaseSnapshot
  /** Zero denies later control actions but still permits approved read verbs. */
  readonly stepsRemaining: number
}

export interface NativeWindowLeaseStatus {
  /** Safe renderer projection for the current active lease. */
  readonly lease: NativeWindowLeaseRendererProjection | null
  /** Main-only cleanup work produced by an expiry sweep. */
  readonly expired: NativeWindowLeaseRevocation | null
}

/**
 * Must perform a current, main-owned LaunchAttempt/process identity check,
 * including exact selected PID and process-start identity. Return literal
 * `true` only; truthy values and async validators fail closed.
 */
export type NativeWindowLeaseOwnershipValidator = (lease: NativeWindowLeaseSnapshot) => true

export interface NativeWindowLeaseRegistryOptions {
  instanceEpoch: string
  validateOwnership: NativeWindowLeaseOwnershipValidator
  now?: () => number
  createLeaseId?: () => string
}

interface ActiveLease {
  lease: NativeWindowLeaseSnapshot
}

const EMPTY_OPTIONAL_OWNER = null

/**
 * One-active-lease registry. A replacement is an atomic state transition: the
 * old lease is no longer authorizable before the caller receives its detach
 * receipt, so a stale picker completion or renderer click cannot keep it alive.
 */
export class NativeWindowLeaseRegistry {
  private readonly instanceEpoch: string
  private readonly validateOwnership: NativeWindowLeaseOwnershipValidator
  private readonly now: () => number
  private readonly createLeaseId: () => string
  private active: ActiveLease | null = null
  private highestConsentGeneration = -1
  private readonly consumedConsentEpochs = new Set<string>()
  private readonly issuedLeaseIds = new Set<string>()
  private validationActive = false

  constructor(options: NativeWindowLeaseRegistryOptions) {
    if (!options || typeof options !== 'object') {
      fail('invalid-input', 'Native window lease options are required.')
    }
    this.instanceEpoch = requiredString(options.instanceEpoch, 'instanceEpoch')
    if (typeof options.validateOwnership !== 'function') {
      fail('invalid-input', 'A synchronous native-window ownership validator is required.')
    }
    this.validateOwnership = options.validateOwnership
    this.now = options.now ?? Date.now
    this.createLeaseId = options.createLeaseId ?? defaultLeaseId
  }

  /**
   * Creates the only active lease after a human-picked window has passed live
   * LaunchAttempt ownership validation. A stale consent completion is rejected
   * without disturbing the currently active lease.
   */
  grantOrReplace(input: NativeWindowLeaseGrantInput): NativeWindowLeaseGrantResult {
    this.assertNotValidating()
    const candidate = snapshotGrantInput(input, this.now())
    if (candidate.instanceEpoch !== this.instanceEpoch) {
      fail('instance-epoch-mismatch', 'Native window consent belongs to a different app instance.')
    }
    if (candidate.consentGeneration <= this.highestConsentGeneration) {
      fail(
        'stale-consent-generation',
        'Native window consent is older than the current consent generation.'
      )
    }
    if (this.consumedConsentEpochs.has(candidate.consentEpoch)) {
      fail('consent-replay', 'Native window consent has already been consumed.')
    }

    const leaseId = requiredString(this.createLeaseId(), 'leaseId')
    if (this.issuedLeaseIds.has(leaseId)) {
      fail('lease-id-replay', 'Native window lease id must be fresh.')
    }
    const lease = freezeLease({ ...candidate, leaseId })
    this.assertLiveOwnership(lease)
    const previous = this.active
    this.active = { lease }
    this.highestConsentGeneration = candidate.consentGeneration
    this.consumedConsentEpochs.add(candidate.consentEpoch)
    this.issuedLeaseIds.add(leaseId)

    return Object.freeze({
      lease,
      replaced: previous ? revocationFor(previous.lease, 'replaced', this.now()) : null
    })
  }

  /**
   * Check a capture/read request. This does not consume a native-control step.
   * The returned snapshot stays main-only because it contains the daemon handle.
   */
  resolveForExecutor(
    context: NativeWindowLeaseExecutorContext,
    verb: NativeWindowLeaseReadVerb = 'observe'
  ): NativeWindowLeaseSnapshot {
    this.assertNotValidating()
    assertReadVerb(verb)
    return this.requireAuthorizedExecutorLease(context, verb).lease
  }

  /**
   * Claim exactly one native-control step before a bridge action. The final
   * allowed action leaves the lease active for post-action observation. A later
   * control attempt revokes the exhausted lease and returns its cleanup receipt.
   */
  consumeControlStep(
    context: NativeWindowLeaseExecutorContext,
    verb: NativeWindowLeaseControlVerb
  ): NativeWindowLeaseStepGrant {
    this.assertNotValidating()
    assertControlVerb(verb)
    const active = this.requireAuthorizedExecutorLease(context, verb)
    if (active.lease.stepsUsed >= active.lease.stepBudget) {
      const revocation = this.revokeActiveInternal('step-budget-exhausted')
      fail('step-budget-exhausted', 'Native window control step budget is exhausted.', revocation)
    }

    const lease = freezeLease({ ...active.lease, stepsUsed: active.lease.stepsUsed + 1 })
    this.active = { lease }
    const stepsRemaining = lease.stepBudget - lease.stepsUsed
    return Object.freeze({ lease, stepsRemaining })
  }

  /**
   * Renderer/user detach must carry the projection's current lease id. A stale
   * click returns null rather than revoking a newer picker selection.
   */
  revokeExact(
    leaseId: string,
    reason: NativeWindowLeaseRevocationReason = 'user-detached'
  ): NativeWindowLeaseRevocation | null {
    this.assertNotValidating()
    if (typeof leaseId !== 'string' || !leaseId.trim()) return null
    if (this.active?.lease.leaseId !== leaseId) return null
    return this.revokeActiveInternal(reason)
  }

  /** Run terminal events must include both stable owner values. */
  revokeForRun(
    owner: Pick<NativeWindowLeaseExecutorContext, 'chatId' | 'runId'>,
    reason: NativeWindowLeaseRevocationReason = 'run-terminal'
  ): NativeWindowLeaseRevocation | null {
    this.assertNotValidating()
    const chatId = requiredString(owner?.chatId, 'chatId')
    const runId = requiredString(owner?.runId, 'runId')
    if (!this.active || this.active.lease.chatId !== chatId || this.active.lease.runId !== runId) {
      return null
    }
    return this.revokeActiveInternal(reason)
  }

  /** Launch terminal events revoke only the exact attempt they own. */
  revokeForLaunchAttempt(
    launchAttemptId: string,
    reason: NativeWindowLeaseRevocationReason = 'launch-terminal'
  ): NativeWindowLeaseRevocation | null {
    this.assertNotValidating()
    const attemptId = requiredString(launchAttemptId, 'launchAttemptId')
    if (!this.active || this.active.lease.launchAttemptId !== attemptId) return null
    return this.revokeActiveInternal(reason)
  }

  /** Trusted lifecycle paths such as daemon shutdown may revoke the current lease. */
  revokeActive(reason: NativeWindowLeaseRevocationReason): NativeWindowLeaseRevocation | null {
    this.assertNotValidating()
    return this.revokeActiveInternal(reason)
  }

  /**
   * Main should call this from the expiry timer and immediately before emitting
   * status. If non-null, it must detach the returned daemon handle.
   */
  sweepExpired(): NativeWindowLeaseRevocation | null {
    this.assertNotValidating()
    return this.expireActiveIfNeeded()
  }

  /**
   * Status is intentionally split: only `lease` may cross preload. Main keeps
   * `expired` so it can release the daemon resource before publishing null.
   */
  status(): NativeWindowLeaseStatus {
    this.assertNotValidating()
    const expired = this.expireActiveIfNeeded()
    return Object.freeze({
      lease: this.active ? rendererProjection(this.active.lease) : null,
      expired
    })
  }

  private requireAuthorizedExecutorLease(
    context: NativeWindowLeaseExecutorContext,
    verb: NativeWindowLeaseVerb
  ): ActiveLease {
    const expired = this.expireActiveIfNeeded()
    if (expired) {
      fail('lease-expired', 'Native window lease expired.', expired)
    }
    const active = this.active
    if (!active) fail('no-active-lease', 'No active native window lease exists.')
    assertExecutorContextMatches(active.lease, context, this.instanceEpoch)
    assertVerbAllowed(active.lease, verb)
    this.assertLiveOwnership(active.lease)
    return active
  }

  private assertLiveOwnership(lease: NativeWindowLeaseSnapshot): void {
    this.validationActive = true
    let result: unknown
    try {
      result = this.validateOwnership(lease)
    } catch {
      this.validationActive = false
      const revocation = this.revokeIfCurrentInternal(lease.leaseId, 'ownership-invalid')
      fail(
        'ownership-validation-failed',
        'Native window ownership could not be verified.',
        revocation
      )
    }
    this.validationActive = false
    if (isThenable(result)) {
      const revocation = this.revokeIfCurrentInternal(lease.leaseId, 'ownership-invalid')
      fail(
        'async-ownership-validator',
        'Native window ownership validation must be synchronous.',
        revocation
      )
    }
    if (result !== true) {
      const revocation = this.revokeIfCurrentInternal(lease.leaseId, 'ownership-invalid')
      fail(
        'ownership-validation-failed',
        'Native window ownership could not be verified.',
        revocation
      )
    }
  }

  private expireActiveIfNeeded(): NativeWindowLeaseRevocation | null {
    if (!this.active || this.active.lease.expiresAt > this.now()) return null
    return this.revokeActiveInternal('expired')
  }

  private revokeIfCurrentInternal(
    leaseId: string,
    reason: NativeWindowLeaseRevocationReason
  ): NativeWindowLeaseRevocation | null {
    if (this.active?.lease.leaseId !== leaseId) return null
    return this.revokeActiveInternal(reason)
  }

  private revokeActiveInternal(
    reason: NativeWindowLeaseRevocationReason
  ): NativeWindowLeaseRevocation | null {
    const active = this.active
    if (!active) return null
    this.active = null
    return revocationFor(active.lease, reason, this.now())
  }

  private assertNotValidating(): void {
    if (this.validationActive) {
      fail(
        'reentrant-validation',
        'Native window lease operations cannot re-enter ownership validation.'
      )
    }
  }
}

export function rendererProjection(
  lease: NativeWindowLeaseSnapshot
): NativeWindowLeaseRendererProjection {
  return Object.freeze({
    schemaVersion: NATIVE_WINDOW_LEASE_SCHEMA_VERSION,
    leaseId: lease.leaseId,
    chatId: lease.chatId,
    runId: lease.runId,
    provider: lease.provider,
    participantId: lease.participantId,
    launchAttemptId: lease.launchAttemptId,
    expectedPid: lease.expectedPid,
    windowId: lease.windowId,
    consentGeneration: lease.consentGeneration,
    approvedAt: lease.approvedAt,
    approvedBy: lease.approvedBy,
    trustState: 'user-approved',
    allowedVerbs: Object.freeze([...lease.allowedVerbs]),
    expiresAt: lease.expiresAt,
    stepBudget: lease.stepBudget,
    stepsUsed: lease.stepsUsed,
    stepsRemaining: lease.stepBudget - lease.stepsUsed
  })
}

function snapshotGrantInput(input: NativeWindowLeaseGrantInput, grantedAt: number) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('invalid-input', 'Native window lease input must be an object.')
  }
  const expiresAt = finiteNumber(input.expiresAt, 'expiresAt')
  if (expiresAt <= grantedAt) {
    fail('invalid-input', 'Native window lease expiry must be in the future.')
  }
  const approvedAt = nonNegativeInteger(input.approvedAt, 'approvedAt')
  if (approvedAt > grantedAt) {
    fail('invalid-input', 'Native window approval cannot be in the future.')
  }
  if (input.approvedBy !== 'user') {
    fail('invalid-input', 'Native window approval must come from the user.')
  }
  const expectedPid = positiveInteger(input.expectedPid, 'expectedPid')
  const selectedPid = positiveInteger(input.selectedPid, 'selectedPid')
  const ownership = input.ownership ?? 'exact'
  if (ownership !== 'exact' && ownership !== 'descendant') {
    fail('invalid-input', 'Native window lease ownership must be exact or descendant.')
  }
  if (ownership === 'exact' && selectedPid !== expectedPid) {
    fail('invalid-input', 'selectedPid must exactly match expectedPid for native control.')
  }
  // A descendant lease that names the launch process is a mislabelled exact
  // match, and would otherwise be a way to skip the equality rule entirely.
  if (ownership === 'descendant' && selectedPid === expectedPid) {
    fail('invalid-input', 'A descendant lease must name a different process than the launch.')
  }
  return {
    schemaVersion: NATIVE_WINDOW_LEASE_SCHEMA_VERSION,
    instanceEpoch: requiredString(input.instanceEpoch, 'instanceEpoch'),
    chatId: requiredString(input.chatId, 'chatId'),
    runId: requiredString(input.runId, 'runId'),
    provider: optionalOwnerString(input.provider, 'provider'),
    participantId: optionalOwnerString(input.participantId, 'participantId'),
    launchAttemptId: requiredString(input.launchAttemptId, 'launchAttemptId'),
    expectedPid,
    selectedPid,
    ownership,
    selectedProcessStartedAt: canonicalIdentityString(
      input.selectedProcessStartedAt,
      'selectedProcessStartedAt'
    ),
    windowId: positiveInteger(input.windowId, 'windowId'),
    windowHandleId: requiredString(input.windowHandleId, 'windowHandleId'),
    consentEpoch: requiredString(input.consentEpoch, 'consentEpoch'),
    consentGeneration: nonNegativeInteger(input.consentGeneration, 'consentGeneration'),
    grantedAt,
    expiresAt,
    approvedAt,
    approvedBy: 'user' as const,
    allowedVerbs: normalizeAllowedVerbs(input.allowedVerbs),
    stepBudget: positiveInteger(input.stepBudget, 'stepBudget'),
    stepsUsed: 0
  }
}

function assertExecutorContextMatches(
  lease: NativeWindowLeaseSnapshot,
  context: NativeWindowLeaseExecutorContext,
  instanceEpoch: string
): void {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    fail('owner-mismatch', 'Native window lease is not owned by this executor.')
  }
  const matches =
    requiredString(context.instanceEpoch, 'instanceEpoch') === instanceEpoch &&
    context.instanceEpoch === lease.instanceEpoch &&
    requiredString(context.chatId, 'chatId') === lease.chatId &&
    requiredString(context.runId, 'runId') === lease.runId &&
    optionalOwnerString(context.provider, 'provider') === lease.provider &&
    optionalOwnerString(context.participantId, 'participantId') === lease.participantId
  if (!matches) {
    fail('owner-mismatch', 'Native window lease is not owned by this executor.')
  }
}

function assertVerbAllowed(lease: NativeWindowLeaseSnapshot, verb: NativeWindowLeaseVerb): void {
  if (!isNativeWindowLeaseVerb(verb) || !lease.allowedVerbs.includes(verb)) {
    fail('verb-not-allowed', 'This native-window verb is not included in the user-approved lease.')
  }
}

function assertReadVerb(verb: unknown): asserts verb is NativeWindowLeaseReadVerb {
  if (verb !== 'observe' && verb !== 'inspect') {
    fail('invalid-input', 'Capture requests may use only observe or inspect.')
  }
}

function assertControlVerb(verb: unknown): asserts verb is NativeWindowLeaseControlVerb {
  if (verb !== 'click' && verb !== 'fill') {
    fail('invalid-input', 'Native-control requests may use only click or fill.')
  }
}

function freezeLease(
  lease: Omit<NativeWindowLeaseSnapshot, 'schemaVersion'> & {
    schemaVersion: typeof NATIVE_WINDOW_LEASE_SCHEMA_VERSION
  }
): NativeWindowLeaseSnapshot {
  return Object.freeze({ ...lease, allowedVerbs: Object.freeze([...lease.allowedVerbs]) })
}

function revocationFor(
  lease: NativeWindowLeaseSnapshot,
  reason: NativeWindowLeaseRevocationReason,
  revokedAt: number
): NativeWindowLeaseRevocation {
  return Object.freeze({ lease, reason, revokedAt })
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value) {
    fail('invalid-input', `${label} is required.`)
  }
  return value
}

/**
 * Process-start identity is supplied by the platform bridge as a stable string.
 * Do not coerce it: equality with the next bridge observation must remain exact.
 */
function canonicalIdentityString(value: unknown, label: string): string {
  const identity = requiredString(value, label)
  if (identity.normalize('NFC') !== identity) {
    fail('invalid-input', `${label} must be a canonical string.`)
  }
  return identity
}

function optionalOwnerString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return EMPTY_OPTIONAL_OWNER
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value) {
    fail('invalid-input', `${label} must be a trimmed string or null.`)
  }
  return value
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('invalid-input', `${label} must be a finite number.`)
  }
  return value
}

function positiveInteger(value: unknown, label: string): number {
  const number = finiteNumber(value, label)
  if (!Number.isSafeInteger(number) || number <= 0) {
    fail('invalid-input', `${label} must be a positive integer.`)
  }
  return number
}

function nonNegativeInteger(value: unknown, label: string): number {
  const number = finiteNumber(value, label)
  if (!Number.isSafeInteger(number) || number < 0) {
    fail('invalid-input', `${label} must be a non-negative integer.`)
  }
  return number
}

function normalizeAllowedVerbs(value: unknown): readonly NativeWindowLeaseVerb[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail('invalid-input', 'allowedVerbs must contain at least one native-window verb.')
  }
  const verbs = new Set<NativeWindowLeaseVerb>()
  for (const verb of value) {
    if (!isNativeWindowLeaseVerb(verb)) {
      fail('invalid-input', 'allowedVerbs contains an unsupported native-window verb.')
    }
    verbs.add(verb)
  }
  return Object.freeze([...verbs])
}

function isNativeWindowLeaseVerb(value: unknown): value is NativeWindowLeaseVerb {
  return value === 'observe' || value === 'inspect' || value === 'click' || value === 'fill'
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function defaultLeaseId(): string {
  return `native-window-${randomUUID()}`
}

function fail(
  code: NativeWindowLeaseErrorCode,
  message: string,
  revocation?: NativeWindowLeaseRevocation | null
): never {
  throw new NativeWindowLeaseError(code, message, revocation ?? undefined)
}
