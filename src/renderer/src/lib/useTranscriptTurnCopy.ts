import { useCallback, useRef } from 'react'
import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import { loadTranscriptTurnMarkdown } from './transcriptTurnCopy'

export function useTranscriptTurnCopy(
  chat: ChatRecord | null,
  messages: readonly ChatMessage[]
): (message: ChatMessage) => Promise<void> {
  const source = useRef({ chat, messages })
  source.current = { chat, messages }
  // Cached rows keep a stable callback while the source follows live history.
  return useCallback(async (message: ChatMessage) => {
    const markdown = await loadTranscriptTurnMarkdown(source.current, message, window.api)
    await navigator.clipboard.writeText(markdown)
  }, [])
}
