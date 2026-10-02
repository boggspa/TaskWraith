import { describe, expect, it, vi } from 'vitest'
import { createMainWindowPerfProbes } from './MainWindowPerfProbes'
import { createMainResidualBoundary } from './MainResidualInstrumentation'
import { MainDurabilityResiduals } from '../store/MainDurabilityResiduals'
import { createMainResidualWindows } from '../store/MainResidualWindows'

describe('residual actual probe lifecycle', () => {
  it('cleans a failed begin once and contains diagnostic callback failures', () => {
    const cancel = vi.fn()
    const probes = createMainWindowPerfProbes({
      boundary: {
        begin: () => {
          throw new Error('observer failed')
        },
        finish: () => {},
        cancel
      },
      createMeter: () => ({
        start: () => {
          throw new Error('meter failed')
        },
        stop: () => {},
        snapshot: () => ({}) as never
      }),
      createGapRecorder: () =>
        ({ start: () => true, finish: () => ({}), cancel: () => {}, dispose: () => {} }) as never
    })
    expect(probes.request({ action: 'begin', id: 'failed', durationMs: 1 }).status).toBe(
      'unavailable'
    )
    probes.stop()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('counts initial activity and excludes post-deadline activity before a late end query', () => {
    let now = 0
    let finish!: () => void
    const collector = new MainDurabilityResiduals('private', () => now)
    const observe = collector.enroll(['baselineVerifies'])
    const probes = createMainWindowPerfProbes({
      nowMs: () => now,
      boundary: createMainResidualBoundary(createMainResidualWindows(collector)),
      createMeter: () => ({
        start: () => {
          observe('baselineVerifies')
        },
        stop: () => {},
        snapshot: () => ({}) as never
      }),
      createGapRecorder: () =>
        ({ start: () => true, finish: () => ({}), cancel: () => {}, dispose: () => {} }) as never,
      setTimer: (callback) => {
        finish = callback
        return 1
      },
      clearTimer: () => {}
    })
    probes.request({ action: 'begin', id: 'window', durationMs: 10 })
    now = 10
    finish()
    observe('baselineVerifies')
    now = 20
    const receipt = probes.request({ action: 'end', id: 'window' })
    expect(receipt).toMatchObject({
      status: 'complete',
      residuals: {
        counters: { baselineVerifies: 1 },
        aligned: false,
        boundary: { startedAtMs: 0, endedAtMs: 10 }
      }
    })
    expect(probes.request({ action: 'end', id: 'window' }).status).toBe('unavailable')
    probes.request({ action: 'begin', id: 'cancel', durationMs: 10 })
    probes.stop()
    expect(probes.request({ action: 'end', id: 'cancel' }).status).toBe('unavailable')
  })
})
