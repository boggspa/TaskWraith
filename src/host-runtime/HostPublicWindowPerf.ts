import {
  HOST_COMMIT_GATE_BUCKET_BOUNDS_MS,
  HOST_COMMIT_GATE_MODES,
  type HostCommitGate,
  type HostCommitGateDurations
} from './HostCommitGate'
import type { HostPublicWindowFeeder } from './HostPublicWindowFeeder'
import type { HostPublicWindowIndex } from './HostPublicWindowIndex'

/** Live transaction services, never copies or a second diagnostic-only gate. */
export interface HostPublicWindowPerfSources {
  readonly gate: Pick<HostCommitGate, 'snapshot'>
  readonly feeder: Pick<HostPublicWindowFeeder, 'counters'>
  readonly index: Pick<HostPublicWindowIndex, 'diagnostics'>
}

export const HOST_PERF_GATE_HOLDER_LIMIT = 32
export const HOST_PERF_GATE_LABEL_LIMIT = 128

function metric(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error('invalid_metric')
  return value
}

function durations(value: HostCommitGateDurations): unknown {
  const bucketCount = HOST_COMMIT_GATE_BUCKET_BOUNDS_MS.length + 1
  if (value.buckets.length !== bucketCount) throw new Error('invalid_histogram')
  return {
    count: metric(value.count),
    totalMs: metric(value.totalMs),
    maxMs: metric(value.maxMs),
    buckets: Array.from({ length: bucketCount }, (_, i) => metric(value.buckets[i]))
  }
}

/**
 * Fixed-shape projections of the actual production snapshots. Each section
 * fails independently, including a throwing source getter. Error text is
 * deliberately constant: diagnostic exceptions must not enlarge the capture
 * or invoke an arbitrary thrown object's string conversion. Sampling takes no
 * locks, publishes nothing and never enables the transaction flag.
 */
export function createHostPublicWindowPerfSections(
  sources: () => HostPublicWindowPerfSources | null
): Record<string, () => unknown> {
  const section = (read: (live: HostPublicWindowPerfSources) => unknown): (() => unknown) => {
    return () => {
      try {
        const live = sources()
        return live ? read(live) : { available: false }
      } catch {
        return { error: 'snapshot_failed' }
      }
    }
  }

  return {
    commitGate: section(({ gate }) => {
      const snapshot = gate.snapshot()
      return {
        holding: snapshot.holding,
        holderCount: snapshot.holders.length,
        holders: snapshot.holders
          .slice(0, HOST_PERF_GATE_HOLDER_LIMIT)
          .map((label) => label.slice(0, HOST_PERF_GATE_LABEL_LIMIT)),
        omittedHolders: Math.max(0, snapshot.holders.length - HOST_PERF_GATE_HOLDER_LIMIT),
        waiting: metric(snapshot.waiting),
        maxWaiting: metric(snapshot.maxWaiting),
        bucketBoundsMs: [...HOST_COMMIT_GATE_BUCKET_BOUNDS_MS],
        modes: Object.fromEntries(
          HOST_COMMIT_GATE_MODES.map((mode) => {
            const counters = snapshot.modes[mode]
            return [
              mode,
              {
                entered: metric(counters.entered),
                aborted: metric(counters.aborted),
                closed: metric(counters.closed),
                waitMs: durations(counters.waitMs),
                holdMs: durations(counters.holdMs)
              }
            ]
          })
        )
      }
    }),
    publicWindowFeeder: section(({ feeder }) => {
      const counters = feeder.counters()
      return {
        drained: metric(counters.drained),
        absent: metric(counters.absent),
        invalid: metric(counters.invalid),
        refused: metric(counters.refused),
        ignored: metric(counters.ignored),
        rejected: metric(counters.rejected),
        resets: metric(counters.resets),
        failures: metric(counters.failures),
        eager: metric(counters.eager),
        eagerMs: metric(counters.eagerMs),
        refills: metric(counters.refills),
        refillReads: metric(counters.refillReads),
        refillFailures: metric(counters.refillFailures),
        refillsScheduled: metric(counters.refillsScheduled),
        refillsAbandoned: metric(counters.refillsAbandoned),
        absorbRounds: metric(counters.absorbRounds),
        suppressed: metric(counters.suppressed)
      }
    }),
    publicWindowIndex: section(({ index }) => {
      const diagnostics = index.diagnostics()
      return {
        threads: metric(diagnostics.threads),
        keptRuns: metric(diagnostics.keptRuns),
        trimmedThreads: metric(diagnostics.trimmedThreads)
      }
    })
  }
}
