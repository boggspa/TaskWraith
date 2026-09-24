import type { EnsembleParticipant } from '../store/types'

export type BackgroundDispatchRejectReason =
  | 'concurrent_lanes_disabled'
  | 'already_active'
  | 'budget_blocked'
  | 'target_missing'
  | 'launch_failed'
  | 'cancelled'

export type BackgroundDispatchResult =
  | { ok: true; laneIds: string[] }
  | { ok: false; reason: BackgroundDispatchRejectReason; detail?: string }

export type BackgroundDispatchPreflightInput = {
  concurrentLanesEnabled: boolean
  runtimeCancelled: boolean
  targetParticipant: EnsembleParticipant | undefined
  fanoutDispatchState: 'handled' | 'active' | null
  budgetBlockReason: string | null
}

export function preflightBackgroundDispatchTarget(
  input: BackgroundDispatchPreflightInput
): BackgroundDispatchResult | { ok: true } {
  if (input.runtimeCancelled) {
    return { ok: false, reason: 'cancelled' }
  }
  if (!input.targetParticipant || input.targetParticipant.enabled === false) {
    return { ok: false, reason: 'target_missing' }
  }
  if (!input.concurrentLanesEnabled) {
    return { ok: false, reason: 'concurrent_lanes_disabled' }
  }
  if (input.fanoutDispatchState === 'active') {
    return { ok: false, reason: 'already_active' }
  }
  if (input.budgetBlockReason) {
    return { ok: false, reason: 'budget_blocked', detail: input.budgetBlockReason }
  }
  return { ok: true }
}

export function isBackgroundDispatchFailure(
  result: BackgroundDispatchResult | { ok: true }
): result is Extract<BackgroundDispatchResult, { ok: false }> {
  return !result.ok
}

export function backgroundDispatchFailureStatusLine(
  result: Extract<BackgroundDispatchResult, { ok: false }>,
  displayName?: string
): string {
  const detail = result.detail ? ` (${result.detail})` : ''
  if (displayName) {
    return `Background dispatch not launched for ${displayName}: ${result.reason}${detail}.`
  }
  return `Background dispatch not launched: ${result.reason}${detail}.`
}

export type BackgroundDispatchPosture =
  | { mode: 'own_permissions'; statusLine: string }
  | { mode: 'read_only_clamp'; statusLine: string | null }

/**
 * Decides how a background lane is permissioned
 * (the background-seat posture design). `honorSeatPosture` is set ONLY by
 * the user-origin round path — composer @mention or DM chip target; every
 * beginRound prompt is user-authored by construction. Peer mentions and yield
 * routes never set it, so they always take the silent read-only clamp. The
 * User-directed lanes preserve the seat's permission posture and derive lane
 * intent from it; the write-lane kill switch remains the explicit user-side
 * gate. Peer mentions and yields never receive that own-posture authority.
 */
export function resolveBackgroundDispatchPosture(input: {
  honorSeatPosture: boolean
  writeLanesEnabled: boolean
  laneCount: number
}): BackgroundDispatchPosture {
  if (!input.honorSeatPosture) {
    return { mode: 'read_only_clamp', statusLine: null }
  }
  if (!input.writeLanesEnabled) {
    return {
      mode: 'read_only_clamp',
      statusLine:
        'Background lane(s) clamped to read-only: TASKWRAITH_CONCURRENT_WRITE_LANES=0.'
    }
  }
  return {
    mode: 'own_permissions',
    statusLine: `Background: launching ${input.laneCount} lane(s) under their own permission posture (user-directed). Write-capable seats receive writer intent; no permission tier is inferred or widened.`
  }
}
