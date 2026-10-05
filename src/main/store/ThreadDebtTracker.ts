/**
 * Which threads owe the disk, since when, and what pays them when no moment
 * does: a quiet thread's idle barrier, the barriers raised at quit, and the
 * erasure that drops a thread's debt instead of paying it.
 *
 * Every note the thread stores make passes through here on its way to the
 * debt, and every barrier the app raises for a thread goes through `barrier`,
 * so this knows each thread that may still owe something and when it last
 * wrote. A barrier of the whole thread that settles with nothing noted since
 * it was raised has paid the thread, which is then forgotten here. A barrier
 * of one run pays only the thread's own debt and that run's, so the thread
 * stays here after it: other runs may still owe.
 *
 * Idle: a thread that owes something and has written nothing for
 * `THREAD_IDLE_BARRIER_MS` gets one barrier, neither scoped nor urgent. One
 * coarse timer serves the whole app: it is armed only while something is
 * owed, never fires sooner than `IDLE_SWEEP_FLOOR_MS` after it is armed, and
 * is unref'd, so it never keeps the process alive.
 *
 * A barrier that rejects (the disk refused a sync) leaves its debt owed, as
 * the debt keeps it. The thread is then tried again one idle period after
 * the failure, never sooner, and by the next moment or quit barrier if one
 * comes first; a disk that keeps refusing costs one barrier per thread per
 * idle period, never a loop.
 *
 * Quit raises a barrier for every thread that may owe something and waits for
 * them within the time it is given. What did not settle in that time, or
 * failed, is counted and logged by count alone: no path, id or content.
 *
 * Memory: one small entry per thread that has written since its last paid
 * barrier, and one timer.
 */
import type {
  NoteThreadDurabilityDebt,
  ThreadDurabilityBarrierOptions,
  ThreadDurabilityDebt
} from './ThreadDurabilityDebt'

/** How long a thread that owes something may go without a write before it gets a barrier. */
export const THREAD_IDLE_BARRIER_MS = 15_000
/** The least time between two firings of the idle timer. */
export const IDLE_SWEEP_FLOOR_MS = 1_000

export interface ThreadDebtTrackerOptions {
  debt: Pick<ThreadDurabilityDebt, 'note' | 'barrier' | 'forget'>
  /** Milliseconds. */
  now: () => number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  idleMs?: number
  floorMs?: number
  warn?: (message: string) => void
}

export interface ThreadDebtTrackerSnapshot {
  /** Threads that may still owe something. */
  owing: number
  /** Idle barriers raised, and how many of them failed. */
  idleBarriers: number
  idleFailed: number
  /** Threads quit raised a barrier for, and how many of them were not paid in time. */
  quitThreads: number
  quitUnpaid: number
}

interface Owing {
  /** When the thread last noted something; when its last idle barrier failed, after one. */
  since: number
  /** Increases with every note, so a barrier can tell whether anything was noted after it. */
  generation: number
  /** An idle barrier for it is running. */
  idling: boolean
}

export class ThreadDebtTracker {
  private readonly debt: ThreadDebtTrackerOptions['debt']
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly idleMs: number
  private readonly floorMs: number
  private readonly warn: (message: string) => void
  /** In the order each thread last wrote, oldest first. */
  private readonly owing = new Map<string, Owing>()
  private generation = 0
  private timer: unknown = null
  private disposed = false
  private idleBarriers = 0
  private idleFailed = 0
  private quitThreads = 0
  private quitUnpaid = 0

  constructor(options: ThreadDebtTrackerOptions) {
    this.debt = options.debt
    this.now = options.now
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.idleMs = options.idleMs ?? THREAD_IDLE_BARRIER_MS
    this.floorMs = options.floorMs ?? IDLE_SWEEP_FLOOR_MS
    this.warn = options.warn ?? ((message) => console.warn(message))
  }

  /** What the thread stores are given: the debt's own note, with the thread's write remembered. */
  readonly note: NoteThreadDurabilityDebt = (chatId, entry) => {
    this.debt.note(chatId, entry)
    const owing = this.owing.get(chatId) ?? { since: 0, generation: 0, idling: false }
    // Kept as one object, moved to the end: an idle barrier running for the
    // thread settles the same entry.
    this.owing.delete(chatId)
    owing.since = this.now()
    owing.generation = ++this.generation
    this.owing.set(chatId, owing)
    this.arm()
  }

  /**
   * A barrier for the thread, with the debt's own options. One of the whole
   * thread forgets the thread here if nothing was noted meanwhile.
   */
  barrier(chatId: string, options?: ThreadDurabilityBarrierOptions): Promise<void> {
    const raisedAt = options?.run === undefined ? this.owing.get(chatId)?.generation : undefined
    const barrier = options ? this.debt.barrier(chatId, options) : this.debt.barrier(chatId)
    if (raisedAt !== undefined) {
      barrier.then(
        () => {
          if (this.owing.get(chatId)?.generation === raisedAt) this.owing.delete(chatId)
        },
        () => {}
      )
    }
    return barrier
  }

  /** The thread is being erased: drop what it owes without paying it. */
  forget(chatId: string): void {
    this.debt.forget(chatId)
    this.owing.delete(chatId)
  }

  /** Every thread is being erased. */
  forgetAll(): void {
    for (const chatId of this.owing.keys()) this.debt.forget(chatId)
    this.owing.clear()
  }

  /**
   * Quit: a barrier for every thread that may owe something, waited for at
   * most `budgetMs`. Idle barriers stop. Returns how many threads there were
   * and how many were not paid.
   */
  async payAll(budgetMs: number): Promise<{ threads: number; unpaid: number }> {
    this.dispose()
    const chatIds = [...this.owing.keys()]
    if (chatIds.length === 0) return { threads: 0, unpaid: 0 }
    let paid = 0
    const all = Promise.allSettled(
      chatIds.map((chatId) =>
        this.barrier(chatId).then(() => {
          paid += 1
        })
      )
    )
    let timer: unknown = null
    const bound = new Promise<void>((resolve) => {
      timer = this.setTimer(resolve, Math.max(0, budgetMs))
      ;(timer as { unref?: () => void } | null)?.unref?.()
    })
    await Promise.race([all, bound])
    this.clearTimer(timer)
    const unpaid = chatIds.length - paid
    this.quitThreads += chatIds.length
    this.quitUnpaid += unpaid
    if (unpaid > 0) {
      this.warn(
        `[thread-barrier] ${unpaid} of ${chatIds.length} thread(s) still owed the disk at quit`
      )
    }
    return { threads: chatIds.length, unpaid }
  }

  /** Stops the idle timer for good. */
  dispose(): void {
    this.disposed = true
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
  }

  snapshot(): ThreadDebtTrackerSnapshot {
    return {
      owing: this.owing.size,
      idleBarriers: this.idleBarriers,
      idleFailed: this.idleFailed,
      quitThreads: this.quitThreads,
      quitUnpaid: this.quitUnpaid
    }
  }

  /** The thread that next falls quiet, if any is waiting for its idle barrier. */
  private nextQuiet(): Owing | undefined {
    for (const entry of this.owing.values()) if (!entry.idling) return entry
    return undefined
  }

  private arm(): void {
    if (this.timer !== null || this.disposed) return
    const next = this.nextQuiet()
    if (!next) return
    const delay = Math.max(next.since + this.idleMs - this.now(), this.floorMs)
    this.timer = this.setTimer(() => this.sweep(), delay)
    ;(this.timer as { unref?: () => void } | null)?.unref?.()
  }

  private sweep(): void {
    this.timer = null
    if (this.disposed) return
    const quietSince = this.now() - this.idleMs
    for (const [chatId, entry] of this.owing) {
      if (entry.idling) continue
      if (entry.since > quietSince) break
      entry.idling = true
      this.idleBarriers += 1
      this.barrier(chatId).then(
        () => {
          entry.idling = false
          this.arm()
        },
        () => {
          this.idleFailed += 1
          entry.idling = false
          // Still owed: try again one idle period from now, never sooner.
          if (this.owing.get(chatId) === entry) {
            this.owing.delete(chatId)
            entry.since = this.now()
            this.owing.set(chatId, entry)
          }
          this.arm()
        }
      )
    }
    this.arm()
  }
}
