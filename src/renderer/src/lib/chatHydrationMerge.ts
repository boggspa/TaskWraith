import type { ChatRecord } from '../../../main/store/types'
import { isChatSummaryRecord } from './chatRecordMerge'
import { preserveOptimisticEnsembleQueue } from './queuedMessageRows'

export interface ResolveChatHydrationInput {
  incoming: ChatRecord
  current: ChatRecord | null | undefined
  localAtRequestStart: ChatRecord | null | undefined
}

/**
 * Keep a full record which replaced the request's starting snapshot while an
 * asynchronous hydration was in flight. The incoming record was read before
 * that intervening change and must not regain authority merely by resolving
 * last.
 */
export function resolveChatHydration(input: ResolveChatHydrationInput): ChatRecord {
  const { incoming, current, localAtRequestStart } = input
  if (
    current &&
    !isChatSummaryRecord(current) &&
    current !== localAtRequestStart
  ) {
    return current
  }
  return preserveOptimisticEnsembleQueue(incoming, current)
}
