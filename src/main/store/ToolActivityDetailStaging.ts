/**
 * Tool detail moved out of a thread's records only once it is on the disk.
 *
 * A save that strips a tool call's detail from a record leaves a reference to
 * bytes in a separate file. A record line written without a sync can reach
 * the disk before the bytes it references, at any moment and before any
 * barrier runs, and a power cut then leaves a record whose detail is gone,
 * though the disk held it inline before. So a reference enters a thread's
 * records here only after its bytes are synced, with each name on the path to
 * them, and after its checkpoint run event is synced too. Until then the
 * content stays inline in the record. None of this is a thread's debt: no
 * barrier pays any of it, and no wait the user sits in queues behind it.
 *
 * A thread keeps its state from save to save. Each save stages into a batch
 * of its own, `batch(chat)`, the interface a save gives any detail writer:
 *
 * - `stage(run, activity)` returns a ref this thread made durable earlier for
 *   that run and activity, when the activity's bytes now are the ones it
 *   names, and the save strips the row. Otherwise the activity joins this
 *   save's new batch, when the thread has no batch outstanding, is not
 *   backing off and fewer than `maxOutstanding` batches are outstanding
 *   across threads; or it is passed over without being serialized. Either way
 *   it returns null, the row stays inline, and the save's own retries apply:
 *   a finished run is stamped only once every row of it has a ref.
 * - `commit()` writes the new batch's segments without a sync, on the calling
 *   thread, and returns no checkpoints, so the save persists none.
 * - `awaitsDurability(run, activity)` then says the row was left inline only
 *   for that wait, staged or passed over, so the save does not count it as a
 *   failure. A row it could not serialize, and a commit that throws, are.
 *
 * The batch then runs off the event loop, asking the port for every sync at
 * background class: the segment files; then each directory on the path to
 * them, once each; then each segment's checkpoint run event, appended without
 * a sync; then the ledgers it went into and each directory that gained a
 * name. Only then does `stage` return its refs. The directories are all of
 * the path, not only those that gained a name in this batch, because a name
 * made earlier without a sync, a run's folder made by its raw output or by a
 * batch that failed, is no safer than one made now.
 *
 * A sync that fails or finds its path gone, or a write or an append that
 * throws, fails the batch: its refs are never returned, and the thread stages
 * again only after a backoff of 100 ms, doubling to 5 s. `forget` drops a
 * thread's state when the thread is erased and `abandon` every thread's at
 * quit; a batch still running is not waited for, stops at its next step, and
 * is ignored when it ends. Nothing referenced it, and the content is still
 * inline.
 *
 * Memory: for each thread, the refs of its outstanding batch with one
 * checkpoint run event for each run in it, and the refs of its last durable
 * batch that no save has taken yet. A batch holds what one save stages. No
 * segment's bytes are kept once they are written.
 */
import path from 'node:path'

import type { ChatPersistenceDetailBatch } from './ChatPersistencePreparation'
import type { RunEventLedgerStagedAppend } from './RunEventLedgerWriter'
import type { ThreadDurabilityPort, ThreadDurabilitySyncOptions } from './ThreadDurabilityDebt'
import {
  ToolActivityDetailBatchWriter,
  toolActivityDetailSha256,
  type ToolActivityDetailCheckpoint,
  type ToolActivityDetailSegment
} from './ToolActivityDetailLedger'
import type { ChatRecord, RunEventInput, ToolActivity, ToolActivityDetailRef } from './types'

/** Batches outstanding at once across threads unless the caller says otherwise. */
export const TOOL_DETAIL_STAGING_OUTSTANDING = 4

/** A thread whose batch failed stages again after this, doubled for each failure in a row. */
export const TOOL_DETAIL_STAGING_FIRST_BACKOFF_MS = 100

/** The longest a thread waits to stage again after its batches failed. */
export const TOOL_DETAIL_STAGING_LONGEST_BACKOFF_MS = 5_000

export interface ToolActivityDetailStagingOptions {
  /** The folder every run's detail file is in, as for the save's other detail writers. */
  runArtifactsDir: string
  /** Syncs a path off the event loop; every sync is asked for at background class. */
  port: Pick<ThreadDurabilityPort, 'syncFile' | 'syncDirectory'>
  /** The run-event ledger's staged append (`RunEventLedgerWriter.appendStaged`). */
  appendRunEvent(input: RunEventInput): Pick<RunEventLedgerStagedAppend, 'file' | 'directories'>
  /** A segment's checkpoint run event, as a save of `chat` would append it. */
  checkpointInput(chat: ChatRecord, checkpoint: ToolActivityDetailCheckpoint): RunEventInput
  /** Defaults to {@link TOOL_DETAIL_STAGING_OUTSTANDING}. */
  maxOutstanding?: number
  /** Milliseconds, read only for the backoff. */
  now?: () => number
}

/** One save's batch: what the save gives any tool-detail writer. */
export interface ToolActivityDetailStagingBatch extends ChatPersistenceDetailBatch<ToolActivityDetailCheckpoint> {
  stage(runId: string, activity: ToolActivity): ToolActivityDetailRef | null
  /** Writes the new batch's segments and sets it running; returns no checkpoints. */
  commit(): ToolActivityDetailCheckpoint[]
  /** Whether this save left the activity inline only until its bytes are durable: staged, or passed over. */
  awaitsDurability(runId: string, activityId: string): boolean
}

export interface ToolActivityDetailStagingSnapshot {
  /** Threads holding state now. */
  threads: number
  /** Batches between their commit and their end, across threads. */
  outstanding: number
  /** Refs made durable that no save has taken yet, across threads. */
  readyRefs: number
  batches: {
    /** Set running by a commit. */
    committed: number
    /** Whose refs became usable. */
    durable: number
    /** That failed, a commit's write among them. */
    failed: number
    /** Ended after their thread was forgotten or abandoned. */
    dropped: number
  }
  rows: {
    /** Given a durable ref, so the save stripped them. */
    swapped: number
    /** Put in a new batch, staying inline until it is durable. */
    staged: number
    /** Left inline without being serialized: no batch could be admitted. */
    passedOver: number
  }
  /** Syncs asked of the port. */
  syncs: { files: number; directories: number }
  /** Checkpoint run events appended. */
  checkpointEvents: number
}

export interface ToolActivityDetailStaging {
  /** The batch one save of `chat` stages into: a new one for each save. */
  batch(chat: ChatRecord): ToolActivityDetailStagingBatch
  /** The thread is erased: drop its state. A batch of it still running is ignored when it ends. */
  forget(chatId: string): void
  /** A global clear: the same for every thread. */
  forgetAll(): void
  /** Quit: drop every thread's state and stage nothing more. Batches running are not waited for. */
  abandon(): void
  snapshot(): ToolActivityDetailStagingSnapshot
}

/** Refs by run and activity. */
class Refs {
  private readonly runs = new Map<string, Map<string, ToolActivityDetailRef>>()
  size = 0

  get(runId: string, activityId: string): ToolActivityDetailRef | undefined {
    return this.runs.get(runId)?.get(activityId)
  }

  set(runId: string, activityId: string, ref: ToolActivityDetailRef): void {
    let activities = this.runs.get(runId)
    if (!activities) {
      activities = new Map()
      this.runs.set(runId, activities)
    }
    if (!activities.has(activityId)) this.size += 1
    activities.set(activityId, ref)
  }

  /** Remove the ref, if it is still this one. */
  delete(runId: string, activityId: string, ref?: ToolActivityDetailRef): void {
    const activities = this.runs.get(runId)
    const current = activities?.get(activityId)
    if (!activities || !current || (ref && current !== ref)) return
    activities.delete(activityId)
    if (activities.size === 0) this.runs.delete(runId)
    this.size -= 1
  }
}

interface Batch {
  refs: Refs
  files: string[]
  directories: string[]
  checkpoints: RunEventInput[]
}

interface Thread {
  /** The refs of its last durable batch that no save has taken yet. */
  ready: Refs
  outstanding: Batch | null
  /** Batches failed in a row, and when it may stage again after the last. */
  failures: number
  retryAt: number
}

const BACKGROUND: ThreadDurabilitySyncOptions = { background: true }

export function createToolActivityDetailStaging(
  options: ToolActivityDetailStagingOptions
): ToolActivityDetailStaging {
  const { runArtifactsDir, port } = options
  const now = options.now ?? Date.now
  const maxOutstanding = options.maxOutstanding ?? TOOL_DETAIL_STAGING_OUTSTANDING
  if (!Number.isSafeInteger(maxOutstanding) || maxOutstanding < 1) {
    throw new RangeError('Tool detail staging: maxOutstanding must be a whole number of at least 1')
  }
  const threads = new Map<string, Thread>()
  let closed = false
  let outstanding = 0
  const batches = { committed: 0, durable: 0, failed: 0, dropped: 0 }
  const rows = { swapped: 0, staged: 0, passedOver: 0 }
  const syncs = { files: 0, directories: 0 }
  let checkpointEvents = 0

  /** Whether a new batch of this thread may start now. */
  const admits = (thread: Thread | undefined): boolean =>
    !closed &&
    outstanding < maxOutstanding &&
    (!thread || (thread.outstanding === null && now() >= thread.retryAt))

  const backOff = (thread: Thread): void => {
    thread.failures += 1
    thread.retryAt =
      now() +
      Math.min(
        TOOL_DETAIL_STAGING_FIRST_BACKOFF_MS * 2 ** (thread.failures - 1),
        TOOL_DETAIL_STAGING_LONGEST_BACKOFF_MS
      )
  }

  /** A thread with nothing outstanding, nothing ready and no failure to remember holds no state. */
  const release = (chatId: string, thread: Thread): void => {
    if (thread.outstanding === null && thread.ready.size === 0 && thread.failures === 0) {
      threads.delete(chatId)
    }
  }

  /** Every path synced at background class; any failure, or a path found gone, fails them all. */
  const syncAll = async (paths: readonly string[], directories: boolean): Promise<void> => {
    const outcomes = await Promise.allSettled(
      paths.map((target) => {
        syncs[directories ? 'directories' : 'files'] += 1
        try {
          return directories
            ? port.syncDirectory(target, BACKGROUND)
            : port.syncFile(target, BACKGROUND)
        } catch (error) {
          return Promise.reject(error)
        }
      })
    )
    outcomes.forEach((outcome, index) => {
      if (outcome.status === 'rejected') throw outcome.reason
      if (outcome.value === 'missing') throw new Error(`Nothing left to sync at ${paths[index]}`)
    })
  }

  /** The batch's steps, off the event loop; its refs become usable only at the end. */
  const run = async (chatId: string, thread: Thread, batch: Batch): Promise<void> => {
    const current = (): boolean => threads.get(chatId) === thread
    let durable = false
    try {
      await syncAll(batch.files, false)
      if (!current()) return
      await syncAll(batch.directories, true)
      if (!current()) return
      const ledgers = new Set<string>()
      const named = new Set<string>()
      for (const input of batch.checkpoints) {
        const appended = options.appendRunEvent(input)
        checkpointEvents += 1
        ledgers.add(appended.file)
        for (const directory of appended.directories) named.add(directory)
      }
      await syncAll([...ledgers], false)
      await syncAll([...named], true)
      durable = true
    } catch {
      // The batch failed: what it wrote stays unreferenced, and the content inline.
    } finally {
      outstanding -= 1
      if (!current()) batches.dropped += 1
      else {
        thread.outstanding = null
        if (durable) {
          batches.durable += 1
          thread.ready = batch.refs
          thread.failures = 0
          thread.retryAt = 0
        } else {
          batches.failed += 1
          backOff(thread)
        }
      }
    }
  }

  /** Write a save's new batch and set it running, if it is still admitted. */
  const start = (chat: ChatRecord, writer: ToolActivityDetailBatchWriter, refs: Refs): void => {
    const chatId = chat.appChatId
    let thread = threads.get(chatId)
    if (!admits(thread)) return
    if (!thread) {
      thread = { ready: new Refs(), outstanding: null, failures: 0, retryAt: 0 }
      threads.set(chatId, thread)
    }
    let segments: ToolActivityDetailSegment[]
    let checkpoints: RunEventInput[]
    try {
      segments = writer.writeUnsynced()
      checkpoints = segments.map((segment) => options.checkpointInput(chat, segment.checkpoint))
    } catch (error) {
      batches.failed += 1
      backOff(thread)
      throw error
    }
    const directories = new Set<string>()
    for (const segment of segments) directories.add(path.dirname(segment.filePath))
    directories.add(runArtifactsDir)
    directories.add(path.dirname(runArtifactsDir))
    const batch: Batch = {
      refs,
      files: segments.map((segment) => segment.filePath),
      directories: [...directories],
      checkpoints
    }
    thread.outstanding = batch
    outstanding += 1
    batches.committed += 1
    void run(chatId, thread, batch)
  }

  const batch = (chat: ChatRecord): ToolActivityDetailStagingBatch => {
    const chatId = chat.appChatId
    /** Undecided until a row needs a new batch; null once one could not be admitted. */
    let writer: ToolActivityDetailBatchWriter | null | undefined
    const staged = new Refs()
    /** The ready refs this save took: spent once it commits. */
    const taken: Array<[string, string, ToolActivityDetailRef]> = []
    /** The rows this save left inline until their bytes are durable, by run and activity. */
    const awaiting = new Map<string, Set<string>>()
    const awaits = (runId: string, activityId: string): void => {
      let activities = awaiting.get(runId)
      if (!activities) {
        activities = new Set()
        awaiting.set(runId, activities)
      }
      activities.add(activityId)
    }
    let committed = false
    return {
      stage(runId, activity) {
        if (committed || !runId || !activity?.id) return null
        const thread = threads.get(chatId)
        const ready = thread?.ready.get(runId, activity.id)
        if (thread && ready) {
          if (toolActivityDetailSha256(runId, activity) === ready.sha256) {
            taken.push([runId, activity.id, ready])
            rows.swapped += 1
            return ready
          }
          // The activity changed since these bytes were staged.
          thread.ready.delete(runId, activity.id, ready)
        }
        if (writer === undefined) {
          writer = admits(thread) ? new ToolActivityDetailBatchWriter(runArtifactsDir) : null
        }
        if (!writer) {
          rows.passedOver += 1
          awaits(runId, activity.id)
          return null
        }
        const ref = writer.stage(runId, activity)
        if (ref) {
          staged.set(runId, activity.id, ref)
          rows.staged += 1
          awaits(runId, activity.id)
        }
        return null
      },
      commit() {
        if (committed) return []
        committed = true
        if (writer && staged.size > 0) start(chat, writer, staged)
        writer = null
        const thread = threads.get(chatId)
        if (thread) {
          for (const [runId, activityId, ref] of taken) thread.ready.delete(runId, activityId, ref)
          release(chatId, thread)
        }
        return []
      },
      awaitsDurability(runId, activityId) {
        return awaiting.get(runId)?.has(activityId) === true
      }
    }
  }

  return {
    batch,
    forget: (chatId) => {
      threads.delete(chatId)
    },
    forgetAll: () => {
      threads.clear()
    },
    abandon: () => {
      closed = true
      threads.clear()
    },
    snapshot: () => {
      let readyRefs = 0
      for (const thread of threads.values()) readyRefs += thread.ready.size
      return {
        threads: threads.size,
        outstanding,
        readyRefs,
        batches: { ...batches },
        rows: { ...rows },
        syncs: { ...syncs },
        checkpointEvents
      }
    }
  }
}
