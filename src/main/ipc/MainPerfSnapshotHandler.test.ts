import { describe, expect, it, vi } from 'vitest'
import { createMainPerfSnapshotHandler } from './MainPerfSnapshotHandler'
import { createMainPerfInstrumentation } from '../perf/MainPerfSnapshot'
import { createMainWindowPerfProbes } from '../perf/MainWindowPerfProbes'
import type { EventLoopLagMeter } from '../perf/EventLoopLagMeter'

describe('main perf IPC window roundtrip', () => {
  it('forwards begin/end to an isolated meter and preserves sender denial', () => {
    let finish!: () => void
    const snapshot = vi.fn(() => ({
      observedForMs: 100,
      p50Ms: 1,
      p95Ms: 7,
      p99Ms: 8,
      maxMs: 9,
      meanMs: 2,
      sampling: true
    }))
    const isolated: EventLoopLagMeter = { start: vi.fn(), stop: vi.fn(), snapshot }
    const probes = createMainWindowPerfProbes({
      createMeter: () => isolated,
      setTimer: (callback) => {
        finish = callback
        return 1
      },
      clearTimer: () => {}
    })
    const instrumentation = createMainPerfInstrumentation({ windowProbes: probes })
    const handler = createMainPerfSnapshotHandler<number>({
      isMainSender: (id) => id === 1,
      instrumentation: () => instrumentation
    })
    expect(handler(2, { window: { action: 'begin', id: 'denied', durationMs: 100 } })).toBeNull()
    expect(
      handler(1, { window: { action: 'begin', id: 'ipc_window', durationMs: 100 } })?.window?.status
    ).toBe('started')
    handler(1, { resetLagWindow: true })
    expect(snapshot).not.toHaveBeenCalled()
    finish()
    expect(handler(1, { window: { action: 'end', id: 'ipc_window' } })?.window).toMatchObject({
      status: 'complete',
      id: 'ipc_window',
      eventLoopLag: { p95Ms: 7 }
    })
    instrumentation.stop()
  })
})
