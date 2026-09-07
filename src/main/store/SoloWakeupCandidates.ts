/**
 * Boot prefilter for the persisted solo-wakeup sweep.
 *
 * `SoloChatWakeupService.getAllPersistedWakeups()` iterates `listChats()`,
 * which is a bare `getChats()` — a whole-corpus parse on the main thread,
 * pre-window, to collect a usually-empty list. The ensemble lane already
 * narrowed its twin sweep by a vouched row count; this is the same idiom for
 * the solo lane.
 *
 * Narrowing only. A candidate still takes the unchanged canonical read and the
 * caller still reads real `soloWakeups` off it; only the SKIP is decided here.
 * A wrong "has wakeups" costs one read, a wrong "none" leaves a wakeup armed
 * with nothing left to fire it — so a row must be vouched AND carry an
 * explicit numeric zero to be skipped. Rows written before the field existed
 * carry no value, which reads as unknown and takes the canonical read.
 */

export interface SoloWakeupCandidateSource {
  /** True only when the index row's mtime+size match the record on disk. */
  vouchesForSourceBytes: (chatId: string) => boolean
  /** The vouched row's pending-wakeup count, or null when the row carries none. */
  readWakeupCount: (chatId: string) => number | null
}

/**
 * The chats that must be read canonically to collect persisted solo wakeups.
 * Order is preserved so the caller's sweep order is unchanged.
 */
export function selectSoloWakeupCandidateChatIds(
  chatIds: readonly string[],
  source: SoloWakeupCandidateSource
): string[] {
  const candidates: string[] = []
  for (const chatId of chatIds) {
    if (typeof chatId !== 'string' || chatId === '') continue
    let count: number | null
    try {
      count = source.vouchesForSourceBytes(chatId) ? source.readWakeupCount(chatId) : null
    } catch {
      // An unreadable row is not evidence the chat holds no wakeup.
      count = null
    }
    if (count !== 0) candidates.push(chatId)
  }
  return candidates
}

/**
 * Pending-wakeup count for a chat-list row. Defensive because it runs over
 * normalized records of every vintage.
 *
 * Counts only `pending` records, deliberately unlike the ensemble twin (which
 * counts all statuses): the recovery classifier skips non-pending wakeups, so
 * a chat whose wakeups all expired needs no sweep, and counting them would pin
 * every chat that ever armed one as a permanent candidate. Anything unreadable
 * counts as one — a statement about bytes we hold, not a licence to skip; the
 * row only earns a skip once the index can also vouch for those bytes.
 */
export function countPendingSoloWakeups(soloWakeups: unknown): number {
  if (!soloWakeups || typeof soloWakeups !== 'object') return 0
  let count = 0
  for (const record of Object.values(soloWakeups as Record<string, unknown>)) {
    if (!record || typeof record !== 'object') {
      count += 1
      continue
    }
    if ((record as { status?: unknown }).status === 'pending') count += 1
  }
  return count
}
