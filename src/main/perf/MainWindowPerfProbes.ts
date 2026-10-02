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

export type MainWindowPerfRequest =
  | { action: 'begin'; id: string; durationMs: number }
  | { action: 'end'; id: string }

export type MainWindowPerfReceipt =
  | {
      status: 'started'
      id: string
      startedAtMs: number
      expectedEndAtMs: number
      durability: unknown
    }
  | {
      status: 'complete'
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
    nowMs?: () => number
    setTimer?: (callback: () => void, ms: number) => unknown
    clearTimer?: (timer: unknown) => void
    readDurability?: () => unknown
    acquireProtection?: () => MainSuspensionProtection
    createGapRecorder?: () => ReturnType<typeof createMainLoopGapRecorder>
  } = {}
) {
  const nowMs = options.nowMs ?? Date.now
  const createMeter = options.createMeter ?? createEventLoopLagMeter
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
          createMainLoopGapRecorder({ nowMs, acquireProtection: options.acquireProtection })
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
        if (
          !Number.isFinite(startedAtMs) ||
          startedAtMs < 0 ||
          !Number.isSafeInteger(expectedEndAtMs)
        )
          throw new Error('Invalid clock')
        meter.start()
        if (!gaps.start(startedAtMs)) throw new Error('Gap recorder refused')
        held = window
        window.timer = setTimer(() => {
          if (held !== window) return
          window.timer = undefined
          try {
            const endedAtMs = nowMs()
            if (!Number.isFinite(endedAtMs) || endedAtMs < startedAtMs)
              throw new Error('Invalid clock')
            const eventLoopLag = meter.snapshot()
            const loopGaps = gaps.finish(false, endedAtMs)
            window.receipt = {
              status: 'complete',
              id: window.id,
              startedAtMs,
              endedAtMs,
              expectedEndAtMs,
              eventLoopLag,
              loopGaps,
              durability: readDurability()
            }
          } catch {
            window.receipt = { status: 'unavailable', reason: 'window_measurement_failed' }
          } finally {
            if (!cleanup(window))
              window.receipt = { status: 'unavailable', reason: 'window_cleanup_failed' }
          }
        }, input.durationMs)
      } catch {
        held = undefined
        cleanup(window)
        return { status: 'unavailable', reason: 'window_start_failed' }
      }
      return { status: 'started', id: input.id, startedAtMs, expectedEndAtMs, durability }
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
