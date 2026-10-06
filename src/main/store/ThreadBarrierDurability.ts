/**
 * Barrier durability, put together for one app process: a record of what
 * every thread owes the disk, the port that pays it off the event loop, and
 * the tickets that the moments reporting "done" take on it.
 *
 * The store builds one only while its switch is on, and hands the thread
 * stores the debt's `note`. The journal and the run-event ledger then write
 * without a sync and say what they owe; a barrier raised for a thread pays
 * it. A save's tool detail is no thread's debt: it is staged, synced off the
 * save at the port's background class, and referenced only by a later save
 * once it is on the disk (`ToolActivityDetailStaging`). The journal is also
 * handed the worker pool it folds checkpoints in, whole, and the port's
 * directory sync for the rename that installs one. Building one starts no
 * timer, opens no file, starts no process and syncs nothing, and nothing here
 * can sync on the calling thread.
 *
 * After each append the store hands it the save, and it takes a ticket for
 * each moment the save contains (`ChatSaveMoments`), waiting for a barrier of
 * that thread: an urgent one for what the user sits in, one of the run for a
 * run's final record. What no moment pays is paid by a quiet thread's idle
 * barrier or at quit, and dropped unpaid when the thread is erased
 * (`ThreadDebtTracker`). While a thread keeps writing, what it owes is also
 * synced in the background every `THREAD_TRICKLE_MS`, outside its barriers,
 * so that the barrier at a run's end pays about that much of what the run
 * wrote.
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
import {
  MAX_CHECKPOINT_PREPARATION_SOURCE_BYTES,
  type CheckpointPreparationPort
} from './CheckpointPreparationProtocol'
import {
  CheckpointPreparationWorker,
  type CheckpointPreparationWorkerSnapshot
} from './CheckpointPreparationWorker'
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
import {
  THREAD_TRICKLE_MS,
  ThreadDebtTracker,
  type ThreadDebtTrackerSnapshot
} from './ThreadDebtTracker'
import type { RunEventLedgerStagedAppend } from './RunEventLedgerWriter'
import type { ToolActivityDetailCheckpoint } from './ToolActivityDetailLedger'
import {
  createToolActivityDetailStaging,
  type ToolActivityDetailStagingBatch,
  type ToolActivityDetailStagingSnapshot
} from './ToolActivityDetailStaging'
import type { FlushReason } from './saveCoalescer'
import type { ChatRecord, RunEventInput } from './types'

export interface ThreadBarrierDurabilitySnapshot {
  debt: ThreadDurabilityDebtSnapshot
  /** Null when the port was supplied from outside and keeps no counters here. */
  port: ThreadDurabilityDebtFsSnapshot | null
  tickets: ChatDurabilityTicketsSnapshot
  /** Threads that may still owe something, and the idle and quit barriers. */
  threads: ThreadDebtTrackerSnapshot
  /** Tool detail staged off the save path; null when the layer was not told where it goes. */
  staging: ToolActivityDetailStagingSnapshot | null
  /** Null for an injected pool that supplies no statistics. */
  checkpointPreparation: CheckpointPreparationWorkerSnapshot | null
}

export interface ThreadBarrierDurability {
  /** What every thread store is given in place of a sync. */
  readonly note: NoteThreadDurabilityDebt
  readonly debt: ThreadDurabilityDebt
  /**
   * The port that pays every barrier, for the stores outside the threads that
   * sync off the event loop too: their syncs queue with the threads', each at
   * its class, within the same limit.
   */
  readonly port: ThreadDurabilityPort
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
  /**
   * The tool-detail writer one save of `chat` is given: a batch of the
   * staging, which hands the save a ref only for bytes an earlier batch made
   * durable, and writes nothing for a run whose history is erased or frozen.
   * Null when the layer was not told where tool detail goes.
   */
  detailBatch(chat: ChatRecord): ToolActivityDetailStagingBatch | null
  /**
   * The catalogue's durability seam: heads and tickets written without a sync
   * and owed to no barrier. Holds, fences and resolved rows never reach it.
   */
  catalogue(profilePath: string): MainCatalogueUnsyncedDurability
  /** A barrier for the thread, as every barrier the app raises for one is. */
  barrier(chatId: string): Promise<void>
  /**
   * Raises nothing: resolves once a barrier raised after the thread's latest
   * write has paid (a user moment's, a run's, the idle or quit barrier), and
   * rejects if the thread is erased first. For confirming a write by the
   * barriers the app raises anyway, without adding a sync to the port.
   */
  paidThrough(chatId: string): Promise<void>
  /**
   * The barrier a queued start waits for before it tells the Host its run row
   * is durable: the thread's own debt, where the row's journal line is. A
   * start is no moment, so no save's ticket pays it; and it is the app's
   * work, not a wait the user sits in, so the barrier is not urgent.
   */
  startBarrier(chatId: string): Promise<void>
  /**
   * What a dispatch waits for: the chat's tickets for the user's moments. Each
   * save that held one raised its urgent barrier already, so a dispatch raises
   * none of its own, and with none pending it resolves at once: what streaming
   * wrote is no moment, and its idle barrier pays it. Rejects when the disk
   * refused the sync of one of them. A run's final record is not waited for
   * here: its own barrier pays what it wrote, and its ticket belongs to the
   * work that follows the run.
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
  /**
   * Quit: abandon the staged tool detail, never waiting for a batch, then pay
   * every thread within `budgetMs` and count what was not paid.
   */
  payAll(budgetMs: number): Promise<{ threads: number; unpaid: number }>
  /** Stops the idle timer, and stages no more tool detail. */
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
  checkpointPreparation?: CheckpointPreparationPort & {
    stats?(): CheckpointPreparationWorkerSnapshot
  }
  /** Milliseconds, for timing barriers and tickets, and for idle threads. */
  now?: () => number
  /** The idle timer; the real one when omitted. */
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** The trickle's period: `THREAD_TRICKLE_MS` when omitted, none when null. */
  trickleMs?: number | null
  /** Where a save's tool detail is staged. Without it the layer stages none. */
  detail?: ThreadBarrierDetailOptions
}

/** Where and how the layer stages a save's tool detail, through its own port. */
export interface ThreadBarrierDetailOptions {
  /** The folder every run's detail file is in. */
  runArtifactsDir: string
  /** The run-event ledger's staged append (`RunEventLedgerWriter.appendStaged`). */
  appendRunEvent(input: RunEventInput): Pick<RunEventLedgerStagedAppend, 'file' | 'directories'>
  /** A segment's checkpoint run event, as a save of `chat` would append it. */
  checkpointInput(chat: ChatRecord, checkpoint: ToolActivityDetailCheckpoint): RunEventInput
  /**
   * Whether a run's history takes no new tool detail: the run erased, or
   * frozen by a deletion being prepared, as a strict run-event append is
   * refused. Asked once a run in a save before anything of it is written, and
   * again before each checkpoint event is appended.
   */
  refuses(runId: string, chatId: string): boolean
}

type RaisesBarriers = {
  barrier(chatId: string, options?: ThreadDurabilityBarrierOptions): Promise<void>
}

/**
 * The barrier of every wait the user sits in: the moments of a save that are
 * theirs. It pays the thread's own debt alone: the message, the decision and
 * the destructive batch are journal lines, and what streaming runs wrote is
 * left to their own barriers. Urgent, so the port starts its syncs ahead of
 * every sync that is not.
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
  const trickleMs = options.trickleMs === undefined ? THREAD_TRICKLE_MS : options.trickleMs
  const threads = new ThreadDebtTracker({
    debt,
    now,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
    ...(trickleMs === null ? {} : { trickleMs })
  })
  const note = threads.note
  const detail = options.detail
  const staging = detail
    ? createToolActivityDetailStaging({
        runArtifactsDir: detail.runArtifactsDir,
        port,
        appendRunEvent: (input) => {
          // Thrown, the batch fails: nothing references what it wrote.
          if (detail.refuses(input.runId, input.chatId ?? '')) {
            throw new Error(`The history of run ${input.runId} takes no new tool detail`)
          }
          return detail.appendRunEvent(input)
        },
        checkpointInput: detail.checkpointInput
      })
    : null
  const checkpointPreparation =
    options.checkpointPreparation ??
    new CheckpointPreparationWorker({
      maxSourceBytes: MAX_CHECKPOINT_PREPARATION_SOURCE_BYTES,
      maxReservedBytes: 1024 * 1024 * 1024
    })
  let unclassified = 0
  return {
    note,
    debt,
    port,
    tickets,
    journal: {
      noteDurabilityDebt: note,
      repairTornTailBeforeAppend: true,
      checkpointPreparation,
      syncDirectory: (directory) => port.syncDirectory(directory)
    },
    detailBatch(chat) {
      if (!staging || !detail) return null
      const batch = staging.batch(chat)
      const refused = new Map<string, boolean>()
      return {
        stage(runId, activity) {
          let refuses = refused.get(runId)
          if (refuses === undefined) {
            refuses = detail.refuses(runId, chat.appChatId)
            refused.set(runId, refuses)
          }
          return refuses ? null : batch.stage(runId, activity)
        },
        commit: () => batch.commit(),
        awaitsDurability: (runId, activityId) => batch.awaitsDurability(runId, activityId)
      }
    },
    catalogue: (profilePath) => new MainCatalogueUnsyncedDurability({ profilePath }),
    barrier: (chatId) => threads.barrier(chatId),
    paidThrough: (chatId) => threads.paidThrough(chatId),
    startBarrier: (chatId) => threads.barrier(chatId, { threadOnly: true }),
    awaitDurable: (chatId) => tickets.awaitChat(chatId, USER_DURABILITY_MOMENTS),
    forget(chatId) {
      threads.forget(chatId)
      staging?.forget(chatId)
      tickets.awaitChat(chatId).catch(() => {})
    },
    forgetAll() {
      threads.forgetAll()
      staging?.forgetAll()
      for (const chatId of tickets.chatIds()) tickets.awaitChat(chatId).catch(() => {})
    },
    payAll(budgetMs) {
      staging?.abandon()
      return threads.payAll(budgetMs)
    },
    dispose() {
      threads.dispose()
      staging?.abandon()
    },
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
      threads: threads.snapshot(),
      staging: staging?.snapshot() ?? null,
      checkpointPreparation: checkpointPreparation.stats?.() ?? null
    })
  }
}
