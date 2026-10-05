/**
 * Barrier durability, put together for one app process: a record of what
 * every thread owes the disk, the port that pays it off the event loop, and
 * the tickets that the moments reporting "done" take on it.
 *
 * The store builds one only while its switch is on, and hands the thread
 * stores the debt's `note`. The journal, the run-event ledger and a save's
 * tool-detail writer then write without a sync and say what they owe; a
 * barrier raised for a thread pays it. The journal is also handed the worker
 * pool it folds checkpoints in, whole, and the port's directory sync for the
 * rename that installs one. Building one starts no timer, opens no file,
 * starts no process and syncs nothing, and nothing here can sync on the
 * calling thread.
 *
 * After each append the store hands it the save, and it takes a ticket for
 * each moment the save contains (`ChatSaveMoments`), waiting for a barrier of
 * that thread: an urgent one for what the user sits in, one of the run for a
 * run's final record. What no moment pays is paid by a quiet thread's idle
 * barrier or at quit, and dropped unpaid when the thread is erased
 * (`ThreadDebtTracker`).
 */
import {
  ChatDurabilityTickets,
  USER_DURABILITY_MOMENTS,
  type ChatDurabilityTicketsSnapshot
} from './ChatDurabilityTickets'
import {
  classifyChatSaveMoments,
  classifyCreatedChatMoments,
  type ChatSaveMoment
} from './ChatSaveMoments'
import type { CheckpointPreparationPort } from './CheckpointPreparationProtocol'
import { CheckpointPreparationWorker } from './CheckpointPreparationWorker'
import { MainCatalogueUnsyncedDurability } from './MainCatalogueUnsyncedDurability'
import type { IncrementalChatPersistResult } from './IncrementalChatPersistence'
import {
  createThreadDurabilityDebt,
  type NoteThreadDurabilityDebt,
  type ThreadDurabilityBarrierOptions,
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
   * fragment, so the journal cuts it first. Its compactions fold in the pool,
   * which it is given whole: its own queue waits for room with `admits` and
   * `onCapacity`. The rename that installs a folded checkpoint is made durable
   * by the port every barrier uses, within the same limit and counted with
   * the rest.
   */
  readonly journal: {
    readonly noteDurabilityDebt: NoteThreadDurabilityDebt
    readonly repairTornTailBeforeAppend: true
    readonly checkpointPreparation: CheckpointPreparationPort
    readonly syncDirectory: (directory: string) => Promise<unknown>
  }
  /** What one save's tool-detail writer is given, for that save's thread. */
  detail(chatId: string): ToolActivityDetailDebt
  /**
   * The catalogue's durability seam: heads and tickets written without a sync
   * and owed to no barrier. Holds, fences and resolved rows never reach it.
   */
  catalogue(profilePath: string): MainCatalogueUnsyncedDurability
  /** A barrier for the thread, as every barrier the app raises for one is. */
  barrier(chatId: string): Promise<void>
  /**
   * What a dispatch waits for: the thread's `userWaitBarrier`, and the chat's
   * tickets for the user's moments. Rejects when the disk refused a sync of
   * either. A run's final record is not waited for here: its own barrier pays
   * what it wrote, and its ticket belongs to the work that follows the run.
   */
  awaitDurable(chatId: string): Promise<void>
  /**
   * Erasure, after its own syncs: drop the thread's debt unpaid. Its tickets
   * count as covered: the erasure, which syncs itself, is what reports the
   * thread gone, and nothing is left for their barriers to make durable.
   */
  forget(chatId: string): void
  /** A global clear, after its own syncs: the same for every thread. */
  forgetAll(): void
  /** Quit: pay every thread within `budgetMs`, and count what was not paid. */
  payAll(budgetMs: number): Promise<{ threads: number; unpaid: number }>
  /** Stops the idle timer. */
  dispose(): void
  /**
   * After a save's append: a ticket for each moment the save contains, at the
   * revision its batch wrote. A save that created the thread wrote its first
   * checkpoint instead of a batch, owed like a line, and takes a ticket at the
   * record's revision when it holds the user's message. A save whose append
   * failed (`persisted` null) wrote nothing a barrier pays and takes none.
   * `removalAskedByUser`: the route the save came by says the user asked for
   * the rows it removes; without it a removal takes no ticket. Returns the
   * moments found.
   */
  noteSave(
    previous: ChatRecord | null,
    next: ChatRecord,
    persisted: Pick<IncrementalChatPersistResult, 'derived'> | null,
    flushReason: FlushReason,
    removalAskedByUser?: boolean
  ): ChatSaveMoment[]
  snapshot(): ThreadBarrierDurabilitySnapshot
}

export interface ThreadBarrierDurabilityOptions {
  /** Pays the debt; the production port when omitted. */
  port?: ThreadDurabilityPort
  /** The pool the journal folds checkpoints in; a `CheckpointPreparationWorker` when omitted. */
  checkpointPreparation?: CheckpointPreparationPort
  /** Milliseconds, for timing barriers and tickets, and for idle threads. */
  now?: () => number
  /** The idle timer; the real one when omitted. */
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

type RaisesBarriers = {
  barrier(chatId: string, options?: ThreadDurabilityBarrierOptions): Promise<void>
}

/**
 * The barrier of every wait the user sits in: the moments of a save that are
 * theirs, and a dispatch. It pays the thread's own debt alone: the message,
 * the decision, the destructive batch and the record a dispatch reads are all
 * journal lines, and what streaming runs wrote is left to their own barriers.
 * Urgent, so the port starts its syncs ahead of every sync that is not.
 */
export function userWaitBarrier(debt: RaisesBarriers, chatId: string): Promise<void> {
  return debt.barrier(chatId, { threadOnly: true, urgent: true })
}

/**
 * The barrier each of one save's moments waits for, one per kind of wait.
 *
 * A user message, a decision and a destructive change are waits the user sits
 * in: they share one `userWaitBarrier`. A run's final record waits for a
 * barrier of that run, which pays the thread's own debt and the run's and
 * leaves what other runs owe; it is not urgent. Runs that end in the same save
 * get one barrier each.
 */
export function barriersForSaveMoments(
  debt: RaisesBarriers,
  chatId: string
): (moment: ChatSaveMoment) => Promise<void> {
  let urgent: Promise<void> | null = null
  const runs = new Map<string, Promise<void>>()
  return (found) => {
    if (found.moment !== 'run_final') return (urgent ??= userWaitBarrier(debt, chatId))
    let barrier = runs.get(found.runId)
    if (!barrier) {
      barrier = debt.barrier(chatId, { run: found.runId })
      runs.set(found.runId, barrier)
    }
    return barrier
  }
}

/**
 * The moments the user sits in come first: their barrier goes to the port
 * before a run's, and so never queues behind what the run wrote.
 */
function userWaitsFirst(moments: readonly ChatSaveMoment[]): ChatSaveMoment[] {
  return [
    ...moments.filter((found) => found.moment !== 'run_final'),
    ...moments.filter((found) => found.moment === 'run_final')
  ]
}

export function createThreadBarrierDurability(
  options: ThreadBarrierDurabilityOptions = {}
): ThreadBarrierDurability {
  const now = options.now ?? Date.now
  const built = options.port ? null : createThreadDurabilityDebtFs()
  const port = options.port ?? built!
  const debt = createThreadDurabilityDebt({ port, now })
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
    journal: {
      noteDurabilityDebt: note,
      repairTornTailBeforeAppend: true,
      checkpointPreparation: options.checkpointPreparation ?? new CheckpointPreparationWorker(),
      syncDirectory: (directory) => port.syncDirectory(directory)
    },
    detail: (chatId) => ({ chatId, note }),
    catalogue: (profilePath) => new MainCatalogueUnsyncedDurability({ profilePath }),
    barrier: (chatId) => threads.barrier(chatId),
    awaitDurable: (chatId) =>
      Promise.all([
        userWaitBarrier(threads, chatId),
        tickets.awaitChat(chatId, USER_DURABILITY_MOMENTS)
      ]).then(() => undefined),
    forget(chatId) {
      threads.forget(chatId)
      tickets.awaitChat(chatId).catch(() => {})
    },
    forgetAll() {
      threads.forgetAll()
      for (const chatId of tickets.chatIds()) tickets.awaitChat(chatId).catch(() => {})
    },
    payAll: (budgetMs) => threads.payAll(budgetMs),
    dispose: () => threads.dispose(),
    noteSave(previous, next, persisted, flushReason, removalAskedByUser = false) {
      if (!persisted) return []
      const derived = persisted.derived
      const chatId = derived?.batch.chatId ?? next.appChatId
      const revision = derived?.batch.revision ?? next.persistenceRevision ?? 0
      let moments: ChatSaveMoment[]
      try {
        if (!previous) moments = classifyCreatedChatMoments(next)
        else if (derived) {
          moments = classifyChatSaveMoments({
            previous,
            next,
            operations: derived.batch.operations,
            transcriptOps: derived.transcriptOps,
            flushReason,
            removalAskedByUser
          })
        } else return []
      } catch (error) {
        // Never fail a save that is already written. What it wrote is paid
        // now instead, with no ticket to wait for it.
        if (unclassified++ === 0) console.error('[thread-barrier] could not classify a save', error)
        threads.barrier(chatId).catch(() => {})
        return []
      }
      const barrierFor = barriersForSaveMoments(threads, chatId)
      for (const found of userWaitsFirst(moments)) {
        tickets.note(chatId, revision, found.moment, barrierFor(found))
      }
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
