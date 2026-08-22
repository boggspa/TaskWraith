import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import { RENDERER_CHAT_TRANSCRIPT_MUTATION_VERSION } from '../../../shared/rendererChatTranscriptMutation'
import { RendererChatTranscriptPersistence } from './RendererChatTranscriptPersistence'

function message(content: string): ChatMessage {
  return {
    id: 'stream',
    role: 'assistant',
    content,
    timestamp: '2026-08-22T00:00:00.000Z'
  }
}

function chat(content: string, revision = 3, title = 'Chat'): ChatRecord {
  return {
    appChatId: 'chat-1',
    provider: 'mistral',
    title,
    scope: 'global',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    persistenceRevision: revision,
    messages: [message(content)],
    runs: []
  }
}

describe('RendererChatTranscriptPersistence', () => {
  it('coalesces a stream burst into one final compact update', async () => {
    const base = chat('h')
    const middle = { ...base, messages: [message('he')] }
    const target = { ...middle, messages: [message('hello')] }
    const mutate = vi.fn(async () => ({
      version: RENDERER_CHAT_TRANSCRIPT_MUTATION_VERSION,
      accepted: true as const,
      chatId: 'chat-1',
      revision: 4,
      updatedAt: 2,
      messageCount: 1
    }))
    const onAccepted = vi.fn()
    const persistence = new RendererChatTranscriptPersistence({
      mutate,
      loadCanonical: vi.fn(async () => null),
      onAccepted,
      onRecovered: vi.fn(),
      onUnrecoverable: vi.fn()
    })

    expect(persistence.queue(base, middle)).toBe(true)
    expect(persistence.queue(middle, target)).toBe(true)
    await persistence.flush('chat-1')

    expect(mutate).toHaveBeenCalledWith({
      version: RENDERER_CHAT_TRANSCRIPT_MUTATION_VERSION,
      chatId: 'chat-1',
      baseRevision: 3,
      transcriptOps: [{ op: 'update', id: 'stream', message: target.messages[0] }]
    })
    expect(onAccepted).toHaveBeenCalledWith(
      'chat-1',
      3,
      expect.objectContaining({ persistenceRevision: 4 }),
      expect.objectContaining({ accepted: true, revision: 4 })
    )
  })

  it('rebases a rejected tail update onto the conflict snapshot and retries', async () => {
    const base = chat('old', 3)
    const target = { ...base, messages: [message('new')] }
    const canonical = chat('old', 4, 'Main title')
    const mutate = vi
      .fn()
      .mockResolvedValueOnce({
        version: RENDERER_CHAT_TRANSCRIPT_MUTATION_VERSION,
        accepted: false as const,
        chatId: 'chat-1',
        revision: 4,
        reason: 'revision-conflict' as const,
        canonical
      })
      .mockResolvedValueOnce({
        version: RENDERER_CHAT_TRANSCRIPT_MUTATION_VERSION,
        accepted: true as const,
        chatId: 'chat-1',
        revision: 5,
        updatedAt: 3,
        messageCount: 1
      })
    const onRecovered = vi.fn()
    const persistence = new RendererChatTranscriptPersistence({
      mutate,
      loadCanonical: vi.fn(async () => canonical),
      onAccepted: vi.fn(),
      onRecovered,
      onUnrecoverable: vi.fn()
    })

    persistence.queue(base, target)
    await persistence.flush('chat-1')

    expect(onRecovered).toHaveBeenCalledWith(
      'chat-1',
      target,
      expect.objectContaining({
        title: 'Main title',
        persistenceRevision: 4,
        messages: [expect.objectContaining({ content: 'new' })]
      })
    )
    expect(mutate).toHaveBeenCalledTimes(2)
    expect(mutate.mock.calls[1][0]).toMatchObject({
      baseRevision: 4,
      transcriptOps: [{ op: 'update', id: 'stream' }]
    })
  })
})
