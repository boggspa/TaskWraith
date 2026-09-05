import type { EnsembleWakeupRecord } from '../store/types'
import type { ScheduleWakeupInput } from './EnsembleOrchestratorTypes'

/**
 * 1.0.5-N4 — Maximum wakeup delay. Node's `setTimeout` silently
 * clamps delays > 2³¹−1 ms (~24.86 days) to 1ms, which would make
 * a far-future wakeup fire IMMEDIATELY instead of at the requested
 * time. We cap at 7 days here — generous enough for any plausible
 * long-running task, and forces agents to be explicit about
 * longer horizons via sequential wakeups (schedule one, work, on
 * resume schedule another) rather than passing 30+ days as a
 * single delay and getting bitten by the Node clamp.
 */
export const MAX_WAKEUP_DELAY_MS = 7 * 24 * 60 * 60 * 1000

export function resolveWakeAtMs(input: ScheduleWakeupInput, nowMs: number): number {
  const delayMs =
    typeof input.delayMs === 'number' && Number.isFinite(input.delayMs)
      ? input.delayMs
      : typeof input.delaySeconds === 'number' && Number.isFinite(input.delaySeconds)
        ? input.delaySeconds * 1000
        : undefined
  if (delayMs !== undefined) return nowMs + Math.max(0, delayMs)
  if (input.wakeAt) {
    const parsed = new Date(input.wakeAt).getTime()
    return Number.isFinite(parsed) ? parsed : Number.NaN
  }
  return Number.NaN
}

export function formatWakeupScheduledReason(wakeup: EnsembleWakeupRecord): string {
  const reason = wakeup.reason ? ` Reason: ${wakeup.reason}` : ''
  return `[wakeup:${wakeup.wakeupId} until ${wakeup.wakeAt}]${reason}`
}

export function formatWakeupResumePrompt(prompt: string, wakeup: EnsembleWakeupRecord): string {
  const reason = wakeup.reason ? `\nWake reason: ${wakeup.reason}` : ''
  return `${prompt}\n\n[Scheduled wakeup]\nWakeup id: ${wakeup.wakeupId}\nScheduled at: ${wakeup.scheduledAt}\nWoke at: ${wakeup.firedAt || new Date().toISOString()}${reason}\nContinue this same Ensemble round from where you intentionally slept.`
}

export function extractWakeupIdFromReason(reason: string): string | undefined {
  return /\[wakeup:([^\s\]]+)/.exec(reason)?.[1]
}

export function extractWakeAtFromReason(reason: string): string | undefined {
  return /\[wakeup:[^\]]+ until ([^\]]+)\]/.exec(reason)?.[1]
}
