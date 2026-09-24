/**
 * Post-paint completion for the bounded pre-window boot sweeps.
 *
 * The pre-window pass settles only the most recent candidates so the first
 * window can paint in seconds; the deferred sweep runs the SAME sweeps over
 * the full candidate set once the first frame is up, in byte-budgeted slices
 * that yield the event loop so chat IPC stays responsive while the corpus
 * drains. Same predicates, just later — truncation pre-window is a deferral,
 * never a skip, and this is where the remainder lands.
 *
 * Electron-free by design: the caller injects the paint signal, so this stays
 * unit-testable and the composition root keeps only the wiring.
 */

/** Yield the event loop once so pending IPC/macrotasks run between slices. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Process slices in order, yielding between them. A trailing yield after the
 * last slice keeps the cadence uniform so callers can chain sweep kinds
 * without bunching the boundary slices.
 */
export async function runSlicesSerially<T>(
  slices: readonly (readonly T[])[],
  processSlice: (slice: readonly T[]) => void | Promise<void>,
  yieldBetweenSlices: () => Promise<void> = yieldToEventLoop
): Promise<void> {
  for (const slice of slices) {
    await processSlice(slice)
    await yieldBetweenSlices()
  }
}

export interface DeferredBootSweepSchedule {
  /** Headless hosts have no window to wait for; run on the next macrotask. */
  headless: boolean
  /** Subscribe to the first frame. Ignored when headless. */
  onFirstPaint: (onPaint: () => void) => void
  /** Backstop when the paint signal never arrives. Ignored when headless. */
  paintTimeoutMs: number
  /** The full sweeps. Runs exactly once, whichever signal fires first. */
  runFullSweeps: () => Promise<void>
  /** Sweep failure reporter. Defaults to console.error. Must not throw. */
  onError?: (error: unknown) => void
  /** Injectable timers for tests. */
  setTimeoutFn?: (callback: () => void, ms: number) => unknown
  clearTimeoutFn?: (handle: unknown) => void
}

/**
 * Run the full sweeps exactly once: on first paint, on the paint-timeout
 * backstop, or on the next macrotask when headless. A sweep failure is
 * reported, never thrown — boot must not die because a background sweep did.
 */
export function scheduleDeferredBootSweeps(schedule: DeferredBootSweepSchedule): void {
  let settled = false
  let timer: unknown
  const clearTimer = (): void => {
    if (timer === undefined) return
    const handle = timer
    timer = undefined
    try {
      if (schedule.clearTimeoutFn) schedule.clearTimeoutFn(handle)
      else clearTimeout(handle as NodeJS.Timeout)
    } catch {
      // Best-effort: a stuck backstop merely re-fires into the once-guard.
    }
  }
  const runOnce = (): void => {
    if (settled) return
    settled = true
    clearTimer()
    void Promise.resolve()
      .then(() => schedule.runFullSweeps())
      .catch((error) => {
        if (schedule.onError) {
          try {
            schedule.onError(error)
          } catch {
            // The reporter must not take down the scheduler.
          }
        } else {
          console.error('[boot-sweeps] deferred full sweep failed:', error)
        }
      })
  }
  const setTimeoutImpl = schedule.setTimeoutFn ?? setTimeout
  if (schedule.headless) {
    setTimeoutImpl(runOnce, 0)
    return
  }
  schedule.onFirstPaint(runOnce)
  timer = setTimeoutImpl(runOnce, schedule.paintTimeoutMs)
  const unref = (timer as { unref?: unknown } | undefined)?.unref
  if (typeof unref === 'function') {
    try {
      ;(unref as () => void).call(timer)
    } catch {
      // Best-effort: unref is a courtesy, not a contract.
    }
  }
}
