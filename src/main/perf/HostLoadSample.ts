/**
 * HostLoadSample — the host-side half of "is TaskWraith slow, or is the Mac?".
 *
 * `MainPerfSnapshot` already answers THAT main stalled (the event-loop lag
 * histogram) and WHICH pipeline was hot in the same window (the section
 * counters). Neither can separate those from a box that was simply
 * oversubscribed: a red G-lag gate reads identically whether the regression is
 * ours, or whether a build, a local model and three other agents were competing
 * for the same cores. The ambiguity is not academic — main-thread slowness in
 * this app has repeatedly been investigated from the wrong end, because the
 * plausible half of an ambiguous signal is the half that gets debugged.
 *
 * Every field is a point-in-time read of an OS counter: no I/O, nothing that
 * can block, no allocation beyond the returned record. That matters because the
 * only moment anyone reads this is from inside a snapshot that is trying to
 * measure a stall.
 *
 * MEASURED 2026-08-20, and the reason this file gained a CPU reading: on a
 * 10-core Mac13,1 a 1-minute load average of 12.9 sat beside 37% IDLE CPU while
 * the disk ran 1350-1730 tps. macOS load counts threads blocked on I/O, so
 * `loadPerCpu1m` above 1 does NOT establish CPU contention — and a boolean
 * derived from load alone said "contended" about a host with a third of its CPU
 * doing nothing. `hostContended` therefore reads CPU utilisation now, and
 * `loadIsNotCpuBound` names the discrepancy directly so the next reader does
 * not have to rediscover it.
 *
 * CPU time is CUMULATIVE at the source — `process.cpuUsage()` counts from
 * launch — so one reading says nothing about the window that just stalled. The
 * sampler holds the previous reading and reports the RATE across the interval
 * between them. That is the number worth having, and it is the whole reason
 * this is a stateful sampler rather than a free function.
 *
 * TOTALITY CONTRACT: `sample()` never throws. Diagnostics that fail under the
 * load they exist to diagnose are worse than no diagnostics, so every reading
 * is individually guarded and degrades to a null/fallback field rather than
 * taking the enclosing snapshot down. `MainPerfSnapshot` relies on this and
 * calls it without a try/catch; `HostLoadSample.test.ts` pins it.
 */
import * as os from 'node:os'

/**
 * Platforms where `os.loadavg()` is a documented stub that returns zeros.
 *
 * Reporting those zeros as real load would read as a perfectly idle host and
 * send the next investigation the wrong way — precisely the failure this module
 * exists to prevent — so they are surfaced as "not reported", not as 0.
 */
const PLATFORMS_WITHOUT_LOAD_AVERAGE: ReadonlySet<NodeJS.Platform> = new Set(['win32'])

const MICROSECONDS_PER_MS = 1_000

/**
 * Load-per-core at or above which the run queue is longer than the machine is
 * wide. NOT a CPU-contention threshold on macOS — see `loadIsNotCpuBound`.
 */
export const HOST_CONTENDED_LOAD_PER_CPU = 1

/**
 * Machine-wide CPU utilisation at or above which cores are treated as
 * contended. A heuristic starting point, not a measurement; `cpuBusyPercent`
 * is the ground truth — read it rather than the boolean when the answer matters.
 */
export const HOST_CONTENDED_CPU_BUSY_PERCENT = 85

/**
 * CPU utilisation below which load is considered NOT explained by CPU demand.
 * Deliberately well under the contended threshold: the gap between the two is
 * an "unclear" band rather than a claim in either direction.
 */
export const LOAD_NOT_CPU_BOUND_CPU_BUSY_PERCENT = 70

export interface HostLoadSnapshot {
  /**
   * 1-minute load average divided by usable cores — the headline number.
   * Comfortably below 1 means the host had headroom and a lag spike is ours;
   * meaningfully above it means the run queue was long and some of the lag was
   * the box. Null where the platform does not report load.
   */
  loadPerCpu1m: number | null
  loadAverage1m: number | null
  loadAverage5m: number | null
  loadAverage15m: number | null
  /** See `PLATFORMS_WITHOUT_LOAD_AVERAGE`. False means the fields above are unknown, not zero. */
  loadAverageReported: boolean
  /**
   * Machine-wide CPU busy across the interval since the previous sample, as a
   * percentage of all cores (0-100), from `os.cpus()` tick deltas. Null on the
   * first sample. THIS, not the load average, is the CPU-contention signal.
   */
  cpuBusyPercent: number | null
  /**
   * `cpuBusyPercent >= HOST_CONTENDED_CPU_BUSY_PERCENT` — are the CORES
   * contended? Null until a second sample exists. Deliberately not derived from
   * the load average; see the header.
   */
  hostContended: boolean | null
  /**
   * Load says the run queue is long while the CPU says it is mostly idle — so
   * the pressure is elsewhere (on this host, disk I/O). When true, CPU-priority
   * levers such as nice(2) will not help; I/O-aware ones (macOS `taskpolicy -b`)
   * or removing blocking I/O from the thread will. Null while either input is
   * unknown, and false in the band between the two thresholds, which claims
   * nothing.
   */
  loadIsNotCpuBound: boolean | null
  /** Cores available to this process, honouring cgroup quota and CPU affinity. */
  cpuCount: number
  /**
   * Main-process CPU across the interval since the previous sample, as a
   * percentage of ONE core. Routinely exceeds 100 and should: V8's background
   * compiler and GC threads and the libuv pool all count against it. Null on
   * the first sample, which has no interval behind it.
   */
  processCpuPercent: number | null
  /** Interval the rate covers. Null on the first sample. */
  processCpuWindowMs: number | null
  /** Cumulative main-process CPU since launch, for absolute comparisons. */
  processCpuUserMs: number
  processCpuSystemMs: number
}

export interface HostLoadSampler {
  /** Read the counters. Never throws — see the TOTALITY CONTRACT above. */
  sample(): HostLoadSnapshot
}

export interface HostLoadSamplerOptions {
  loadAverage?: () => number[]
  /** Cumulative per-core tick counters; production uses `os.cpus()`. */
  cpuTimes?: () => ReadonlyArray<{
    times: { user: number; nice: number; sys: number; idle: number; irq: number }
  }>
  cpuCount?: () => number
  cpuUsage?: () => NodeJS.CpuUsage
  now?: () => number
  /** Test seam; production reads `process.platform`. */
  platform?: NodeJS.Platform
}

/** Finite numbers only; anything else is unknown rather than zero. */
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/**
 * `availableParallelism` honours cgroup quotas and CPU affinity; `cpus().length`
 * reports the whole machine regardless of what this process may actually use.
 * The latter is a fallback only, for runtimes predating the former.
 */
function defaultCpuCount(): number {
  if (typeof os.availableParallelism === 'function') return os.availableParallelism()
  return os.cpus().length
}

/** Guarded read: a throwing seam yields the fallback, never an exception. */
function safely<T>(read: () => T, fallback: T): T {
  try {
    const value = read()
    return value === undefined || value === null ? fallback : value
  } catch {
    return fallback
  }
}

export function createHostLoadSampler(options: HostLoadSamplerOptions = {}): HostLoadSampler {
  const platform = options.platform ?? process.platform
  const readLoadAverage = options.loadAverage ?? (() => os.loadavg())
  const readCpuCount = options.cpuCount ?? defaultCpuCount
  const readCpuUsage = options.cpuUsage ?? (() => process.cpuUsage())
  const readCpuTimes = options.cpuTimes ?? (() => os.cpus())
  const now = options.now ?? (() => Date.now())

  const loadAverageReported = !PLATFORMS_WITHOUT_LOAD_AVERAGE.has(platform)

  let previousCpu: NodeJS.CpuUsage | null = null
  let previousCpuAt = 0
  let previousHostTicks: { busy: number; total: number } | null = null

  const sample = (): HostLoadSnapshot => {
    const rawCpuCount = finiteOrNull(safely(readCpuCount, 1))
    const cpuCount = Math.max(1, Math.floor(rawCpuCount ?? 1))

    const rawLoad = loadAverageReported ? safely(readLoadAverage, []) : []
    const loadAverage1m = Array.isArray(rawLoad) ? finiteOrNull(rawLoad[0]) : null
    const loadAverage5m = Array.isArray(rawLoad) ? finiteOrNull(rawLoad[1]) : null
    const loadAverage15m = Array.isArray(rawLoad) ? finiteOrNull(rawLoad[2]) : null
    const loadPerCpu1m = loadAverage1m === null ? null : round(loadAverage1m / cpuCount, 2)

    // Machine-wide utilisation from cumulative tick counters. Summed across
    // cores, so the result is a share of the WHOLE machine, not of one core.
    const cores = safely(readCpuTimes, [] as ReturnType<typeof readCpuTimes>)
    let hostTicks: { busy: number; total: number } | null = null
    if (Array.isArray(cores) && cores.length > 0) {
      let busy = 0
      let total = 0
      for (const core of cores) {
        const t = core?.times
        if (!t) continue
        const idle = finiteOrNull(t.idle) ?? 0
        const active =
          (finiteOrNull(t.user) ?? 0) +
          (finiteOrNull(t.nice) ?? 0) +
          (finiteOrNull(t.sys) ?? 0) +
          (finiteOrNull(t.irq) ?? 0)
        busy += active
        total += active + idle
      }
      if (total > 0) hostTicks = { busy, total }
    }
    let cpuBusyPercent: number | null = null
    if (hostTicks && previousHostTicks) {
      const totalDelta = hostTicks.total - previousHostTicks.total
      const busyDelta = hostTicks.busy - previousHostTicks.busy
      // A non-positive span means the counters did not advance (or wrapped);
      // report nothing rather than a fabricated ratio.
      if (totalDelta > 0 && busyDelta >= 0) {
        cpuBusyPercent = round(Math.min(100, (busyDelta / totalDelta) * 100), 2)
      }
    }
    if (hostTicks) previousHostTicks = hostTicks

    const cpu = safely(readCpuUsage, { user: 0, system: 0 })
    const cpuUserMicros = finiteOrNull(cpu.user) ?? 0
    const cpuSystemMicros = finiteOrNull(cpu.system) ?? 0
    const at = finiteOrNull(safely(now, 0)) ?? 0

    let processCpuPercent: number | null = null
    let processCpuWindowMs: number | null = null
    if (previousCpu) {
      const windowMs = at - previousCpuAt
      // A non-positive window means the clock moved backwards or two samples
      // landed in the same millisecond; report no rate rather than a wild one.
      if (windowMs > 0) {
        const busyMicros = cpuUserMicros - previousCpu.user + (cpuSystemMicros - previousCpu.system)
        const busyMs = busyMicros / MICROSECONDS_PER_MS
        processCpuPercent = round(Math.max(0, (busyMs / windowMs) * 100), 2)
        processCpuWindowMs = round(windowMs, 0)
      }
    }
    previousCpu = { user: cpuUserMicros, system: cpuSystemMicros }
    previousCpuAt = at

    return {
      loadPerCpu1m,
      loadAverage1m: loadAverage1m === null ? null : round(loadAverage1m, 2),
      loadAverage5m: loadAverage5m === null ? null : round(loadAverage5m, 2),
      loadAverage15m: loadAverage15m === null ? null : round(loadAverage15m, 2),
      loadAverageReported,
      cpuBusyPercent,
      hostContended:
        cpuBusyPercent === null ? null : cpuBusyPercent >= HOST_CONTENDED_CPU_BUSY_PERCENT,
      loadIsNotCpuBound:
        loadPerCpu1m === null || cpuBusyPercent === null
          ? null
          : loadPerCpu1m >= HOST_CONTENDED_LOAD_PER_CPU &&
            cpuBusyPercent < LOAD_NOT_CPU_BOUND_CPU_BUSY_PERCENT,
      cpuCount,
      processCpuPercent,
      processCpuWindowMs,
      processCpuUserMs: round(cpuUserMicros / MICROSECONDS_PER_MS, 0),
      processCpuSystemMs: round(cpuSystemMicros / MICROSECONDS_PER_MS, 0)
    }
  }

  return { sample }
}
