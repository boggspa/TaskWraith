import type { LaunchAttempt, LaunchAttemptStatus } from '../launch/types'

/** Native-window control is unavailable below this macOS release. */
export const NATIVE_WINDOW_TARGET_MINIMUM_MACOS_VERSION = '15.2' as const

/**
 * `stopping` remains active for LaunchAttempt retention, but is not safe for a
 * new or renewed native-window target. A terminal transition must revoke it.
 */
const ACTIVE_TARGET_ATTEMPT_STATUSES: ReadonlySet<LaunchAttemptStatus> = new Set([
  'starting',
  'running'
])

const CANONICAL_PROCESS_STARTED_AT_PATTERN =
  /^(?:procBSDInfo|nsRunningApplication):[1-9][0-9]{0,18}$/

/** The identity returned by the user-mediated native window picker. */
export interface NativeWindowTargetSelectedWindow {
  pid: number
  windowId: number
  /** Opaque process-start identity, not a display timestamp to normalize. */
  processStartedAt: string
}

/**
 * Main-owned inputs for one target-ownership decision. This deliberately has
 * no title, application name, or bundle identifier: exact PID plus canonical
 * process-start identity is the authority boundary. Ancestry and process groups
 * never authorize a selected native window.
 */
export interface NativeWindowTargetOwnershipInput {
  instanceEpoch: string
  chatId: string
  runId: string
  launchAttemptId: string
  macosVersion: string
  hostProtectedPids: ReadonlySet<number> | readonly number[]
  attempt: LaunchAttempt | null | undefined
  selectedWindow: NativeWindowTargetSelectedWindow
}

/** Immutable identity to carry into the native-window lease. */
export interface NativeWindowTargetBinding {
  readonly instanceEpoch: string
  readonly chatId: string
  readonly runId: string
  readonly launchAttemptId: string
  readonly expectedPid: number
  readonly selectedPid: number
  readonly windowId: number
  readonly processStartedAt: string
}

export type NativeWindowTargetOwnershipErrorCode =
  | 'attempt-identity-mismatch'
  | 'binding-mismatch'
  | 'inactive-launch-attempt'
  | 'invalid-input'
  | 'pid-not-owned'
  | 'protected-process'
  | 'revalidation-state-unavailable'
  | 'unsupported-macos-version'

export interface NativeWindowTargetOwnershipError {
  readonly code: NativeWindowTargetOwnershipErrorCode
  readonly message: string
}

export interface NativeWindowTargetOwnershipSuccess {
  readonly ok: true
  readonly binding: NativeWindowTargetBinding
}

export interface NativeWindowTargetOwnershipFailure {
  readonly ok: false
  readonly error: NativeWindowTargetOwnershipError
}

/** Structured failures are authorization denials; callers must never fall back. */
export type NativeWindowTargetOwnershipResult =
  | NativeWindowTargetOwnershipSuccess
  | NativeWindowTargetOwnershipFailure

/**
 * Revalidation checks a saved binding against fresh main-owned state. It is
 * intentionally synchronous so it can be called before every lease operation.
 */
export interface NativeWindowTargetOwnershipRevalidationInput {
  binding: NativeWindowTargetBinding
  current: NativeWindowTargetOwnershipInput | null | undefined
}

export type NativeWindowTargetOwnershipRevalidator = (
  input: NativeWindowTargetOwnershipRevalidationInput
) => NativeWindowTargetOwnershipResult

/**
 * Structural subset of NativeWindowLeaseSnapshot used by the lease registry's
 * synchronous `validateOwnership` callback. Kept local to avoid a dependency
 * cycle between this pure gate and the registry.
 */
export interface NativeWindowTargetOwnershipLeaseProjection {
  readonly instanceEpoch: string
  readonly chatId: string
  readonly runId: string
  readonly launchAttemptId: string
  readonly expectedPid: number
  readonly selectedPid: number
  readonly selectedProcessStartedAt: string
  readonly windowId: number
}

/** Compatible with NativeWindowLeaseOwnershipValidator's literal-true contract. */
export type NativeWindowTargetOwnershipLeaseRevalidator = (
  lease: NativeWindowTargetOwnershipLeaseProjection
) => true

/**
 * The state reader must be synchronous. A Promise or throw is treated as an
 * unavailable current state and therefore denies the lease operation.
 */
export type NativeWindowTargetOwnershipCurrentStateReader = () =>
  | NativeWindowTargetOwnershipInput
  | null
  | undefined

/** Error form for the registry-compatible hook; the structured failure is retained. */
export class NativeWindowTargetOwnershipRevalidationError extends Error {
  constructor(readonly failure: NativeWindowTargetOwnershipFailure) {
    super(failure.error.message)
    this.name = 'NativeWindowTargetOwnershipRevalidationError'
  }
}

/**
 * Authorize one picker-selected window against an exact live LaunchAttempt.
 * This module intentionally performs no process, window, title, or bundle-ID
 * lookup; its inputs must come from main-owned launch and picker observations.
 */
export function validateNativeWindowTargetOwnership(
  input: NativeWindowTargetOwnershipInput | null | undefined
): NativeWindowTargetOwnershipResult {
  try {
    return validateTargetOwnership(input)
  } catch {
    return fail('invalid-input', 'Native window target ownership input is unavailable.')
  }
}

/** Recheck all authoritative identity fields and reject PID/birth-receipt drift. */
export const revalidateNativeWindowTargetOwnership: NativeWindowTargetOwnershipRevalidator = (
  input
) => {
  try {
    if (!isRecord(input) || !isRecord(input.binding)) {
      return fail('invalid-input', 'Native window target binding is required.')
    }
    const current = validateNativeWindowTargetOwnership(input.current)
    if (!current.ok) return current
    if (!bindingsMatch(input.binding as NativeWindowTargetBinding, current.binding)) {
      return fail('binding-mismatch', 'Native window target ownership has changed.')
    }
    return current
  } catch {
    return fail('invalid-input', 'Native window target ownership cannot be revalidated.')
  }
}

/**
 * Adapt the structured revalidator to NativeWindowLeaseRegistry's synchronous
 * literal-true validator contract. The registry catches the error and revokes
 * the lease, so no failed revalidation can leave native authority live.
 */
export function createNativeWindowTargetOwnershipLeaseRevalidator(
  binding: NativeWindowTargetBinding,
  readCurrent: NativeWindowTargetOwnershipCurrentStateReader
): NativeWindowTargetOwnershipLeaseRevalidator {
  return (lease) => {
    let current: NativeWindowTargetOwnershipInput | null | undefined
    try {
      if (typeof readCurrent !== 'function') {
        throw new Error('Native window target state reader is unavailable.')
      }
      current = readCurrent()
    } catch {
      throw new NativeWindowTargetOwnershipRevalidationError(
        fail('revalidation-state-unavailable', 'Current native window target state is unavailable.')
      )
    }

    const result = revalidateNativeWindowTargetOwnership({ binding, current })
    if (!result.ok) throw new NativeWindowTargetOwnershipRevalidationError(result)
    if (!leaseMatchesBinding(lease, result.binding)) {
      throw new NativeWindowTargetOwnershipRevalidationError(
        fail('binding-mismatch', 'Native window lease does not match its target binding.')
      )
    }
    return true
  }
}

export function isNativeWindowTargetMacosVersionSupported(version: unknown): boolean {
  const actual = parseVersion(version)
  const minimum = parseVersion(NATIVE_WINDOW_TARGET_MINIMUM_MACOS_VERSION)
  return actual !== null && minimum !== null && compareVersions(actual, minimum) >= 0
}

export function isActiveNativeWindowTargetAttempt(
  attempt: LaunchAttempt | null | undefined
): attempt is LaunchAttempt {
  return Boolean(attempt && ACTIVE_TARGET_ATTEMPT_STATUSES.has(attempt.status))
}

function validateTargetOwnership(
  input: NativeWindowTargetOwnershipInput | null | undefined
): NativeWindowTargetOwnershipResult {
  if (!isRecord(input)) {
    return fail('invalid-input', 'Native window target ownership input is required.')
  }

  const instanceEpoch = canonicalString(input.instanceEpoch)
  const chatId = canonicalString(input.chatId)
  const runId = canonicalString(input.runId)
  const launchAttemptId = canonicalString(input.launchAttemptId)
  if (!instanceEpoch || !chatId || !runId || !launchAttemptId) {
    return fail(
      'invalid-input',
      'Native window target ownership requires exact non-empty identities.'
    )
  }
  if (!isNativeWindowTargetMacosVersionSupported(input.macosVersion)) {
    return fail(
      'unsupported-macos-version',
      `Native window targets require macOS ${NATIVE_WINDOW_TARGET_MINIMUM_MACOS_VERSION} or newer.`
    )
  }

  const protectedPids = normalizeProtectedPids(input.hostProtectedPids)
  if (!protectedPids) {
    return fail('invalid-input', 'Current host protected process identities are required.')
  }

  const attempt = input.attempt
  if (!isActiveNativeWindowTargetAttempt(attempt)) {
    return fail('inactive-launch-attempt', 'The selected window has no active launch attempt.')
  }
  if (attempt.id !== launchAttemptId || attempt.chatId !== chatId || attempt.runId !== runId) {
    return fail(
      'attempt-identity-mismatch',
      'The selected window does not match this chat, run, and launch attempt.'
    )
  }

  const expectedPid = attempt.pid
  if (!isPositiveInteger(expectedPid)) {
    return fail('invalid-input', 'The active launch attempt has no positive process identity.')
  }
  const expectedProcessStartedAt = canonicalProcessStartedAt(attempt.processStartedAt)
  if (!expectedProcessStartedAt) {
    return fail(
      'invalid-input',
      'The active launch attempt has no canonical process-birth receipt; native control remains view-only.'
    )
  }
  const selectedWindow = input.selectedWindow
  if (!isRecord(selectedWindow)) {
    return fail('invalid-input', 'The selected native window identity is required.')
  }
  const selectedPid = selectedWindow.pid
  const windowId = selectedWindow.windowId
  const processStartedAt = canonicalProcessStartedAt(selectedWindow.processStartedAt)
  if (!isPositiveInteger(selectedPid) || !isPositiveInteger(windowId) || !processStartedAt) {
    return fail(
      'invalid-input',
      'The selected native window has an invalid process, window, or start identity.'
    )
  }

  if (protectedPids.has(selectedPid)) {
    return fail(
      'protected-process',
      'The selected native window belongs to a protected host process.'
    )
  }

  if (selectedPid !== expectedPid || processStartedAt !== expectedProcessStartedAt) {
    return fail(
      'pid-not-owned',
      'The selected native window does not exactly match the active launch process identity.'
    )
  }

  return succeed({
    instanceEpoch,
    chatId,
    runId,
    launchAttemptId,
    expectedPid,
    selectedPid,
    windowId,
    processStartedAt
  })
}

function bindingsMatch(left: NativeWindowTargetBinding, right: NativeWindowTargetBinding): boolean {
  return (
    left.instanceEpoch === right.instanceEpoch &&
    left.chatId === right.chatId &&
    left.runId === right.runId &&
    left.launchAttemptId === right.launchAttemptId &&
    left.expectedPid === right.expectedPid &&
    left.selectedPid === right.selectedPid &&
    left.windowId === right.windowId &&
    left.processStartedAt === right.processStartedAt
  )
}

function leaseMatchesBinding(
  lease: NativeWindowTargetOwnershipLeaseProjection,
  binding: NativeWindowTargetBinding
): boolean {
  return Boolean(
    lease &&
    lease.instanceEpoch === binding.instanceEpoch &&
    lease.chatId === binding.chatId &&
    lease.runId === binding.runId &&
    lease.launchAttemptId === binding.launchAttemptId &&
    lease.expectedPid === binding.expectedPid &&
    lease.selectedPid === binding.selectedPid &&
    lease.selectedProcessStartedAt === binding.processStartedAt &&
    lease.windowId === binding.windowId
  )
}

function normalizeProtectedPids(value: unknown): ReadonlySet<number> | null {
  const values = Array.isArray(value) || value instanceof Set ? value : null
  if (!values) return null
  const protectedPids = new Set<number>()
  for (const pid of values) {
    if (!isPositiveInteger(pid)) return null
    protectedPids.add(pid)
  }
  return protectedPids
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function canonicalString(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.trim() !== value) return null
  return value
}

function canonicalProcessStartedAt(value: unknown): string | null {
  const receipt = canonicalString(value)
  return receipt && CANONICAL_PROCESS_STARTED_AT_PATTERN.test(receipt) ? receipt : null
}

function parseVersion(value: unknown): number[] | null {
  const version = canonicalString(value)
  if (!version || !/^\d+(?:\.\d+)*$/.test(version)) return null
  const parts = version.split('.').map(Number)
  return parts.every((part) => Number.isSafeInteger(part) && part >= 0) ? parts : null
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0)
    if (delta !== 0) return delta > 0 ? 1 : -1
  }
  return 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function succeed(binding: NativeWindowTargetBinding): NativeWindowTargetOwnershipSuccess {
  return Object.freeze({ ok: true, binding: Object.freeze({ ...binding }) })
}

function fail(
  code: NativeWindowTargetOwnershipErrorCode,
  message: string
): NativeWindowTargetOwnershipFailure {
  return Object.freeze({ ok: false, error: Object.freeze({ code, message }) })
}
