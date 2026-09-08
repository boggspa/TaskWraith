/**
 * Opt-in bounded file transport for the Host perf snapshot (Independent
 * Threads Programme M1, Amendment A1.2).
 *
 * The M1 harness needs Host-process evidence (loop lag + work-span
 * aggregates) but the Host has no polling transport: the collector ships
 * `hostPerf: { unsupported: 'host_perf_transport_unspecified' }` on every
 * path. This writer closes that gap without opening a socket or an IPC
 * surface: on an unref'd timer it captures `instrumentation.snapshot()`,
 * serializes `{ identity, sequence, capturedAt, snapshot }`, and atomically
 * replaces one well-known file (write tmp + rename). The collector reads,
 * validates identity/sequence/freshness, and only then replaces its
 * unsupported marker.
 *
 * Contract, in order of importance:
 * - OFF the hot path. Capture, serialize and write happen inside the timer
 *   callback only; nothing runs inside a Host command. The timer is unref'd
 *   so an idle Host can still exit.
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
 * - Passive. The snapshot is captured with `resetLagWindow: false`; this
 *   transport must not steal lag-window data from other pollers.
 *
 * Wiring stays with the composition root (HostStandaloneComposition is
 * claimed by the startup-redesign session): construct beside
 * `createHostPerfInstrumentation`, `start()` after it starts, `stop()` on
 * shutdown. Until then this module is exercised only by its tests.
 */
import { renameSync, writeFileSync } from 'node:fs'
import type { HostPerfSnapshot } from './HostPerfSnapshot'

export interface HostPerfSnapshotFileIdentity {
  readonly process: 'host'
  /** Stable id for this Host instance (composition-chosen, e.g. a UUID). */
  readonly instanceId: string
  /** Monotonic restart generation; lets the reader spot a stale artifact. */
  readonly generation: number
  readonly pid: number
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
  snapshot: unknown
}

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
  const frozenIdentity: HostPerfSnapshotFileIdentity = Object.freeze({
    process: 'host',
    instanceId: requireNonEmptyString(identity.instanceId, 'Host perf snapshot instanceId'),
    generation: requireNonNegativeInteger(identity.generation, 'Host perf snapshot generation'),
    pid: requirePositiveInteger(identity.pid, 'Host perf snapshot pid')
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
   * Degrade an over-budget payload: keep only the workSpans section, then
   * strip its byChat attribution. Aggregates and counters — the exact
   * coverage evidence — are always the last thing standing.
   */
  const degrade = (payload: HostPerfSnapshotFilePayload): HostPerfSnapshotFilePayload => {
    const snapshot = payload.snapshot
    let degradedSnapshot: unknown = snapshot
    if (isPlainObject(snapshot) && isPlainObject(snapshot.sections)) {
      const sections = snapshot.sections
      const workSpans = sections.workSpans
      let degradedWorkSpans: unknown = workSpans
      if (isPlainObject(workSpans) && 'byChat' in workSpans) {
        const { byChat: _dropped, ...rest } = workSpans
        degradedWorkSpans = rest
      }
      degradedSnapshot = {
        ...snapshot,
        sections: workSpans === undefined ? {} : { workSpans: degradedWorkSpans }
      }
    }
    return { ...payload, truncated: true, snapshot: degradedSnapshot }
  }

  const writeOnce = (): boolean => {
    let snapshot: HostPerfSnapshot
    try {
      snapshot = instrumentation.snapshot({ resetLagWindow: false })
    } catch {
      writeFailures += 1
      return false
    }
    const payload: HostPerfSnapshotFilePayload = {
      identity: frozenIdentity,
      sequence: sequence + 1,
      capturedAt: now().toISOString(),
      snapshot
    }
    let json = serialize(payload)
    if (json === null) {
      writeFailures += 1
      return false
    }
    let truncated = false
    if (byteLength(json) > maxBytes) {
      json = serialize(degrade(payload))
      if (json === null || byteLength(json) > maxBytes) {
        // Still over budget: fail closed and keep the last good artifact
        // rather than publish an over-cap file the reader must distrust.
        writeFailures += 1
        return false
      }
      truncated = true
    }
    try {
      fs.writeFileSync(tmpPath, json)
      fs.renameSync(tmpPath, path)
    } catch {
      writeFailures += 1
      return false
    }
    sequence += 1
    writes += 1
    if (truncated) truncatedWrites += 1
    return true
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
