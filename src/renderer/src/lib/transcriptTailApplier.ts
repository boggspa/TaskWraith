import { isTranscriptRowPrefixRegression, type ChatTranscriptStore } from './chatTranscriptStore'
import { estimateJsonishBytes, type TranscriptPage } from '../../../shared/transcriptPage'
import type { TranscriptTailFrame } from '../../../shared/transcriptTailStream'

/**
 * Lands pushed transcript rows in the window the user is actually looking at.
 *
 * Scoped to PAGED chats on purpose. A fully hydrated chat holds its complete
 * arrays and its canonical `chat-updated` delivery is small and fast; it was
 * never the thing that froze. The stall class is the paged lane, where the
 * visible rows are a window the renderer had to go and fetch. So this applies
 * to exactly that case and declines everything else, rather than growing a
 * second write path into state the canonical lane already owns correctly.
 *
 * Declining is cheap and safe: every decline still advances the watchdog's
 * announcement, and the pull lane converges the window as it always did. The
 * only thing lost is the latency win, on a case that did not need it.
 */

export type TranscriptTailApplyStatus =
  | 'applied'
  | 'duplicate'
  | 'resync-required'
  | 'not-paged'
  | 'not-at-tail'
  | 'discontiguous'
  /**
   * An update frame whose rows are all OUTSIDE the loaded window — the reader
   * has scrolled away from the rows that changed.
   *
   * Counted as settled. The user is seeing everything this frame describes that
   * is theirs to see, so there is nothing outstanding; announcing it and never
   * settling would report a permanent lag on a transcript that is entirely up
   * to date, which is the phantom the sequence numbering exists to prevent.
   */
  | 'not-visible'
  /**
   * The frame is OLDER than the newest sequence this lane has already shown
   * for the chat. Frames arrive ordered by the producer, so a strictly older
   * one predates state the window already reflects, and writing it would put
   * old rows over new. Refused unsettled; the watchdog already announced and
   * settled the newer frame, so the refusal reports no phantom gap.
   */
  | 'stale-sequence'
  /**
   * An update whose rows would strictly shorten a non-empty streamed text row
   * by a pure prefix — the signature of a regressed canonical record (a stale
   * whole-record save re-shipped as an update), not an edit. Streamed text
   * only grows, so the frame is refused whole and the canonical lane
   * reconciles. Unsettled on purpose: the newest announcement stays visibly
   * outstanding until the pull lane lands it.
   */
  | 'stale-content'

export interface TranscriptTailApplyResult {
  status: TranscriptTailApplyStatus
  chatId: string
  sequence: number
  /** Rows that reached the window. Zero for every non-applied status. */
  rows: number
  /**
   * Whether the visible window now reflects this frame. True for `applied`, for
   * `duplicate` — a row already on screen is, by definition, visible — and for
   * `not-visible`, where nothing this frame describes is in the window at all.
   * That is what the caller settles the watchdog and the latency receipt on.
   */
  settled: boolean
}

function result(
  status: TranscriptTailApplyStatus,
  frame: TranscriptTailFrame,
  rows = 0
): TranscriptTailApplyResult {
  return {
    status,
    chatId: frame.chatId,
    sequence: frame.sequence,
    rows,
    settled: status === 'applied' || status === 'duplicate' || status === 'not-visible'
  }
}

/**
 * Turn an append frame into the adjacent page the store already knows how to
 * accumulate, rather than teaching the store a second merge path.
 *
 * `runs: []` is deliberate. The store merges runs by id and keeps the existing
 * rows when a page brings none, so an empty list means "no opinion" — the frame
 * carries rows, not run chrome, and run state continues to arrive on the
 * canonical lane where it has always come from.
 */
function pageForAppend(
  frame: Extract<TranscriptTailFrame, { kind: 'tail-append' }>
): TranscriptPage {
  const windowStart = frame.baseMessageCount
  const windowEnd = windowStart + frame.messages.length
  return {
    chatId: frame.chatId,
    messages: frame.messages,
    runs: [],
    totalMessageCount: windowEnd,
    windowStart,
    windowEnd,
    estimatedBytes: estimateJsonishBytes(frame.messages),
    hasOlder: windowStart > 0,
    hasNewer: false,
    oldestMessageId: frame.messages[0]?.id ?? null,
    newestMessageId: frame.messages[frame.messages.length - 1]?.id ?? null,
    updatedAt: frame.appendedAtMs
  }
}

export function applyTranscriptTailFrame(
  frame: TranscriptTailFrame,
  store: ChatTranscriptStore
): TranscriptTailApplyResult {
  if (frame.kind === 'tail-resync') {
    // A resync ends this lane's ordering epoch: the producer declined to
    // carry the change, so the frames that follow are measured against a
    // window the pull lane is about to replace. Retire the watermark now —
    // keeping it would refuse fresh frames behind a number from before the
    // gap, and a restarted producer (re-sequenced from 1) would wedge.
    store.forgetTailSequence(frame.chatId)
    return result('resync-required', frame)
  }
  if (!store.isPaged(frame.chatId)) return result('not-paged', frame)
  // Recency: a frame strictly older than the newest this lane has already
  // shown for the chat writes rows from before the state on screen. Recording
  // on sight rather than on a successful apply is deliberate — even a frame
  // refused below proves the lane has moved past everything older than it.
  if (store.noteTailSequence(frame.chatId, frame.sequence) === 'stale') {
    return result('stale-sequence', frame)
  }
  if (frame.kind === 'tail-update') return applyUpdate(frame, store)

  // `isPaged` already proved the entry exists, so this is a type narrowing
  // rather than a reachable branch.
  const current = store.get(frame.chatId)
  if (!current) return result('not-paged', frame)

  // Only the live tail may be extended. A reader who has scrolled back is
  // looking at a window that does not end where these rows begin, and quietly
  // appending to it would either jump them forward or, worse, splice rows in
  // next to history they do not belong beside.
  if (current.hasNewer) return result('not-at-tail', frame)

  // The contiguity proof, and the reason `baseMessageCount` is on the wire.
  // Without it a frame that arrives after a missed one reaches the store's
  // "page does not touch this window" path, which REPLACES the window — the
  // user's transcript would collapse to the two rows that just arrived.
  const frameEnd = frame.baseMessageCount + frame.messages.length
  if (current.windowEnd !== frame.baseMessageCount) {
    // Already holding all of them — a benign overlap with the reconcile lane.
    // `windowStart` matters as much as `windowEnd`: a frame from before this
    // window begins is NOT on screen, and calling it a duplicate would tell the
    // watchdog the user can see rows that are nowhere in the window.
    if (current.windowStart <= frame.baseMessageCount && current.windowEnd >= frameEnd) {
      return result('duplicate', frame)
    }
    // Partial overlap at the tail: the window already holds the first rows of
    // this frame and the rest are genuinely new. Dropping the whole frame would
    // discard a row for no reason, so carry the suffix that abuts the window.
    if (current.windowEnd > frame.baseMessageCount && current.windowEnd < frameEnd) {
      const suffix = frame.messages.slice(current.windowEnd - frame.baseMessageCount)
      return applyAppend(
        { ...frame, baseMessageCount: current.windowEnd, messages: suffix },
        store,
        current.windowEnd
      )
    }
    return result('discontiguous', frame)
  }

  return applyAppend(frame, store, current.windowEnd)
}

/**
 * Land rows that changed in place.
 *
 * Unlike an append this has no contiguity question to answer — no row arrives
 * and the window does not move — so the checks are about IDENTITY and RECENCY
 * instead: the canonical length must be the one this window belongs to, each
 * row must land on the row that already carries its id, and no row may
 * strictly shorten the non-empty streamed text already on screen by a pure
 * prefix. The store enforces all three and refuses the whole frame if any
 * fails, because a half-applied update leaves the transcript rendering a row
 * it cannot know is wrong.
 *
 * A refusal is not an error; the canonical lane reconciles the window exactly
 * as it did before this lane carried edits at all.
 */
function applyUpdate(
  frame: Extract<TranscriptTailFrame, { kind: 'tail-update' }>,
  store: ChatTranscriptStore
): TranscriptTailApplyResult {
  const before = store.get(frame.chatId)
  if (!before) return result('not-paged', frame)

  // The prefix guard, pre-checked here so the refusal is reported as what it
  // is rather than as a contiguity failure. The store enforces the same rule
  // again for any caller that did not pre-check; from this path its identical
  // refusal is unreachable.
  for (const row of frame.rows) {
    const offset = row.index - before.windowStart
    if (offset < 0 || offset >= before.messages.length) continue
    if (isTranscriptRowPrefixRegression(before.messages[offset], row.message)) {
      return result('stale-content', frame)
    }
  }

  const applied = store.updateChatTranscriptRows(frame.chatId, frame.rows, frame.messageCount)
  if (!applied) return result('discontiguous', frame)

  // The store returns the SAME payload when nothing in the window changed,
  // which is how "the reader has scrolled away from these rows" is told apart
  // from "these rows were written".
  if (applied === before) {
    const visible = frame.rows.some(
      (row) => row.index >= before.windowStart && row.index < before.windowEnd
    )
    // Rows inside the window that produced no change were already exactly these
    // rows: a benign overlap with the reconcile lane, same as an append's.
    return visible ? result('duplicate', frame, 0) : result('not-visible', frame)
  }

  let rows = 0
  for (const row of frame.rows) {
    if (row.index >= before.windowStart && row.index < before.windowEnd) rows += 1
  }
  return result('applied', frame, rows)
}

function applyAppend(
  frame: Extract<TranscriptTailFrame, { kind: 'tail-append' }>,
  store: ChatTranscriptStore,
  windowEndBefore: number
): TranscriptTailApplyResult {
  const applied = store.appendChatTranscriptPage(frame.chatId, pageForAppend(frame))
  if (!applied) return result('not-paged', frame)
  const rows = Math.max(0, applied.windowEnd - windowEndBefore)
  return result(rows === 0 ? 'duplicate' : 'applied', frame, rows)
}
