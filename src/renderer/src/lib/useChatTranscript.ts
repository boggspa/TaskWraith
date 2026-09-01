import { useCallback, useSyncExternalStore } from 'react'
import {
  ChatTranscriptStore,
  EMPTY_CHAT_TRANSCRIPT_PAYLOAD,
  type ChatTranscriptPayload
} from './chatTranscriptStore'
import {
  requestLatestTranscriptPage,
  requestNewerTranscriptPage,
  requestOlderTranscriptPage,
  requestRevealTranscriptMessage
} from './chatTranscriptPager'

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

// Stage 1b: when the store holds a main-produced page (no local full arrays),
// window moves and jumps go through the pager's IPC fetch and the current
// payload is returned until the response lands; the store notification then
// re-renders subscribers. Fully hydrated chats keep the sync local rewindow.

export function showOlderChatTranscriptPage(
  chatId: string | null | undefined
): ChatTranscriptPayload | null {
  if (!chatId) return null
  const store = getChatTranscriptStore()
  if (store.isPaged(chatId)) {
    requestOlderTranscriptPage(chatId, store)
    return store.get(chatId)
  }
  return store.showOlderPage(chatId)
}

export function showNewerChatTranscriptPage(
  chatId: string | null | undefined
): ChatTranscriptPayload | null {
  if (!chatId) return null
  const store = getChatTranscriptStore()
  if (store.isPaged(chatId)) {
    requestNewerTranscriptPage(chatId, store)
    return store.get(chatId)
  }
  return store.showNewerPage(chatId)
}

export function showLatestChatTranscriptPage(
  chatId: string | null | undefined
): ChatTranscriptPayload | null {
  if (!chatId) return null
  const store = getChatTranscriptStore()
  if (store.isPaged(chatId)) {
    requestLatestTranscriptPage(chatId, store)
    return store.get(chatId)
  }
  return store.showLatestPage(chatId)
}

export function revealChatTranscriptMessage(
  chatId: string | null | undefined,
  messageId: string
): ChatTranscriptPayload | null {
  if (!chatId) return null
  const store = getChatTranscriptStore()
  if (store.isPaged(chatId)) {
    requestRevealTranscriptMessage(chatId, messageId, store)
    return store.get(chatId)
  }
  return store.revealMessage(chatId, messageId)
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
