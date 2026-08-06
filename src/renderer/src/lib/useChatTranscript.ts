import { useCallback, useSyncExternalStore } from 'react'
import {
  ChatTranscriptStore,
  EMPTY_CHAT_TRANSCRIPT_PAYLOAD,
  type ChatTranscriptPayload
} from './chatTranscriptStore'

/**
 * T7a — React binding for the external transcript store.
 *
 * App installs its hydration-runtime store once via `bindChatTranscriptStore`
 * so focused TranscriptPanel / ChatViewPane can subscribe by chat id without
 * taking `messages` through chrome React state every stream frame.
 */

let activeStore: ChatTranscriptStore | null = null

/** Install the App-owned store instance the hook should observe. */
export function bindChatTranscriptStore(store: ChatTranscriptStore): void {
  activeStore = store
}

/** Active store, or a lazy fallback for tests / pre-bind reads. */
export function getChatTranscriptStore(): ChatTranscriptStore {
  if (!activeStore) activeStore = new ChatTranscriptStore()
  return activeStore
}

/** Test helper — drop the bound instance so the next get creates a fresh one. */
export function resetChatTranscriptStoreBindingForTests(): void {
  activeStore = null
}

export function subscribeChatTranscript(
  chatId: string | null | undefined,
  listener: () => void
): () => void {
  return getChatTranscriptStore().subscribe(chatId, listener)
}

export function getChatTranscriptSnapshot(
  chatId: string | null | undefined
): ChatTranscriptPayload {
  return getChatTranscriptStore().getSnapshot(chatId)
}

/**
 * Narrow transcript subscription for one chat.
 * Returns the shared empty payload when `chatId` is nullish or unset.
 */
export function useChatTranscript(chatId: string | null | undefined): ChatTranscriptPayload {
  const subscribe = useCallback(
    (listener: () => void) => subscribeChatTranscript(chatId, listener),
    [chatId]
  )
  const getSnapshot = useCallback(() => getChatTranscriptSnapshot(chatId), [chatId])
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_CHAT_TRANSCRIPT_PAYLOAD)
}
