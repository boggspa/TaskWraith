import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import {
  agentQuestionTombstoneKey,
  buildAgentQuestionTombstone,
  indexAgentQuestionReplies,
  isAgentQuestionMarker,
  suppressedAgentQuestionReplyIds
} from './agentQuestionTombstone'

const QUESTION_ID = 'q-1'
const MARKER_ID = `agent-question-${QUESTION_ID}`

function marker(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: MARKER_ID,
    role: 'system',
    content: 'Codex asked you to pick an option:',
    timestamp: '2026-07-27T14:30:00.000Z',
    metadata: {
      kind: 'agentQuestion',
      questionId: QUESTION_ID,
      agentQuestion: 'Do Channels replace General chats, or sit alongside them?',
      agentQuestionOptions: ['Replace — all are channels', 'Sit alongside them'],
      agentQuestionContext: 'Affects the v1 migration path.'
    },
    ...over
  } as ChatMessage
}

function reply(
  over: Partial<ChatMessage> = {},
  metadata: Record<string, unknown> = {}
): ChatMessage {
  return {
    id: `agent-question-reply-${QUESTION_ID}`,
    role: 'user',
    content: 'Replace — all are channels',
    timestamp: '2026-07-27T14:32:00.000Z',
    metadata: {
      kind: 'agentQuestionReply',
      questionId: QUESTION_ID,
      respondedToMessageId: MARKER_ID,
      isCustomAnswer: false,
      ...metadata
    },
    ...over
  } as ChatMessage
}

describe('agent question tombstone', () => {
  it('recognises only question markers', () => {
    expect(isAgentQuestionMarker(marker())).toBe(true)
    expect(isAgentQuestionMarker(reply())).toBe(false)
    expect(isAgentQuestionMarker({ ...marker(), role: 'assistant' } as ChatMessage)).toBe(false)
  })

  it('bakes the chosen option in, marking it against the option list', () => {
    const t = buildAgentQuestionTombstone(marker(), indexAgentQuestionReplies([reply()]))
    expect(t).toMatchObject({
      questionId: QUESTION_ID,
      question: 'Do Channels replace General chats, or sit alongside them?',
      context: 'Affects the v1 migration path.',
      options: ['Replace — all are channels', 'Sit alongside them'],
      answer: 'Replace — all are channels',
      isCustomAnswer: false,
      outcome: 'answered',
      replyMessageId: `agent-question-reply-${QUESTION_ID}`
    })
  })

  it('keeps a typed answer flagged custom so the card gives it its own line', () => {
    // A free-text answer matches no option button, so highlighting the list
    // would silently mark nothing. The writer's flag is authoritative.
    const t = buildAgentQuestionTombstone(
      marker(),
      indexAgentQuestionReplies([
        reply({ content: 'Something else entirely' }, { isCustomAnswer: true })
      ])
    )
    expect(t?.isCustomAnswer).toBe(true)
    expect(t?.answer).toBe('Something else entirely')
  })

  it('reports a question with no reply as skipped, not as unanswered-forever', () => {
    // Dismissal and the 24-minute timeout BOTH append nothing, so they are
    // indistinguishable here — and mean the same thing to a reader.
    const t = buildAgentQuestionTombstone(marker(), new Map())
    expect(t?.outcome).toBe('skipped')
    expect(t?.answer).toBeUndefined()
    expect(t?.replyMessageId).toBeUndefined()
  })

  it('falls back to the header line when an older marker carries no question text', () => {
    const legacy = marker({
      metadata: { kind: 'agentQuestion', questionId: QUESTION_ID }
    } as Partial<ChatMessage>)
    const t = buildAgentQuestionTombstone(legacy, new Map())
    // The header at least names who asked; an empty card would name nothing.
    expect(t?.question).toBe('Codex asked you to pick an option:')
    expect(t?.options).toEqual([])
  })

  it('resolves a reply that predates respondedToMessageId', () => {
    const legacyReply = reply({}, { respondedToMessageId: undefined })
    const t = buildAgentQuestionTombstone(marker(), indexAgentQuestionReplies([legacyReply]))
    expect(t?.outcome).toBe('answered')
  })

  it('drops non-string options rather than rendering them', () => {
    const weird = marker({
      metadata: {
        kind: 'agentQuestion',
        questionId: QUESTION_ID,
        agentQuestion: 'Pick',
        agentQuestionOptions: ['ok', 42, null, { a: 1 }]
      }
    } as Partial<ChatMessage>)
    expect(buildAgentQuestionTombstone(weird, new Map())?.options).toEqual(['ok'])
  })

  it('returns null for anything that is not a question marker', () => {
    expect(buildAgentQuestionTombstone(reply(), new Map())).toBeNull()
  })
})

describe('reply suppression', () => {
  it('suppresses the reply once the question has settled', () => {
    const suppressed = suppressedAgentQuestionReplyIds([marker(), reply()], new Set())
    expect([...suppressed]).toEqual([`agent-question-reply-${QUESTION_ID}`])
  })

  it('suppresses NOTHING while the question is still open', () => {
    // No tombstone renders for a pending question, so nothing is carrying the
    // answer — hiding the reply row would lose it entirely.
    const suppressed = suppressedAgentQuestionReplyIds([marker(), reply()], new Set([MARKER_ID]))
    expect(suppressed.size).toBe(0)
  })

  it('leaves an unrelated user message alone', () => {
    const chat: ChatMessage[] = [
      marker(),
      reply(),
      { id: 'u-1', role: 'user', content: 'and another thing', timestamp: '' } as ChatMessage
    ]
    expect(suppressedAgentQuestionReplyIds(chat, new Set()).has('u-1')).toBe(false)
  })
})

describe('row cache key', () => {
  it('changes when the question is answered', () => {
    const open = buildAgentQuestionTombstone(marker(), new Map())
    const answered = buildAgentQuestionTombstone(marker(), indexAgentQuestionReplies([reply()]))
    // Without this the row cache would keep serving the "Skipped" card after
    // the user answered.
    expect(agentQuestionTombstoneKey(open, false)).not.toBe(
      agentQuestionTombstoneKey(answered, false)
    )
  })

  it('distinguishes a hidden reply row from a plain one', () => {
    expect(agentQuestionTombstoneKey(null, true)).not.toBe(agentQuestionTombstoneKey(null, false))
  })
})
