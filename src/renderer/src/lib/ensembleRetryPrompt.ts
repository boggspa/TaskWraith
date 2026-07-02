import type { ChatMessage } from '../../../main/store/types'

export function lastRetryableEnsembleUserPrompt(messages: ChatMessage[] | undefined): string {
  const lastUserMessage = [...(messages || [])]
    .reverse()
    .find((message) => message.role === 'user' && message.metadata?.kind !== 'channelInbound')
  return lastUserMessage?.content?.trim() || ''
}
