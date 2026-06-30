import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord, ProviderId } from '../../../main/store/types'
import {
  GUEST_PARTICIPANT_STEERING_PREAMBLE,
  buildGuestParentTranscriptContext,
  formatGuestParentContextMessage,
  truncateGuestContextText
} from './guestParticipantContext'

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: partial.id || 'm',
    role: partial.role || 'user',
    content: partial.content ?? '',
    timestamp: partial.timestamp || '2026-01-01T00:00:00.000Z',
    ...partial
  } as ChatMessage
}

function chat(messages: ChatMessage[], provider: ProviderId = 'claude'): ChatRecord {
  return { appChatId: 'parent-1', provider, messages } as ChatRecord
}

describe('guestParticipantContext', () => {
  it('exposes the steering preamble', () => {
    expect(GUEST_PARTICIPANT_STEERING_PREAMBLE).toContain('guest participant')
  })

  it('truncates guest context text with an ellipsis', () => {
    expect(truncateGuestContextText('hello', 10)).toBe('hello')
    const out = truncateGuestContextText('abcdefghij', 5)
    expect(out).toBe('abcd…')
    expect(out.length).toBe(5)
  })

  it('formats parent transcript messages and skips guest replies', () => {
    expect(formatGuestParentContextMessage(msg({ role: 'user', content: 'hi' }), 'claude')).toBe(
      'User: hi'
    )
    expect(
      formatGuestParentContextMessage(msg({ role: 'assistant', content: 'yo' }), 'claude')
    ).toContain('parent agent: yo')
    expect(
      formatGuestParentContextMessage(
        msg({
          role: 'assistant',
          content: 'ensemble answer',
          metadata: { ensembleProvider: 'codex', ensembleRole: 'Planner' }
        }),
        'grok'
      )
    ).toBe('Codex / Planner: ensemble answer')
    expect(
      formatGuestParentContextMessage(
        msg({
          role: 'system',
          content: 'earlier guest reply',
          metadata: { kind: 'guestParticipantReply' }
        }),
        'claude'
      )
    ).toBeNull()
    expect(
      formatGuestParentContextMessage(
        msg({ role: 'system', content: 'sub result', metadata: { kind: 'subThreadReturn' } }),
        'claude'
      )
    ).toBe('Returned sub-thread context: sub result')
  })

  it('builds parent transcript context with heading and capped turns', () => {
    expect(buildGuestParentTranscriptContext(chat([]))).toBe('')
    const out = buildGuestParentTranscriptContext(
      chat([msg({ role: 'user', content: 'do X' }), msg({ role: 'assistant', content: 'host did X' })])
    )
    expect(out).toContain('Parent transcript context')
    expect(out).toContain('User: do X')
    expect(out).toContain('parent agent: host did X')

    const ensembleOut = buildGuestParentTranscriptContext(
      chat(
        [
          msg({
            role: 'assistant',
            content: 'planner summary',
            metadata: { ensembleProvider: 'codex', ensembleRole: 'Planner' }
          })
        ],
        'grok'
      )
    )
    expect(ensembleOut).toContain('Codex / Planner: planner summary')
    expect(ensembleOut).not.toContain('Grok parent agent')

    const many = Array.from({ length: 30 }, (_, i) => msg({ role: 'user', content: `turn ${i}` }))
    const capped = buildGuestParentTranscriptContext(chat(many))
    expect(capped).not.toContain('turn 9')
    expect(capped).toContain('turn 29')
  })
})
