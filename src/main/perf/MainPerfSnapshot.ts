/**
 * One pollable bundle for "is the main process healthy, and if not, who is
 * eating it": the event-loop lag histogram beside the per-subsystem counters
 * the store already keeps. The lag number says THAT main stalled; the section
 * counters (save coalescing, incremental journal, delivery protocol, utility
 * write queue) say WHICH pipeline was hot in the same window. The perf-epic
 * ADR's G-lag gate (main event-loop lag p95 < 25 ms under 30-seat continuous)
 * reads straight off this snapshot.
 *
 * The third leg is `host`: whether the Mac itself had headroom in that same
 * window. Without it the lag number is ambiguous in the one direction that
 * matters — our own regression and an oversubscribed box produce the same red
 * gate — and the ambiguity resolves by guesswork. `HostLoadSample.sample()` is
 * total by contract, so it is called without a guard; sections are not, and
 * still degrade individually below.
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
import {
  createHostLoadSampler,
  type HostLoadSampler,
  type HostLoadSnapshot
} from './HostLoadSample'
import {
  createMainWindowPerfProbes,
  type MainWindowPerfRequest,
  type MainWindowPerfReceipt
} from './MainWindowPerfProbes'
import type { MainSuspensionProtection } from './MainLoopGapRecorder'

export interface MainPerfSnapshotOptions {
  resetLagWindow?: boolean
  window?: MainWindowPerfRequest
}

export interface MainPerfSnapshot {
  capturedAt: string
  eventLoopLag: EventLoopLagSnapshot
  /** Host contention over the same window — is the lag ours, or the machine's? */
  host: HostLoadSnapshot
  sections: Record<string, unknown>
  window?: MainWindowPerfReceipt
}

export interface MainPerfInstrumentation {
  start(): void
  stop(): void
  snapshot(options?: MainPerfSnapshotOptions): MainPerfSnapshot
}

export interface MainPerfInstrumentationOptions {
  sections?: Record<string, () => unknown>
  /** Injection seam for tests; production uses the native sampler. */
  meter?: EventLoopLagMeter
  /** Injection seam for tests; production reads the real OS counters. */
  hostLoad?: HostLoadSampler
  now?: () => Date
  windowProbes?: ReturnType<typeof createMainWindowPerfProbes>
  acquireWindowProtection?: () => MainSuspensionProtection
}

export function createMainPerfInstrumentation(
  options: MainPerfInstrumentationOptions = {}
): MainPerfInstrumentation {
  const meter = options.meter ?? createEventLoopLagMeter()
  const hostLoad = options.hostLoad ?? createHostLoadSampler()
  const now = options.now ?? (() => new Date())
  const sections = options.sections ?? {}
  const windowProbes =
    options.windowProbes ??
    createMainWindowPerfProbes({
      acquireProtection: options.acquireWindowProtection,
      readDurability: () => sections.mainDurability?.() ?? null
    })

  const snapshot = (snapshotOptions?: MainPerfSnapshotOptions): MainPerfSnapshot => {
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
      // Rates window between calls, so on a fixed poll cadence this covers the
      // same interval as a reset-windowed lag reading.
      host: hostLoad.sample(),
      sections: collected,
      ...(snapshotOptions?.window ? { window: windowProbes.request(snapshotOptions.window) } : {})
    }
  }

  return {
    start: () => meter.start(),
    stop: () => {
      try {
        meter.stop()
      } finally {
        windowProbes.stop()
      }
    },
    snapshot
  }
}
