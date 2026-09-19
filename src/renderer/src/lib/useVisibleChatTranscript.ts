import { useCallback, useSyncExternalStore } from 'react'
import type { ChatTranscriptPayload } from './chatTranscriptStore'
import { getChatTranscriptStore } from './useChatTranscript'

/**
 * The visible transcript is an urgent surface, even when a store write arrives
 * inside a transition. Keep this subscription local to the virtualised panel:
 * App and pane chrome can continue using their deferred presentation snapshots.
 */
export function useVisibleChatTranscript(chatId: string | null | undefined): ChatTranscriptPayload {
  const store = getChatTranscriptStore()
  const scope = chatId || null
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(scope, listener),
    [store, scope]
  )
  const getSnapshot = useCallback(() => store.getSnapshot(scope), [store, scope])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
