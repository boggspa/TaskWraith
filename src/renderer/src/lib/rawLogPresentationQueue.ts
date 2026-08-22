import type { RawLogEntry } from './rawLogEntry'

/**
 * Raw provider lines are diagnostic data, not transcript-critical paint. Keep
 * the exact per-chat buffer synchronous, but publish its focused projection at
 * a bounded cadence so one JSONL line cannot force one App-root render.
 */
export const RAW_LOG_PRESENTATION_INTERVAL_MS = 100

export interface RawLogPresentationSnapshot {
  chatId: string
  logs: RawLogEntry[]
}

export interface RawLogPresentationQueueOptions {
  present: (snapshot: RawLogPresentationSnapshot) => void
  schedule: (callback: () => void, delayMs: number) => unknown
  cancel: (handle: unknown) => void
  delayMs?: number
}

export class RawLogPresentationQueue {
  private pending: RawLogPresentationSnapshot | null = null
  private scheduled = false
  private scheduledHandle: unknown
  private readonly delayMs: number

  constructor(private readonly options: RawLogPresentationQueueOptions) {
    const requestedDelay = options.delayMs ?? RAW_LOG_PRESENTATION_INTERVAL_MS
    this.delayMs = Math.max(0, Number.isFinite(requestedDelay) ? requestedDelay : 0)
  }

  enqueue(snapshot: RawLogPresentationSnapshot): void {
    this.pending = snapshot
    if (this.scheduled) return

    this.scheduled = true
    const handle = this.options.schedule(() => {
      this.scheduled = false
      this.scheduledHandle = undefined
      this.drain()
    }, this.delayMs)
    if (this.scheduled) this.scheduledHandle = handle
  }

  flushNow(): void {
    this.cancelScheduled()
    this.drain()
  }

  cancelPending(): void {
    this.cancelScheduled()
    this.pending = null
  }

  hasPending(): boolean {
    return this.pending !== null
  }

  private cancelScheduled(): void {
    if (!this.scheduled) return
    this.scheduled = false
    this.options.cancel(this.scheduledHandle)
    this.scheduledHandle = undefined
  }

  private drain(): void {
    const pending = this.pending
    this.pending = null
    if (pending) this.options.present(pending)
  }
}
