import type { ChatListRunSummary } from './types'

/**
 * Boot prefilter for the stale-run reconciler.
 *
 * The pre-window reconcile pass reads and parses EVERY chat record to reach the
 * handful holding an unsettled run. Measured on Chris's profile 2026-09-07:
 * 1058MB across 509 files parsed on the main thread to find work on 6 chats,
 * which is most of the multi-minute pre-window stall.
 *
 * The chat-list index already records the exact mtime+size of the bytes each
 * row was derived from, and `ChatListIndexStore.writeEntry` writes that row's
 * `runsSummary` side file in the same call from the same item. So a row that
 * vouches for the record on disk vouches for its sibling summary too, and that
 * summary can answer "does this chat hold an unsettled run?" without the
 * canonical read.
 *
 * The narrowing is a PREFILTER, never a substitute predicate. Every candidate
 * still takes the unchanged canonical read and `chatHasReconcilableRun` still
 * decides on real bytes; only the SKIP is decided here. The two error
 * directions are not symmetric, so the skip is gated hard in one direction:
 * a wrong "unsettled" costs one extra read, while a wrong "settled" strands a
 * run with nothing left to settle it. Every uncertainty — no row, a stale stat
 * pair, a missing or unreadable summary, a summary row with no `endedAt` —
 * therefore yields a candidate, and only an exact vouch can produce a skip.
 */
export interface OpenRunCandidateSource {
  /** True only when the index row's mtime+size match the record on disk. */
  vouchesForSourceBytes: (chatId: string) => boolean
  /** The vouched row's run summaries, or null when none can be read. */
  readRunsSummary: (chatId: string) => readonly ChatListRunSummary[] | null
}

/**
 * A summarised run has settled only when it carries a non-empty `endedAt`.
 * An entry with no usable `runId` cannot be reconciled at all, so it never
 * forces its chat into the candidate set — that mirrors `chatHasReconcilableRun`.
 */
export function runSummaryIsUnsettled(summary: ChatListRunSummary | null | undefined): boolean {
  if (!summary) return false
  if (typeof summary.runId !== 'string' || summary.runId.trim() === '') return false
  return typeof summary.endedAt !== 'string' || summary.endedAt.trim() === ''
}

/**
 * The chats the reconciler must still read canonically. Order is preserved so
 * the caller's own sweep order is unchanged.
 */
export function selectOpenRunCandidateChatIds(
  chatIds: readonly string[],
  source: OpenRunCandidateSource
): string[] {
  const candidates: string[] = []
  for (const chatId of chatIds) {
    if (typeof chatId !== 'string' || chatId === '') continue
    let summaries: readonly ChatListRunSummary[] | null
    try {
      summaries = source.vouchesForSourceBytes(chatId) ? source.readRunsSummary(chatId) : null
    } catch {
      // An unreadable row is not evidence the chat is settled.
      summaries = null
    }
    if (!summaries || summaries.some((summary) => runSummaryIsUnsettled(summary))) {
      candidates.push(chatId)
    }
  }
  return candidates
}
