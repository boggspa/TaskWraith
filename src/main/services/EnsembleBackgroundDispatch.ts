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
