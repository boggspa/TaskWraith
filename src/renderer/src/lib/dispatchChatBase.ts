import type { ChatRecord } from '../../../main/store/types'
import { isChatSummaryRecord } from './chatRecordMerge'

/**
 * Choose the record a dispatch appends its prompt and its new run to.
 *
 * `executeRun` snapshots the chat at the top of dispatch, then awaits prompt
 * composition, worktree allocation and attachment thumbnails before appending
 * the prompt. Rows the renderer or a main delivery appended during that window
 * land in the live `chatByIdRef` map, so spreading the SNAPSHOT dropped them —
 * and then persisted the loss, because the dispatch saves the whole record.
 * That window widens with exactly the send lag that makes it likely, and it is
 * the same staleness that leaves a delivery carrying rows the renderer's live
 * transcript is missing (see `chatUpdateRenderMerge`).
 *
 * The live map is written by every hydration, merge and stream delta, so it is
 * never staler than the snapshot. The one way it can be WORSE is in kind: a
 * catalogue row or a paged shell carries a bounded tail page, or no transcript
 * arrays at all, rather than the transcript. Dispatching from one of those
 * would save that page over the full history, so a projection is refused and
 * the snapshot stands.
 */
export function resolveDispatchChatBase(
  snapshot: ChatRecord,
  live: ChatRecord | null | undefined
): ChatRecord {
  if (!live || live === snapshot) return snapshot
  if (live.appChatId !== snapshot.appChatId) return snapshot
  // A catalogue row and a paged shell both carry `summaryOnly`.
  if (isChatSummaryRecord(live)) return snapshot
  if (!Array.isArray(live.messages) || !Array.isArray(live.runs)) return snapshot
  return live
}
