import {
  createEventLoopLagMeter,
  type EventLoopLagMeter,
  type EventLoopLagSnapshot
} from './EventLoopLagMeter'

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
      durability: unknown
    }
  | { status: 'unavailable'; reason: string }

interface HeldWindow {
  id: string
  startedAtMs: number
  expectedEndAtMs: number
  meter: EventLoopLagMeter
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

  const stop = () => {
    if (!held) return
    clearTimer(held.timer)
    held.meter.stop()
    held = undefined
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
      const meter = createMeter()
      const durability = readDurability()
      const startedAtMs = nowMs()
      const expectedEndAtMs = startedAtMs + input.durationMs
      meter.start()
      const window: HeldWindow = {
        id: input.id,
        startedAtMs,
        expectedEndAtMs,
        meter,
        timer: undefined
      }
      held = window
      window.timer = setTimer(() => {
        if (held !== window) return
        const endedAtMs = nowMs()
        const eventLoopLag = meter.snapshot()
        meter.stop()
        window.receipt = {
          status: 'complete',
          id: window.id,
          startedAtMs,
          endedAtMs,
          expectedEndAtMs,
          eventLoopLag,
          durability: readDurability()
        }
      }, input.durationMs)
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
