import {
  createEventLoopLagMeter,
  type EventLoopLagMeter,
  type EventLoopLagSnapshot
} from './EventLoopLagMeter'
import {
  createMainLoopGapRecorder,
  type MainLoopGapSnapshot,
  type MainSuspensionProtection
} from './MainLoopGapRecorder'
import { resolveMainPerfClock, type MainPerfClock } from './MainPerfClock'

export type MainWindowPerfRequest =
  | { action: 'begin'; id: string; durationMs: number }
  | { action: 'end'; id: string }

export interface MainWindowBoundaryPort {
  begin(id: string, at: number, clock: Omit<MainPerfClock, 'nowMs'>): void
  finish(id: string, at: number): unknown
  cancel(): void
}

export type MainWindowPerfReceipt =
  | {
      status: 'started'
      clock: Omit<MainPerfClock, 'nowMs'>
      id: string
      startedAtMs: number
      expectedEndAtMs: number
      durability: unknown
    }
  | {
      status: 'complete'
      residuals?: unknown
      clock: Omit<MainPerfClock, 'nowMs'>
      id: string
      startedAtMs: number
      endedAtMs: number
      expectedEndAtMs: number
      eventLoopLag: EventLoopLagSnapshot
      loopGaps: MainLoopGapSnapshot
      durability: unknown
    }
  | { status: 'unavailable'; reason: string }

interface HeldWindow {
  id: string
  startedAtMs: number
  expectedEndAtMs: number
  meter: EventLoopLagMeter
  gaps: ReturnType<typeof createMainLoopGapRecorder>
  timer: unknown
  receipt?: MainWindowPerfReceipt
}

export function createMainWindowPerfProbes(
  options: {
    createMeter?: () => EventLoopLagMeter
    boundary?: MainWindowBoundaryPort
    nowMs?: () => number
    clock?: MainPerfClock
    setTimer?: (callback: () => void, ms: number) => unknown
    clearTimer?: (timer: unknown) => void
    readDurability?: () => unknown
    acquireProtection?: () => MainSuspensionProtection
    createGapRecorder?: () => ReturnType<typeof createMainLoopGapRecorder>
  } = {}
) {
  const clock = resolveMainPerfClock(options.clock, options.nowMs)
  const nowMs = clock.nowMs
  const { nowMs: _readClock, ...clockIdentity } = clock
  const createMeter = options.createMeter ?? (() => createEventLoopLagMeter({ now: nowMs }))
  const readDurability = () => {
    try {
      return options.readDurability?.() ?? null
    } catch {
      return null
    }
  }
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer =
    options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  let held: HeldWindow | undefined
  let boundaryActive = false
  const cancelBoundary = () => {
    if (!boundaryActive) return
    boundaryActive = false
    try {
      options.boundary?.cancel()
    } catch {
      /* Diagnostic failure only. */
    }
  }

  const cleanup = (window: HeldWindow) => {
    let clean = true
    try {
      if (window.timer !== undefined) clearTimer(window.timer)
    } catch {
      clean = false
    } finally {
      try {
        window.meter.stop()
      } catch {
        clean = false
      } finally {
        try {
          window.gaps.cancel()
        } catch {
          clean = false
        } finally {
          try {
            window.gaps.dispose()
          } catch {
            clean = false
          }
        }
      }
    }
    window.timer = undefined
    return clean
  }
  const stop = () => {
    if (!held) return
    const window = held
    held = undefined
    cancelBoundary()
    cleanup(window)
  }
  const request = (input: MainWindowPerfRequest): MainWindowPerfReceipt => {
    if (!input || typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.id)) {
      return { status: 'unavailable', reason: 'invalid_window' }
    }
    if (input.action === 'begin') {
      if (
        !Number.isSafeInteger(input.durationMs) ||
        input.durationMs < 1 ||
        input.durationMs > 600_000
      ) {
        return { status: 'unavailable', reason: 'invalid_duration' }
      }
      if (held) return { status: 'unavailable', reason: 'window_held' }
      let meter: EventLoopLagMeter
      try {
        meter = createMeter()
      } catch {
        return { status: 'unavailable', reason: 'window_start_failed' }
      }
      let gaps: ReturnType<typeof createMainLoopGapRecorder>
      try {
        gaps =
          options.createGapRecorder?.() ??
          createMainLoopGapRecorder({ clock, acquireProtection: options.acquireProtection })
      } catch {
        try {
          meter.stop()
        } catch {
          /* Factory failure before either meter starts. */
        }
        return { status: 'unavailable', reason: 'window_start_failed' }
      }
      const durability = readDurability()
      let startedAtMs: number
      try {
        startedAtMs = nowMs()
      } catch {
        startedAtMs = Number.NaN
      }
      const expectedEndAtMs = startedAtMs + input.durationMs
      const window: HeldWindow = {
        id: input.id,
        startedAtMs,
        expectedEndAtMs,
        meter,
        gaps,
        timer: undefined
      }
      try {
        if (!Number.isFinite(startedAtMs) || startedAtMs < 0 || !Number.isFinite(expectedEndAtMs))
          throw new Error('Invalid clock')
        try {
          boundaryActive = true
          options.boundary?.begin(input.id, startedAtMs, clockIdentity)
        } catch {
          cancelBoundary()
        }
        meter.start()
        if (!gaps.start(startedAtMs)) throw new Error('Gap recorder refused')
        held = window
        const close = () => {
          if (held !== window) return
          window.timer = undefined
          let waiting = false
          try {
            const endedAtMs = nowMs()
            if (!Number.isFinite(endedAtMs) || endedAtMs < startedAtMs)
              throw new Error('Invalid clock')
            if (endedAtMs < expectedEndAtMs || endedAtMs - startedAtMs < input.durationMs) {
              // Node arms a timer on a whole millisecond of its own loop clock,
              // so it can run up to a millisecond before this clock covers the
              // window. No receipt until it has: wait out the rest.
              window.timer = setTimer(close, Math.max(1, Math.ceil(expectedEndAtMs - endedAtMs)))
              waiting = true
              return
            }
            let residuals: unknown = { intervalCoverage: 'unavailable' }
            if (boundaryActive) {
              try {
                residuals = options.boundary?.finish(window.id, endedAtMs)
              } catch {
                cancelBoundary()
              }
              boundaryActive = false
            }
            const eventLoopLag = meter.snapshot()
            const loopGaps = gaps.finish(false, endedAtMs)
            window.receipt = {
              status: 'complete',
              clock: clockIdentity,
              id: window.id,
              startedAtMs,
              endedAtMs,
              expectedEndAtMs,
              eventLoopLag,
              loopGaps,
              durability: readDurability(),
              residuals
            }
          } catch {
            cancelBoundary()
            window.receipt = { status: 'unavailable', reason: 'window_measurement_failed' }
          } finally {
            if (!waiting && !cleanup(window))
              window.receipt = { status: 'unavailable', reason: 'window_cleanup_failed' }
          }
        }
        window.timer = setTimer(close, input.durationMs)
      } catch {
        cancelBoundary()
        held = undefined
        cleanup(window)
        return { status: 'unavailable', reason: 'window_start_failed' }
      }
      return {
        status: 'started',
        clock: clockIdentity,
        id: input.id,
        startedAtMs,
        expectedEndAtMs,
        durability
      }
    }
    if (input.action !== 'end' || !held || held.id !== input.id) {
      return { status: 'unavailable', reason: 'window_missing' }
    }
    if (!held.receipt) {
      // Do not invent the rest of a window when a caller asks too early.
      return { status: 'unavailable', reason: 'window_incomplete' }
    }
    const receipt = held.receipt
    stop()
    return receipt
  }
  return { request, stop }
}
