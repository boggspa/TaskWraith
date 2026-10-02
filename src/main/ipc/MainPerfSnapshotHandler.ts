import type { MainPerfInstrumentation } from '../perf/MainPerfSnapshot'
import type { MainWindowPerfRequest } from '../perf/MainWindowPerfProbes'

export function createMainPerfSnapshotHandler<Event>(ports: {
  isMainSender(event: Event): boolean
  instrumentation(): MainPerfInstrumentation | null | undefined
}) {
  return (event: Event, options?: unknown) => {
    if (!ports.isMainSender(event)) return null
    const input = options && typeof options === 'object' ? (options as Record<string, unknown>) : {}
    let window: MainWindowPerfRequest | undefined
    const request = input.window
    if (request && typeof request === 'object') {
      const value = request as Record<string, unknown>
      if (typeof value.id === 'string') {
        if (value.action === 'end') window = { action: 'end', id: value.id }
        if (value.action === 'begin' && typeof value.durationMs === 'number') {
          window = { action: 'begin', id: value.id, durationMs: value.durationMs }
        }
      }
    }
    return (
      ports
        .instrumentation()
        ?.snapshot({ resetLagWindow: input.resetLagWindow === true, window }) ?? null
    )
  }
}
