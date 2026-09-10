import { isActiveChatRunStatus } from '../../../shared/chatRunStatus'
import type { ChatRun } from '../../../main/store/types'

/**
 * A run is OPEN while it has no `endedAt` AND its status is not terminal.
 *
 * BOTH halves are load-bearing, and each was learned the hard way.
 *
 * `!endedAt` alone is not enough. Real profile data has threads carrying
 * unsealed `failed` runs -- a run whose provider died without ever writing
 * `endedAt` -- including one thread with 42 runs whose 3 unsealed failures sit
 * BEHIND a properly closed tail. Scanning back for "no endedAt" there resolves
 * a months-old run, so the composer would count up from an ancient start and
 * the model badge would name a provider the user has not used in that thread
 * for weeks.
 *
 * A status check alone is not enough either, and must not be spelled
 * `status === 'running'`. `ChatRun.status` is a free-form string; the desktop
 * dispatch lane seeds `'starting'`, which no status union documents, and Muse
 * never leaves it -- Muse is the one provider that hands RunManager no process
 * and no abort controller, so the promotion in
 * `persistChatRunRunningFromSession` never fires and the persisted run sits at
 * `'starting'` for the whole turn. `isActiveChatRunStatus` is the repo's own
 * vocabulary for this and already covers `starting`, `queued`, `cancelling`,
 * `steer_promoting`, `active` and `paused`.
 *
 * A run with no status at all is treated as open when unsealed: legacy rows
 * predate the field, and `!endedAt` is exactly the retention predicate the two
 * page producers use -- `selectTranscriptPageRuns` (src/shared/transcriptPage.ts)
 * and the `pageRunOrdinals` SQL (src/main/store/ThreadCatalogueDatabase.ts) --
 * so anything they keep stays selectable here.
 */
export function isOpenChatRun(run: ChatRun | null | undefined): boolean {
  if (!run) return false
  if (run.endedAt) return false
  const status = run.status
  if (status === undefined || status === null || status === '') return true
  return isActiveChatRunStatus(status)
}

/**
 * Resolve the run the live surfaces describe: the Working indicator's elapsed
 * time, the composer TURN timecode, the context/model badges.
 *
 * WHY THIS EXISTS. The call site was a bare tail read on the canonical record,
 * `currentChat?.runs?.[currentChat.runs.length - 1]`. On a paged chat that
 * array is EMPTY BY CONSTRUCTION, not merely stale:
 *
 *   - `buildChatShell` (src/main/ipc/chatTranscriptPageHandlers.ts) stamps
 *     `runs: []` alongside `transcriptPaged: true`;
 *   - `ChatUpdateInterestRouter` (src/main/ChatUpdateInterestRouter.ts)
 *     replaces every mid-run `chat-updated` for a non-`full` target with a
 *     compact `summaryOnly` invalidation that also carries `runs: []` -- and
 *     that router is on by default.
 *
 * So the tail read returned `undefined`, `startedAt` resolved to `null`, and
 * the composer painted 00:00:00:00 -- while the renderer-local
 * `runningChatIds` set, written at dispatch and cleared only on `agent-exit`,
 * kept the surface on "Working". Timers at zero UNDERNEATH a live Working chip
 * is the exact signature of this bug.
 *
 * SAFETY PROPERTY, and the reason this belongs at the one shared seam rather
 * than at each of the ~20 consumers of `currentRun`: it is a PURE WIDENING.
 * Whenever the canonical array is non-empty the result is identical to the old
 * tail read, so it can only ever turn `undefined` into a run and never swap one
 * run for another. `resolveCurrentChatTranscriptWindow` returns `chat.runs`
 * itself for a hydrated record, so on that path both arguments are one array.
 *
 * The window fallback is CLASS T only (tail-sufficient: current run, latest
 * message) per the read-path rule in `lib/currentChatTranscriptWindow.ts`.
 * Whole-transcript aggregates such as `computeCumulativeRunBaseMs` must keep
 * reading the canonical array; a partial window would silently understate them.
 */
export function selectCurrentChatRun(
  canonicalRuns: readonly ChatRun[] | null | undefined,
  windowRuns: readonly ChatRun[] | null | undefined
): ChatRun | undefined {
  const canonical = Array.isArray(canonicalRuns) ? canonicalRuns : []
  if (canonical.length > 0) return canonical[canonical.length - 1]
  const windowed = Array.isArray(windowRuns) ? windowRuns : []
  if (windowed.length === 0) return undefined
  // The window is tail-anchored but its last entry is not guaranteed to be the
  // live one: `selectTranscriptPageRuns` unions the open runs with the runs the
  // page's own messages reference, then slices. Prefer the open run.
  for (let index = windowed.length - 1; index >= 0; index -= 1) {
    if (isOpenChatRun(windowed[index])) return windowed[index]
  }
  return windowed[windowed.length - 1]
}
