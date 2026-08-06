import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import { mergeChatUpdatedForRender } from './chatUpdateRenderMerge'

function message(id: string, content: string): ChatMessage {
  return { id, role: 'assistant', content, timestamp: '1' }
}

function chat(messages: ChatMessage[]): ChatRecord {
  return {
    appChatId: 'chat-merge',
    title: 'Merge test',
    archived: false,
    messages,
    runs: [],
    createdAt: 1,
    updatedAt: 1
  } as ChatRecord
}

describe('mergeChatUpdatedForRender', () => {
  it('reuses the live transcript for metadata-only updates', () => {
    const incomingMessages = [message('a', 'incoming')]
    const liveMessages = [message('a', 'live'), message('b', 'synthetic')]
    const merged = mergeChatUpdatedForRender(chat(incomingMessages), {
      liveChat: chat(liveMessages),
      messagesChanged: false,
      hasActiveRun: true,
      hadRecentRun: false
    })

    expect(merged.messages).toBe(liveMessages)
  })

  it('keeps longer live assistant content when the incoming transcript changed', () => {
    const incomingMessages = [message('a', 'short')]
    const liveMessages = [message('a', 'longer live answer')]
    const merged = mergeChatUpdatedForRender(chat(incomingMessages), {
      liveChat: chat(liveMessages),
      messagesChanged: true,
      hasActiveRun: true,
      hadRecentRun: false
    })

    expect(merged.messages).toHaveLength(1)
    expect(merged.messages[0].content).toBe('longer live answer')
  })
})
