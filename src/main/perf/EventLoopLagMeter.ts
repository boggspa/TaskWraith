/**
 * Main-process event-loop lag meter (perf-epic T1 instrumentation).
 *
 * The multi-ensemble stall class this epic exists for is main-thread
 * saturation: synchronous persistence work multiplied by concurrent run
 * count. Every prior diagnosis needed a hand-attached profiler on a live
 * repro; nothing in the product could say "the main loop was blocked for
 * 480 ms at 14:02". This meter is the missing number.
 *
 * `monitorEventLoopDelay` is a native sampler: it timestamps timer wakeups
 * off-thread and histograms the delta, so it observes blockage without
 * adding main-thread work per sample. Overhead is a single idle timer at
 * `resolution` ms. Percentiles come back in nanoseconds; everything this
 * module exposes is milliseconds.
 *
 * The meter is deliberately dumb: start/stop/snapshot. Attribution (WHICH
 * save/journal/broadcast was hot) belongs to the per-subsystem counters the
 * store already keeps (`IncrementalChatPersistenceStats`, delivery-protocol
 * counters); the composition root bundles those with a snapshot when the
 * Introspection surface polls. Windowing is the caller's choice: pass
 * `reset: true` to make each snapshot cover only the interval since the
 * last one.
 */
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'

export interface EventLoopLagSnapshot {
  /** Milliseconds the sampler has been observing since the last reset. */
  observedForMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
  /** Mean lag; useful as a cheap saturation trend line. */
  meanMs: number
  /** True while the underlying histogram is actively sampling. */
  sampling: boolean
}

export interface EventLoopLagMeter {
  start(): void
  stop(): void
  /** Read current percentiles; `reset` makes the next snapshot windowed. */
  snapshot(options?: { reset?: boolean }): EventLoopLagSnapshot
}

export interface EventLoopLagMeterOptions {
  /** Sampler resolution in milliseconds (native default is 10). */
  resolutionMs?: number
  now?: () => number
  /** Test seam; production always uses the native histogram. */
  createHistogram?: (resolutionMs: number) => IntervalHistogram
}

const NS_PER_MS = 1e6

function toMs(nanoseconds: number): number {
  if (!Number.isFinite(nanoseconds) || nanoseconds <= 0) return 0
  return nanoseconds / NS_PER_MS
}

export function createEventLoopLagMeter(options: EventLoopLagMeterOptions = {}): EventLoopLagMeter {
  const resolutionMs = Math.max(1, Math.floor(options.resolutionMs ?? 10))
  const now = options.now ?? (() => Date.now())
  const histogram = (options.createHistogram ?? ((r) => monitorEventLoopDelay({ resolution: r })))(
    resolutionMs
  )
  let sampling = false
  let windowStartedAt = now()

  const start = (): void => {
    if (sampling) return
    histogram.reset()
    histogram.enable()
    sampling = true
    windowStartedAt = now()
  }

  const stop = (): void => {
    if (!sampling) return
    histogram.disable()
    sampling = false
  }

  const snapshot = (snapshotOptions?: { reset?: boolean }): EventLoopLagSnapshot => {
    const result: EventLoopLagSnapshot = {
      observedForMs: sampling ? Math.max(0, now() - windowStartedAt) : 0,
      p50Ms: toMs(histogram.percentile(50)),
      p95Ms: toMs(histogram.percentile(95)),
      p99Ms: toMs(histogram.percentile(99)),
      maxMs: toMs(histogram.max),
      meanMs: toMs(histogram.mean),
      sampling
    }
    if (snapshotOptions?.reset) {
      histogram.reset()
      windowStartedAt = now()
    }
    return result
  }

  return { start, stop, snapshot }
}
