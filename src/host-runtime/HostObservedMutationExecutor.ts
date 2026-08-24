/**
 * Observed Host mutation substrate (Wave 2E-2B Subwave 4).
 *
 * Captures a complete, privacy-clean HostSnapshot before a decoded HostCommand
 * is executed exactly once through an injected port, always attempts an after
 * snapshot, and — only when both captures are complete and the executor
 * returned — diffs the pair into HostDomainEffectDto values via
 * diffHostSnapshotDomainEffects.
 *
 * This module is observation-only:
 * - no delta publication / cursor minting
 * - no receipt terminalization or indeterminate mutation
 * - no envelope, authority adapter, store, bootstrap, or client wiring
 * - never synthesizes effects from command intent
 * - never returns raw thrown messages or snapshot/warning bodies
 * - never claims observed effects when after-capture or diff is incomplete
 */

import { decodeHostSnapshot, type HostCommand, type HostSnapshot } from '../shared/hostProtocol'
import type { HostCommandExecutionResult } from './HostCommandExecutionResult'
import type { HostDomainEffectDto } from './HostDomainDeltaPublisher'
import {
  diffHostSnapshotDomainEffects,
  type HostSnapshotDomainEffectDiffIncoherenceReason
} from './HostSnapshotDomainEffectDiff'
import { inspectHostSnapshotPrivacy } from './HostSnapshotProjector'

/** Injected snapshot capture — returns a raw HostSnapshot-shaped value. */
export type HostObservedMutationCaptureSnapshot = () => unknown | Promise<unknown>

/** Injected command executor — decoded HostCommand in, Bridge-compatible result out. */
export type HostObservedMutationExecuteCommand = (
  command: HostCommand
) => HostCommandExecutionResult | Promise<HostCommandExecutionResult>

export interface HostObservedMutationExecutorOptions {
  readonly captureSnapshot: HostObservedMutationCaptureSnapshot
  readonly executeCommand: HostObservedMutationExecuteCommand
}

export type HostObservedMutationPreExecutionReason =
  | 'before_snapshot_capture_failed'
  | 'before_snapshot_decode_failed'
  | 'before_snapshot_privacy_failed'
  | 'before_projection_truncated'

export type HostObservedMutationObservationFailureReason =
  | 'after_snapshot_capture_failed'
  | 'after_snapshot_decode_failed'
  | 'after_snapshot_privacy_failed'
  | 'after_projection_truncated'
  | 'diff_decode_failed'
  | 'diff_privacy_failed'
  | 'diff_incoherent'

/** Bounded after-capture metadata when execution threw (never effects). */
export type HostObservedMutationAfterCaptureMeta =
  | { readonly status: 'complete' }
  | { readonly status: 'capture_failed' }
  | { readonly status: 'decode_failed' }
  | { readonly status: 'privacy_failed' }
  | { readonly status: 'projection_truncated' }

export type HostObservedMutationResult =
  | {
      readonly kind: 'pre_execution_failed'
      readonly reason: HostObservedMutationPreExecutionReason
      readonly effects: readonly []
    }
  | {
      readonly kind: 'observed'
      readonly execution: HostCommandExecutionResult
      readonly effects: readonly HostDomainEffectDto[]
    }
  | {
      readonly kind: 'observation_failed'
      readonly execution: HostCommandExecutionResult
      readonly effects: readonly []
      readonly reason: HostObservedMutationObservationFailureReason
      readonly incoherenceReason?: HostSnapshotDomainEffectDiffIncoherenceReason
    }
  | {
      readonly kind: 'execution_may_have_begun'
      readonly effects: readonly []
      readonly afterCapture: HostObservedMutationAfterCaptureMeta
    }

const EMPTY_EFFECTS: readonly [] = []

type SnapshotInspection =
  | { readonly ok: true; readonly snapshot: HostSnapshot }
  | {
      readonly ok: false
      readonly reason: 'decode_failed' | 'privacy_failed' | 'projection_truncated'
    }

/**
 * Semantic truncation fence: any decoded warning with code `projection_truncated`
 * means the projection is incomplete. Never inspect warning message bodies.
 */
export function hostSnapshotHasProjectionTruncation(snapshot: HostSnapshot): boolean {
  const warnings = snapshot.warnings
  if (!Array.isArray(warnings)) return false
  for (const warning of warnings) {
    if (warning && typeof warning === 'object' && warning.code === 'projection_truncated') {
      return true
    }
  }
  return false
}

function inspectCapturedSnapshot(raw: unknown): SnapshotInspection {
  const decoded = decodeHostSnapshot(raw)
  if (!decoded.ok) {
    return { ok: false, reason: 'decode_failed' }
  }
  const privacy = inspectHostSnapshotPrivacy(decoded.value)
  if (!privacy.ok) {
    return { ok: false, reason: 'privacy_failed' }
  }
  if (hostSnapshotHasProjectionTruncation(decoded.value)) {
    return { ok: false, reason: 'projection_truncated' }
  }
  return { ok: true, snapshot: decoded.value }
}

function preExecutionFailed(
  reason: HostObservedMutationPreExecutionReason
): HostObservedMutationResult {
  return { kind: 'pre_execution_failed', reason, effects: EMPTY_EFFECTS }
}

function mapBeforeReason(
  reason: 'decode_failed' | 'privacy_failed' | 'projection_truncated'
): HostObservedMutationPreExecutionReason {
  switch (reason) {
    case 'decode_failed':
      return 'before_snapshot_decode_failed'
    case 'privacy_failed':
      return 'before_snapshot_privacy_failed'
    case 'projection_truncated':
      return 'before_projection_truncated'
  }
}

function mapAfterReason(
  reason: 'decode_failed' | 'privacy_failed' | 'projection_truncated'
): HostObservedMutationObservationFailureReason {
  switch (reason) {
    case 'decode_failed':
      return 'after_snapshot_decode_failed'
    case 'privacy_failed':
      return 'after_snapshot_privacy_failed'
    case 'projection_truncated':
      return 'after_projection_truncated'
  }
}

async function invokeCapture(
  captureSnapshot: HostObservedMutationCaptureSnapshot
): Promise<{ ok: true; raw: unknown } | { ok: false }> {
  try {
    const raw = await captureSnapshot()
    return { ok: true, raw }
  } catch {
    return { ok: false }
  }
}

/**
 * Isolated observed-mutation substrate: one capture → one execute → one capture →
 * optional pure domain-effect diff. Callers later compose receipts/publishers.
 */
export class HostObservedMutationExecutor {
  private readonly captureSnapshot: HostObservedMutationCaptureSnapshot
  private readonly executeCommand: HostObservedMutationExecuteCommand

  constructor(options: HostObservedMutationExecutorOptions) {
    if (!options || typeof options !== 'object') {
      throw new Error('HostObservedMutationExecutor requires options')
    }
    if (typeof options.captureSnapshot !== 'function') {
      throw new Error('HostObservedMutationExecutor requires captureSnapshot')
    }
    if (typeof options.executeCommand !== 'function') {
      throw new Error('HostObservedMutationExecutor requires executeCommand')
    }
    this.captureSnapshot = options.captureSnapshot
    this.executeCommand = options.executeCommand
  }

  /**
   * Observe one HostCommand mutation. Never retries capture or execution.
   * Does not mutate the input command object.
   */
  async execute(command: HostCommand): Promise<HostObservedMutationResult> {
    const beforeCapture = await invokeCapture(this.captureSnapshot)
    if (!beforeCapture.ok) {
      return preExecutionFailed('before_snapshot_capture_failed')
    }

    const beforeInspect = inspectCapturedSnapshot(beforeCapture.raw)
    if (!beforeInspect.ok) {
      return preExecutionFailed(mapBeforeReason(beforeInspect.reason))
    }

    let execution: HostCommandExecutionResult | undefined
    let thrown = false
    try {
      execution = await this.executeCommand(command)
    } catch {
      thrown = true
    }

    // Always attempt after-capture once execution has been invoked (return or throw).
    const afterCapture = await invokeCapture(this.captureSnapshot)

    if (thrown) {
      return {
        kind: 'execution_may_have_begun',
        effects: EMPTY_EFFECTS,
        afterCapture: classifyAfterCapture(afterCapture)
      }
    }

    // TypeScript: execution is defined when not thrown.
    const returned = execution as HostCommandExecutionResult

    if (!afterCapture.ok) {
      return {
        kind: 'observation_failed',
        execution: returned,
        effects: EMPTY_EFFECTS,
        reason: 'after_snapshot_capture_failed'
      }
    }

    const afterInspect = inspectCapturedSnapshot(afterCapture.raw)
    if (!afterInspect.ok) {
      return {
        kind: 'observation_failed',
        execution: returned,
        effects: EMPTY_EFFECTS,
        reason: mapAfterReason(afterInspect.reason)
      }
    }

    const diff = diffHostSnapshotDomainEffects(beforeInspect.snapshot, afterInspect.snapshot)
    if (diff.kind === 'effects') {
      return {
        kind: 'observed',
        execution: returned,
        effects: diff.effects
      }
    }

    if (diff.kind === 'incoherent') {
      return {
        kind: 'observation_failed',
        execution: returned,
        effects: EMPTY_EFFECTS,
        reason: 'diff_incoherent',
        incoherenceReason: diff.reason
      }
    }

    return {
      kind: 'observation_failed',
      execution: returned,
      effects: EMPTY_EFFECTS,
      reason: diff.reason === 'privacy_failed' ? 'diff_privacy_failed' : 'diff_decode_failed'
    }
  }
}

function classifyAfterCapture(
  afterCapture: { ok: true; raw: unknown } | { ok: false }
): HostObservedMutationAfterCaptureMeta {
  if (!afterCapture.ok) {
    return { status: 'capture_failed' }
  }
  const inspected = inspectCapturedSnapshot(afterCapture.raw)
  if (!inspected.ok) {
    return { status: inspected.reason }
  }
  return { status: 'complete' }
}
