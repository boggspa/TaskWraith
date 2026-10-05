/**
 * Barrier durability, put together for one app process: a record of what
 * every thread owes the disk, the port that pays it off the event loop, and
 * the tickets that the moments reporting "done" take on it.
 *
 * The store builds one only while its switch is on, and hands the thread
 * stores the debt's `note`. The journal, the run-event ledger and a save's
 * tool-detail writer then write without a sync and say what they owe; a
 * barrier raised for a thread pays it. Building one starts no timer, opens no
 * file and syncs nothing, and nothing here can sync on the calling thread.
 *
 * After each append the store hands it the save, and it takes a ticket for
 * each moment the save contains (`ChatSaveMoments`), waiting for a barrier of
 * that thread. What no moment pays is paid by a quiet thread's idle barrier
 * or at quit, and dropped unpaid when the thread is erased
 * (`ThreadDebtTracker`).
 */
import { ChatDurabilityTickets, type ChatDurabilityTicketsSnapshot } from './ChatDurabilityTickets'
import { classifyChatSaveMoments, type ChatSaveMoment } from './ChatSaveMoments'
import type { IncrementalChatPersistResult } from './IncrementalChatPersistence'
import {
  createThreadDurabilityDebt,
  type NoteThreadDurabilityDebt,
  type ThreadDurabilityDebt,
  type ThreadDurabilityDebtSnapshot,
  type ThreadDurabilityPort
} from './ThreadDurabilityDebt'
import {
  createThreadDurabilityDebtFs,
  type ThreadDurabilityDebtFsSnapshot
} from './ThreadDurabilityDebtFs'
import { ThreadDebtTracker, type ThreadDebtTrackerSnapshot } from './ThreadDebtTracker'
import type { ToolActivityDetailDebt } from './ToolActivityDetailLedger'
import type { FlushReason } from './saveCoalescer'
import type { ChatRecord } from './types'

export interface ThreadBarrierDurabilitySnapshot {
  debt: ThreadDurabilityDebtSnapshot
  /** Null when the port was supplied from outside and keeps no counters here. */
  port: ThreadDurabilityDebtFsSnapshot | null
  tickets: ChatDurabilityTicketsSnapshot
  /** Threads that may still owe something, and the idle and quit barriers. */
  threads: ThreadDebtTrackerSnapshot
}

export interface ThreadBarrierDurability {
  /** What every thread store is given in place of a sync. */
  readonly note: NoteThreadDurabilityDebt
  readonly debt: ThreadDurabilityDebt
  readonly tickets: ChatDurabilityTickets
  /**
   * The journal's options in this mode. A line written without a sync can be
   * torn by a power cut, and the next append must not be glued to the
   * fragment, so the journal cuts it first.
   */
  readonly journal: {
    readonly noteDurabilityDebt: NoteThreadDurabilityDebt
    readonly repairTornTailBeforeAppend: true
  }
  /** What one save's tool-detail writer is given, for that save's thread. */
  detail(chatId: string): ToolActivityDetailDebt
  /** A barrier for the thread, as every barrier the app raises for one is. */
  barrier(chatId: string): Promise<void>
  /** Erasure, after its own syncs: drop the thread's debt unpaid. */
  forget(chatId: string): void
  /** A global clear, after its own syncs: drop every thread's debt unpaid. */
  forgetAll(): void
  /** Quit: pay every thread within `budgetMs`, and count what was not paid. */
  payAll(budgetMs: number): Promise<{ threads: number; unpaid: number }>
  /** Stops the idle timer. */
  dispose(): void
  /**
   * After a save's append: a ticket for each moment the save contains, at the
   * revision its batch wrote. A save that created the thread, or whose append
   * failed (`persisted` null), wrote no batch and takes none. Returns the
   * moments found.
   */
  noteSave(
    previous: ChatRecord | null,
    next: ChatRecord,
    persisted: Pick<IncrementalChatPersistResult, 'derived'> | null,
    flushReason: FlushReason
  ): ChatSaveMoment[]
  snapshot(): ThreadBarrierDurabilitySnapshot
}

export interface ThreadBarrierDurabilityOptions {
  /** Pays the debt; the production port when omitted. */
  port?: ThreadDurabilityPort
  /** Milliseconds, for timing barriers and tickets, and for idle threads. */
  now?: () => number
  /** The idle timer; the real one when omitted. */
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * The barrier each of one save's moments waits for.
 *
 * NAMED SEAM for the log lane's slice 4c, which adds scoped and urgent
 * barriers: a user message, a decision and a destructive change are then to
 * wait for `barrier(chatId, { urgent: true })`, and a run's final record for
 * `barrier(chatId, { run })`. Until it lands every moment waits for the
 * thread's whole debt, neither scoped nor urgent, and the moments of one save
 * share one barrier.
 */
export function barrierForSaveMoments(
  debt: Pick<ThreadDurabilityDebt, 'barrier'>,
  chatId: string
): (moment: ChatSaveMoment) => Promise<void> {
  let barrier: Promise<void> | null = null
  return () => (barrier ??= debt.barrier(chatId))
}

export function createThreadBarrierDurability(
  options: ThreadBarrierDurabilityOptions = {}
): ThreadBarrierDurability {
  const now = options.now ?? Date.now
  const built = options.port ? null : createThreadDurabilityDebtFs()
  const debt = createThreadDurabilityDebt({ port: options.port ?? built!, now })
  const tickets = new ChatDurabilityTickets({ now })
  const threads = new ThreadDebtTracker({
    debt,
    now,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer
  })
  const note = threads.note
  let unclassified = 0
  return {
    note,
    debt,
    tickets,
    journal: { noteDurabilityDebt: note, repairTornTailBeforeAppend: true },
    detail: (chatId) => ({ chatId, note }),
    barrier: (chatId) => threads.barrier(chatId),
    forget: (chatId) => threads.forget(chatId),
    forgetAll: () => threads.forgetAll(),
    payAll: (budgetMs) => threads.payAll(budgetMs),
    dispose: () => threads.dispose(),
    noteSave(previous, next, persisted, flushReason) {
      const derived = persisted?.derived
      if (!previous || !derived) return []
      const { chatId, revision, operations } = derived.batch
      let moments: ChatSaveMoment[]
      try {
        moments = classifyChatSaveMoments({
          previous,
          next,
          operations,
          transcriptOps: derived.transcriptOps,
          flushReason
        })
      } catch (error) {
        // Never fail a save that is already written. What it wrote is paid
        // now instead, with no ticket to wait for it.
        if (unclassified++ === 0) console.error('[thread-barrier] could not classify a save', error)
        threads.barrier(chatId).catch(() => {})
        return []
      }
      const barrierFor = barrierForSaveMoments(threads, chatId)
      for (const found of moments) tickets.note(chatId, revision, found.moment, barrierFor(found))
      return moments
    },
    snapshot: () => ({
      debt: debt.snapshot(),
      port: built?.snapshot() ?? null,
      tickets: tickets.snapshot(),
      threads: threads.snapshot()
    })
  }
}
