import { resolveMainPerfClock, type MainPerfClock } from './MainPerfClock'

export interface MainSuspensionProtection {
  held(): boolean
  release(): void
}

export interface MainLoopGapSnapshot {
  clock: Omit<MainPerfClock, 'nowMs'>
  intervalMs: 5
  thresholdMs: 25
  startedAtMs: number
  endedAtMs: number
  observedForMs: number
  gaps: Array<{ expectedAtMs: number; observedAtMs: number; durationMs: number }>
  blockedMs: number
  blockedFraction: number | null
  dropped: number
  censored: boolean
  reasons: string[]
  suspensionProtection: { type: 'prevent-app-suspension'; heldThroughout: boolean }
}

/** Construction acquires no timers or Electron resources. One instance is one window. */
export function createMainLoopGapRecorder(
  options: {
    nowMs?: () => number
    clock?: MainPerfClock
    setTimer?: (callback: () => void, ms: number) => unknown
    clearTimer?: (timer: unknown) => void
    acquireProtection?: () => MainSuspensionProtection
    capacity?: number
  } = {}
) {
  const timebase = resolveMainPerfClock(options.clock, options.nowMs)
  const now = timebase.nowMs
  const { nowMs: _readClock, ...clockIdentity } = timebase
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer =
    options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const capacity = options.capacity ?? 4096
  const gaps: MainLoopGapSnapshot['gaps'] = []
  const reasons = new Set<string>()
  let timer: unknown
  let active = false
  let startedAtMs = 0
  let expectedAtMs = 0
  let blockedMs = 0
  let dropped = 0
  let protection: MainSuspensionProtection | undefined
  let protectedThroughout = true
  let result: MainLoopGapSnapshot | undefined
  let lastClock = 0
  const clock = (given?: number) => {
    let value: number
    try {
      value = given ?? now()
    } catch {
      value = Number.NaN
    }
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - 5) {
      reasons.add('invalid_gap_clock')
      return lastClock
    }
    if (value < lastClock) {
      reasons.add('clock_regressed')
      return lastClock
    }
    lastClock = value
    return value
  }
  const release = () => {
    const resource = protection
    protection = undefined
    try {
      resource?.release()
    } catch {
      reasons.add('protection_release_failed')
    }
  }
  const clear = () => {
    const handle = timer
    timer = undefined
    try {
      if (handle !== undefined) clearTimer(handle)
    } catch {
      reasons.add('gap_timer_clear_failed')
    }
  }

  const checkProtection = () => {
    try {
      if (protection?.held()) return
    } catch {
      /* An unobservable resource cannot prove protection. */
    }
    protectedThroughout = false
    reasons.add('suspension_protection_unavailable')
  }
  const record = (observedAtMs: number) => {
    checkProtection()
    if (observedAtMs < expectedAtMs - 5) reasons.add('clock_regressed')
    const durationMs = observedAtMs - expectedAtMs
    if (durationMs < 25) return
    blockedMs += durationMs
    if (gaps.length < capacity) gaps.push({ expectedAtMs, observedAtMs, durationMs })
    else {
      dropped++
      reasons.add('gap_ring_overflow')
    }
  }
  const tick = () => {
    if (!active) return
    timer = undefined
    const observedAtMs = clock()
    record(observedAtMs)
    // Re-arm from the actual fire: overdue ticks are one stretch, not many
    // overlapping copies of the same blocked interval.
    expectedAtMs = observedAtMs + 5
    try {
      timer = setTimer(tick, 5)
    } catch {
      reasons.add('gap_timer_failed')
      active = false
      release()
    }
  }
  const start = (atMs?: number) => {
    if (active || result) return false
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 65_536) {
      reasons.add('invalid_gap_capacity')
      return false
    }
    try {
      protection = options.acquireProtection?.()
    } catch {
      reasons.add('suspension_protection_unavailable')
    }
    checkProtection()
    startedAtMs = clock(atMs)
    expectedAtMs = startedAtMs + 5
    active = true
    try {
      timer = setTimer(tick, 5)
      return true
    } catch {
      reasons.add('gap_timer_failed')
      active = false
      clear()
      release()
      return false
    }
  }
  const finish = (cancelled = false, atMs?: number): MainLoopGapSnapshot => {
    if (result) return result
    const endedAtMs = clock(atMs)
    if (active) {
      clear()
      // Capture a final overdue tick even if the window deadline callback
      // ran first in the timer queue after a stall.
      record(endedAtMs)
    } else reasons.add('gap_recorder_not_started')
    active = false
    if (cancelled) reasons.add('gap_window_cancelled')
    const observedForMs = Math.max(0, endedAtMs - startedAtMs)
    if (observedForMs === 0) reasons.add('gap_window_empty')
    release()
    result = {
      clock: clockIdentity,
      intervalMs: 5,
      thresholdMs: 25,
      startedAtMs,
      endedAtMs,
      observedForMs,
      gaps: gaps.map((gap) => ({ ...gap })),
      blockedMs,
      blockedFraction: observedForMs > 0 ? blockedMs / observedForMs : null,
      dropped,
      censored: reasons.size > 0,
      reasons: [...reasons],
      suspensionProtection: { type: 'prevent-app-suspension', heldThroughout: protectedThroughout }
    }
    return result
  }
  const dispose = () => {
    active = false
    try {
      clear()
    } finally {
      release()
    }
  }
  return { start, finish, cancel: () => finish(true), dispose }
}
