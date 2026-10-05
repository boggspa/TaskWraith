/**
 * The run queue under barrier durability: the list in memory is what the
 * store reads and changes, and its file follows it, a write behind.
 *
 * A change replaces the list and asks for a write of it. A write puts the
 * whole list in a temp file off the event loop, has the port sync it, renames
 * it over the file, and has the port sync the folder, so a power cut leaves
 * the old file or the new one, never a torn or empty one. A write starts a
 * turn after the change that asks for it, so the changes of one turn share
 * it. One write runs at a time and at most one waits, which takes the latest
 * list when it starts: a burst of changes costs a write or two, not one each.
 * A write that fails is tried again after 100 ms, doubling to 5 s, with the
 * list as it is then.
 *
 * `awaitWritten(version)` resolves once a finished write holds that change or
 * a later one. A change a person makes waits for it, bounded, before its
 * reply; automatic transitions wait for nothing. While a person waits, the
 * port is asked for the syncs as urgent, and otherwise at its normal class,
 * since the file is what tells startup which runs had begun.
 *
 * History deletion rewrites the file itself, on the calling thread and
 * synced: `writeNowSync` first writes the latest list the same way, so the
 * deletion reads it, and `reload` takes back the list the deletion left. A
 * write running then removes its temp and renames nothing over theirs.
 *
 * Quit (`close`) waits within its budget for the latest list's write. From
 * then on every change is written on the calling thread and synced, as
 * without barrier durability; and so once the store shuts its durability
 * down (`dispose`), when a write still running renames nothing.
 *
 * Nothing kept here is handed out: what the store reads back is a copy, as a
 * parse of the file was, and a job given in is copied before it is kept.
 *
 * Memory: the list, its serialization while a write runs, and one callback
 * per change a person is waiting on.
 */
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import path from 'node:path'

import type { ThreadDurabilityPort, ThreadDurabilitySyncOptions } from './ThreadDurabilityDebt'
import type { RunQueueJob } from './types'

/** A write that failed is tried again after this, doubled for each failure in a row. */
export const RUN_QUEUE_WRITE_FIRST_BACKOFF_MS = 100

/** The longest wait before a failed write is tried again. */
export const RUN_QUEUE_WRITE_LONGEST_BACKOFF_MS = 5_000

export interface RunQueueFileOptions {
  filePath: string
  /** The barrier layer's port: every sync it makes runs off the event loop. */
  port: Pick<ThreadDurabilityPort, 'syncFile' | 'syncDirectory'>
  /** The file as the store reads it, at first use: its own read, which sets a corrupt file aside. */
  read(): RunQueueJob[]
  /** The store's own write on the calling thread, synced: for history deletion and after quit. */
  writeSync(jobs: RunQueueJob[]): void
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** Where a failed write and an unwritten quit are reported, by count alone. */
  warn?: (message: string) => void
}

export interface RunQueueFileSnapshot {
  /** Changes made to the list. */
  changes: number
  /** Whole-file writes finished off the event loop. */
  writes: number
  /** Changes a later write took in instead of one of their own. */
  coalesced: number
  /** Writes that failed, each tried again. */
  failed: number
  /** Writes that found the file written on the calling thread meanwhile, and renamed nothing. */
  superseded: number
  /** Writes on the calling thread, synced: for history deletion, and at and after quit. */
  inlineWrites: number
  /** Syncs asked of the port: temp files, and the folder. */
  syncs: { files: number; directories: number }
  /** Now: whether a write is running, and how many changes no finished write holds yet. */
  writing: boolean
  unwrittenChanges: number
  /** Quit found the latest list not written within its budget. */
  quitUnwritten: number
}

interface Waiter {
  version: number
  urgent: boolean
  resolve(): void
}

/** As the file would give it back: a parse of what is written. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export class RunQueueFile {
  private readonly filePath: string
  private readonly port: RunQueueFileOptions['port']
  private readonly readFile: () => RunQueueJob[]
  private readonly writeFileSync: (jobs: RunQueueJob[]) => void
  private readonly setTimer: (callback: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly warn: (message: string) => void
  private list: RunQueueJob[] = []
  private kept = new Set<RunQueueJob>()
  private loaded = false
  /** Counts the list's changes; a write holds the version it serialized. */
  private changedVersion = 0
  private writtenVersionValue = 0
  /** Increased by every write on the calling thread: a write running from before renames nothing. */
  private generation = 0
  private writing: Promise<void> | null = null
  private again = false
  private retryTimer: unknown = null
  private failuresInARow = 0
  private runningTemp: string | null = null
  private closed = false
  /** The store shut its durability down: no write starts or renames from here on. */
  private disposed = false
  private waiters: Waiter[] = []
  private warned = false
  private readonly counts = {
    changes: 0,
    writes: 0,
    coalesced: 0,
    failed: 0,
    superseded: 0,
    inlineWrites: 0,
    fileSyncs: 0,
    directorySyncs: 0,
    quitUnwritten: 0
  }

  constructor(options: RunQueueFileOptions) {
    this.filePath = options.filePath
    this.port = options.port
    this.readFile = options.read
    this.writeFileSync = options.writeSync
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.warn = options.warn ?? ((message) => console.warn(message))
  }

  /** The latest change. */
  get version(): number {
    return this.changedVersion
  }

  /** The latest change a finished write holds. */
  get writtenVersion(): number {
    return this.writtenVersionValue
  }

  /**
   * The list for the store's own use: a new array of the jobs kept, which the
   * store may reorder and replace in but must not change or hand out.
   */
  read(): RunQueueJob[] {
    this.load()
    return Array.isArray(this.list) ? [...this.list] : this.list
  }

  /** Jobs read from the list, copied for a caller outside the store. */
  copies(jobs: RunQueueJob[]): RunQueueJob[] {
    return jobs.map((job) => copy(job))
  }

  /** A job read from the list, copied for a caller outside the store. */
  copyOf(job: RunQueueJob): RunQueueJob {
    return copy(job)
  }

  /**
   * The list after a change, already capped and sorted as the file keeps it.
   * Jobs not kept already are copied in. Returns the change's version.
   */
  replace(jobs: RunQueueJob[]): number {
    this.load()
    this.list = jobs.map((job) => (this.kept.has(job) ? job : copy(job)))
    this.kept = new Set(this.list)
    this.changedVersion += 1
    this.counts.changes += 1
    if (this.closed) this.writeNowSync()
    else this.kick()
    return this.changedVersion
  }

  /**
   * Resolves once a finished write holds `version` or a later change. While
   * an `urgent` wait is open, the port is asked for the syncs as urgent.
   */
  awaitWritten(version: number, options: { urgent?: boolean } = {}): Promise<void> {
    if (this.writtenVersionValue >= version) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.waiters.push({ version, urgent: options.urgent === true, resolve })
    })
  }

  /**
   * Writes the latest list on the calling thread, synced, as the store does
   * without barrier durability. A write running from before renames nothing.
   */
  writeNowSync(): void {
    this.load()
    // A write running for an earlier change was superseded when this was marked.
    if (this.writtenVersionValue >= this.changedVersion) return
    this.generation += 1
    this.discardRunningTemp()
    this.writeFileSync(this.list)
    this.counts.inlineWrites += 1
    this.markWritten(this.changedVersion)
  }

  /**
   * Takes the list back from the file, after `writeNowSync` and a rewrite of
   * the file on the calling thread: what the rewrite left is what is kept.
   */
  reload(): void {
    this.generation += 1
    this.discardRunningTemp()
    this.loaded = false
    this.load()
    this.changedVersion += 1
    this.markWritten(this.changedVersion)
  }

  /**
   * Quit: wait within `budgetMs` for the latest list's write; from then on
   * every change is written on the calling thread, synced.
   */
  async close(budgetMs: number): Promise<{ unwritten: boolean }> {
    if (this.closed) return { unwritten: false }
    const target = this.changedVersion
    let unwritten = false
    if (this.writtenVersionValue < target) {
      let timer: unknown = null
      const bound = new Promise<'timeout'>((resolve) => {
        timer = this.setTimer(() => resolve('timeout'), Math.max(0, budgetMs))
        ;(timer as { unref?: () => void } | null)?.unref?.()
      })
      const outcome = await Promise.race([
        this.awaitWritten(target).then(() => 'written' as const),
        bound
      ])
      this.clearTimer(timer)
      unwritten = outcome === 'timeout'
    }
    this.closed = true
    if (unwritten) {
      this.counts.quitUnwritten += 1
      this.warn('[run-queue] the latest run queue was not written within the quit budget')
    } else if (this.writtenVersionValue < this.changedVersion) {
      // Changed while quit waited: written here, as every change from now on is.
      this.writeNowSync()
    }
    return { unwritten }
  }

  /**
   * The store shut its durability down: a write running renames nothing, no
   * write starts, and a later change is written on the calling thread.
   */
  dispose(): void {
    this.disposed = true
    this.closed = true
    if (this.retryTimer !== null) this.clearTimer(this.retryTimer)
    this.retryTimer = null
  }

  snapshot(): RunQueueFileSnapshot {
    return {
      changes: this.counts.changes,
      writes: this.counts.writes,
      coalesced: this.counts.coalesced,
      failed: this.counts.failed,
      superseded: this.counts.superseded,
      inlineWrites: this.counts.inlineWrites,
      syncs: { files: this.counts.fileSyncs, directories: this.counts.directorySyncs },
      writing: this.writing !== null,
      unwrittenChanges: this.changedVersion - this.writtenVersionValue,
      quitUnwritten: this.counts.quitUnwritten
    }
  }

  private load(): void {
    if (this.loaded) return
    this.list = this.readFile()
    this.kept = new Set(Array.isArray(this.list) ? this.list : [])
    this.loaded = true
  }

  private kick(): void {
    if (this.writing) {
      this.again = true
      return
    }
    if (this.disposed) return
    if (this.retryTimer !== null || this.writtenVersionValue >= this.changedVersion) return
    this.writing = this.writeLatest().finally(() => {
      this.writing = null
      if (!this.again && this.writtenVersionValue >= this.changedVersion) return
      this.again = false
      if (!this.closed) this.kick()
    })
  }

  private syncOptions(): ThreadDurabilitySyncOptions | undefined {
    return this.waiters.some((waiter) => waiter.urgent) ? { urgent: true } : undefined
  }

  private async writeLatest(): Promise<void> {
    // Changes made in the same turn as the one that started this write go in it.
    await Promise.resolve()
    if (this.disposed || this.writtenVersionValue >= this.changedVersion) return
    const target = this.changedVersion
    const generation = this.generation
    const content = JSON.stringify(this.list, null, 2)
    const directory = path.dirname(this.filePath)
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    let created = false
    this.runningTemp = temp
    try {
      await fs.promises.mkdir(directory, { recursive: true })
      const handle = await fs.promises.open(temp, 'wx', 0o600)
      created = true
      try {
        await handle.writeFile(content, 'utf-8')
      } finally {
        await handle.close()
      }
      this.counts.fileSyncs += 1
      await this.port.syncFile(temp, this.syncOptions())
      if (generation !== this.generation || this.disposed) {
        // The file was written on the calling thread meanwhile, with a later list.
        this.counts.superseded += 1
        await fs.promises.unlink(temp).catch(() => {})
        return
      }
      fs.renameSync(temp, this.filePath)
      created = false
      this.counts.directorySyncs += 1
      await this.port.syncDirectory(directory, this.syncOptions())
      this.counts.writes += 1
      this.counts.coalesced += Math.max(0, target - this.writtenVersionValue - 1)
      this.failuresInARow = 0
      this.markWritten(target)
    } catch (error) {
      if (created) await fs.promises.unlink(temp).catch(() => {})
      if (generation !== this.generation || this.disposed) {
        // What failed was already superseded: nothing to try again.
        this.counts.superseded += 1
        return
      }
      this.counts.failed += 1
      if (!this.warned) {
        this.warned = true
        const code = (error as NodeJS.ErrnoException | null)?.code ?? 'error'
        this.warn(`[run-queue] a write of the run queue failed (${code}); it is tried again`)
      }
      this.retryAfterFailure()
    } finally {
      if (this.runningTemp === temp) this.runningTemp = null
    }
  }

  private retryAfterFailure(): void {
    const delay = Math.min(
      RUN_QUEUE_WRITE_FIRST_BACKOFF_MS * 2 ** this.failuresInARow,
      RUN_QUEUE_WRITE_LONGEST_BACKOFF_MS
    )
    this.failuresInARow += 1
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null
      if (!this.closed) this.kick()
    }, delay)
    ;(this.retryTimer as { unref?: () => void } | null)?.unref?.()
  }

  /** A write running from before a write on the calling thread: its temp goes now. */
  private discardRunningTemp(): void {
    const temp = this.runningTemp
    if (!temp) return
    this.runningTemp = null
    try {
      fs.unlinkSync(temp)
    } catch {
      // Not written yet: the write removes it when it finds the generation changed.
    }
  }

  private markWritten(version: number): void {
    if (version <= this.writtenVersionValue) return
    this.writtenVersionValue = version
    const ready = this.waiters.filter((waiter) => waiter.version <= version)
    if (ready.length === 0) return
    this.waiters = this.waiters.filter((waiter) => waiter.version > version)
    for (const waiter of ready) waiter.resolve()
  }
}
