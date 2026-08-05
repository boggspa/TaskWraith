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
 * KNOWN GAPS in this API — see the GrokWork collision report; these are
 * findings for the owning lane, deliberately NOT silently added here:
 *  1. No read-through. While a write is deferred the file on disk is stale,
 *     but `saveChat` derives `persistenceRevision` from a re-read baseline
 *     (`readChatForFeedbackBaseline`, store/index.ts) — two saves inside one
 *     deferral window would derive from the same baseline and collide.
 *  2. No max-latency ceiling. The trailing timer re-arms on every save, so a
 *     continuously streaming chat can defer indefinitely.
 *  3. No discard. A pending write that lands after a delete recreates the
 *     deleted chat file.
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
  stats(): SaveCoalescerStats
}

interface PendingSave {
  write: () => void
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * @param delayMs Trailing-edge window. Negative disables coalescing entirely
 *   (every save writes through synchronously, i.e. today's behaviour); `0`
 *   still coalesces saves issued in the same synchronous batch.
 */
export function createSaveCoalescer(delayMs: number): SaveCoalescer {
  const pending = new Map<string, PendingSave>()
  let scheduled = 0
  let coalesced = 0
  let flushed = 0
  let urgentFlushes = 0

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
      supersede(chatId)

      const entry: PendingSave = { write, timer: null }
      pending.set(chatId, entry)
      entry.timer = setTimeout(() => {
        // A barrier or a superseding save may have replaced this entry
        // between scheduling and firing; writing then would resurrect
        // superseded state.
        if (pending.get(chatId) !== entry) return
        pending.delete(chatId)
        runWrite(entry.write)
      }, delayMs)
      return delayMs
    },

    flush,

    flushAll(): void {
      for (const chatId of [...pending.keys()]) flush(chatId)
    },

    stats(): SaveCoalescerStats {
      return { scheduled, coalesced, flushed, pending: pending.size, urgentFlushes }
    }
  }
}
