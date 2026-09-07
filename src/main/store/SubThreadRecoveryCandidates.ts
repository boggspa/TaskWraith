/**
 * Boot prefilter for the sub-thread recovery sweep.
 *
 * `recoverSubThreadWorkerQueues` and the join-policy loop iterate a bare
 * `getChats()` — a whole-corpus parse on the main thread, pre-window — and
 * then skip every chat that is not a sub-thread carrying worker control or a
 * join policy. Both answers are list-carried chrome: `parentChatId` and
 * `delegationContext` survive on the chat-list row, so a vouched row can
 * answer them without the canonical read.
 *
 * Narrowing only. A candidate still takes the unchanged canonical read and the
 * caller still applies its own predicate to real bytes; only the SKIP is
 * decided here. The skip needs a vouched row whose hint proves the chat is not
 * a sub-thread, or a sub-thread with neither worker control nor a join policy.
 * Every uncertainty — no row, a stale stat pair, an unreadable hint — yields a
 * candidate.
 */

export interface SubThreadRecoveryHint {
  /** The row's parent chat id, or null when the chat is not a sub-thread. */
  parentChatId: string | null
  /** The row carries delegation worker control. */
  hasWorkerControl: boolean
  /** The row carries at least one sub-thread join policy. */
  hasJoinPolicy: boolean
}

export interface SubThreadRecoveryCandidateSource {
  /** True only when the index row's mtime+size match the record on disk. */
  vouchesForSourceBytes: (chatId: string) => boolean
  /** The vouched row's recovery hint, or null when none can be read. */
  readRecoveryHint: (chatId: string) => SubThreadRecoveryHint | null
}

/**
 * The chats that must be read canonically for sub-thread recovery. Order is
 * preserved so the caller's sweep order is unchanged.
 */
export function selectSubThreadRecoveryCandidateChatIds(
  chatIds: readonly string[],
  source: SubThreadRecoveryCandidateSource
): string[] {
  const candidates: string[] = []
  for (const chatId of chatIds) {
    if (typeof chatId !== 'string' || chatId === '') continue
    let hint: SubThreadRecoveryHint | null
    try {
      hint = source.vouchesForSourceBytes(chatId) ? source.readRecoveryHint(chatId) : null
    } catch {
      // An unreadable row is not evidence the chat needs no recovery.
      hint = null
    }
    if (!hint) {
      candidates.push(chatId)
      continue
    }
    if (hint.parentChatId && (hint.hasWorkerControl || hint.hasJoinPolicy)) {
      candidates.push(chatId)
    }
  }
  return candidates
}
