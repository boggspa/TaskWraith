import type { ChatRecord } from '../../../main/store/types'
import { isChatSummaryRecord } from './chatRecordMerge'
import { preserveOptimisticEnsembleQueue } from './queuedMessageRows'
import {
  ChatByteLru,
  type ChatPinReason,
  type RetainChatsWithinByteBudgetResult,
  retainChatsWithinByteBudget
} from './chatByteLru'
import { ChatTranscriptStore } from './chatTranscriptStore'

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

/**
 * After hydration resolves, ingest the full transcript into the external
 * store (T7a) and optionally touch the byte LRU (T7b). Pure w.r.t. durable
 * disk — store/LRU are renderer-heap only.
 */
export function commitHydratedChat(input: {
  chat: ChatRecord
  transcriptStore?: ChatTranscriptStore | null
  byteLru?: ChatByteLru | null
  pinReason?: ChatPinReason
}): ChatRecord {
  const { chat, transcriptStore, byteLru, pinReason } = input
  if (transcriptStore && !isChatSummaryRecord(chat)) {
    transcriptStore.ingest(chat)
  }
  if (byteLru && chat.appChatId) {
    byteLru.touch(chat.appChatId)
    if (pinReason) byteLru.pin(chat.appChatId, pinReason)
  }
  return chat
}

/**
 * Apply the byte budget across a chat list while keeping `pinnedIds` hydrated.
 * Convenience wrapper so App / reconcile callers do not import the LRU module
 * directly for the common path.
 */
export function retainHydratedChats(
  chats: readonly ChatRecord[],
  options?: {
    pinnedIds?: ReadonlySet<string>
    maxBytes?: number
    lruOrder?: readonly string[]
  }
): RetainChatsWithinByteBudgetResult {
  return retainChatsWithinByteBudget({
    chats,
    pinnedIds: options?.pinnedIds,
    maxBytes: options?.maxBytes,
    lruOrder: options?.lruOrder
  })
}
