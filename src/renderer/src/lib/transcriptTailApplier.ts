import type { ChatTranscriptStore } from './chatTranscriptStore'
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

export interface TranscriptTailApplyResult {
  status: TranscriptTailApplyStatus
  chatId: string
  sequence: number
  /** Rows that reached the window. Zero for every non-applied status. */
  rows: number
  /**
   * Whether the visible window now reflects this frame. True for `applied` and
   * for `duplicate` — a row already on screen is, by definition, visible — and
   * that is what the caller settles the watchdog and the latency receipt on.
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
    settled: status === 'applied' || status === 'duplicate'
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
  if (frame.kind === 'tail-resync') return result('resync-required', frame)
  if (!store.isPaged(frame.chatId)) return result('not-paged', frame)

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
