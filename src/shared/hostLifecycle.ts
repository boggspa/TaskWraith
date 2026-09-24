/**
 * Browser-safe contract for TaskWraith's Host lifecycle as the app sees it.
 *
 * The snapshot describes the Host this app process is attached to: the
 * in-app lifecycle phase and, once known, the identity block of the Host
 * process itself (pid, install id, payload hash, start instant). The reasons
 * name every path that may move it, including the bounded restart policy: an
 * explicit user restart, a confirmed poisoned-session restart and a lease
 * re-acquire, each serialized by the controller and bounded by its guards. A
 * failed start is never retried in the background. Launch-at-login and any
 * service-manager state stay out of this contract.
 */

import { decodeHostStatusProjection, type HostStatusProjection } from './hostProtocol'

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
  'app-quit',
  /** The user asked for a restart (menu item, Settings, a confirmed dialog). */
  'user-restart',
  /** The Desktop session was confirmed narrowed; bounded by the loop guard. */
  'poison-restart',
  /** Main's lease was lost (lapse, Host exit) and is being taken again. */
  'lease-reacquire'
] as const

export type HostLifecycleReason = (typeof HOST_LIFECYCLE_REASONS)[number]

export const HOST_LIFECYCLE_ACTIONS = ['start', 'stop', 'restart'] as const

export type HostLifecycleAction = (typeof HOST_LIFECYCLE_ACTIONS)[number]

/**
 * The Host process behind the snapshot, as the app last observed it (the
 * discovery record its launcher's probe authenticated through). Display only:
 * nothing compares it for liveness.
 */
export interface HostLifecycleHostIdentity {
  readonly pid: number
  /** Durable per install; the same across restarts. */
  readonly hostId: string
  /** Listener start, ISO-8601. */
  readonly startedAt: string
  /** `sha256:<hex>` over the Host payload, when the Host published one. */
  readonly payloadVersion?: string
  /** Hex birth-identity digest of the pid, when one was observed. */
  readonly birthIdentity?: string
}

/** One monotonically-versioned view of the current lifecycle. */
export interface HostLifecycleSnapshot {
  readonly revision: number
  readonly phase: HostLifecyclePhase
  readonly desired: HostLifecycleDesiredState
  readonly reason: HostLifecycleReason
  readonly changedAt: string
  /** Bounded message only; stacks and arbitrary thrown values never cross IPC. */
  readonly error?: string
  /** Absent until a Host process has been observed (and for the in-process Host). */
  readonly host?: HostLifecycleHostIdentity
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

/**
 * Why main holds its Host lease, as kinds. Phase 1 holds for `app` only (from
 * app start to quit); later phases add `window`, `work` and `pin` (a paired
 * phone pinned to keep the Host). Device keys never cross IPC: a pin appears
 * here as its kind only.
 */
export const HOST_LEASE_REASON_KINDS = ['app', 'window', 'work', 'pin'] as const

export type HostLeaseReasonKind = (typeof HOST_LEASE_REASON_KINDS)[number]

/**
 * Main's own lease on the Host. `legacy` means the Host predates lease
 * support: it keeps running as before and a restart upgrades it.
 */
export interface HostLifecycleLeaseProjection {
  readonly mode: 'lease' | 'legacy'
  /** Main holds an explicit lease right now. */
  readonly held: boolean
  readonly reasons: readonly HostLeaseReasonKind[]
}

/**
 * Answer to the inspect channel: the lifecycle snapshot, the Host's own live
 * `host.status` (null when it could not be read: offline, not yet connected,
 * or a Host that predates it), and main's lease (null when this app holds
 * none, as with the in-process Host).
 */
export type HostLifecycleInspectResult =
  | {
      readonly ok: true
      readonly snapshot: HostLifecycleSnapshot
      readonly host: HostStatusProjection | null
      readonly lease: HostLifecycleLeaseProjection | null
    }
  | { readonly ok: false; readonly error: string }

const PHASE_SET = new Set<string>(HOST_LIFECYCLE_PHASES)
const REASON_SET = new Set<string>(HOST_LIFECYCLE_REASONS)
const ACTION_SET = new Set<string>(HOST_LIFECYCLE_ACTIONS)
const LEASE_REASON_KIND_SET = new Set<string>(HOST_LEASE_REASON_KINDS)
const HOST_ID_MAX_LENGTH = 512
const PAYLOAD_VERSION_PATTERN = /^sha256:[0-9a-f]{64}$/
const BIRTH_IDENTITY_PATTERN = /^[0-9a-f]{64}$/

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

export function isHostLifecycleAction(value: unknown): value is HostLifecycleAction {
  return typeof value === 'string' && ACTION_SET.has(value)
}

/** Strict: every field typed and bounded; an unknown key is refused. */
export function isHostLifecycleHostIdentity(value: unknown): value is HostLifecycleHostIdentity {
  if (!isRecord(value)) return false
  for (const key of Object.keys(value)) {
    if (!['pid', 'hostId', 'startedAt', 'payloadVersion', 'birthIdentity'].includes(key)) {
      return false
    }
  }
  if (!Number.isSafeInteger(value.pid) || Number(value.pid) < 1) return false
  if (
    typeof value.hostId !== 'string' ||
    value.hostId.length === 0 ||
    value.hostId.length > HOST_ID_MAX_LENGTH
  ) {
    return false
  }
  if (!isIsoTimestamp(value.startedAt)) return false
  if (
    value.payloadVersion !== undefined &&
    (typeof value.payloadVersion !== 'string' ||
      !PAYLOAD_VERSION_PATTERN.test(value.payloadVersion))
  ) {
    return false
  }
  if (
    value.birthIdentity !== undefined &&
    (typeof value.birthIdentity !== 'string' || !BIRTH_IDENTITY_PATTERN.test(value.birthIdentity))
  ) {
    return false
  }
  return true
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
  if (value.host !== undefined && !isHostLifecycleHostIdentity(value.host)) return false
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

export function isHostLifecycleLeaseProjection(
  value: unknown
): value is HostLifecycleLeaseProjection {
  if (!isRecord(value)) return false
  if (value.mode !== 'lease' && value.mode !== 'legacy') return false
  if (typeof value.held !== 'boolean') return false
  if (!Array.isArray(value.reasons) || value.reasons.length > HOST_LEASE_REASON_KINDS.length) {
    return false
  }
  return value.reasons.every(
    (reason: unknown) => typeof reason === 'string' && LEASE_REASON_KIND_SET.has(reason)
  )
}

/** The Host status is checked with the protocol's own fail-closed decoder. */
export function isHostLifecycleInspectResult(value: unknown): value is HostLifecycleInspectResult {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  if (!value.ok) return isBoundedError(value.error)
  if (!isHostLifecycleSnapshot(value.snapshot)) return false
  if (value.host !== null && !decodeHostStatusProjection(value.host).ok) return false
  return value.lease === null || isHostLifecycleLeaseProjection(value.lease)
}

/** Clone the bounded wire value so callers cannot mutate shared controller state. */
export function cloneHostLifecycleSnapshot(snapshot: HostLifecycleSnapshot): HostLifecycleSnapshot {
  return {
    revision: snapshot.revision,
    phase: snapshot.phase,
    desired: snapshot.desired,
    reason: snapshot.reason,
    changedAt: snapshot.changedAt,
    ...(snapshot.error ? { error: snapshot.error } : {}),
    ...(snapshot.host ? { host: cloneHostLifecycleHostIdentity(snapshot.host) } : {})
  }
}

export function cloneHostLifecycleHostIdentity(
  host: HostLifecycleHostIdentity
): HostLifecycleHostIdentity {
  return {
    pid: host.pid,
    hostId: host.hostId,
    startedAt: host.startedAt,
    ...(host.payloadVersion ? { payloadVersion: host.payloadVersion } : {}),
    ...(host.birthIdentity ? { birthIdentity: host.birthIdentity } : {})
  }
}
