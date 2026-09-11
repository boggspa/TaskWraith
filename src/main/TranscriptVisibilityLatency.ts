/**
 * The number that turns "the transcript never lags" from a hope into a gate.
 *
 * Measures append-to-visible: main stamps a tail frame when it pushes it, the
 * renderer sends a receipt once those rows are committed into the visible
 * transcript window, and the delta lands here. It sits beside the event-loop
 * lag histogram in `MainPerfSnapshot` for the same reason that one exists —
 * before it, every stall diagnosis needed a profiler attached to a live repro,
 * and the 2026-09-11 freeze was diagnosed from a diagnostics ring that could
 * say deliveries stopped but never how far behind the user's eyes were.
 *
 * THE RECEIPT MUST NEVER GATE A SEND. This is the one rule that makes the lane
 * different from `chat-updated`, whose ACK does gate, and whose ACK gating is
 * how a slow renderer used to withhold every later frame. Nothing in this
 * module is reachable from the producer's send path; it observes and it
 * reports. A renderer that never sends a receipt degrades this histogram's
 * coverage and nothing else.
 *
 * Latency is measured entirely on main's clock — stamp at send, compare at
 * receipt — so it never assumes two processes agree on wall time. That makes
 * the reading a deliberate OVER-estimate of what the user experienced: it
 * includes the receipt's own hop back. A conservative bound is the right error
 * direction for a gate.
 */

export interface TranscriptVisibilityLatencySnapshot {
  /** Completed append→visible measurements in the current window. */
  samples: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
  /**
   * Age of the OLDEST frame still awaiting a receipt. This is the live
   * "how far behind is the transcript right now" reading; the percentiles are
   * historical and go quiet during the exact stall they should describe.
   */
  oldestPendingMs: number
  /** Frames still awaiting a receipt. */
  pending: number
  /**
   * Frames abandoned without a receipt (older than the pending ceiling). A
   * rising count means the push lane is being dropped on the floor rather than
   * being slow, which is a different defect with a different fix.
   */
  abandoned: number
  /** Receipts that matched no outstanding frame — duplicate or post-reload. */
  unmatchedReceipts: number
}

export interface TranscriptVisibilityLatencyOptions {
  /**
   * Bounds retained completed samples. Percentiles are computed over this
   * reservoir, so it is a memory bound and a window length at once.
   */
  maxSamples?: number
  /** Bounds outstanding frames; the oldest are abandoned first. */
  maxPending?: number
  /** A frame older than this is abandoned rather than skewing `oldestPendingMs` forever. */
  pendingCeilingMs?: number
  now?: () => number
}

interface PendingFrame {
  key: string
  sentAtMs: number
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index] ?? 0
}

export class TranscriptVisibilityLatency {
  private readonly samples: number[] = []
  /** Insertion-ordered, so the first entry is always the oldest outstanding frame. */
  private readonly pending = new Map<string, PendingFrame>()
  private readonly maxSamples: number
  private readonly maxPending: number
  private readonly pendingCeilingMs: number
  private readonly now: () => number
  private abandoned = 0
  private unmatchedReceipts = 0

  constructor(options: TranscriptVisibilityLatencyOptions = {}) {
    this.maxSamples = Math.max(1, options.maxSamples ?? 2_048)
    this.maxPending = Math.max(1, options.maxPending ?? 512)
    this.pendingCeilingMs = Math.max(1, options.pendingCeilingMs ?? 120_000)
    this.now = options.now ?? Date.now
  }

  private static key(chatId: string, sequence: number): string {
    return `${chatId}\u0000${sequence}`
  }

  /** Called on the producer's send path. Must stay O(1) and must never throw. */
  recordSent(chatId: string, sequence: number, sentAtMs?: number): void {
    if (!chatId || !Number.isSafeInteger(sequence) || sequence <= 0) return
    const key = TranscriptVisibilityLatency.key(chatId, sequence)
    this.pending.set(key, { key, sentAtMs: sentAtMs ?? this.now() })
    this.evictOverflowPending()
  }

  /** Called when a renderer reports the rows are committed into its visible window. */
  recordCommitted(chatId: string, sequence: number): void {
    if (!chatId || !Number.isSafeInteger(sequence) || sequence <= 0) return
    const key = TranscriptVisibilityLatency.key(chatId, sequence)
    const frame = this.pending.get(key)
    if (!frame) {
      this.unmatchedReceipts += 1
      return
    }
    this.pending.delete(key)
    this.push(Math.max(0, this.now() - frame.sentAtMs))
  }

  /** Drop outstanding frames for a chat the renderer will never receipt. */
  forget(chatId: string): void {
    if (!chatId) return
    const prefix = `${chatId}\u0000`
    for (const key of [...this.pending.keys()]) {
      if (key.startsWith(prefix)) this.pending.delete(key)
    }
  }

  snapshot(options?: { reset?: boolean }): TranscriptVisibilityLatencySnapshot {
    this.expirePending()
    const sorted = [...this.samples].sort((a, b) => a - b)
    const oldest = this.pending.values().next().value as PendingFrame | undefined
    const snapshot: TranscriptVisibilityLatencySnapshot = {
      samples: sorted.length,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      p99Ms: percentile(sorted, 0.99),
      maxMs: sorted.length > 0 ? (sorted[sorted.length - 1] ?? 0) : 0,
      oldestPendingMs: oldest ? Math.max(0, this.now() - oldest.sentAtMs) : 0,
      pending: this.pending.size,
      abandoned: this.abandoned,
      unmatchedReceipts: this.unmatchedReceipts
    }
    if (options?.reset) {
      this.samples.length = 0
      this.abandoned = 0
      this.unmatchedReceipts = 0
    }
    return snapshot
  }

  private push(valueMs: number): void {
    this.samples.push(valueMs)
    // Drop the oldest sample rather than the newest: a window that stops
    // accepting data once full would make a long stall invisible in exactly
    // the reading that should show it.
    if (this.samples.length > this.maxSamples) this.samples.shift()
  }

  private expirePending(): void {
    if (this.pending.size === 0) return
    const cutoff = this.now() - this.pendingCeilingMs
    for (const [key, frame] of this.pending) {
      // Insertion-ordered: the first frame inside the ceiling ends the sweep.
      if (frame.sentAtMs > cutoff) break
      this.pending.delete(key)
      this.abandoned += 1
    }
  }

  private evictOverflowPending(): void {
    while (this.pending.size > this.maxPending) {
      const oldestKey = this.pending.keys().next().value
      if (typeof oldestKey !== 'string') break
      this.pending.delete(oldestKey)
      this.abandoned += 1
    }
  }
}
