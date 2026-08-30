import { useCallback, useSyncExternalStore } from 'react'
import { createComposerDraftState } from '../lib/composerDraftState'
import { readComposerDrafts } from '../lib/composerDraftStore'

/**
 * The one live composer-draft store for this renderer window.
 *
 * Seeded at MODULE LOAD from localStorage, which runs before the first React
 * render — the same synchronous-restore guarantee the old `usePerChatState`
 * lazy initializer gave. Hydrating asynchronously instead would reintroduce the
 * clobber race where a late restore overwrites text the user already began
 * typing.
 */
export const composerDraftState = createComposerDraftState(readComposerDrafts())

const NO_SUBSCRIPTION = (): void => {}

/**
 * Live draft text for one chat. Re-renders ONLY the calling component, and only
 * when THIS chat's text changes — which is what keeps a keystroke out of the App
 * render root. Mirrors the `projectReferenceContextSelection` per-chat
 * subscription next door in App.
 */
export const useComposerDraft = (chatId: string | null | undefined): string => {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!chatId) return NO_SUBSCRIPTION
      return composerDraftState.subscribeToChat(chatId, listener)
    },
    [chatId]
  )
  const read = useCallback(() => composerDraftState.getDraft(chatId), [chatId])
  return useSyncExternalStore(subscribe, read, read)
}

/**
 * The set of chats currently showing a draft indicator. Identity is stable
 * across keystrokes that do not change membership, so a component reading this
 * does NOT re-render while text changes inside a draft that already existed.
 */
export const useComposerDraftChatIds = (): ReadonlySet<string> =>
  useSyncExternalStore(
    composerDraftState.subscribeToDraftChatIds,
    composerDraftState.getDraftChatIds,
    composerDraftState.getDraftChatIds
  )
