import type { HostTransactionLog, HostTransactionLogCompaction } from './HostTransactionLog'
import type { HostTransactionRecoveryInput } from './HostTransactionManifest'

export const HOST_TRANSACTION_LOG_COMPACT_RECORDS = 1_024
export const HOST_TRANSACTION_LOG_COMPACT_INTERVAL_MS = 30_000

export interface HostTransactionLogMaintenanceOptions {
  log: HostTransactionLog
  /** Sample inside the log's I/O turn, never before queued appends drain. */
  receipts: () => ReadonlyMap<string, HostTransactionRecoveryInput['receipt']>
  recordThreshold?: number
  intervalMs?: number
}

/**
 * Start only after manifest recovery. One compaction may be outstanding;
 * appends trigger a sweep every 1024 durable records and the periodic sweep
 * retires receipts that settled after their last manifest write. Pending and
 * indeterminate anchors are retained by the manifest's RR-3 predicate.
 * There is no absolute bound on unresolved anchors; they are recovery data.
 */
export class HostTransactionLogMaintenance {
  private readonly threshold: number
  private readonly intervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private unsubscribe: (() => void) | null = null
  private running: Promise<HostTransactionLogCompaction | null> | null = null
  private records = 0
  private stopped = false
  private last: HostTransactionLogCompaction | null = null

  constructor(private readonly options: HostTransactionLogMaintenanceOptions) {
    this.threshold = options.recordThreshold ?? HOST_TRANSACTION_LOG_COMPACT_RECORDS
    this.intervalMs = options.intervalMs ?? HOST_TRANSACTION_LOG_COMPACT_INTERVAL_MS
    if (!Number.isSafeInteger(this.threshold) || this.threshold < 1) {
      throw new Error('Transaction log maintenance needs a positive record threshold')
    }
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1) {
      throw new Error('Transaction log maintenance needs a positive interval')
    }
  }

  start(): void {
    if (this.stopped || this.unsubscribe) return
    this.unsubscribe = this.options.log.subscribeDurableAppends((count) => {
      this.records += count
      if (this.records >= this.threshold) void this.sweep()
    })
    this.timer = setInterval(() => void this.sweep(), this.intervalMs)
    this.timer.unref()
    // Bound historical logs immediately after recovery, including flag-off boot.
    void this.sweep()
  }

  sweep(): Promise<HostTransactionLogCompaction | null> {
    if (this.running) return this.running
    if (this.stopped || this.options.log.stats().commands === 0) return Promise.resolve(null)
    this.records = 0
    let snapshot: ReadonlyMap<string, HostTransactionRecoveryInput['receipt']> | null = null
    this.running = this.options.log
      .compact((commandId) => {
        snapshot ??= this.options.receipts()
        return snapshot.get(commandId) ?? null
      })
      .catch(
        (error: unknown): HostTransactionLogCompaction => ({
          kind: 'failed',
          detail: error instanceof Error ? error.message : String(error)
        })
      )
      .then((result) => {
        this.last = result
        return result
      })
      .finally(() => {
        this.running = null
        // Coalesce pressure received during a sweep, without a queue of jobs.
        if (!this.stopped && this.records >= this.threshold) void this.sweep()
      })
    return this.running
  }

  snapshot(): {
    running: boolean
    recordsSinceSweep: number
    last: HostTransactionLogCompaction | null
  } {
    return {
      running: this.running !== null,
      recordsSinceSweep: this.records,
      last: this.last && { ...this.last }
    }
  }

  async close(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.unsubscribe?.()
    this.unsubscribe = null
    await this.running
  }
}
