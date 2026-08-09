import { useEffect, useRef } from 'react'

/**
 * A visible chat surface owns its thread residency. The surface may be a
 * multiview pane, linked side chat, popout, or any future simultaneous chat
 * presentation; focus never participates in this lifecycle.
 */
export interface ChatSurfaceHydrationBindings<TChat> {
  resolveChat: (chatId: string) => TChat | null | undefined
  isHydrated: (chat: TChat) => boolean
  hydrateChat: (chatId: string) => Promise<TChat | null>
  pinChat: (chatId: string) => void
  unpinChat: (chatId: string) => void
}

function uniqueChatIds(chatIds: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const chatId of chatIds) {
    if (!chatId || seen.has(chatId)) continue
    seen.add(chatId)
    ids.push(chatId)
  }
  return ids
}

export class ChatSurfaceHydrationCoordinator<TChat> {
  private visibleChatIds = new Set<string>()
  private readonly inFlight = new Map<string, Promise<TChat | null>>()

  constructor(private readonly bindings: ChatSurfaceHydrationBindings<TChat>) {}

  updateVisible(chatIds: readonly (string | null | undefined)[]): void {
    const next = new Set(uniqueChatIds(chatIds))
    for (const chatId of this.visibleChatIds) {
      if (!next.has(chatId)) this.bindings.unpinChat(chatId)
    }
    for (const chatId of next) {
      if (!this.visibleChatIds.has(chatId)) this.bindings.pinChat(chatId)
    }
    this.visibleChatIds = next
    this.ensureVisibleHydrated()
  }

  ensureVisibleHydrated(): void {
    for (const chatId of this.visibleChatIds) {
      const chat = this.bindings.resolveChat(chatId)
      if (chat && this.bindings.isHydrated(chat)) continue
      if (this.inFlight.has(chatId)) continue

      const request = Promise.resolve()
        .then(() => this.bindings.hydrateChat(chatId))
        .finally(() => {
          if (this.inFlight.get(chatId) === request) this.inFlight.delete(chatId)
        })
      this.inFlight.set(chatId, request)
      // One surface's failed disk read must not cancel or reject another
      // surface's hydration. A later update/retry may request this id again.
      void request.catch(() => {})
    }
  }

  pendingChatIds(): string[] {
    return Array.from(this.inFlight.keys())
  }

  dispose(): void {
    for (const chatId of this.visibleChatIds) this.bindings.unpinChat(chatId)
    this.visibleChatIds.clear()
  }
}

/**
 * React bridge for one surface class in an App instance. Bindings are read
 * through a ref so callback identity churn cannot tear down ownership or
 * restart reads.
 */
export function useChatSurfaceHydration<TChat>(
  chatIds: readonly (string | null | undefined)[],
  bindings: ChatSurfaceHydrationBindings<TChat>
): void {
  const bindingsRef = useRef(bindings)
  bindingsRef.current = bindings
  const coordinatorRef = useRef<ChatSurfaceHydrationCoordinator<TChat> | null>(null)
  if (!coordinatorRef.current) {
    coordinatorRef.current = new ChatSurfaceHydrationCoordinator<TChat>({
      resolveChat: (chatId) => bindingsRef.current.resolveChat(chatId),
      isHydrated: (chat) => bindingsRef.current.isHydrated(chat),
      hydrateChat: (chatId) => bindingsRef.current.hydrateChat(chatId),
      pinChat: (chatId) => bindingsRef.current.pinChat(chatId),
      unpinChat: (chatId) => bindingsRef.current.unpinChat(chatId)
    })
  }

  const visibleKey = uniqueChatIds(chatIds).sort().join('\n')
  useEffect(() => {
    coordinatorRef.current?.updateVisible(visibleKey ? visibleKey.split('\n') : [])
  }, [visibleKey])
  useEffect(
    () => () => {
      coordinatorRef.current?.dispose()
    },
    []
  )
}
