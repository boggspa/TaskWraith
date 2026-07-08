import { useCallback, useRef } from 'react'
import type { ChatRecord } from '../../../main/store/types'
import {
  updateChat,
  mergeChat,
  reconcileAll,
  replaceAll,
  removeChat,
  removeChats,
  promoteToFront,
  type UpdateChatOptions,
} from './chatMutations'

/**
 * useChatMutations — React binding hook for the chat-mutation facade.
 *
 * Returns a stable API object (ref-based) so consumers can use it inside
 * useEffect without dependency churn.  The rAF coalescer is INTERNAL:
 * updateChatCoalesced batches rapid successive updates into one flush
 * per animation frame.
 *
 * This is a SCAFFOLD — the App.tsx call-site migration is owned by @WriteRender
 * in a later slice.  Do NOT import this into App.tsx until that slice lands.
 */

export interface ChatMutationsApi {
  updateChat: (id: string, updater: (chat: ChatRecord) => ChatRecord, opts?: UpdateChatOptions) => void
  mergeChat: (record: ChatRecord) => void
  reconcileAll: (records: ChatRecord[]) => void
  replaceAll: (records: ChatRecord[]) => void
  removeChat: (id: string) => void
  removeChats: (ids: Iterable<string>) => void
  promoteToFront: (record: ChatRecord) => void
}

export function useChatMutations(
  setChats: React.Dispatch<React.SetStateAction<ChatRecord[]>>
): ChatMutationsApi {
  // Stable ref so the returned api object never changes identity.
  const setChatsRef = useRef(setChats)
  setChatsRef.current = setChats

  const rafRef = useRef<number | null>(null)
  const pendingRef = useRef<ChatRecord[] | null>(null)

  const flushCoalesced = useCallback(() => {
    rafRef.current = null
    const batch = pendingRef.current
    if (batch == null) return
    pendingRef.current = null
    setChatsRef.current((prev) => reconcileAll(prev, batch))
  }, [])

  const scheduleCoalesced = useCallback(
    (record: ChatRecord) => {
      if (pendingRef.current == null) {
        pendingRef.current = [record]
      } else {
        pendingRef.current = [...pendingRef.current, record]
      }
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(flushCoalesced)
      }
    },
    [flushCoalesced]
  )

  // Coalesced update path — currently unused at scaffold time; will be wired
  // by @WriteRender when migrating the rAF-coalesced setChats sites.
  void scheduleCoalesced

  const apiRef = useRef<ChatMutationsApi>({
    updateChat: (id, updater, opts) => {
      setChatsRef.current((prev) => updateChat(prev, id, updater, opts))
    },
    mergeChat: (record) => {
      setChatsRef.current((prev) => mergeChat(prev, record))
    },
    reconcileAll: (records) => {
      setChatsRef.current((prev) => reconcileAll(prev, records))
    },
    replaceAll: (records) => {
      setChatsRef.current(() => replaceAll([], records))
    },
    removeChat: (id) => {
      setChatsRef.current((prev) => removeChat(prev, id))
    },
    removeChats: (ids) => {
      setChatsRef.current((prev) => removeChats(prev, ids))
    },
    promoteToFront: (record) => {
      setChatsRef.current((prev) => promoteToFront(prev, record))
    },
  })

  return apiRef.current
}
