import { describe, expect, it } from 'vitest'
import { groupEnsembleMessagesByRound } from './ensembleRoundGrouping'
import type { ChatMessage, ChatRecord } from '../../../main/store/types'

function message(
  id: string,
  overrides: Partial<ChatMessage> & {
    roundId?: string
  } = {}
): ChatMessage {
  const { roundId, ...rest } = overrides
  return {
    id,
    role: 'assistant',
    content: `body-${id}`,
    timestamp: '2026-05-27T12:00:00.000Z',
    ...(roundId ? { metadata: { ensembleRoundId: roundId } } : {}),
    ...rest
  } as ChatMessage
}

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'c1',
    title: 'Chat',
    provider: 'codex',
    chatKind: 'ensemble',
    messages: [],
    runs: [],
    createdAt: '2026-05-27T00:00:00.000Z',
    updatedAt: '2026-05-27T00:00:00.000Z',
    ...overrides
  } as ChatRecord
}

describe('groupEnsembleMessagesByRound (AV1)', () => {
  it('returns an empty array for null / no-messages chat', () => {
    expect(groupEnsembleMessagesByRound(null)).toEqual([])
    expect(groupEnsembleMessagesByRound(undefined)).toEqual([])
    expect(groupEnsembleMessagesByRound(chat())).toEqual([])
  })

  it('flattens non-ensemble chats into per-message items (no grouping)', () => {
    const soloChat = chat({
      chatKind: 'single',
      messages: [
        message('a', { roundId: 'r1' }),
        message('b', { roundId: 'r1' }),
        message('c', { roundId: 'r1' })
      ]
    })
    const items = groupEnsembleMessagesByRound(soloChat)
    expect(items.map((i) => i.type)).toEqual(['message', 'message', 'message'])
  })

  it('groups consecutive ensemble messages with the same roundId', () => {
    const messages = [
      message('user', { role: 'user', roundId: 'r1' }),
      message('a', { roundId: 'r1' }),
      message('b', { roundId: 'r1' })
    ]
    const items = groupEnsembleMessagesByRound(chat({ messages }))
    expect(items).toHaveLength(1)
    expect(items[0].type).toBe('round-group')
    if (items[0].type === 'round-group') {
      expect(items[0].roundId).toBe('r1')
      expect(items[0].messages.map((m) => m.id)).toEqual(['user', 'a', 'b'])
    }
  })

  it('starts a new group when roundId changes', () => {
    const messages = [
      message('u1', { role: 'user', roundId: 'r1' }),
      message('a', { roundId: 'r1' }),
      message('u2', { role: 'user', roundId: 'r2' }),
      message('b', { roundId: 'r2' })
    ]
    const items = groupEnsembleMessagesByRound(chat({ messages }))
    expect(items).toHaveLength(2)
    expect(items[0].type).toBe('round-group')
    expect(items[1].type).toBe('round-group')
    if (items[0].type === 'round-group') expect(items[0].roundId).toBe('r1')
    if (items[1].type === 'round-group') expect(items[1].roundId).toBe('r2')
  })

  it('keeps non-round messages inline between groups', () => {
    const messages = [
      message('preface', { role: 'system' }),
      message('u1', { role: 'user', roundId: 'r1' }),
      message('a', { roundId: 'r1' }),
      message('between', { role: 'system' }),
      message('u2', { role: 'user', roundId: 'r2' }),
      message('b', { roundId: 'r2' })
    ]
    const items = groupEnsembleMessagesByRound(chat({ messages }))
    expect(items.map((i) => i.type)).toEqual(['message', 'round-group', 'message', 'round-group'])
  })

  it('does NOT merge non-adjacent same-roundId messages (steer/resume safety)', () => {
    const messages = [
      message('u1', { role: 'user', roundId: 'r1' }),
      message('a', { roundId: 'r1' }),
      message('break', { role: 'system' }),
      message('a2', { roundId: 'r1' })
    ]
    const items = groupEnsembleMessagesByRound(chat({ messages }))
    expect(items.map((i) => i.type)).toEqual(['round-group', 'message', 'round-group'])
    if (items[0].type === 'round-group')
      expect(items[0].messages.map((m) => m.id)).toEqual(['u1', 'a'])
    if (items[2].type === 'round-group') expect(items[2].messages).toHaveLength(1)
  })

  it('surfaces lastRoundSummary on the group for the current active round fallback', () => {
    const messages = [
      message('u1', { role: 'user', roundId: 'r1' }),
      message('a', { roundId: 'r1' })
    ]
    const items = groupEnsembleMessagesByRound(
      chat({
        messages,
        ensemble: {
          enabled: true,
          maxParticipants: 4,
          participants: [],
          activeRound: { roundId: 'r1', status: 'completed', prompt: '', startedAt: '' } as any,
          lastRoundSummary: 'Decisions: shipped X. Next action: write tests.'
        }
      })
    )
    expect(items).toHaveLength(1)
    if (items[0].type === 'round-group') {
      expect(items[0].summary).toContain('shipped X')
    }
  })

  it('surfaces historical round summaries from the per-round summary index', () => {
    const messages = [
      message('u1', { role: 'user', roundId: 'r1' }),
      message('a', { roundId: 'r1' }),
      message('u2', { role: 'user', roundId: 'r2' }),
      message('b', { roundId: 'r2' })
    ]
    const items = groupEnsembleMessagesByRound(
      chat({
        messages,
        ensemble: {
          enabled: true,
          maxParticipants: 4,
          participants: [],
          activeRound: { roundId: 'r2', status: 'running', prompt: '', startedAt: '' } as any,
          lastRoundSummary: 'Round 2 summary',
          roundSummaries: {
            r1: {
              roundId: 'r1',
              participantId: 'codex',
              provider: 'codex',
              summary: 'Round 1 captured summary',
              capturedAt: '2026-05-27T12:01:00.000Z'
            }
          }
        }
      })
    )
    if (items[0].type === 'round-group') {
      expect(items[0].summary).toContain('Round 1 captured')
    }
    if (items[1].type === 'round-group') {
      expect(items[1].summary).toContain('Round 2')
    }
  })

  it('treats empty / whitespace summary as null', () => {
    const messages = [message('u1', { role: 'user', roundId: 'r1' })]
    const items = groupEnsembleMessagesByRound(
      chat({
        messages,
        ensemble: {
          enabled: true,
          maxParticipants: 4,
          participants: [],
          activeRound: { roundId: 'r1', status: 'completed', prompt: '', startedAt: '' } as any,
          lastRoundSummary: '   '
        }
      })
    )
    if (items[0].type === 'round-group') {
      expect(items[0].summary).toBeNull()
    }
  })

  /* Historical `agentQuestionReply` rows predate the writers stamping
   * `ensembleRoundId`. Without adoption, an unstamped reply is a flat item
   * that splits its round into TWO adjacent groups — two "Round N" headers
   * for one round, with the naked answer bubble floating between them. The
   * reply semantically belongs to the round whose question it answered, so
   * it adopts the group that is open around it. */
  it('adopts an unstamped agentQuestionReply into the surrounding round group', () => {
    const reply: ChatMessage = {
      id: 'agent-question-reply-q1',
      role: 'user',
      content: 'Yes',
      timestamp: '2026-05-27T12:00:40.000Z',
      metadata: {
        kind: 'agentQuestionReply',
        questionId: 'q1',
        respondedToMessageId: 'agent-question-q1',
        isCustomAnswer: false
      }
    } as ChatMessage
    const items = groupEnsembleMessagesByRound(
      chat({
        messages: [
          message('a1', { roundId: 'r1' }),
          reply,
          message('a2', { roundId: 'r1' }),
          message('b1', { roundId: 'r2' })
        ]
      })
    )
    expect(items.map((item) => item.type)).toEqual(['round-group', 'round-group'])
    if (items[0].type === 'round-group') {
      expect(items[0].roundId).toBe('r1')
      expect(items[0].messages.map((m) => m.id)).toEqual(['a1', 'agent-question-reply-q1', 'a2'])
    }
  })

  it('leaves an unstamped reply flat when no round group is open around it', () => {
    const reply: ChatMessage = {
      id: 'agent-question-reply-q2',
      role: 'user',
      content: 'Alpha',
      timestamp: '2026-05-27T12:00:40.000Z',
      metadata: {
        kind: 'agentQuestionReply',
        questionId: 'q2',
        respondedToMessageId: 'agent-question-q2',
        isCustomAnswer: false
      }
    } as ChatMessage
    const items = groupEnsembleMessagesByRound(
      chat({ messages: [message('a1'), reply, message('a2')] })
    )
    expect(items.map((item) => item.type)).toEqual(['message', 'message', 'message'])
  })
})
