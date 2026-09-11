import type { ChatListItem, ChatRecord, ChatRun } from '../../../main/store/types'
import { computeThreadRunWallMs, readThreadRunWallMs } from '../../../shared/threadRunWallTime'

/**
 * Returns thread wall time from completed runs without double-counting
 * concurrent Ensemble seats. When a current run/round start is supplied, the
 * caller adds its live delta separately, so completed spans are capped there
 * before the interval union is measured.
 *
 * The union math itself now lives in `shared/threadRunWallTime` so the same
 * measurement can be taken main-side, before a projection strips `runs`. This
 * wrapper is unchanged behaviour and keeps its own goldens.
 */
export function computeCumulativeRunBaseMs(
  runs: readonly ChatRun[] | undefined,
  activeStartedAt?: string | null
): number {
  return computeThreadRunWallMs(runs, activeStartedAt)
}

/** Records this resolver can read: hydrated, or any summary projection of one. */
type CumulativeRunBaseSource = ChatRecord & Partial<ChatListItem>

/**
 * THE read seam for the composer's TOTAL THREAD timecode.
 *
 * WHY THIS EXISTS. The call site was `computeCumulativeRunBaseMs(chat.runs)`,
 * and on every record that is a PROJECTION rather than a hydrated chat that
 * array is empty by construction, not merely stale:
 *
 *   - `catalogueChatListItem` (src/main/store/ThreadCatalogueMirror.ts) stamps
 *     `runs: []` on every catalogue row — and a thread opened from the
 *     catalogue IS that row until something escalates it;
 *   - `buildChatShell` (src/main/ipc/chatTranscriptPageHandlers.ts) and
 *     `boundChatUpdateSnapshot` do the same for a paged thread;
 *   - `ChatUpdateInterestRouter.projectCompactChat` replaces a mid-run
 *     `chat-updated` for a non-`full` target with a compact `summaryOnly` row
 *     that also carries `runs: []`;
 *   - `demoteChatToSummary` (lib/chatByteLru) does it under byte pressure.
 *
 * So the union was measured over nothing, the base came back 0, and the
 * composer painted `TOTAL THREAD 00:00:00:00` on a thread with hours of
 * history — while the TURN timecode kept ticking, because `selectCurrentChatRun`
 * had already been widened for exactly this class and deliberately left whole
 * transcript aggregates (this one) behind.
 *
 * The fix is to carry the AGGREGATE rather than re-derive it from an array the
 * projections are entitled to drop: `runWallMs` is to thread wall time what
 * `runCount` is to run count, and every producer that strips `runs` now stamps
 * it from the array it is stripping.
 */
export function resolveCumulativeRunBaseMs(
  chat: CumulativeRunBaseSource | null | undefined,
  activeStartedAt?: string | null
): number {
  if (!chat) return 0
  const runs = Array.isArray(chat.runs) ? chat.runs : []
  // A hydrated record owns the exact answer, including the live-boundary cap.
  if (chat.summaryOnly !== true) return computeThreadRunWallMs(runs, activeStartedAt)

  // Below here the record is a projection. `runs` is empty, or (on a paged
  // shell) a bounded tail page that would silently UNDERSTATE the thread.
  //
  // `runWallMs` is uncapped by construction — the projector cannot know which
  // run a later reader treats as live — so on an Ensemble thread whose live
  // round overlaps a seat that finished inside it, the carried scalar and the
  // live delta can double-count that overlap. Bounded by the overlap of one
  // round's seats, and strictly better than painting a zeroed thread.
  const carried = readThreadRunWallMs((chat as Partial<ChatListItem>).runWallMs)
  const windowed = computeThreadRunWallMs(runs, activeStartedAt)
  if (carried !== null) return Math.max(carried, windowed)
  if (windowed > 0) return windowed

  // Rows projected before `runWallMs` existed still carry the tail run, so a
  // legacy row understates rather than reading as a thread that never ran.
  const lastRun = (chat as Partial<ChatListItem>).lastRun
  return lastRun ? computeThreadRunWallMs([lastRun], activeStartedAt) : 0
}

/**
 * O(1) memo key for `resolveCumulativeRunBaseMs`.
 *
 * The old call site keyed its `useMemo` on `chat.runs` alone, which was both
 * correct and cheap: the array's identity changed exactly when the answer
 * could. The resolver now also reads three projection fields, and widening the
 * dependency to `chat` itself would re-walk the run array on EVERY streamed
 * chat update — thousands of `Date.parse` calls per second on a thread with
 * ten thousand turns. Pair this with `chat?.runs` to get the old narrowness
 * back.
 */
export function cumulativeRunBaseSignature(
  chat: CumulativeRunBaseSource | null | undefined
): string {
  if (!chat) return ''
  const projection = chat as Partial<ChatListItem>
  return `${projection.summaryOnly === true ? 1 : 0}:${projection.runWallMs ?? -1}:${
    projection.lastRun?.startedAt ?? ''
  }:${projection.lastRun?.endedAt ?? ''}`
}
