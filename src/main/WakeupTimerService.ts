import type { EnsembleWakeupRecord, EnsembleWakeupStatus } from './store/types'

export const WAKEUP_RECOVERY_GRACE_MS = 60 * 60 * 1000

/**
 * 1.0.5-EW37 — Minimal structural shape the timer service + recovery
 * classifier read from a wakeup record. Pre-EW37 this was hard-typed
 * to `EnsembleWakeupRecord`; widening to a structural minimum lets
 * the same service drive both ensemble + solo-chat wakeups without
 * a parallel implementation. Both record types in `store/types`
 * already include these fields.
 */
export interface WakeupRecordLike {
  wakeupId: string
  wakeAt: string
  status: EnsembleWakeupStatus
}

export type WakeupRecoveryAction<T extends WakeupRecordLike = EnsembleWakeupRecord> =
  | { action: 'arm'; wakeup: T }
  | { action: 'fire'; wakeup: T }
  | { action: 'expire'; wakeup: T; expiredAt: string }

interface WakeupTimerServiceDeps {
  now?: () => number
  setTimeout?: (callback: () => void, delayMs: number) => unknown
  clearTimeout?: (handle: unknown) => void
  onFire: (wakeupId: string) => unknown
  /**
   * Timer callbacks are detached from their caller, so neither a synchronous
   * throw nor a rejected async handler has an awaiting owner. Keep both inside
   * the timer boundary and surface them through this diagnostic hook.
   */
  onFireError?: (error: unknown, wakeupId: string) => void
}

export class WakeupTimerService {
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly onFire: (wakeupId: string) => unknown
  private readonly onFireError: (error: unknown, wakeupId: string) => void
  private readonly timers = new Map<string, unknown>()

  constructor(deps: WakeupTimerServiceDeps) {
    this.now = deps.now || Date.now
    this.setTimer = deps.setTimeout || ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimer =
      deps.clearTimeout || ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.onFire = deps.onFire
    this.onFireError =
      deps.onFireError ||
      ((error, wakeupId) => {
        console.error(`Wakeup timer handler failed for ${wakeupId}:`, error)
      })
  }

  schedule(wakeup: WakeupRecordLike): void {
    if (wakeup.status !== 'pending') return
    this.cancel(wakeup.wakeupId)
    const delayMs = Math.max(0, new Date(wakeup.wakeAt).getTime() - this.now())
    const handle = this.setTimer(() => {
      this.timers.delete(wakeup.wakeupId)
      try {
        const outcome = this.onFire(wakeup.wakeupId)
        void Promise.resolve(outcome).catch((error) => {
          this.reportFireError(error, wakeup.wakeupId)
        })
      } catch (error) {
        this.reportFireError(error, wakeup.wakeupId)
      }
    }, delayMs)
    this.timers.set(wakeup.wakeupId, handle)
  }

  replace(wakeup: WakeupRecordLike): void {
    this.schedule(wakeup)
  }

  cancel(wakeupId: string): boolean {
    const handle = this.timers.get(wakeupId)
    if (!handle) return false
    this.clearTimer(handle)
    this.timers.delete(wakeupId)
    return true
  }

  cancelWhere(predicate: (wakeupId: string) => boolean): string[] {
    const cancelled: string[] = []
    for (const wakeupId of Array.from(this.timers.keys())) {
      if (!predicate(wakeupId)) continue
      if (this.cancel(wakeupId)) cancelled.push(wakeupId)
    }
    return cancelled
  }

  has(wakeupId: string): boolean {
    return this.timers.has(wakeupId)
  }

  clear(): void {
    for (const wakeupId of Array.from(this.timers.keys())) {
      this.cancel(wakeupId)
    }
  }

  private reportFireError(error: unknown, wakeupId: string): void {
    try {
      this.onFireError(error, wakeupId)
    } catch (reportError) {
      console.error(
        `Wakeup timer error reporter failed for ${wakeupId}:`,
        new AggregateError([error, reportError], 'Wakeup timer handler and reporter both failed.')
      )
    }
  }
}

export function classifyWakeupRecovery<T extends WakeupRecordLike>(
  wakeups: Iterable<T>,
  options: { nowMs: number; graceMs?: number; nowIso?: string }
): WakeupRecoveryAction<T>[] {
  const graceMs = options.graceMs ?? WAKEUP_RECOVERY_GRACE_MS
  const nowIso = options.nowIso || new Date(options.nowMs).toISOString()
  const actions: WakeupRecoveryAction<T>[] = []
  for (const wakeup of wakeups) {
    if (wakeup.status !== 'pending') continue
    const wakeMs = new Date(wakeup.wakeAt).getTime()
    if (!Number.isFinite(wakeMs)) {
      actions.push({ action: 'expire', wakeup, expiredAt: nowIso })
      continue
    }
    if (wakeMs > options.nowMs) {
      actions.push({ action: 'arm', wakeup })
    } else if (options.nowMs - wakeMs <= graceMs) {
      actions.push({ action: 'fire', wakeup })
    } else {
      actions.push({ action: 'expire', wakeup, expiredAt: nowIso })
    }
  }
  return actions
}
