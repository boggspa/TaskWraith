import type { ChatListItem, ChatRecord, ChatRun } from '../../../main/store/types'
import { computeThreadRunWallMs, readThreadRunWallMs } from '../../../shared/threadRunWallTime'

type ComposerRunTimecodeChat = Pick<ChatRecord, 'chatKind' | 'ensemble'>

function nonEmptyTimestamp(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed && Number.isFinite(Date.parse(trimmed)) ? trimmed : null
}

/**
 * Resolves the clock anchor for the composer's TURN readout.
 *
 * An Ensemble TURN is the whole round, so it is anchored to the round start
 * even during the main-owned gap between participant invocations. The generic
 * renderer `isRunning` flag is seat/run evidence and can briefly fall false at
 * exactly that handoff boundary; it must not restart or zero the round clock.
 * A terminal round clears the anchor even if a stale run flag remains true.
 * Solo chats retain the ordinary current-run behaviour.
 */
export function resolveComposerRunTimecodeStartedAt(input: {
  chat: ComposerRunTimecodeChat | null | undefined
  isRunning: boolean
  currentRunStartedAt?: string | null
}): string | null {
  if (!input.chat) return null

  if (input.chat.chatKind === 'ensemble') {
    const round = input.chat.ensemble?.activeRound
    if (!round || round.status !== 'running' || round.endedAt) return null
    return nonEmptyTimestamp(round.startedAt)
  }

  return input.isRunning ? nonEmptyTimestamp(input.currentRunStartedAt) : null
}

/**
 * Legacy/solo arithmetic seam over completed runs. When a current run start is
 * supplied, the caller adds its live delta separately, so completed spans are
 * capped there before the interval union is measured. Exact Ensemble-round
 * totals require `resolveCumulativeRunBaseMs`, which also receives the compact
 * round ledger from the chat record.
 *
 * The measurement itself lives in `shared/threadRunWallTime` so it can also be
 * taken main-side before a projection strips its timing inputs. This wrapper
 * retains the original run-only behavior and goldens.
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
 * `runCount` is to run count, and every producer stamps it from the canonical
 * runs plus the compact round ledger before stripping both.
 */
export function resolveCumulativeRunBaseMs(
  chat: CumulativeRunBaseSource | null | undefined,
  activeStartedAt?: string | null
): number {
  if (!chat) return 0
  const runs = Array.isArray(chat.runs) ? chat.runs : []
  // A hydrated record owns the exact answer, including the live-boundary cap.
  if (chat.summaryOnly !== true) return computeThreadRunWallMs(runs, activeStartedAt, chat.ensemble)

  // Below here the record is a projection. `runs` is empty, or (on a paged
  // shell) a bounded tail page that would silently UNDERSTATE the thread.
  //
  // Current projectors receive Ensemble timing state and omit the live round,
  // so their carried scalar can be combined with the live delta exactly. A row
  // written before that round-aware projection existed is indistinguishable on
  // the wire and may still contain completed seats from the live round; keep
  // the legacy larger-scalar preference rather than silently discarding older
  // thread history.
  const carried = readThreadRunWallMs((chat as Partial<ChatListItem>).runWallMs)
  const windowed = computeThreadRunWallMs(runs, activeStartedAt, chat.ensemble)
  if (carried !== null) return Math.max(carried, windowed)
  if (windowed > 0) return windowed

  // Rows projected before `runWallMs` existed still carry the tail run, so a
  // legacy row understates rather than reading as a thread that never ran.
  const lastRun = (chat as Partial<ChatListItem>).lastRun
  return lastRun ? computeThreadRunWallMs([lastRun], activeStartedAt, chat.ensemble) : 0
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
