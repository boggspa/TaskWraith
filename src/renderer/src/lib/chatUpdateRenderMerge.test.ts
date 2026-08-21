import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import { coalescePendingChatUpdateRender, mergeChatUpdatedForRender } from './chatUpdateRenderMerge'

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

  it('preserves a renderer-authored closeout outside the recent-run window', () => {
    const incoming = chat([message('a', 'answer')])
    const closeout: ChatMessage = {
      id: 'closeout',
      role: 'system',
      content: '',
      timestamp: '2',
      metadata: { kind: 'taskWraithCloseout' }
    }
    const live = chat([...incoming.messages, closeout])
    const merged = mergeChatUpdatedForRender(incoming, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })

    expect(merged.messages.map((entry) => entry.id)).toEqual(['a', 'closeout'])
  })
})

describe('coalescePendingChatUpdateRender', () => {
  it('keeps transcript dirt sticky when metadata arrives before the frame flush', () => {
    const live = chat([message('a', 'old')])
    const closeout: ChatMessage = {
      id: 'closeout',
      role: 'system',
      content: '',
      timestamp: '2',
      metadata: { kind: 'taskWraithCloseout' }
    }
    const transcriptMessages = [message('a', 'old'), closeout]
    const transcriptDelivery = chat(transcriptMessages)
    const metadataDelivery = {
      ...chat(transcriptMessages),
      title: 'Newest metadata'
    }

    const first = coalescePendingChatUpdateRender(undefined, {
      chat: transcriptDelivery,
      messagesChanged: true,
      hasActiveRun: true,
      hadRecentRun: false
    })
    const pending = coalescePendingChatUpdateRender(first, {
      chat: metadataDelivery,
      messagesChanged: false,
      hasActiveRun: true,
      hadRecentRun: false
    })
    const merged = mergeChatUpdatedForRender(pending.chat, {
      liveChat: live,
      messagesChanged: pending.messagesChanged,
      hasActiveRun: pending.hasActiveRun,
      hadRecentRun: pending.hadRecentRun
    })

    expect(pending.chat).toBe(metadataDelivery)
    expect(pending.messagesChanged).toBe(true)
    expect(merged.title).toBe('Newest metadata')
    expect(merged.messages.map((entry) => entry.id)).toEqual(['a', 'closeout'])
  })

  it('retains only the newest non-gating render receipt for a coalesced chat', () => {
    const first = coalescePendingChatUpdateRender(undefined, {
      chat: chat([message('a', 'one')]),
      messagesChanged: true,
      hasActiveRun: true,
      hadRecentRun: false,
      renderReceipt: {
        chatId: 'chat-merge',
        deliveryId: 'delivery-1',
        revision: 1,
        rendererEpoch: 'renderer-a'
      }
    })
    const pending = coalescePendingChatUpdateRender(first, {
      chat: chat([message('a', 'two')]),
      messagesChanged: true,
      hasActiveRun: true,
      hadRecentRun: false,
      renderReceipt: {
        chatId: 'chat-merge',
        deliveryId: 'delivery-2',
        revision: 2,
        rendererEpoch: 'renderer-a'
      }
    })

    expect(pending.renderReceipt?.deliveryId).toBe('delivery-2')
  })
})
