/**
 * One pollable bundle for "is the main process healthy, and if not, who is
 * eating it": the event-loop lag histogram beside the per-subsystem counters
 * the store already keeps. The lag number says THAT main stalled; the section
 * counters (save coalescing, incremental journal, delivery protocol, utility
 * write queue) say WHICH pipeline was hot in the same window. The perf-epic
 * ADR's G-lag gate (main event-loop lag p95 < 25 ms under 30-seat continuous)
 * reads straight off this snapshot.
 *
 * Section providers are read-only closures supplied by the composition root.
 * A provider failure must never take the snapshot down — diagnostics that
 * crash under the load they exist to diagnose are worse than none — so each
 * section degrades to an `{ error }` marker independently.
 */
import {
  createEventLoopLagMeter,
  type EventLoopLagMeter,
  type EventLoopLagSnapshot
} from './EventLoopLagMeter'

export interface MainPerfSnapshot {
  capturedAt: string
  eventLoopLag: EventLoopLagSnapshot
  sections: Record<string, unknown>
}

export interface MainPerfInstrumentation {
  start(): void
  stop(): void
  snapshot(options?: { resetLagWindow?: boolean }): MainPerfSnapshot
}

export interface MainPerfInstrumentationOptions {
  sections?: Record<string, () => unknown>
  /** Injection seam for tests; production uses the native sampler. */
  meter?: EventLoopLagMeter
  now?: () => Date
}

export function createMainPerfInstrumentation(
  options: MainPerfInstrumentationOptions = {}
): MainPerfInstrumentation {
  const meter = options.meter ?? createEventLoopLagMeter()
  const now = options.now ?? (() => new Date())
  const sections = options.sections ?? {}

  const snapshot = (snapshotOptions?: { resetLagWindow?: boolean }): MainPerfSnapshot => {
    const collected: Record<string, unknown> = {}
    for (const [name, provider] of Object.entries(sections)) {
      try {
        collected[name] = provider() ?? null
      } catch (error) {
        collected[name] = { error: error instanceof Error ? error.message : String(error) }
      }
    }
    return {
      capturedAt: now().toISOString(),
      eventLoopLag: meter.snapshot({ reset: snapshotOptions?.resetLagWindow }),
      sections: collected
    }
  }

  return {
    start: () => meter.start(),
    stop: () => meter.stop(),
    snapshot
  }
}
