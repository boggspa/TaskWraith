/**
 * Deferred materialization for large-chat Host compatibility checkpoints.
 *
 * WHY THIS EXISTS: an idle large chat's `terminal` save used to materialize
 * the full Host compatibility checkpoint synchronously inside
 * `AppStore.saveChat`. Materializing means serializing the whole record
 * (tens of megabytes) on the Electron main thread and then asking the Host to
 * parse and re-serialize it — all for a mutation that is ALREADY durable in
 * the incremental journal. Measured on a 27.5 MB thread, that serialize alone
 * held main for ~2 s (the save's own invalidation could not go out until it
 * finished), and the Host-side parse held the Host loop for ~6.4 s, past the
 * client's 6.25 s connect budget: every Host round-trip the UI needed during
 * that window failed, and the panel looked frozen for ~25 s.
 *
 * WHAT DEFERRAL PRESERVES: the journal is the hot durability path; the
 * checkpoint is a compatibility copy for readers outside this process. For a
 * LARGE record the cost of writing it now dominates the save, so the write
 * moves off the save path to a short trailing timer that coalesces a burst of
 * edits into one checkpoint. Freshness guarantees stay explicit:
 *   - a durability barrier (`awaitChatRecordPersisted`) still materializes
 *     synchronously before it drains (see `barrierChatRecordPersisted`);
 *   - shutdown drains every staged checkpoint before exit;
 *   - the timer is short, so external readers lag the journal by seconds,
 *     never sit stale until some unrelated save.
 *
 * WHAT NEVER DEFERS: creation, a journal failure (the checkpoint is then the
 * only durability), a detail-externalization failure, `approval`/`shutdown`/
 * `history-deletion` flushes, records under the size floor (their checkpoint
 * is cheap and external readers expect it immediately), and deleted chats
 * (the timer re-checks the tombstone before materializing).
 */

/** Records at or above this size defer their compatibility checkpoint. */
export const DEFERRED_HOST_MATERIALIZE_MIN_BYTES = 4 * 1024 * 1024
/** Trailing coalescing window for deferred checkpoints. Kept above the
 *  renderer's post-save pull window: the panel refresh and any pull issued ~1 s
 *  after a save must be able to finish before the checkpoint's Host-side parse
 *  begins, or they queue behind a multi-second event-loop block. */
export const DEFERRED_HOST_MATERIALIZE_DELAY_MS = 5_000

export interface DeferredHostMaterializationOptions {
  /** Flush one staged checkpoint now. Return value is advisory only. */
  readonly materialize: (chatId: string) => boolean
  /** The save-path tombstone: a deleted chat must never be re-materialized. */
  readonly isDeleted: (chatId: string) => boolean
  readonly minBytes?: number
  readonly delayMs?: number
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

export class DeferredHostMaterialization {
  private readonly materialize: (chatId: string) => boolean
  private readonly isDeleted: (chatId: string) => boolean
  private readonly minBytes: number
  private readonly delayMs: number
  private readonly setTimer: (
    callback: () => void,
    delayMs: number
  ) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(options: DeferredHostMaterializationOptions) {
    if (
      !options ||
      typeof options.materialize !== 'function' ||
      typeof options.isDeleted !== 'function'
    ) {
      throw new TypeError(
        'DeferredHostMaterialization requires materialize and isDeleted callbacks.'
      )
    }
    this.materialize = options.materialize
    this.isDeleted = options.isDeleted
    this.minBytes =
      Number.isFinite(options.minBytes) && (options.minBytes ?? 0) >= 0
        ? Math.floor(options.minBytes!)
        : DEFERRED_HOST_MATERIALIZE_MIN_BYTES
    this.delayMs =
      Number.isFinite(options.delayMs) && (options.delayMs ?? 0) >= 0
        ? Math.floor(options.delayMs!)
        : DEFERRED_HOST_MATERIALIZE_DELAY_MS
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
  }

  get pendingChatIds(): string[] {
    return [...this.pending.keys()].sort()
  }

  /**
   * Decide whether this save's checkpoint may defer and, when it may, start
   * (or restart) the trailing timer. Returns true ONLY when the caller must
   * NOT materialize synchronously.
   */
  schedule(
    chatId: string,
    decision: {
      existingBytes: number
      flushReason: string
      /** Journal failed or externalization failed: the checkpoint is the durability fallback. */
      durabilityFallback: boolean
    }
  ): boolean {
    if (typeof chatId !== 'string' || chatId.length === 0) return false
    if (decision.flushReason !== 'terminal' || decision.durabilityFallback) return false
    if (!Number.isFinite(decision.existingBytes) || decision.existingBytes < this.minBytes) {
      return false
    }
    const previous = this.pending.get(chatId)
    if (previous) this.clearTimer(previous)
    const timer = this.setTimer(() => {
      this.pending.delete(chatId)
      // A delete during the window owns the lane: materializing would
      // resurrect the record the user just erased. The compatibility layer's
      // prepareDelete also discards the staged record; this is the backstop
      // for the timer living outside that layer.
      if (this.isDeleted(chatId)) return
      try {
        this.materialize(chatId)
      } catch {
        // The next save, barrier, or shutdown drain retries the checkpoint;
        // the journal remains the durable record either way.
      }
    }, this.delayMs)
    ;(timer as { unref?: () => void }).unref?.()
    this.pending.set(chatId, timer)
    return true
  }

  cancel(chatId: string): void {
    const timer = this.pending.get(chatId)
    if (!timer) return
    this.clearTimer(timer)
    this.pending.delete(chatId)
  }

  dispose(): void {
    for (const timer of this.pending.values()) this.clearTimer(timer)
    this.pending.clear()
  }
}
