import type { ChatMessage, ProviderId } from '../main/store/types'

export const TASKWRAITH_CLOSEOUT_KIND = 'taskWraithCloseout'

export type TaskWraithCloseoutSource =
  | 'currentProvider'
  | 'summaryProvider'
  | 'deterministicFallback'

export function taskWraithRunCloseoutId(runId: string): string {
  return `taskwraith-closeout-run-${runId}`
}

export function taskWraithRoundCloseoutId(roundId: string): string {
  return `taskwraith-closeout-round-${roundId}`
}

export function isTaskWraithCloseoutMessage(
  message: Pick<ChatMessage, 'metadata'> | null | undefined
): boolean {
  return message?.metadata?.kind === TASKWRAITH_CLOSEOUT_KIND
}

/** AI-authored close-out prose persisted on the message, if any. Lets the
 *  rebuild effect re-consume the summary instead of clobbering it back to the
 *  deterministic fallback after restart/chat-reselect. */
export function closeoutAiSummaryFromMetadata(
  metadata: ChatMessage['metadata'] | null | undefined
): { text: string; model?: string } | null {
  const text = typeof metadata?.closeoutAiSummary === 'string' ? metadata.closeoutAiSummary : ''
  if (!text.trim()) return null
  return {
    text,
    ...(typeof metadata?.closeoutModel === 'string' && metadata.closeoutModel.trim()
      ? { model: metadata.closeoutModel }
      : {})
  }
}

export function closeoutProviderFromMetadata(
  metadata: ChatMessage['metadata'] | null | undefined
): ProviderId | null {
  const provider = metadata?.closeoutProvider
  return provider === 'gemini' ||
    provider === 'codex' ||
    provider === 'claude' ||
    provider === 'kimi' ||
    provider === 'grok' ||
    provider === 'cursor' ||
    provider === 'ollama'
    ? provider
    : null
}
