import { startTransition, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChatTranscriptStore, type ChatTranscriptPayload } from './chatTranscriptStore'
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

export interface ChatTranscriptPresentationOptions {
  /**
   * Publish store notifications through `startTransition` so React can
   * interrupt a streaming burst for composer input. Leave it off for an idle
   * chat: a transition render of a large transcript never completes while
   * unrelated urgent updates keep landing (renderer pinned at 100% with every
   * transition lane pending and expired, 2026-09-05), whereas a synchronous
   * publish always commits.
   */
  deferPresentation?: boolean
}

/**
 * A presentation snapshot, deliberately separate from the authoritative store.
 * useSyncExternalStore forces stream notifications into React's synchronous
 * lane, even inside startTransition. That makes transcript rendering (and App
 * / pane rendering for paged chats) block composer input during active runs.
 * State updates let React interrupt this work for typing and coalesce a burst
 * to its latest snapshot — while a consumer opts in via `deferPresentation`.
 * Imperative store reads remain immediately current.
 */
export function useChatTranscript(
  chatId: string | null | undefined,
  options?: ChatTranscriptPresentationOptions
): ChatTranscriptPayload {
  const store = getChatTranscriptStore()
  const scope = chatId || null
  // A -> B -> A must create a new subscription identity: pending work from
  // the first visit to A can still be replayed by React after the return.
  const source = useMemo(() => ({ store, scope }), [store, scope])
  const deferPresentation = options?.deferPresentation === true
  const deferPresentationRef = useRef(deferPresentation)
  useLayoutEffect(() => {
    deferPresentationRef.current = deferPresentation
  }, [deferPresentation])
  const [presentation, setPresentation] = useState(() => ({
    source,
    payload: store.getSnapshot(scope)
  }))

  // Navigation is urgent: never paint chat A's deferred transcript under chat
  // B's title or let a queued A update revive it after a switch/clear.
  const scopeChanged = presentation.source !== source
  const payload = scopeChanged ? store.getSnapshot(scope) : presentation.payload
  if (scopeChanged) setPresentation({ source, payload })

  useLayoutEffect(() => {
    const { store, scope } = source
    let subscribed = true
    const update = (): void => {
      if (!subscribed) return
      const next = store.getSnapshot(scope)
      const publish = (): void => {
        setPresentation((previous) => {
          if (previous.source !== source || previous.payload === next) {
            return previous
          }
          return { source, payload: next }
        })
      }
      if (deferPresentationRef.current) startTransition(publish)
      else publish()
    }
    const unsubscribe = store.subscribe(scope, update)
    // Close the render-to-subscribe race, including writes from sibling layout
    // effects. No polling or timeout: every notification schedules the latest
    // immutable payload, including final output when the stream stops.
    update()
    return () => {
      subscribed = false
      unsubscribe()
    }
  }, [source])

  return payload
}
