/**
 * Ordered, cooperative intake for one provider output stream.
 *
 * Stream callbacks must not hold the Cocoa / Electron main loop for seconds, so
 * each stream gets a G-lag budget per loop turn. Once it is spent, whatever is
 * left waits for the next macrotask. The budget belongs to the TURN, not to a
 * call: a reader that hands over one line at a time (readline, a JSON-RPC
 * decoder) is paced exactly like one that hands over a whole chunk.
 *
 * What waits stays at the head of ONE queue per stream, and output that arrives
 * meanwhile queues behind it. A pump per chunk cannot give that guarantee — the
 * newer chunk's first turn runs ahead of the older chunk's deferred lines, and
 * whatever is still deferred when the child closes is handled after the run's
 * terminal projection.
 *
 * The backlog is bounded by pausing the source, never by dropping output or
 * failing the run: a paused child simply blocks on its own stdout, which is
 * the same pressure a synchronous handler applied by not returning.
 */

export const COOPERATIVE_STREAM_TURN_BUDGET_MS = 25
export const ORDERED_STREAM_PUMP_HIGH_WATER_ITEMS = 1024
export const ORDERED_STREAM_PUMP_LOW_WATER_ITEMS = 256
export const ORDERED_STREAM_PUMP_HIGH_WATER_CHARS = 4 * 1024 * 1024
export const ORDERED_STREAM_PUMP_LOW_WATER_CHARS = 1024 * 1024

const COMPACT_MIN_HANDLED_ITEMS = 1024

// Pacing depends on the wall clock, and a unit test of a provider client must
// not: one long GC pause inside a visit would defer the very output the test's
// next line asserts on. Under test a pump therefore handles output on arrival
// unless the test turns pacing on, which every test of the pacing itself does.
let pacedByDefault = process.env.NODE_ENV !== 'test'

export function setOrderedStreamPumpPacingForTest(paced: boolean): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Ordered stream pump pacing can only be switched in tests.')
  }
  pacedByDefault = paced
}

/** The readable half of a child pipe; anything with the same two verbs works. */
export interface OrderedStreamPumpSource {
  pause(): unknown
  resume(): unknown
}

export interface OrderedStreamPumpOptions<T> {
  /** Counter group. Use the provider id so the set of groups stays closed. */
  label: string
  visit: (item: T) => void
  /** Paused while the backlog is over its high-water mark. Absent: unbounded. */
  source?: OrderedStreamPumpSource | null
  /** Backlog weight of one item. Defaults to a string's length, else zero. */
  sizeOf?: (item: T) => number
  /**
   * Receives an error thrown by `visit` during `flush()`, where it must not
   * reach the caller's terminal path. Defaults to rethrowing it on a later
   * macrotask so it stays as loud as an error thrown from a stream callback.
   */
  onFlushVisitError?: (error: unknown) => void
  budgetMs?: number
  highWaterItems?: number
  lowWaterItems?: number
  highWaterChars?: number
  lowWaterChars?: number
  now?: () => number
  schedule?: (resume: () => void) => void
}

export interface OrderedStreamPump<T> {
  /** Queue one item behind everything already waiting. */
  push(item: T): void
  /** Queue several items, in order, behind everything already waiting. */
  pushAll(items: readonly T[]): void
  /**
   * Handle everything still waiting, in order, before returning. Call it first
   * in the stream's close/exit path: terminal projection must never overtake
   * output the child already wrote. Never throws.
   */
  flush(): void
  /** Items waiting to be handled. */
  readonly pending: number
}

export interface OrderedStreamPumpCounters {
  /** Pumps created under this label. */
  pumps: number
  /** Items queued. */
  pushed: number
  /** Items handled. */
  visited: number
  /** Loop turns that ran out of budget with output still waiting. */
  yields: number
  /** `flush()` calls that found a backlog. */
  flushes: number
  /** Items handled by `flush()` rather than by a paced turn. */
  flushedItems: number
  /** Times the source was paused because the backlog reached a high-water mark. */
  pauses: number
  /** Errors thrown by `visit`. */
  visitErrors: number
  /** Single items whose handling alone outran the turn budget. */
  slowVisits: number
  /** Deepest backlog seen, in items. */
  maxPending: number
  /** Heaviest backlog seen, by `sizeOf`. */
  maxPendingChars: number
  /** Heaviest single item seen, by `sizeOf`. */
  maxItemChars: number
  /** Longest single `visit`, in milliseconds. */
  maxVisitMs: number
}

const countersByLabel = new Map<string, OrderedStreamPumpCounters>()

function countersFor(label: string): OrderedStreamPumpCounters {
  let counters = countersByLabel.get(label)
  if (!counters) {
    counters = {
      pumps: 0,
      pushed: 0,
      visited: 0,
      yields: 0,
      flushes: 0,
      flushedItems: 0,
      pauses: 0,
      visitErrors: 0,
      slowVisits: 0,
      maxPending: 0,
      maxPendingChars: 0,
      maxItemChars: 0,
      maxVisitMs: 0
    }
    countersByLabel.set(label, counters)
  }
  return counters
}

/** Process-wide totals per label, copied so a reader cannot mutate them. */
export function orderedStreamPumpCounters(): Record<string, OrderedStreamPumpCounters> {
  const snapshot: Record<string, OrderedStreamPumpCounters> = {}
  for (const [label, counters] of countersByLabel) snapshot[label] = { ...counters }
  return snapshot
}

export function resetOrderedStreamPumpCountersForTest(): void {
  countersByLabel.clear()
}

function defaultSizeOf(item: unknown): number {
  return typeof item === 'string' ? item.length : 0
}

function rethrowOnLaterMacrotask(error: unknown): void {
  setImmediate(() => {
    throw error
  })
}

export function createOrderedStreamPump<T>(
  options: OrderedStreamPumpOptions<T>
): OrderedStreamPump<T> {
  const budgetMs =
    options.budgetMs ??
    (pacedByDefault ? COOPERATIVE_STREAM_TURN_BUDGET_MS : Number.POSITIVE_INFINITY)
  const paced = Number.isFinite(budgetMs)
  const highWaterItems = options.highWaterItems ?? ORDERED_STREAM_PUMP_HIGH_WATER_ITEMS
  const lowWaterItems = options.lowWaterItems ?? ORDERED_STREAM_PUMP_LOW_WATER_ITEMS
  const highWaterChars = options.highWaterChars ?? ORDERED_STREAM_PUMP_HIGH_WATER_CHARS
  const lowWaterChars = options.lowWaterChars ?? ORDERED_STREAM_PUMP_LOW_WATER_CHARS
  // Looked up per call, like `setImmediate` below: a test that installs fake
  // timers swaps both, and the clock must not be left behind on the real one.
  const now = options.now ?? (() => Date.now())
  const schedule = options.schedule ?? ((resume) => setImmediate(resume))
  const sizeOf = options.sizeOf ?? defaultSizeOf
  const onFlushVisitError = options.onFlushVisitError ?? rethrowOnLaterMacrotask
  const source = options.source ?? null
  const counters = countersFor(options.label)
  counters.pumps += 1

  // `head` walks the array instead of shift(), which is O(n) per item on the
  // very backlog this exists to work through.
  let queue: T[] = []
  let head = 0
  let pendingChars = 0
  let draining = false
  let flushing = false
  let sourcePaused = false
  // Handling time this stream has used in the current loop turn. The boundary
  // callback is what ends a turn: it runs on the next macrotask, clears the
  // spend, and takes whatever was left waiting.
  let turnSpentMs = 0
  let turnYielded = false
  let boundaryScheduled = false

  const pendingItems = (): number => queue.length - head

  const pauseSourceIfOverHighWater = (): void => {
    if (sourcePaused || !source) return
    if (pendingItems() < highWaterItems && pendingChars < highWaterChars) return
    sourcePaused = true
    counters.pauses += 1
    try {
      source.pause()
    } catch {
      // A source that cannot pause only loses the bound; intake is unaffected.
    }
  }

  const resumeSourceIfUnderLowWater = (): void => {
    if (!sourcePaused || !source) return
    if (pendingItems() > lowWaterItems || pendingChars > lowWaterChars) return
    sourcePaused = false
    try {
      source.resume()
    } catch {
      // Same as pause: the bound is best-effort, the queue is not.
    }
  }

  const scheduleBoundary = (): void => {
    if (boundaryScheduled) return
    boundaryScheduled = true
    schedule(() => {
      boundaryScheduled = false
      turnSpentMs = 0
      turnYielded = false
      if (pendingItems() > 0) drain()
    })
  }

  const noteYield = (): void => {
    if (turnYielded) return
    turnYielded = true
    counters.yields += 1
  }

  const drain = (): void => {
    // A push or flush from inside `visit` joins the turn already running.
    if (draining) return
    draining = true
    let previous = now()
    try {
      while (head < queue.length) {
        // Checked before the visit, never after: the boundary callback starts
        // every deferred turn with nothing spent, so it always makes progress.
        if (!flushing && turnSpentMs >= budgetMs) {
          noteYield()
          break
        }
        const item = queue[head]
        head += 1
        pendingChars -= sizeOf(item)
        counters.visited += 1
        if (flushing) counters.flushedItems += 1
        try {
          options.visit(item)
        } catch (error) {
          counters.visitErrors += 1
          // A flush runs in a terminal path: finish the backlog and keep the
          // error out of it. A paced turn rethrows, with the remainder already
          // safe in the queue for the boundary the `finally` below schedules.
          if (!flushing) throw error
          onFlushVisitError(error)
        }
        const at = now()
        const visitMs = at - previous
        previous = at
        turnSpentMs += visitMs
        if (visitMs > counters.maxVisitMs) counters.maxVisitMs = visitMs
        if (visitMs >= budgetMs) counters.slowVisits += 1
      }
    } finally {
      draining = false
      flushing = false
      if (head >= queue.length) {
        queue = []
        head = 0
        pendingChars = 0
      } else if (head >= COMPACT_MIN_HANDLED_ITEMS && head >= queue.length - head) {
        // A stream that never fully drains would otherwise keep every handled
        // item alive behind `head` for as long as the child runs.
        queue = queue.slice(head)
        head = 0
      }
      // A boundary is owed whenever something waits, and whenever a paced
      // turn has spend to clear before the next can start with a full budget.
      if (pendingItems() > 0 || (paced && turnSpentMs > 0)) scheduleBoundary()
      resumeSourceIfUnderLowWater()
    }
  }

  const enqueue = (item: T): void => {
    const size = sizeOf(item)
    queue.push(item)
    pendingChars += size
    counters.pushed += 1
    if (size > counters.maxItemChars) counters.maxItemChars = size
  }

  const afterEnqueue = (): void => {
    try {
      // One queue, always taken from the head: whatever has waited longest
      // goes first, and the turn budget decides whether anything runs now.
      drain()
    } finally {
      // Measured after the turn: what is left is the backlog, not the burst.
      const depth = pendingItems()
      if (depth > counters.maxPending) counters.maxPending = depth
      if (pendingChars > counters.maxPendingChars) counters.maxPendingChars = pendingChars
      pauseSourceIfOverHighWater()
    }
  }

  return {
    push(item) {
      enqueue(item)
      afterEnqueue()
    },
    pushAll(items) {
      if (items.length === 0) return
      for (const item of items) enqueue(item)
      afterEnqueue()
    },
    flush() {
      if (pendingItems() === 0) return
      counters.flushes += 1
      flushing = true
      drain()
    },
    get pending() {
      return pendingItems()
    }
  }
}
