import { useCallback, useEffect, useState } from 'react'
import type { ChatMessage } from '../../../main/store/types'

interface ComposerAboveRowsInput {
  chatId: string | null | undefined
  isEnsemble: boolean
  isWelcome: boolean
  messages?: ReadonlyArray<Pick<ChatMessage, 'role'>>
}

interface ComposerAboveRowsState {
  minimized: boolean
  awaitingFirstPrompt: boolean
}

/**
 * Collapse a welcome Ensemble's rows once its first prompt reaches the thread.
 * Waiting for a user row also covers keyboard/side-pane sends without treating
 * configuration notices or rejected sends as the start of a conversation.
 * Both the one-shot transition and manual choices belong to the chat, since a
 * mounted composer can switch between threads.
 */
export function useComposerAboveRowsMinimized({
  chatId,
  isEnsemble,
  isWelcome,
  messages
}: ComposerAboveRowsInput): readonly [boolean, (minimized: boolean) => void] {
  const [states, setStates] = useState<Record<string, ComposerAboveRowsState>>({})
  const hasUserPrompt = messages?.some((message) => message.role === 'user') === true

  useEffect(() => {
    if (!chatId) return
    setStates((previous) => {
      const state = previous[chatId]
      if (!state) {
        return {
          ...previous,
          [chatId]: {
            minimized: false,
            awaitingFirstPrompt: isWelcome && !hasUserPrompt
          }
        }
      }
      if (!state.awaitingFirstPrompt || !hasUserPrompt) return previous
      return {
        ...previous,
        [chatId]: {
          minimized: isEnsemble || state.minimized,
          awaitingFirstPrompt: false
        }
      }
    })
  }, [chatId, hasUserPrompt, isEnsemble, isWelcome])

  const setMinimized = useCallback(
    (minimized: boolean): void => {
      if (!chatId) return
      setStates((previous) => {
        const state = previous[chatId] ?? {
          minimized: false,
          awaitingFirstPrompt: isWelcome && !hasUserPrompt
        }
        if (state.minimized === minimized) return previous
        return { ...previous, [chatId]: { ...state, minimized } }
      })
    },
    [chatId, hasUserPrompt, isWelcome]
  )

  return [chatId ? states[chatId]?.minimized === true : false, setMinimized] as const
}
