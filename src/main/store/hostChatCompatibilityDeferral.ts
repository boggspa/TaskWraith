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
 *     never sit stale until some unrelated save;
 *   - a fired checkpoint that cannot materialize yet because the
 *     thread-catalogue write gate is held is re-armed (bounded), never dropped
 *     — the copy cannot lag the journal by a whole recovery hold.
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
/**
 * Bound on re-arms when a fired checkpoint cannot materialize yet. Sized to
 * outlast the longest catalogue recovery gate hold (~10 minutes) at the
 * default trailing delay: the deferred checkpoint is re-armed, never dropped,
 * so the on-disk compatibility copy cannot lag the journal by the whole hold.
 */
export const DEFERRED_HOST_MATERIALIZE_MAX_RETRIES = 120

export interface DeferredHostMaterializationOptions {
  /** Flush one staged checkpoint now. Return value is advisory only. */
  readonly materialize: (chatId: string) => boolean
  /** The save-path tombstone: a deleted chat must never be re-materialized. */
  readonly isDeleted: (chatId: string) => boolean
  /**
   * When a fired checkpoint returns false, re-arm the trailing timer instead of
   * dropping it — but only while this predicate says the blockage is transient
   * (e.g. the thread-catalogue write gate is held). Without it a false return
   * drops the checkpoint exactly as before.
   */
  readonly retryWhen?: (chatId: string) => boolean
  readonly minBytes?: number
  readonly delayMs?: number
  /** Bound on re-arms per scheduled checkpoint; see DEFERRED_HOST_MATERIALIZE_MAX_RETRIES. */
  readonly maxRetries?: number
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

export class DeferredHostMaterialization {
  private readonly materialize: (chatId: string) => boolean
  private readonly isDeleted: (chatId: string) => boolean
  private readonly retryWhen: ((chatId: string) => boolean) | null
  private readonly minBytes: number
  private readonly delayMs: number
  private readonly maxRetries: number
  private readonly setTimer: (
    callback: () => void,
    delayMs: number
  ) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void
  private readonly pending = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; attempts: number }
  >()

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
    this.retryWhen = typeof options.retryWhen === 'function' ? options.retryWhen : null
    this.minBytes =
      Number.isFinite(options.minBytes) && (options.minBytes ?? 0) >= 0
        ? Math.floor(options.minBytes!)
        : DEFERRED_HOST_MATERIALIZE_MIN_BYTES
    this.delayMs =
      Number.isFinite(options.delayMs) && (options.delayMs ?? 0) >= 0
        ? Math.floor(options.delayMs!)
        : DEFERRED_HOST_MATERIALIZE_DELAY_MS
    this.maxRetries =
      Number.isSafeInteger(options.maxRetries) && (options.maxRetries ?? -1) >= 0
        ? options.maxRetries!
        : DEFERRED_HOST_MATERIALIZE_MAX_RETRIES
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
    if (previous) this.clearTimer(previous.timer)
    const arm = (attempts: number): void => {
      const timer = this.setTimer(() => {
        this.pending.delete(chatId)
        // A delete during the window owns the lane: materializing would
        // resurrect the record the user just erased. The compatibility layer's
        // prepareDelete also discards the staged record; this is the backstop
        // for the timer living outside that layer.
        if (this.isDeleted(chatId)) return
        let materialized = false
        try {
          materialized = this.materialize(chatId)
        } catch {
          // The next save, barrier, or shutdown drain retries the checkpoint;
          // the journal remains the durable record either way.
          return
        }
        // A transient blockage (the write gate held by a catalogue recovery)
        // used to DROP the checkpoint here, leaving the on-disk compatibility
        // copy stale for the whole hold. Re-arm within a bound instead.
        if (!materialized && this.retryWhen?.(chatId) && attempts < this.maxRetries) {
          arm(attempts + 1)
        }
      }, this.delayMs)
      ;(timer as { unref?: () => void }).unref?.()
      this.pending.set(chatId, { timer, attempts })
    }
    arm(0)
    return true
  }

  cancel(chatId: string): void {
    const entry = this.pending.get(chatId)
    if (!entry) return
    this.clearTimer(entry.timer)
    this.pending.delete(chatId)
  }

  dispose(): void {
    for (const entry of this.pending.values()) this.clearTimer(entry.timer)
    this.pending.clear()
  }
}
