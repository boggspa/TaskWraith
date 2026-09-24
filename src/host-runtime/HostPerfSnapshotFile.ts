/**
 * Opt-in bounded file transport for the Host perf snapshot (Independent
 * Threads Programme M1, Amendment A1.2).
 *
 * The M1 harness needs Host-process evidence (loop lag + work-span
 * aggregates). This opt-in writer supplies the production polling transport
 * without opening a socket or an IPC surface: on an unref'd timer it captures
 * `instrumentation.snapshot()`, serializes
 * `{ identity, sequence, capturedAt, snapshot }`, and atomically replaces one
 * well-known file (write tmp + rename). The collector reads, validates
 * identity/sequence/freshness, and only then replaces its unconfigured marker.
 *
 * Contract, in order of importance:
 * - Outside Host commands, on an unref'd timer (or explicit writeOnce).
 *   Capture, JSON.stringify and filesystem writes are still synchronous on
 *   the Host loop. maxBytes bounds only output; full snapshot materialization
 *   and serialization cost remain measurable work, not off-loop I/O.
 * - Never throws into the Host loop. A throwing snapshot provider, a
 *   non-serializable section, or a failing filesystem increments
 *   `writeFailures` and leaves the last good file in place.
 * - Bounded. A payload over `maxBytes` is degraded before it is written:
 *   first the caller-supplied extra sections are dropped, then the
 *   per-chat attribution (`byChat`) inside the workSpans section — the
 *   retained-span-derived data, the only unbounded-ish cargo — and the
 *   payload is marked `truncated: true`. If it is still over budget the
 *   write fails closed (counted, file untouched) rather than ship an
 *   over-cap artifact.
 * - Windowed at the file-write cadence. Each capture asks the shared lag
 *   meter to reset, and the transported lag block carries both its actual
 *   `observedForMs` and the writer's `configuredIntervalMs`. The first
 *   capture covers time since the meter started; a failed publication still
 *   consumed that capture, so the next file never claims to cover time since
 *   the last successful write. `windowBasis: 'since_last_reset'` names that
 *   boundary exactly.
 * - This is safe only while the file writer is the meter's sole poller. If a
 *   second poller is introduced, give the writer its own meter rather than
 *   letting either consumer reset the other's observation window.
 *
 * HostStandaloneComposition owns the production writer beside
 * `createHostPerfInstrumentation`: it starts the writer after instrumentation
 * starts and stops it during shutdown. The transport stays opt-in through the
 * standalone Host production-server configuration.
 */
import { renameSync, writeFileSync } from 'node:fs'
import type { HostPerfSnapshot } from './HostPerfSnapshot'

export interface HostPerfSnapshotFileIdentity {
  readonly process: 'host'
  /** Stable id for this Host instance (composition-chosen, e.g. a UUID). */
  readonly instanceId: string
  /**
   * The standalone composition captures its journal generation at
   * construction, not a restart counter; later resets do not update it.
   * A PID may distinguish different live processes. Sequence is local to a
   * writer and resets on recreation; neither guarantees unique boot identity.
   * The current collector does not infer restarts or check sequence monotonicity.
   * A trustworthy boot/instance epoch and collector binding remain separate,
   * unimplemented work.
   */
  readonly generation: number
  readonly pid: number
  /**
   * Public opaque boot epoch minted per standalone composition incarnation.
   * 64 lowercase hex characters. A random token compared for equality —
   * no timestamps, no counters — so PID reuse, same-ms, or backward clocks
   * are irrelevant by construction. Never the auth token.
   */
  readonly bootEpoch?: string
}

/** Injection seam; production passes node:fs. Sync keeps rename atomic. */
export interface HostPerfSnapshotFileFs {
  writeFileSync(path: string, data: string): void
  renameSync(from: string, to: string): void
}

export interface HostPerfSnapshotFileTimers {
  setInterval(callback: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export interface HostPerfSnapshotFileWriterOptions {
  /** Structural: anything exposing the HostPerfInstrumentation snapshot. */
  instrumentation: {
    snapshot(options?: { resetLagWindow?: boolean }): HostPerfSnapshot
  }
  /** Destination file; the temp sibling is `<path>.<pid>.tmp`. */
  path: string
  intervalMs: number
  maxBytes: number
  identity: HostPerfSnapshotFileIdentity
  now?: () => Date
  fs?: HostPerfSnapshotFileFs
  timers?: HostPerfSnapshotFileTimers
}

export interface HostPerfSnapshotFileWriterStats {
  readonly running: boolean
  /** Sequence of the last successfully written payload; 0 before any. */
  readonly sequence: number
  readonly writes: number
  readonly writeFailures: number
  readonly truncatedWrites: number
}

export interface HostPerfSnapshotFileWriter {
  /** Idempotent; arms the unref'd interval timer. */
  start(): void
  /** Idempotent; disarms the timer and returns final stats. */
  stop(): HostPerfSnapshotFileWriterStats
  stats(): HostPerfSnapshotFileWriterStats
  /**
   * Capture and write one snapshot immediately under the same containment
   * as a timer tick. Returns true when the file was replaced.
   */
  writeOnce(): boolean
}

interface HostPerfSnapshotFilePayload {
  identity: HostPerfSnapshotFileIdentity
  sequence: number
  capturedAt: string
  truncated?: true
  truncation?: { extraSections: boolean; byChat: boolean }
  snapshot: unknown
}

const HOST_PERF_LAG_WINDOW_BASIS = 'since_last_reset' as const

const requireNonEmptyString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`)
  }
  return value
}

const requirePositiveInteger = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return value
}

const requireNonNegativeInteger = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`)
  }
  return value
}

/** Public opaque boot epoch: 64 lowercase hex characters (32 random bytes). */
const BOOT_EPOCH_PATTERN = /^[0-9a-f]{64}$/

const requireOptionalBootEpoch = (value: unknown, label: string): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !BOOT_EPOCH_PATTERN.test(value)) {
    throw new Error(`${label} must be 64 lowercase hex characters when present.`)
  }
  return value
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const defaultFs: HostPerfSnapshotFileFs = { writeFileSync, renameSync }

const defaultTimers: HostPerfSnapshotFileTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as Parameters<typeof clearInterval>[0])
}

export function createHostPerfSnapshotFileWriter(
  options: HostPerfSnapshotFileWriterOptions
): HostPerfSnapshotFileWriter {
  const instrumentation = options.instrumentation
  if (!instrumentation || typeof instrumentation.snapshot !== 'function') {
    throw new Error('Host perf snapshot writer requires an instrumentation with snapshot().')
  }
  const path = requireNonEmptyString(options.path, 'Host perf snapshot path')
  const intervalMs = requirePositiveInteger(options.intervalMs, 'Host perf snapshot intervalMs')
  const maxBytes = requirePositiveInteger(options.maxBytes, 'Host perf snapshot maxBytes')
  const identity = options.identity
  if (!isPlainObject(identity) || identity.process !== 'host') {
    throw new Error("Host perf snapshot identity.process must be 'host'.")
  }
  // Validated before anything is frozen: a malformed epoch refuses the writer
  // at construction rather than shipping an artifact no reader can pin. The
  // conditional spread keeps the legacy payload byte-identical when absent.
  const bootEpoch = requireOptionalBootEpoch(identity.bootEpoch, 'Host perf snapshot bootEpoch')
  const frozenIdentity: HostPerfSnapshotFileIdentity = Object.freeze({
    process: 'host',
    instanceId: requireNonEmptyString(identity.instanceId, 'Host perf snapshot instanceId'),
    generation: requireNonNegativeInteger(identity.generation, 'Host perf snapshot generation'),
    pid: requirePositiveInteger(identity.pid, 'Host perf snapshot pid'),
    ...(bootEpoch === undefined ? {} : { bootEpoch })
  })
  const now = options.now ?? (() => new Date())
  const fs = options.fs ?? defaultFs
  const timers = options.timers ?? defaultTimers
  const tmpPath = `${path}.${frozenIdentity.pid}.tmp`

  let handle: unknown = null
  let sequence = 0
  let writes = 0
  let writeFailures = 0
  let truncatedWrites = 0

  const stats = (): HostPerfSnapshotFileWriterStats => ({
    running: handle !== null,
    sequence,
    writes,
    writeFailures,
    truncatedWrites
  })

  const serialize = (payload: HostPerfSnapshotFilePayload): string | null => {
    try {
      return JSON.stringify(payload)
    } catch {
      // A caller-supplied section can smuggle a circular value into the
      // snapshot; that poisons serialization, never the Host loop.
      return null
    }
  }

  const byteLength = (json: string): number => Buffer.byteLength(json, 'utf8')

  /**
   * Stage one removes only extra sections. Stage two removes attribution
   * only if the first measured candidate still exceeds the output budget.
   * Capture/stringification still run synchronously on the Host timer;
   * maxBytes bounds output, not capture cost, heap use, or loop occupancy.
   */
  const degrade = (
    payload: HostPerfSnapshotFilePayload,
    dropByChat: boolean
  ): HostPerfSnapshotFilePayload => {
    const snapshot = payload.snapshot
    let degradedSnapshot: unknown = snapshot
    if (isPlainObject(snapshot) && isPlainObject(snapshot.sections)) {
      const workSpans = snapshot.sections.workSpans
      let degradedWorkSpans = workSpans
      if (dropByChat && isPlainObject(workSpans)) {
        const { byChat: _dropped, ...rest } = workSpans
        degradedWorkSpans = rest
      }
      degradedSnapshot = {
        ...snapshot,
        sections: workSpans === undefined ? {} : { workSpans: degradedWorkSpans }
      }
    }
    return {
      ...payload,
      truncated: true,
      truncation: { extraSections: true, byChat: dropByChat },
      snapshot: degradedSnapshot
    }
  }

  const writeOnce = (): boolean => {
    // One outer boundary also contains clock/conversion failures and getters
    // supplied by an injected snapshot. Sequence advances only after rename.
    try {
      const snapshot = instrumentation.snapshot({ resetLagWindow: true })
      // Keep HostPerfSnapshot/EventLoopLagSnapshot unchanged for every other
      // caller. The file transport adds its own basis metadata so a collector
      // can distinguish the actual observation duration from the configured
      // timer cadence without pretending either is the 120 s harness window.
      const transportedSnapshot = {
        ...snapshot,
        eventLoopLag: {
          ...snapshot.eventLoopLag,
          windowBasis: HOST_PERF_LAG_WINDOW_BASIS,
          configuredIntervalMs: intervalMs
        }
      }
      const captured = now()
      const time = captured.getTime()
      const capturedAt = captured.toISOString()
      if (!Number.isFinite(time) || Date.parse(capturedAt) !== time) {
        throw new Error('Host perf snapshot clock is invalid.')
      }
      const payload: HostPerfSnapshotFilePayload = {
        identity: frozenIdentity,
        sequence: sequence + 1,
        capturedAt,
        snapshot: transportedSnapshot
      }
      let json = serialize(payload)
      if (json === null) throw new Error('Host perf snapshot is not serializable.')
      let truncated = false
      if (byteLength(json) > maxBytes) {
        json = serialize(degrade(payload, false))
        if (json === null) throw new Error('Host perf snapshot is not serializable.')
        if (byteLength(json) > maxBytes) json = serialize(degrade(payload, true))
        if (json === null || byteLength(json) > maxBytes) {
          // Keep the last good artifact; never publish an oversized candidate.
          throw new Error('Host perf snapshot exceeds its output cap.')
        }
        truncated = true
      }
      fs.writeFileSync(tmpPath, json)
      fs.renameSync(tmpPath, path)
      sequence += 1
      writes += 1
      if (truncated) truncatedWrites += 1
      return true
    } catch {
      writeFailures += 1
      return false
    }
  }

  const start = (): void => {
    if (handle !== null) return
    const created = timers.setInterval(() => {
      writeOnce()
    }, intervalMs)
    handle = created ?? true
    const maybeUnref = created as { unref?: () => void } | null | undefined
    if (maybeUnref && typeof maybeUnref.unref === 'function') {
      try {
        maybeUnref.unref()
      } catch {
        // An exotic injected timer without a working unref stays armed;
        // that costs liveness on exit, never correctness.
      }
    }
  }

  const stop = (): HostPerfSnapshotFileWriterStats => {
    if (handle !== null) {
      const current = handle
      handle = null
      if (current !== true) {
        try {
          timers.clearInterval(current)
        } catch {
          // Same rule: a broken injected seam cannot throw into shutdown.
        }
      }
    }
    return stats()
  }

  return { start, stop, stats, writeOnce }
}
