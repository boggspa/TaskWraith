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
