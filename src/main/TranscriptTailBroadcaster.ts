import type { ChatRecord } from './store/types'
import {
  buildTranscriptTailAppend,
  buildTranscriptTailResync,
  type TranscriptTailFrame
} from '../shared/transcriptTailStream'

/**
 * Per-chat watermark of what this process has already pushed on the tail lane.
 *
 * `lastMessageId` is a fast reject; `messages` is the actual proof. See the
 * field comment below for why the id alone was never enough.
 */
interface TranscriptTailWatermark {
  sequence: number
  messageCount: number
  lastMessageId: string | null
  /**
   * The exact array this process last saw, retained by reference.
   *
   * Id equality at the tail is NOT a prefix proof, and assuming it was is the
   * defect this field exists to close. `EnsembleOrchestrator.flushRun`
   * reconciles timeline rows BY ID — `author.update(replacement)` keeps the id
   * and replaces the object — so a flush that rewrites every row of a run and
   * appends one status card leaves the anchor id untouched and reads as a pure
   * append. The user would have been served a truncated answer with "yielded"
   * printed under it and a tool card still spinning.
   *
   * Reference equality over the prefix is the honest check. It is a pointer
   * walk — microseconds over 20,000 rows, against the ~2 ms of JSON and the
   * multi-megabyte fsync it sits in front of — and it is exact, because every
   * producer here rebuilds a changed row as a new object (`{...message, ...}`)
   * and spreads unchanged ones through by reference.
   *
   * Held WEAKLY. `AppStore`'s record cache is byte-bounded and evicts by LRU; a
   * strong reference here would pin transcripts that cache has already released
   * — hundreds of megabytes at Chris's scale — and defeat its budget. A weak
   * reference gives exactly the right semantics for free: while the chat is hot
   * the array is alive and the prefix is provable, and once main has let the
   * record go there is nothing to prove against, so the lane resyncs and the
   * pull path takes over. A flat row cap was the wrong shape: it disabled the
   * fast lane outright on the 10,000-turn threads that need it most.
   */
  messages: WeakRef<object> | null
  touchedAt: number
}

export interface TranscriptTailBroadcasterOptions {
  /** Bounds retained watermarks; oldest-touched are evicted first. */
  maxTrackedChats?: number
  now?: () => number
}

export interface TranscriptTailBroadcasterCounters {
  /** Frames carrying appended rows — the fast path. */
  appends: number
  /** Rows carried across all append frames. */
  appendedRows: number
  /**
   * Frames that told the renderer to fall back to the pull lane. A rising
   * ratio against `appends` means the transcript is being mutated rather than
   * appended to, and the low-latency lane is not carrying the round.
   */
  resyncs: number
  /** Chats seeded without emitting (first sighting after open or eviction). */
  seeds: number
  /** Saves that changed nothing on the transcript and emitted nothing. */
  noops: number
}

/**
 * Derives "these rows were just appended" from consecutive canonical records.
 *
 * Deliberately derived rather than declared. Transcript rows are appended from
 * many independent places in main — orchestrator turn output, routing
 * checkpoints, system notices, sub-thread back-propagation, IPC handlers — and
 * a lane that depended on every one of them remembering to hand over its rows
 * would be live for whichever call sites were updated and silently dead for the
 * rest. That failure mode is invisible: the transcript simply goes back to
 * being slow. Watching the canonical record instead means one wiring point
 * covers every producer, including ones added later.
 *
 * Correctness is structural, not statistical. A frame is only emitted when the
 * new record is a strict extension of the previous one; anything else — an
 * edit, a deletion, a reorder, a compaction, a paged/summary record with an
 * empty array — degrades to a resync, and the canonical lanes reconcile.
 */
export class TranscriptTailBroadcaster {
  private readonly watermarks = new Map<string, TranscriptTailWatermark>()
  private readonly maxTrackedChats: number
  private readonly now: () => number
  private sequence = 0
  private readonly counters: TranscriptTailBroadcasterCounters = {
    appends: 0,
    appendedRows: 0,
    resyncs: 0,
    seeds: 0,
    noops: 0
  }

  constructor(options: TranscriptTailBroadcasterOptions = {}) {
    // Above this, a new chat evicts an old one and that chat's next save
    // re-seeds — emitting no frame at all. 100-200 concurrent agents is routine
    // here and 500+ is a known saturation point, so a 256 cap would silently
    // drop a rotating subset of seats off the lane at ordinary scale.
    this.maxTrackedChats = Math.max(1, options.maxTrackedChats ?? 1_024)
    this.now = options.now ?? Date.now
  }

  counterSnapshot(): TranscriptTailBroadcasterCounters {
    return { ...this.counters }
  }

  /** Drop a chat's watermark — deletion, or a record this process no longer owns. */
  forget(chatId: string): void {
    this.watermarks.delete(chatId)
  }

  reset(): void {
    this.watermarks.clear()
  }

  /**
   * Returns the frame to push, or null when there is nothing to say.
   *
   * Null on first sighting is intentional: the renderer gets its window from
   * the ordinary open/pull path, and replaying a whole transcript onto a lane
   * capped at 32 rows would only produce a resync storm.
   */
  observe(chat: ChatRecord | null | undefined): TranscriptTailFrame | null {
    const chatId = chat?.appChatId
    if (!chatId || typeof chatId !== 'string') return null
    const messages = Array.isArray(chat?.messages) ? chat.messages : null
    if (!messages) return null

    const previous = this.watermarks.get(chatId)
    const appendedAtMs = this.now()

    if (!previous) {
      this.counters.seeds += 1
      this.setWatermark(chatId, this.sequence, messages, appendedAtMs)
      return null
    }

    // A paged/summary projection carries `messages: []` while the canonical
    // transcript is untouched — `buildChatShell` emits exactly that, and such
    // shells reach `saveChat` routinely on any thread over the paging
    // threshold. `Array.isArray([])` is true, so this needs its own guard:
    // without it the shell reset the watermark to zero, and the escalated save
    // that immediately followed was read as "the entire transcript was just
    // appended". Return null AND leave the watermark alone.
    if (messages.length === 0 && previous.messageCount > 0) return null

    const lastMessageId = messages.length > 0 ? (messages[messages.length - 1]?.id ?? null) : null

    // SCOPE: this lane carries row ARRIVAL. A same-length change is an in-place
    // edit — streaming text growing inside the tail row, a tool activity
    // completing — and the pull lane has always owned those, at its own
    // cadence. Emitting a resync for each one would fire a `get-chat-transcript-page`
    // every 250 ms flush straight into the main thread this lane exists to stop
    // depending on: a storm, in the name of freshness. The watermark is still
    // advanced so the NEXT append is measured against what actually landed.
    if (messages.length === previous.messageCount) {
      if (lastMessageId === previous.lastMessageId) {
        this.setWatermark(chatId, previous.sequence, messages, appendedAtMs)
        this.counters.noops += 1
        return null
      }
      // Same length, different tail row: a replacement, not an edit. The pull
      // lane must reconcile that.
      const replaced = ++this.sequence
      this.counters.resyncs += 1
      this.setWatermark(chatId, replaced, messages, appendedAtMs)
      return buildTranscriptTailResync({
        chatId,
        sequence: replaced,
        messageCount: messages.length,
        appendedAtMs
      })
    }

    const sequence = ++this.sequence
    const appended = this.appendedRows(messages, previous)
    if (appended) {
      const frame = buildTranscriptTailAppend({
        chatId,
        sequence,
        baseMessageCount: previous.messageCount,
        messages: appended,
        appendedAtMs
      })
      if (frame) {
        this.counters.appends += 1
        this.counters.appendedRows += appended.length
        this.setWatermark(chatId, sequence, messages, appendedAtMs)
        return frame
      }
    }

    this.counters.resyncs += 1
    this.setWatermark(chatId, sequence, messages, appendedAtMs)
    return buildTranscriptTailResync({
      chatId,
      sequence,
      messageCount: messages.length,
      appendedAtMs
    })
  }

  /**
   * The appended suffix, or null when this record is not a strict extension.
   *
   * "Strict extension" means every row we have already shown the renderer is
   * still the SAME OBJECT. Anything weaker admits an in-place edit — the shape
   * `flushRun` produces on every single turn — as an append, and the renderer
   * keeps rendering superseded rows with no way to learn it is wrong.
   */
  private appendedRows(
    messages: ChatRecord['messages'],
    previous: TranscriptTailWatermark
  ): ChatRecord['messages'] | null {
    if (messages.length <= previous.messageCount) return null
    if (previous.messageCount === 0) {
      return previous.lastMessageId === null ? messages.slice(0) : null
    }
    const anchor = messages[previous.messageCount - 1]
    // Cheap reject first: an id change is the common case and needs no walk.
    if (!anchor || anchor.id !== previous.lastMessageId) return null
    if (!this.prefixUnchanged(messages, previous, previous.messageCount)) return null
    return messages.slice(previous.messageCount)
  }

  /**
   * Reference equality across the rows the renderer already holds.
   *
   * A pointer walk, not a content comparison: producers here rebuild a changed
   * row as a new object and spread unchanged ones through by reference, so
   * identity is exact and costs one comparison per retained row. Measured
   * against what it guards — a ~2 ms serialization and a multi-megabyte fsync —
   * this is free, and it is the difference between a lane that is fast and a
   * lane that is fast and correct.
   *
   * Without the retained array there is nothing to compare, so we refuse rather
   * than guess.
   */
  private prefixUnchanged(
    messages: ChatRecord['messages'],
    previous: TranscriptTailWatermark,
    length: number
  ): boolean {
    const retained = previous.messages?.deref() as ChatRecord['messages'] | undefined
    // Nothing to compare against — main released the record, or we never held
    // it. Refuse rather than guess; a resync is always safe.
    if (!retained || retained.length < length || messages.length < length) return false
    for (let index = 0; index < length; index += 1) {
      if (messages[index] !== retained[index]) return false
    }
    return true
  }

  private setWatermark(
    chatId: string,
    sequence: number,
    messages: ChatRecord['messages'],
    touchedAt: number
  ): void {
    const existing = this.watermarks.get(chatId)
    const lastMessageId = messages.length > 0 ? (messages[messages.length - 1]?.id ?? null) : null
    const retained = new WeakRef(messages as unknown as object)
    if (existing) {
      existing.sequence = sequence
      existing.messageCount = messages.length
      existing.lastMessageId = lastMessageId
      existing.messages = retained
      existing.touchedAt = touchedAt
      return
    }
    this.watermarks.set(chatId, {
      sequence,
      messageCount: messages.length,
      lastMessageId,
      messages: retained,
      touchedAt
    })
    this.prune()
  }

  private prune(): void {
    if (this.watermarks.size <= this.maxTrackedChats) return
    let oldestChatId: string | null = null
    let oldestTouchedAt = Number.POSITIVE_INFINITY
    for (const [chatId, watermark] of this.watermarks) {
      if (watermark.touchedAt < oldestTouchedAt) {
        oldestTouchedAt = watermark.touchedAt
        oldestChatId = chatId
      }
    }
    if (oldestChatId !== null) this.watermarks.delete(oldestChatId)
  }
}
