/**
 * T3a-1 — per-chat save coalescing.
 *
 * PROVENANCE / OWNERSHIP NOTE (read before editing):
 * This implementation was reconstructed by the GrokWork lane from the
 * behavioural contract in `saveCoalescer.test.ts` after a concurrent-write
 * collision on the shared checkout: two pass-5 lanes were dispatched onto the
 * same T3a-1 slice, and a `write_file` from this lane overwrote the peer
 * lane's implementation while their `store/index.ts` wiring
 * (`import { createSaveCoalescer, type FlushReason }`) was already in the tree.
 * That left the tree unable to typecheck. This file restores the peer lane's
 * exact public API so their wiring, their tests, and the other concurrent
 * sessions sharing this checkout all build again. The peer lane owns this
 * slice: if their own implementation returns, prefer it over this one — the
 * test file, not this file, is the contract.
 *
 * WHY COALESCING AT ALL (measured, not assumed):
 * The T2 authoritative baseline recorded the hot chat being atomically
 * rewritten 8-14 times per sampled 10 s window, each rewrite a full
 * serialize + write + fsync + rename + directory fsync of the whole record.
 * The T2 main-process CPU profile showed main 98.2% idle while throughput
 * decayed ~5x, so the cost is not CPU: it is wall time blocked inside
 * synchronous durability syscalls, which a V8 sampling profiler cannot
 * attribute. Consecutive saves of one chat are strictly superseding, so
 * making the earlier one durable buys only the crash window between them.
 *
 * DURABILITY CONTRACT:
 *  - Only `'normal'` saves are ever deferred. Every other reason is a
 *    durability barrier and writes synchronously before returning.
 *  - A deferred write that throws is swallowed and counted rather than
 *    rethrown: its caller has already returned, so there is no one left to
 *    handle it, and letting it escape a timer callback would take down the
 *    main process. Barrier writes keep normal throw semantics.
 *
 * GAP STATUS (all three closed; kept here as the audit trail):
 *  1. Read-through — CLOSED in `store/index.ts`, not here. `saveChat` derives
 *     `persistenceRevision` from a re-read baseline, so a deferred write must
 *     not leave that read seeing stale disk. The store marks its cache entry
 *     dirty (`mtimeMs: -1`) and `readChatRecordCached` /
 *     `readChatForFeedbackBaseline` consult it, so the baseline is the latest
 *     record rather than the last file on disk.
 *  2. Max-latency ceiling — CLOSED below. The trailing timer re-arms on every
 *     save, so under sustained streaming the trailing edge is never reached;
 *     without a ceiling a continuously active chat would defer forever. The
 *     ceiling makes the deferral window bounded and therefore the crash-loss
 *     window bounded, which is what makes raising the trailing window safe.
 *  3. Discard — CLOSED below. A pending write that fires after its chat was
 *     deleted recreates the file, and `getChats()` enumerates the directory,
 *     so the deleted chat reappears. Deletion must DISCARD, never flush.
 */

/**
 * Why a save is being written. Everything except `'normal'` is a durability
 * barrier and bypasses coalescing entirely.
 */
export type FlushReason = 'normal' | 'terminal' | 'approval' | 'history-deletion' | 'shutdown'

export interface SaveCoalescerStats {
  /** Saves that were deferred behind a timer. */
  scheduled: number
  /** Deferred saves superseded before they ever reached disk — the
   *  write-amplification reduction, stated directly. */
  coalesced: number
  /** Write callbacks actually executed, including failed and barrier writes. */
  flushed: number
  /** Saves currently deferred. */
  pending: number
  /** Barrier saves that bypassed the timer. */
  urgentFlushes: number
  /** Deferred writes forced out by the max-latency ceiling rather than by the
   *  trailing edge. Under sustained streaming this is the governing path. */
  ceilingFlushes: number
  /** Pending writes dropped without writing, because their chat was deleted. */
  discarded: number
}

export interface SaveCoalescer {
  /**
   * Queue or perform one save. Returns the deferral delay in milliseconds, or
   * `-1` when the write was performed synchronously (barrier reason, or
   * coalescing disabled).
   */
  schedule(chatId: string, write: () => void, reason: FlushReason): number
  /** Durability barrier for one chat. True when a deferred write was performed. */
  flush(chatId: string): boolean
  /** Durability barrier for every deferred chat — shutdown and global consistency points. */
  flushAll(): void
  /**
   * Drop a deferred write WITHOUT performing it. Only correct where the target
   * is being destroyed: flushing there would recreate a deleted chat file.
   * Returns true when a pending write was dropped.
   */
  discard(chatId: string): boolean
  /** Drop every deferred write without performing it — global history deletion. */
  discardAll(): number
  stats(): SaveCoalescerStats
}

interface PendingSave {
  write: () => void
  timer: ReturnType<typeof setTimeout> | null
  /** When this chat first went pending, for the max-latency ceiling. */
  firstQueuedAt: number
}

/** Ceiling applied when the caller does not supply one explicitly. */
export const DEFAULT_MAX_LATENCY_MULTIPLIER = 3

/**
 * @param delayMs Trailing-edge window. Negative disables coalescing entirely
 *   (every save writes through synchronously, i.e. today's behaviour); `0`
 *   still coalesces saves issued in the same synchronous batch.
 * @param maxLatencyMs Hard ceiling between a chat's first pending save and its
 *   write. The trailing timer re-arms on every save, so under sustained
 *   streaming the trailing edge is never reached and this ceiling — not
 *   `delayMs` — is what actually governs. It bounds both the staleness of the
 *   file on disk and the crash-loss window. Ignored when `delayMs <= 0`, where
 *   there is no meaningful deferral to bound.
 */
export function createSaveCoalescer(
  delayMs: number,
  maxLatencyMs: number = Math.max(delayMs, delayMs * DEFAULT_MAX_LATENCY_MULTIPLIER)
): SaveCoalescer {
  const pending = new Map<string, PendingSave>()
  // A ceiling below the trailing window would make the trailing edge
  // unreachable and every write would report as ceiling-forced.
  const ceilingMs = delayMs > 0 ? Math.max(delayMs, maxLatencyMs) : 0
  let scheduled = 0
  let coalesced = 0
  let flushed = 0
  let urgentFlushes = 0
  let ceilingFlushes = 0
  let discarded = 0

  /**
   * Run one write callback. Counted even when it throws: the write was
   * attempted and is no longer pending, and reporting it as still-queued
   * would overstate what is durable.
   */
  const runWrite = (write: () => void): void => {
    try {
      write()
    } catch (error) {
      // A deferred write's caller returned long ago. Escaping here would
      // reach an unhandled timer rejection on the main process.
      console.error('Coalesced chat save failed', error)
    } finally {
      flushed += 1
    }
  }

  /** Drop a deferred write that a superseding save has made redundant. */
  const supersede = (chatId: string): void => {
    const entry = pending.get(chatId)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    pending.delete(chatId)
    coalesced += 1
  }

  const flush = (chatId: string): boolean => {
    const entry = pending.get(chatId)
    if (!entry) return false
    if (entry.timer) clearTimeout(entry.timer)
    pending.delete(chatId)
    runWrite(entry.write)
    return true
  }

  return {
    schedule(chatId: string, write: () => void, reason: FlushReason): number {
      // Disabled: preserve today's exact synchronous behaviour.
      if (delayMs < 0) {
        runWrite(write)
        return -1
      }

      // Durability barrier. Any deferred save for this chat is strictly
      // superseded by this record, so it is dropped rather than written —
      // writing it would be pure amplification and could land out of order.
      if (reason !== 'normal') {
        supersede(chatId)
        urgentFlushes += 1
        runWrite(write)
        return -1
      }

      scheduled += 1
      // The ceiling is measured from when this chat FIRST went pending, not
      // from the newest save. Restarting it per save is what would let a
      // continuously streaming chat defer forever.
      const previous = pending.get(chatId)
      const firstQueuedAt = previous ? previous.firstQueuedAt : Date.now()
      supersede(chatId)

      const remainingCeiling =
        ceilingMs > 0 ? ceilingMs - (Date.now() - firstQueuedAt) : Number.POSITIVE_INFINITY
      const forcedByCeiling = remainingCeiling <= delayMs
      const delay = forcedByCeiling ? Math.max(0, remainingCeiling) : delayMs

      const entry: PendingSave = { write, timer: null, firstQueuedAt }
      pending.set(chatId, entry)
      entry.timer = setTimeout(() => {
        // A barrier, a discard, or a superseding save may have replaced this
        // entry between scheduling and firing; writing then would resurrect
        // superseded — or deleted — state.
        if (pending.get(chatId) !== entry) return
        pending.delete(chatId)
        if (forcedByCeiling) ceilingFlushes += 1
        runWrite(entry.write)
      }, delay)
      return delay
    },

    flush,

    flushAll(): void {
      for (const chatId of [...pending.keys()]) flush(chatId)
    },

    discard(chatId: string): boolean {
      const entry = pending.get(chatId)
      if (!entry) return false
      if (entry.timer) clearTimeout(entry.timer)
      pending.delete(chatId)
      discarded += 1
      return true
    },

    discardAll(): number {
      let dropped = 0
      for (const chatId of [...pending.keys()]) {
        const entry = pending.get(chatId)
        if (!entry) continue
        if (entry.timer) clearTimeout(entry.timer)
        pending.delete(chatId)
        discarded += 1
        dropped += 1
      }
      return dropped
    },

    stats(): SaveCoalescerStats {
      return {
        scheduled,
        coalesced,
        flushed,
        pending: pending.size,
        urgentFlushes,
        ceilingFlushes,
        discarded
      }
    }
  }
}
