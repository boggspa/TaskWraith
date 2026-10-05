/**
 * The usage log's syncs under barrier durability. An append writes without a
 * sync on the thread that makes it and says here what it left owing: the
 * journal or a spill file whose bytes are not on the disk yet, and the folder
 * when a name in it was made or removed. A round then pays all of it off the
 * event loop, through the barrier layer's port at its background class, so it
 * never delays a sync a person waits for.
 *
 * At most one round starts in any `USAGE_JOURNAL_SYNC_INTERVAL_MS` while
 * appends arrive: the first after a quiet spell starts as soon as the work
 * that owed it is done, and what is owed while one runs, or within the
 * interval, waits for the next. A round syncs the files first and
 * then the folders, since a name must not be made durable before the bytes it
 * names, and it pays what was owed when it started: a sync asked for after a
 * write covers that write. A sync that fails, or a round the port rejects, is
 * owed again for the next round, one interval on: a disk that keeps refusing
 * costs one round a second, never a loop.
 *
 * After a power cut the usage log keeps what the last finished round paid,
 * and of what was appended after it no more than the disk wrote by itself.
 * Records are accounting rows, not decisions, so the last second of them is
 * what a power cut may cost.
 *
 * `settle` is for quit: it waits for the round running, then pays what is
 * still owed in one more round at the port's normal class, within the time it
 * is given, and counts what was not paid. No round starts after it: the store
 * syncs every append where it is made from then on.
 *
 * Memory: one entry per path owed, which is the journal, the folder and at
 * most a few spill files, and one timer.
 */
import type { ThreadDurabilityPort, ThreadDurabilitySyncOptions } from './ThreadDurabilityDebt'

/** The least time between the starts of two rounds. */
export const USAGE_JOURNAL_SYNC_INTERVAL_MS = 1_000

export interface UsageJournalBackgroundSyncOptions {
  port: Pick<ThreadDurabilityPort, 'syncFile' | 'syncDirectory'>
  intervalMs?: number
  /** Milliseconds, read only to space rounds. */
  now?: () => number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** Where a failed round and an unpaid quit are reported, by count alone. */
  warn?: (message: string) => void
}

export interface UsageJournalBackgroundSyncSnapshot {
  /** Paths owed now and not yet in a round. */
  owed: { files: number; directories: number }
  /** Rounds started, and those in which a sync failed or the port refused. */
  rounds: number
  failedRounds: number
  /** Syncs asked of the port, in every round and at quit. */
  syncs: { files: number; directories: number }
  /** Whether quit's round was raised, and whether it was not done in its time. */
  quitRounds: number
  quitUnpaid: number
}

export class UsageJournalBackgroundSync {
  private readonly port: UsageJournalBackgroundSyncOptions['port']
  private readonly intervalMs: number
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly warn: (message: string) => void
  private files = new Set<string>()
  private directories = new Set<string>()
  private timer: unknown = null
  private startQueued = false
  private running: Promise<void> | null = null
  private lastStartedAt: number | null = null
  private settling = false
  private disposed = false
  private rounds = 0
  private failedRounds = 0
  private fileSyncs = 0
  private directorySyncs = 0
  private quitRounds = 0
  private quitUnpaid = 0
  private failureWarned = false

  constructor(options: UsageJournalBackgroundSyncOptions) {
    this.port = options.port
    this.intervalMs = Math.max(0, options.intervalMs ?? USAGE_JOURNAL_SYNC_INTERVAL_MS)
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.warn = options.warn ?? ((message) => console.warn(message))
  }

  /** Whether quit has settled it: from then on the store syncs where it writes. */
  get settled(): boolean {
    return this.settling
  }

  /**
   * What one write left owing: files whose bytes were written and not synced,
   * and folders in which a name was made, renamed or removed. Given whole, so
   * a round that starts here pays all of it.
   */
  owe(owed: { files?: readonly string[]; directories?: readonly string[] }): void {
    for (const file of owed.files ?? []) this.files.add(file)
    for (const directory of owed.directories ?? []) this.directories.add(directory)
    this.schedule()
  }

  /**
   * Quit: wait for the round running, then pay what is still owed, at the
   * port's normal class, within `budgetMs`. Starts no round after it.
   */
  async settle(budgetMs: number): Promise<{ unpaid: boolean }> {
    if (this.settling) return { unpaid: false }
    this.settling = true
    this.cancelTimer()
    let timer: unknown = null
    const bound = new Promise<'timeout'>((resolve) => {
      timer = this.setTimer(() => resolve('timeout'), Math.max(0, budgetMs))
      ;(timer as { unref?: () => void } | null)?.unref?.()
    })
    const paying = (async (): Promise<'paid'> => {
      await this.running?.catch(() => {})
      if (this.files.size > 0 || this.directories.size > 0) {
        this.quitRounds += 1
        await this.round({})
      }
      return 'paid'
    })()
    const outcome = await Promise.race([paying, bound])
    this.clearTimer(timer)
    const unpaid = outcome === 'timeout' || this.files.size > 0 || this.directories.size > 0
    if (unpaid) {
      this.quitUnpaid += 1
      this.warn('[usage-journal] the usage log still owed the disk at quit')
    }
    return { unpaid }
  }

  /** Stops the timer; what is owed stays owed. */
  dispose(): void {
    this.disposed = true
    this.cancelTimer()
  }

  snapshot(): UsageJournalBackgroundSyncSnapshot {
    return {
      owed: { files: this.files.size, directories: this.directories.size },
      rounds: this.rounds,
      failedRounds: this.failedRounds,
      syncs: { files: this.fileSyncs, directories: this.directorySyncs },
      quitRounds: this.quitRounds,
      quitUnpaid: this.quitUnpaid
    }
  }

  private schedule(): void {
    if (this.disposed || this.settling || this.timer !== null || this.running) return
    if (this.startQueued) return
    const due = this.lastStartedAt === null ? 0 : this.lastStartedAt + this.intervalMs - this.now()
    if (due <= 0) {
      // Once the work that owed this is done, so that the round pays all of it.
      this.startQueued = true
      queueMicrotask(() => {
        this.startQueued = false
        this.start()
      })
      return
    }
    this.timer = this.setTimer(() => {
      this.timer = null
      this.start()
    }, due)
    ;(this.timer as { unref?: () => void } | null)?.unref?.()
  }

  private start(): void {
    if (this.disposed || this.settling || this.running) return
    if (this.files.size === 0 && this.directories.size === 0) return
    this.lastStartedAt = this.now()
    this.running = this.round({ background: true }).finally(() => {
      this.running = null
      if (this.files.size > 0 || this.directories.size > 0) this.schedule()
    })
  }

  /** Pays what is owed now: the files, then the folders. What fails is owed again. */
  private async round(options: ThreadDurabilitySyncOptions): Promise<void> {
    const files = [...this.files]
    const directories = [...this.directories]
    this.files = new Set()
    this.directories = new Set()
    this.rounds += 1
    let failed = false
    const settled = await Promise.allSettled(
      files.map((file) => {
        this.fileSyncs += 1
        return this.port.syncFile(file, options)
      })
    )
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') return
      failed = true
      this.files.add(files[index])
    })
    if (failed) {
      // A name is never made durable before the bytes it names.
      for (const directory of directories) this.directories.add(directory)
    } else {
      const named = await Promise.allSettled(
        directories.map((directory) => {
          this.directorySyncs += 1
          return this.port.syncDirectory(directory, options)
        })
      )
      named.forEach((result, index) => {
        if (result.status === 'fulfilled') return
        failed = true
        this.directories.add(directories[index])
      })
    }
    if (failed) {
      this.failedRounds += 1
      if (!this.failureWarned) {
        this.failureWarned = true
        this.warn('[usage-journal] a background sync of the usage log failed; it is owed again')
      }
    }
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
  }
}
