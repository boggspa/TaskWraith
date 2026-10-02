import type { MainPerfInstrumentation } from './MainPerfSnapshot'
import type { createMainResidualWindows } from '../store/MainResidualWindows'
import type { MainWindowBoundaryPort } from './MainWindowPerfProbes'

export function createMainResidualBoundary(
  windows: ReturnType<typeof createMainResidualWindows>
): MainWindowBoundaryPort {
  let started: { id: string; at: number; clock: unknown } | undefined
  return {
    begin(id, at, clock) {
      windows.begin(id)
      started = { id, at, clock }
    },
    finish(id, at) {
      const held = started
      started = undefined
      if (!held || held.id !== id) {
        windows.cancel()
        throw new Error('Residual boundary mismatch')
      }
      const delta = windows.end(id)
      return {
        ...delta,
        intervalCoverage: 'diagnostic-boundary-sampling',
        boundary: { startedAtMs: held.at, endedAtMs: at, clock: held.clock },
        // Sampling is synchronous at the boundary but its own clock reads
        // occur just after the probe timestamp; exact equality is unproven.
        aligned: false
      }
    },
    cancel() {
      started = undefined
      windows.cancel()
    }
  }
}

export function bindMainResidualInstrumentation(
  instrumentation: MainPerfInstrumentation,
  windows: ReturnType<typeof createMainResidualWindows>
): MainPerfInstrumentation {
  return {
    start: () => instrumentation.start(),
    stop: () => {
      windows.cancel()
      instrumentation.stop()
    },
    snapshot: (options) => {
      let snapshot: ReturnType<MainPerfInstrumentation['snapshot']>
      try {
        snapshot = instrumentation.snapshot(options)
      } catch (error) {
        windows.cancel()
        throw error
      }
      if (snapshot.window?.status === 'complete') {
        snapshot.sections.mainDurabilityResiduals = snapshot.window.residuals ?? {
          unavailable: true
        }
      }
      return snapshot
    }
  }
}
