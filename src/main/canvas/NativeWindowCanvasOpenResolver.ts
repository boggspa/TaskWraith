import type { CanvasWindowOpenTarget } from './canvasTypes'
import type { LaunchAttempt } from '../launch/types'
import type { NativeFeatureCapability } from '../NativeCapabilities'
import type {
  CanvasWindowOpenResolveContext,
  CanvasWindowOpenTargetResolution,
  CanvasWindowOpenUnavailableReason
} from '../mcp/CanvasToolExecutors'
import type {
  NativeWindowCoordinatorCanvasAccess,
  NativeWindowCoordinatorCanvasOwner,
  NativeWindowCoordinatorRendererStatus
} from '../nativeWindow/NativeWindowCoordinator'
import type { NativeWindowLeaseReadVerb } from '../nativeWindow/NativeWindowLeaseRegistry'

export const NATIVE_WINDOW_CANVAS_OPEN_MINIMUM_MACOS_VERSION = '15.2' as const

/**
 * Main-only subset of a selected attachment. It intentionally excludes title,
 * application name, and bundle ID: exact process identity is the only input to
 * this resolver's target-ownership decision.
 */
export interface NativeWindowCanvasOpenObservation {
  readonly chatID: string
  readonly windowMeta: {
    readonly pid: number
    readonly windowID: number
    readonly processStartedAt: string
  }
}

/** Narrow, injectable coordinator surface used before issuing an opaque target. */
export interface NativeWindowCanvasOpenCoordinator {
  statusForChat(chatId: string): NativeWindowCoordinatorRendererStatus
  getObservationForChat(chatId: string): NativeWindowCanvasOpenObservation | null
  resolveLeaseForCanvas(
    owner: NativeWindowCoordinatorCanvasOwner,
    verb?: NativeWindowLeaseReadVerb
  ): NativeWindowCoordinatorCanvasAccess
}

/** Narrow, injectable token issuer. The returned target must remain opaque. */
export interface NativeWindowCanvasOpenTargetIssuer {
  issueOpenTarget(owner: NativeWindowCoordinatorCanvasOwner): CanvasWindowOpenTarget
}

export interface NativeWindowCanvasOpenResolverInput {
  readonly attempt: LaunchAttempt
  readonly context: CanvasWindowOpenResolveContext
  readonly platform: string
  readonly macosVersion: string | null | undefined
  readonly appDriveCapability: NativeFeatureCapability | null | undefined
  readonly isDaemonRunning: () => boolean
  readonly coordinator: NativeWindowCanvasOpenCoordinator | null | undefined
  readonly targetIssuer: NativeWindowCanvasOpenTargetIssuer | null | undefined
}

/**
 * Resolve an exact run-owned native target for canvas_open_launch.
 *
 * This function never returns a coordinator lease, picker handle, PID, process
 * identity, or control receipt. Its sole success value is a copied opaque token
 * issued by CanvasWindowDriverFactory after a second exact lease check.
 */
export function resolveNativeWindowCanvasOpenTarget(
  input: NativeWindowCanvasOpenResolverInput
): CanvasWindowOpenTargetResolution {
  try {
    return resolve(input)
  } catch {
    return unavailable('attachment-stale')
  }
}

function resolve(input: NativeWindowCanvasOpenResolverInput): CanvasWindowOpenTargetResolution {
  if (
    input?.platform !== 'darwin' ||
    !isSupportedMacosVersion(input.macosVersion, NATIVE_WINDOW_CANVAS_OPEN_MINIMUM_MACOS_VERSION)
  ) {
    return unavailable('not-native-macos-launch')
  }

  if (
    input.appDriveCapability?.available !== true ||
    !isDaemonRunning(input.isDaemonRunning) ||
    !hasCoordinator(input.coordinator) ||
    !hasTargetIssuer(input.targetIssuer)
  ) {
    return unavailable('native-bridge-unavailable')
  }

  const context = canonicalContext(input.context)
  if (!context || !isExactActiveAttempt(input.attempt, context)) {
    return unavailable('target-unavailable')
  }

  const status = statusForChat(input.coordinator, context.appChatId)
  if (!status) return unavailable('attachment-stale')
  if (!status.observation) return unavailable('attachment-required')
  if (status.observation.chatId !== context.appChatId) return unavailable('target-unavailable')
  if (!status.control) return unavailable('view-control-not-approved')

  const owner = exactOwner(input.attempt, context)
  if (!matchesControl(status.control, owner)) return unavailable('attachment-stale')

  const observation = observationForChat(input.coordinator, context.appChatId)
  if (!observation) return unavailable('attachment-stale')

  // The lease is read first because it records how this window earned the
  // launch's authority — an exact PID, or a descendant proved during the
  // human-consented pick. The checks still report in their original order, so
  // an unowned window is still `target-unavailable` rather than stale.
  const access = resolveLease(input.coordinator, owner)
  if (!matchesAttemptProcess(input.attempt, observation, context.appChatId, access?.lease)) {
    return unavailable('target-unavailable')
  }
  if (!access || !matchesLease(access, owner, observation)) {
    return unavailable('attachment-stale')
  }

  const issued = issueTarget(input.targetIssuer, owner)
  if (!issued) return unavailable('attachment-stale')
  return resolved(issued)
}

function canonicalContext(
  value: CanvasWindowOpenResolveContext | null | undefined
): CanvasWindowOpenResolveContext | null {
  if (!value || typeof value !== 'object') return null
  if (
    !isCanonicalString(value.appChatId) ||
    !isCanonicalString(value.appRunId) ||
    !isCanonicalString(value.parentProvider) ||
    !isCanonicalString(value.workspacePath)
  ) {
    return null
  }
  return value
}

function isExactActiveAttempt(
  attempt: LaunchAttempt | null | undefined,
  context: CanvasWindowOpenResolveContext
): attempt is LaunchAttempt {
  return Boolean(
    attempt &&
    isCanonicalString(attempt.id) &&
    attempt.chatId === context.appChatId &&
    attempt.runId === context.appRunId &&
    attempt.provider === context.parentProvider &&
    attempt.workspacePath === context.workspacePath &&
    (attempt.status === 'starting' || attempt.status === 'running') &&
    isPositiveInteger(attempt.pid) &&
    isCanonicalString(attempt.processStartedAt)
  )
}

function exactOwner(
  attempt: LaunchAttempt,
  context: CanvasWindowOpenResolveContext
): NativeWindowCoordinatorCanvasOwner {
  return Object.freeze({
    chatId: context.appChatId,
    runId: context.appRunId,
    launchAttemptId: attempt.id,
    provider: context.parentProvider,
    participantId: null
  })
}

function matchesControl(
  control: NonNullable<NativeWindowCoordinatorRendererStatus['control']>,
  owner: NativeWindowCoordinatorCanvasOwner
): boolean {
  return (
    control.chatId === owner.chatId &&
    control.runId === owner.runId &&
    control.provider === owner.provider &&
    control.launchAttemptId === owner.launchAttemptId &&
    control.participantId === null
  )
}

function matchesAttemptProcess(
  attempt: LaunchAttempt,
  observation: NativeWindowCanvasOpenObservation,
  expectedChatId: string,
  lease: NativeWindowCoordinatorCanvasAccess['lease'] | null | undefined
): boolean {
  const window = observation.windowMeta
  if (
    observation.chatID !== expectedChatId ||
    !isPositiveInteger(window.pid) ||
    !isPositiveInteger(window.windowID) ||
    !isCanonicalString(window.processStartedAt)
  ) {
    return false
  }
  // A process group is still neither a stable process identity nor a control
  // grant: unrelated helpers can share one. What does carry authority is an
  // explicit descent chain, verified once during the human-consented pick and
  // recorded on the lease. Anything else needs the exact spawned PID.
  if (lease?.ownership === 'descendant') {
    return lease.expectedPid === attempt.pid && window.pid === lease.pid
  }
  return window.pid === attempt.pid && window.processStartedAt === attempt.processStartedAt
}

function matchesLease(
  access: NativeWindowCoordinatorCanvasAccess,
  owner: NativeWindowCoordinatorCanvasOwner,
  observation: NativeWindowCanvasOpenObservation
): boolean {
  const lease = access.lease
  const window = observation.windowMeta
  return (
    lease.chatId === owner.chatId &&
    lease.runId === owner.runId &&
    lease.attemptId === owner.launchAttemptId &&
    lease.pid === window.pid &&
    lease.windowId === window.windowID &&
    lease.processStartedAt === window.processStartedAt
  )
}

function statusForChat(
  coordinator: NativeWindowCanvasOpenCoordinator,
  chatId: string
): NativeWindowCoordinatorRendererStatus | null {
  try {
    const status = coordinator.statusForChat(chatId)
    return status && typeof status === 'object' ? status : null
  } catch {
    return null
  }
}

function observationForChat(
  coordinator: NativeWindowCanvasOpenCoordinator,
  chatId: string
): NativeWindowCanvasOpenObservation | null {
  try {
    const observation = coordinator.getObservationForChat(chatId)
    return observation && typeof observation === 'object' ? observation : null
  } catch {
    return null
  }
}

function resolveLease(
  coordinator: NativeWindowCanvasOpenCoordinator,
  owner: NativeWindowCoordinatorCanvasOwner
): NativeWindowCoordinatorCanvasAccess | null {
  try {
    const access = coordinator.resolveLeaseForCanvas(owner, 'observe')
    return access && typeof access === 'object' ? access : null
  } catch {
    return null
  }
}

function issueTarget(
  issuer: NativeWindowCanvasOpenTargetIssuer,
  owner: NativeWindowCoordinatorCanvasOwner
): CanvasWindowOpenTarget | null {
  try {
    const candidate = issuer.issueOpenTarget(owner)
    if (!candidate || typeof candidate !== 'object' || !isCanonicalString(candidate.leaseId)) {
      return null
    }
    return Object.freeze({ leaseId: candidate.leaseId })
  } catch {
    return null
  }
}

function hasCoordinator(value: unknown): value is NativeWindowCanvasOpenCoordinator {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as NativeWindowCanvasOpenCoordinator).statusForChat === 'function' &&
    typeof (value as NativeWindowCanvasOpenCoordinator).getObservationForChat === 'function' &&
    typeof (value as NativeWindowCanvasOpenCoordinator).resolveLeaseForCanvas === 'function'
  )
}

function hasTargetIssuer(value: unknown): value is NativeWindowCanvasOpenTargetIssuer {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as NativeWindowCanvasOpenTargetIssuer).issueOpenTarget === 'function'
  )
}

function isDaemonRunning(predicate: unknown): boolean {
  try {
    return typeof predicate === 'function' && predicate() === true
  } catch {
    return false
  }
}

function isSupportedMacosVersion(version: unknown, minimum: string): boolean {
  const actual = parseVersion(version)
  const required = parseVersion(minimum)
  return actual !== null && required !== null && compareVersions(actual, required) >= 0
}

function parseVersion(value: unknown): number[] | null {
  if (!isCanonicalString(value) || !/^\d+(?:\.\d+)*$/.test(value)) return null
  const parts = value.split('.').map(Number)
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

function isCanonicalString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function unavailable(reason: CanvasWindowOpenUnavailableReason): CanvasWindowOpenTargetResolution {
  return Object.freeze({ ok: false, reason })
}

function resolved(target: CanvasWindowOpenTarget): CanvasWindowOpenTargetResolution {
  return Object.freeze({ ok: true, target: Object.freeze({ leaseId: target.leaseId }) })
}
