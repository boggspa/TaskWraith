/**
 * The fence between observed writes and transactional commits (Independent
 * Threads M4, slice 3).
 *
 * The legacy path learns a command's effects by capturing the Host's state
 * before and after the command and diffing the two. Reconciler passes and
 * snapshot position stamping read the state as a whole. A transactional
 * commit changes the state without being observed that way. So no commit may
 * land inside an observer's window, where the diff would charge it to the
 * observed command, and no observer may read while a commit sits between its
 * rename and its publication.
 *
 * Modes:
 * - `observer`, shared with other observers: legacy windows including setup
 *   commands, control bypasses across their captures, queued-start
 *   publication, reconciler passes (held through publish) and snapshot
 *   stamping;
 * - `committer`, shared with other committers but never beside an observer:
 *   commit, publish and refill;
 * - `exclusive`, alone: generation reset.
 *
 * Requests are served in arrival order, and a run of compatible requests at
 * the head enters together. A request that arrives while others wait queues
 * behind them even when it is compatible with the holders. So observers
 * arriving every second cannot keep a waiting committer out, and a stream of
 * committers cannot keep an observer out either. A holder must not enter
 * again before releasing; bound a wait with `signal`.
 *
 * Preparation never takes the gate. Counters per mode: entries, refusals,
 * and wait and hold durations (totals, maxima, fixed-bucket histograms).
 * The gate also reports the most requests ever waiting at once and its
 * holders' labels.
 *
 * Unwired in this slice.
 */

export type HostCommitGateMode = 'observer' | 'committer' | 'exclusive'

export const HOST_COMMIT_GATE_MODES: readonly HostCommitGateMode[] = Object.freeze([
  'observer',
  'committer',
  'exclusive'
])

/**
 * Upper bounds of the duration buckets, in ms. A sample falls in the first
 * bucket whose bound it does not exceed; one more bucket takes the rest.
 */
export const HOST_COMMIT_GATE_BUCKET_BOUNDS_MS: readonly number[] = Object.freeze([
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 30_000
])

const MAX_LABEL_LENGTH = 256

export interface HostCommitGateLease {
  readonly mode: HostCommitGateMode
  readonly label: string
  readonly released: boolean
  /** Leave the gate. Idempotent. */
  release(): void
}

export type HostCommitGateEnterResult =
  | { readonly ok: true; readonly lease: HostCommitGateLease }
  | { readonly ok: false; readonly reason: 'aborted' | 'closed' }

export interface HostCommitGateEnterRequest {
  /** Names the holder in snapshots. */
  readonly label: string
  /** Leaves the queue while still waiting; no effect once entered. */
  readonly signal?: AbortSignal
}

export interface HostCommitGateDurations {
  /** Timed samples; a failed clock read drops one. */
  readonly count: number
  readonly totalMs: number
  readonly maxMs: number
  /** One count per bound in HOST_COMMIT_GATE_BUCKET_BOUNDS_MS, then the rest. */
  readonly buckets: readonly number[]
}

export interface HostCommitGateModeCounters {
  readonly entered: number
  readonly aborted: number
  readonly closed: number
  readonly waitMs: HostCommitGateDurations
  readonly holdMs: HostCommitGateDurations
}

export interface HostCommitGateSnapshot {
  /** The holders' mode, or null when the gate is free. */
  readonly holding: HostCommitGateMode | null
  readonly holders: readonly string[]
  readonly waiting: number
  readonly maxWaiting: number
  readonly modes: Readonly<Record<HostCommitGateMode, HostCommitGateModeCounters>>
}

export interface HostCommitGateOptions {
  /** Monotonic clock seam for waits and holds; defaults to performance.now. */
  readonly now?: () => number
}

export interface HostCommitGate {
  readonly closed: boolean
  enter(
    mode: HostCommitGateMode,
    request: HostCommitGateEnterRequest
  ): Promise<HostCommitGateEnterResult>
  snapshot(): HostCommitGateSnapshot
  /** Refuse queued and new requests; holders keep the gate until they release. */
  close(): void
}

interface Waiting {
  readonly mode: HostCommitGateMode
  readonly label: string
  readonly enteredAt: number | null
  readonly settle: (result: HostCommitGateEnterResult) => void
  detach: () => void
}

interface Holder {
  readonly label: string
  readonly grantedAt: number | null
}

interface Durations {
  count: number
  totalMs: number
  maxMs: number
  readonly buckets: number[]
}

interface ModeCounters {
  entered: number
  aborted: number
  closed: number
  readonly waitMs: Durations
  readonly holdMs: Durations
}

type Refused = Extract<HostCommitGateEnterResult, { ok: false }>

const ABORTED: Refused = Object.freeze({ ok: false, reason: 'aborted' } as const)
const CLOSED: Refused = Object.freeze({ ok: false, reason: 'closed' } as const)

function isLabel(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LABEL_LENGTH) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function isMode(value: unknown): value is HostCommitGateMode {
  return HOST_COMMIT_GATE_MODES.includes(value as HostCommitGateMode)
}

function emptyDurations(): Durations {
  return {
    count: 0,
    totalMs: 0,
    maxMs: 0,
    buckets: new Array<number>(HOST_COMMIT_GATE_BUCKET_BOUNDS_MS.length + 1).fill(0)
  }
}

function addSample(durations: Durations, ms: number | null): void {
  if (ms === null) return
  durations.count += 1
  durations.totalMs += ms
  if (ms > durations.maxMs) durations.maxMs = ms
  let bucket = HOST_COMMIT_GATE_BUCKET_BOUNDS_MS.findIndex((bound) => ms <= bound)
  if (bucket < 0) bucket = HOST_COMMIT_GATE_BUCKET_BOUNDS_MS.length
  durations.buckets[bucket] += 1
}

function copyDurations(durations: Durations): HostCommitGateDurations {
  return Object.freeze({
    count: durations.count,
    totalMs: durations.totalMs,
    maxMs: durations.maxMs,
    buckets: Object.freeze([...durations.buckets])
  })
}

/** Whether a request in `mode` may enter beside the current holders. */
function compatible(
  mode: HostCommitGateMode,
  holding: HostCommitGateMode | null,
  holders: number
): boolean {
  if (holders === 0) return true
  return mode !== 'exclusive' && mode === holding
}

export function createHostCommitGate(options: HostCommitGateOptions = {}): HostCommitGate {
  const now = options.now ?? (() => performance.now())
  const holders = new Set<Holder>()
  let holding: HostCommitGateMode | null = null
  const queue: Waiting[] = []
  let maxWaiting = 0
  let closed = false
  const counters = Object.fromEntries(
    HOST_COMMIT_GATE_MODES.map((mode) => [
      mode,
      { entered: 0, aborted: 0, closed: 0, waitMs: emptyDurations(), holdMs: emptyDurations() }
    ])
  ) as Record<HostCommitGateMode, ModeCounters>

  /** A guarded clock read; null drops one timing and nothing else. */
  const readClock = (): number | null => {
    let value: unknown
    try {
      value = now()
    } catch {
      return null
    }
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  }
  const since = (from: number | null, to: number | null): number | null =>
    from === null || to === null ? null : Math.max(0, to - from)

  const refuse = (mode: HostCommitGateMode, result: Refused): HostCommitGateEnterResult => {
    counters[mode][result.reason] += 1
    return result
  }

  const grant = (mode: HostCommitGateMode, label: string, enteredAt: number | null) => {
    const grantedAt = readClock()
    const holder: Holder = { label, grantedAt }
    holders.add(holder)
    holding = mode
    counters[mode].entered += 1
    addSample(counters[mode].waitMs, since(enteredAt, grantedAt))
    let released = false
    const lease: HostCommitGateLease = {
      mode,
      label,
      get released() {
        return released
      },
      release(): void {
        if (released) return
        released = true
        holders.delete(holder)
        if (holders.size === 0) holding = null
        addSample(counters[mode].holdMs, since(holder.grantedAt, readClock()))
        pump()
      }
    }
    return lease
  }

  /** Admit the run of compatible requests at the head of the queue. */
  const pump = (): void => {
    while (queue.length > 0 && compatible(queue[0].mode, holding, holders.size)) {
      const waiting = queue.shift() as Waiting
      waiting.detach()
      waiting.settle({ ok: true, lease: grant(waiting.mode, waiting.label, waiting.enteredAt) })
    }
  }

  return {
    get closed() {
      return closed
    },
    enter(
      mode: HostCommitGateMode,
      request: HostCommitGateEnterRequest
    ): Promise<HostCommitGateEnterResult> {
      if (!isMode(mode)) throw new TypeError('HostCommitGate needs a mode')
      if (!isLabel(request?.label)) throw new TypeError('HostCommitGate needs a holder label')
      const label = request.label
      const signal = request.signal
      if (closed) return Promise.resolve(refuse(mode, CLOSED))
      if (signal?.aborted) {
        return Promise.resolve(refuse(mode, ABORTED))
      }
      const enteredAt = readClock()
      // Only an empty queue lets a request in at once: one that is merely
      // compatible with the holders still queues behind those waiting.
      if (queue.length === 0 && compatible(mode, holding, holders.size)) {
        return Promise.resolve({ ok: true, lease: grant(mode, label, enteredAt) })
      }
      return new Promise<HostCommitGateEnterResult>((resolve) => {
        const waiting: Waiting = { mode, label, enteredAt, settle: resolve, detach: () => {} }
        if (signal) {
          const onAbort = (): void => {
            const index = queue.indexOf(waiting)
            if (index < 0) return
            queue.splice(index, 1)
            resolve(refuse(mode, ABORTED))
            // The request behind it may now be compatible with the holders.
            pump()
          }
          signal.addEventListener('abort', onAbort, { once: true })
          waiting.detach = () => signal.removeEventListener('abort', onAbort)
        }
        queue.push(waiting)
        if (queue.length > maxWaiting) maxWaiting = queue.length
      })
    },
    snapshot(): HostCommitGateSnapshot {
      return Object.freeze({
        holding,
        holders: Object.freeze([...holders].map((holder) => holder.label)),
        waiting: queue.length,
        maxWaiting,
        modes: Object.freeze(
          Object.fromEntries(
            HOST_COMMIT_GATE_MODES.map((mode) => [
              mode,
              Object.freeze({
                entered: counters[mode].entered,
                aborted: counters[mode].aborted,
                closed: counters[mode].closed,
                waitMs: copyDurations(counters[mode].waitMs),
                holdMs: copyDurations(counters[mode].holdMs)
              })
            ])
          ) as Record<HostCommitGateMode, HostCommitGateModeCounters>
        )
      })
    },
    close(): void {
      if (closed) return
      closed = true
      for (const waiting of queue.splice(0, queue.length)) {
        waiting.detach()
        waiting.settle(refuse(waiting.mode, CLOSED))
      }
    }
  }
}
