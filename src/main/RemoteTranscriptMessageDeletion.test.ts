import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord } from './store/types'
import { deleteTranscriptMessage } from './RemoteTranscriptMessageDeletion'

function chat(messages: ChatMessage[]): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'Thread',
    provider: 'codex',
    messages,
    createdAt: 1,
    updatedAt: 1
  } as ChatRecord
}

function message(id: string, metadata?: ChatMessage['metadata']): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: id,
    timestamp: '2026-08-03T00:00:00.000Z',
    ...(metadata ? { metadata } : {})
  }
}

describe('deleteTranscriptMessage', () => {
  it('removes only the selected message and stamps updatedAt', () => {
    const result = deleteTranscriptMessage(chat([message('a'), message('b')]), 'a', {
      now: () => 99
    })
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error('expected delete')
    expect(result.chat.messages.map((item) => item.id)).toEqual(['b'])
    expect(result.chat.updatedAt).toBe(99)
  })

  it('blocks pending plan anchors', () => {
    const result = deleteTranscriptMessage(
      chat([
        message('plan', {
          proposedPlan: { title: 'Plan', body: 'Body', status: 'pending' }
        })
      ]),
      'plan'
    )
    expect(result).toEqual({ ok: false, reason: 'open-prompt-anchor' })
  })

  it('blocks questions still pending in the canonical registry', () => {
    const result = deleteTranscriptMessage(
      chat([
        message('question', {
          kind: 'agentQuestion',
          agentQuestion: { questionId: 'q-1', question: 'Choose?' }
        })
      ]),
      'question',
      { pendingQuestionIds: new Set(['q-1']) }
    )
    expect(result).toEqual({ ok: false, reason: 'open-prompt-anchor' })
  })

  it('allows settled questions and reports missing identities', () => {
    const settled = deleteTranscriptMessage(
      chat([
        message('question', {
          kind: 'agentQuestion',
          agentQuestion: { questionId: 'q-1', question: 'Choose?' }
        })
      ]),
      'question',
      { pendingQuestionIds: new Set() }
    )
    expect(settled.ok).toBe(true)
    expect(deleteTranscriptMessage(chat([]), 'missing')).toEqual({
      ok: false,
      reason: 'message-not-found'
    })
  })
})
