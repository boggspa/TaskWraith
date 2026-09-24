import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChatRecord } from '../../../main/store/types'
import { scheduleAfterNextPaint } from '../app/appScheduleAndCopyHelpers'
import {
  SelectedChatHydrationRecovery,
  type SelectedChatHydrationBindings,
  type SelectedChatHydrationState
} from '../lib/SelectedChatHydrationRecovery'

interface Bindings extends Pick<SelectedChatHydrationBindings, 'needsHydration' | 'hydrate'> {
  subscribe(chatId: string, listener: () => void): () => void
}

export function useSelectedChatHydrationRecovery(chat: ChatRecord | null, bindings: Bindings) {
  const bindingsRef = useRef(bindings)
  useLayoutEffect(() => {
    bindingsRef.current = bindings
  }, [bindings])
  const [state, setState] = useState<SelectedChatHydrationState | null>(null)
  const recoveryRef = useRef<SelectedChatHydrationRecovery | null>(null)
  const getRecovery = useCallback(() => {
    if (!recoveryRef.current) {
      recoveryRef.current = new SelectedChatHydrationRecovery({
        needsHydration: (chatId) => bindingsRef.current.needsHydration(chatId),
        hydrate: (chatId) => bindingsRef.current.hydrate(chatId),
        publish: setState,
        afterPaint: scheduleAfterNextPaint,
        scheduleRetry: (callback, delayMs) => {
          const timer = window.setTimeout(callback, delayMs)
          return () => window.clearTimeout(timer)
        }
      })
    }
    return recoveryRef.current
  }, [])
  const chatId = chat?.appChatId ?? null
  useEffect(() => {
    const recovery = getRecovery()
    recovery.select(chatId)
    if (!chatId) return
    const unsubscribe = bindingsRef.current.subscribe(chatId, () => recovery.reconcile())
    // App seeds selected-record refs in later passive effects during boot.
    // Recheck after those effects even if this first selection was not eligible.
    const cancelReconcile = scheduleAfterNextPaint(() => recovery.reconcile())
    return () => {
      cancelReconcile()
      unsubscribe()
    }
  }, [chatId, getRecovery])
  useEffect(() => {
    getRecovery().reconcile()
  }, [chat, getRecovery])
  useEffect(() => () => recoveryRef.current?.dispose(), [])

  return {
    state: state?.chatId === chatId ? state : null,
    select: (id: string) => getRecovery().select(id),
    retry: () => getRecovery().retry()
  }
}
