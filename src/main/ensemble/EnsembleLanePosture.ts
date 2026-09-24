import type {
  ConcurrentLaneIntent,
  EffectiveRunPermissions,
  PermissionPresetId
} from '../store/types'

/**
 * The posture a fan-out lane is ACTUALLY dispatched under, as resolved at
 * dispatch time — not the roster configuration the seat was authored with.
 *
 * A `locked_writers` fan-out lane can be runtime-clamped to `read_only` after
 * the lane record was written, and there is no write-back to that record. The
 * seat's own `permissionPresetId` and the stored `lane.intent` therefore both
 * go stale in the dangerous direction: they keep saying "writer" while the run
 * can no longer write. Every prompt statement about posture must read THIS
 * object, resolved from the live permissions plus the live run intent.
 */
export interface EffectiveLanePosture {
  /** The preset the run resolved to, after any runtime clamp. */
  presetId: PermissionPresetId
  /** True when the resolved posture cannot mutate the workspace. */
  readOnly: boolean
  /** The live lane intent for this dispatch, not the stored lane record's. */
  laneIntent?: ConcurrentLaneIntent
}

/**
 * A reader lane whose permissions were additionally clamped by the runtime.
 *
 * Moved verbatim from `EnsembleOrchestrator`'s `readerIntentBoundary`, minus
 * the `\n\n` join glue the old inline concatenation needed; every emission site
 * now supplies its own separator.
 */
export const LANE_INTENT_BOUNDARY_READ_CLAMPED =
  'TaskWraith lane intent: inspection, recon, or review only. Do not modify workspace files or external state. This auxiliary lane is runtime read-clamped.'

/** A reader lane that keeps its configured tier so inspection stays non-blocking. */
export const LANE_INTENT_BOUNDARY_TIER_PRESERVED =
  'TaskWraith lane intent: inspection, recon, or review only. Do not modify workspace files or external state. Your configured permission tier remains active so allowed inspection tools stay non-blocking; that authority does not broaden this reader assignment.'

/**
 * The non-elidable posture sentence for a reader lane, or `undefined` for every
 * other seat.
 *
 * Gated strictly on `laneIntent === 'read'`: a write-intent lane, a `'none'`
 * lane, and an ordinary serial seat must all fall through to today's behaviour.
 */
export function formatLaneIntentBoundary(posture?: EffectiveLanePosture): string | undefined {
  if (posture?.laneIntent !== 'read') return undefined
  return posture.readOnly ? LANE_INTENT_BOUNDARY_READ_CLAMPED : LANE_INTENT_BOUNDARY_TIER_PRESERVED
}

/**
 * Pass-through constructor for the dispatch seam.
 *
 * It lives here rather than inline in `EnsembleOrchestrator` so the
 * composition root keeps exactly one expression per call site (see AGENTS.md,
 * composition-root growth policy) and so the seam is unit-testable without a
 * whole orchestrator harness.
 *
 * `laneIntent` MUST come from the live run, never from
 * `config.activeRound.lanes[laneId].intent`: a writer lane that narrows to read
 * at dispatch is not written back to the lane record, so the stored intent is
 * stale in exactly the dangerous direction.
 */
export function resolveEffectiveLanePosture(
  permissions: Pick<EffectiveRunPermissions, 'presetId' | 'readOnly'>,
  laneIntent?: ConcurrentLaneIntent
): EffectiveLanePosture {
  return {
    presetId: permissions.presetId,
    readOnly: permissions.readOnly,
    ...(laneIntent ? { laneIntent } : {})
  }
}
