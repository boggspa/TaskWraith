/**
 * Renderer state for a chat's peer thread-message inbox (S7 plumbing).
 *
 * The inbox is NOT part of `ChatRecord` — it lives in its own main-side ledger —
 * so a mounted view cannot read it from chat state the way it reads notes or
 * messages. This hook is that missing piece: it fetches over IPC and refetches
 * when main announces the receiving chat changed.
 *
 * Main broadcasts the RECEIVING chat after a send is accepted (both the IPC and
 * MCP paths do), so `chat-updated` for that chat id is the signal. The refetch
 * decision is a separate pure function because the renderer test setup renders to
 * static markup and cannot run hooks — the part worth testing has to be callable
 * on its own.
 */

import { useCallback, useEffect, useState } from 'react'
import type { ChatUpdateDelivery } from '../../../shared/chatUpdateTransport'

export interface ThreadMessageInboxEntry {
  id: string
  fromChatId: string
  fromChatTitle: string
  origin: 'user' | 'agent'
  body: string
  requestedDelivery: 'queue' | 'wake'
  createdAt: number
  truncated?: boolean
}

export interface ThreadMessageInboxSnapshot {
  summary: {
    toChatId: string
    pendingCount: number
    hasWakeRequest: boolean
    oldestPendingAt: number | null
    senders: string[]
  }
  pending: ThreadMessageInboxEntry[]
}

function emptySnapshot(chatId: string): ThreadMessageInboxSnapshot {
  return {
    summary: {
      toChatId: chatId,
      pendingCount: 0,
      hasWakeRequest: false,
      oldestPendingAt: null,
      senders: []
    },
    pending: []
  }
}

/**
 * Should a chat-update delivery trigger an inbox refetch?
 *
 * Only for the chat being watched. Refetching on every chat update would put an
 * IPC round-trip behind every keystroke-driven save in the app, for a panel that
 * is usually looking at one thread.
 */
export function shouldRefetchThreadMessageInbox(
  watchedChatId: string,
  delivery: Pick<ChatUpdateDelivery, 'chatId'> | null | undefined
): boolean {
  if (!watchedChatId) return false
  return Boolean(delivery?.chatId) && delivery?.chatId === watchedChatId
}

interface ThreadMessageInboxApi {
  threadMessageInbox?: (chatId: string) => Promise<ThreadMessageInboxSnapshot>
  onChatUpdated?: (callback: (delivery: ChatUpdateDelivery) => void) => () => void
}

export function useThreadMessageInbox(chatId: string | undefined | null): {
  snapshot: ThreadMessageInboxSnapshot
  refresh: () => void
} {
  const watched = chatId || ''
  const [snapshot, setSnapshot] = useState<ThreadMessageInboxSnapshot>(() => emptySnapshot(watched))

  const load = useCallback(() => {
    if (!watched) {
      setSnapshot(emptySnapshot(''))
      return
    }
    const api = (window as unknown as { api?: ThreadMessageInboxApi }).api
    if (!api?.threadMessageInbox) return
    void api
      .threadMessageInbox(watched)
      .then((next) => setSnapshot(next))
      // An inbox that cannot be read shows as empty rather than stale: a count
      // left over from another thread would be worse than no count.
      .catch(() => setSnapshot(emptySnapshot(watched)))
  }, [watched])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const api = (window as unknown as { api?: ThreadMessageInboxApi }).api
    if (!api?.onChatUpdated || !watched) return
    return api.onChatUpdated((delivery) => {
      if (shouldRefetchThreadMessageInbox(watched, delivery)) load()
    })
  }, [watched, load])

  return { snapshot, refresh: load }
}
