/**
 * Browser-safe contract for TaskWraith's in-app Host lifecycle.
 *
 * This describes the lifecycle of the Host inside the current TaskWraith
 * process. It is deliberately not a service-manager contract: there is no
 * daemon identity, launch-at-login state, or background restart policy here.
 */

export const HOST_LIFECYCLE_ERROR_MAX_LENGTH = 512

export const HOST_LIFECYCLE_PHASES = [
  'starting',
  'running',
  'stopping',
  'stopped',
  'failed'
] as const

export type HostLifecyclePhase = (typeof HOST_LIFECYCLE_PHASES)[number]

export type HostLifecycleDesiredState = 'running' | 'stopped'

export const HOST_LIFECYCLE_REASONS = [
  'not-started',
  'app-start',
  'user-start',
  'user-stop',
  'start-failed',
  'stop-failed',
  'app-quit'
] as const

export type HostLifecycleReason = (typeof HOST_LIFECYCLE_REASONS)[number]

export type HostLifecycleAction = 'start' | 'stop'

/** One monotonically-versioned view of the current in-process lifecycle. */
export interface HostLifecycleSnapshot {
  readonly revision: number
  readonly phase: HostLifecyclePhase
  readonly desired: HostLifecycleDesiredState
  readonly reason: HostLifecycleReason
  readonly changedAt: string
  /** Bounded message only; stacks and arbitrary thrown values never cross IPC. */
  readonly error?: string
}

export interface HostLifecycleActionRequest {
  readonly action: HostLifecycleAction
}

export type HostLifecycleStatusResult =
  | { readonly ok: true; readonly snapshot: HostLifecycleSnapshot }
  | { readonly ok: false; readonly error: string }

export type HostLifecycleActionResult =
  | { readonly ok: true; readonly snapshot: HostLifecycleSnapshot }
  | {
      readonly ok: false
      readonly error: string
      /** Present for an attempted transition; absent when the caller was denied. */
      readonly snapshot?: HostLifecycleSnapshot
    }

const PHASE_SET = new Set<string>(HOST_LIFECYCLE_PHASES)
const REASON_SET = new Set<string>(HOST_LIFECYCLE_REASONS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))
}

function isBoundedError(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= HOST_LIFECYCLE_ERROR_MAX_LENGTH
  )
}

/** Strict enough to reject a malformed or stale preload bridge response. */
export function isHostLifecycleSnapshot(value: unknown): value is HostLifecycleSnapshot {
  if (!isRecord(value)) return false
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) return false
  if (typeof value.phase !== 'string' || !PHASE_SET.has(value.phase)) return false
  if (value.desired !== 'running' && value.desired !== 'stopped') return false
  if (typeof value.reason !== 'string' || !REASON_SET.has(value.reason)) return false
  if (!isIsoTimestamp(value.changedAt)) return false
  if (value.error !== undefined && !isBoundedError(value.error)) {
    return false
  }
  return true
}

export function isHostLifecycleStatusResult(value: unknown): value is HostLifecycleStatusResult {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  if (value.ok) return isHostLifecycleSnapshot(value.snapshot)
  return isBoundedError(value.error)
}

export function isHostLifecycleActionResult(value: unknown): value is HostLifecycleActionResult {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  if (value.ok) return isHostLifecycleSnapshot(value.snapshot)
  return (
    isBoundedError(value.error) &&
    (value.snapshot === undefined || isHostLifecycleSnapshot(value.snapshot))
  )
}

/** Clone the bounded wire value so callers cannot mutate shared controller state. */
export function cloneHostLifecycleSnapshot(snapshot: HostLifecycleSnapshot): HostLifecycleSnapshot {
  return {
    revision: snapshot.revision,
    phase: snapshot.phase,
    desired: snapshot.desired,
    reason: snapshot.reason,
    changedAt: snapshot.changedAt,
    ...(snapshot.error ? { error: snapshot.error } : {})
  }
}
