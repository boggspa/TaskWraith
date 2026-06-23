import { useCallback, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'

export type PerChatStateAction<T> = T | ((previous: T) => T)

export const applyStateAction = <T>(value: PerChatStateAction<T>, previous: T): T =>
  typeof value === 'function' ? (value as (previous: T) => T)(previous) : value

/**
 * Pure reducer for one per-chat update. Extracted so the sparse-map invariants
 * are unit-tested without rendering the hook:
 *  - resetting a chat to `initial` deletes its entry (the map only ever holds
 *    chats with a non-default value);
 *  - an unchanged value returns the SAME object reference so React can bail the
 *    update.
 */
export const nextPerChatValues = <T>(
  previousValues: Record<string, T>,
  chatId: string,
  value: PerChatStateAction<T>,
  initial: T
): Record<string, T> => {
  const previous = previousValues[chatId] ?? initial
  const nextValue = applyStateAction(value, previous)

  if (Object.is(nextValue, initial)) {
    if (!(chatId in previousValues)) return previousValues
    const nextValues = { ...previousValues }
    delete nextValues[chatId]
    return nextValues
  }

  if (Object.is(previousValues[chatId], nextValue)) {
    return previousValues
  }

  return { ...previousValues, [chatId]: nextValue }
}

export const usePerChatState = <T>(
  initial: T,
  /**
   * Optional lazy seed for the initial map — runs ONCE (useState initializer), so
   * persisted state (e.g. composer drafts read synchronously from localStorage)
   * is present on the very first render, before any consumer reads it. Restoring
   * synchronously this way avoids the async-effect clobber race where a late
   * hydrate overwrites text the user already started typing.
   */
  lazyInitialMap?: () => Record<string, T>
): readonly [
  Record<string, T>,
  (chatId: string | null | undefined, value: PerChatStateAction<T>) => void,
  Dispatch<SetStateAction<Record<string, T>>>
] => {
  const [valuesByChatId, setValuesByChatId] = useState<Record<string, T>>(
    () => lazyInitialMap?.() ?? {}
  )

  const setForChat = useCallback(
    (chatId: string | null | undefined, value: PerChatStateAction<T>) => {
      if (!chatId) return
      setValuesByChatId((previousValues) =>
        nextPerChatValues(previousValues, chatId, value, initial)
      )
    },
    [initial]
  )

  return [valuesByChatId, setForChat, setValuesByChatId] as const
}
