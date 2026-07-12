import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatRecord } from './store/types'
import { bossOwnTerminalContent, evaluateBossQuotaSoftUnavailable } from './BossQuotaSoftUnavailable'

const ROUND = 'round-1'
const WALL = "You've hit your limit · resets Jul 14"
const BOSS = { id: 'boss', provider: 'claude' as const }

function ensembleMsg(
  id: string,
  participantId: string,
  content: string,
  opts: { roundId?: string; role?: ChatMessage['role'] } = {}
): ChatMessage {
  return {
    id,
    role: opts.role ?? 'assistant',
    content,
    timestamp: '2026-07-12T00:00:00.000Z',
    metadata: {
      kind: 'ensembleParticipant',
      ensembleRoundId: opts.roundId ?? ROUND,
      ensembleParticipantId: participantId
    }
  }
}

function chatWith(messages: ChatMessage[]): Pick<ChatRecord, 'messages'> {
  return { messages }
}

describe('evaluateBossQuotaSoftUnavailable — C1 shared quota evaluator', () => {
  it("flips true on the Boss's own quota-wall terminal", () => {
    expect(evaluateBossQuotaSoftUnavailable(chatWith([ensembleMsg('m1', 'boss', WALL)]), ROUND, BOSS)).toBe(true)
  })

  it('is false when the Boss answered healthily', () => {
    expect(
      evaluateBossQuotaSoftUnavailable(
        chatWith([ensembleMsg('m1', 'boss', 'On it — routing C1 to WriteMain.')]),
        ROUND,
        BOSS
      )
    ).toBe(false)
  })

  it('G1: false on ordinary Boss prose mentioning quota/resets', () => {
    expect(
      evaluateBossQuotaSoftUnavailable(
        chatWith([ensembleMsg('m1', 'boss', 'Let me check when the quota resets before we continue.')]),
        ROUND,
        BOSS
      )
    ).toBe(false)
  })

  it('G1c: a PEER quoting the wall does NOT flip Boss authority', () => {
    const chat = chatWith([
      ensembleMsg('m1', 'peer', WALL), // a non-Boss seat quoting the wall template
      ensembleMsg('m2', 'boss', 'Continuing — Captain, take C1 review.')
    ])
    expect(evaluateBossQuotaSoftUnavailable(chat, ROUND, BOSS)).toBe(false)
  })

  it('non-sticky: an earlier wall followed by a healthy Boss terminal reads false', () => {
    const chat = chatWith([ensembleMsg('m1', 'boss', WALL), ensembleMsg('m2', 'boss', 'Recovered — proceeding.')])
    expect(evaluateBossQuotaSoftUnavailable(chat, ROUND, BOSS)).toBe(false)
  })

  it('reflects the LATEST terminal: a wall after a healthy turn reads true', () => {
    const chat = chatWith([ensembleMsg('m1', 'boss', 'Healthy turn.'), ensembleMsg('m2', 'boss', WALL)])
    expect(evaluateBossQuotaSoftUnavailable(chat, ROUND, BOSS)).toBe(true)
  })

  it('is round-scoped: a wall in a different round does not flip', () => {
    const chat = chatWith([ensembleMsg('m1', 'boss', WALL, { roundId: 'other-round' })])
    expect(evaluateBossQuotaSoftUnavailable(chat, ROUND, BOSS)).toBe(false)
  })

  it('ignores non-assistant messages carrying the wall text', () => {
    const chat = chatWith([
      { id: 'u1', role: 'user', content: WALL, timestamp: '2026-07-12T00:00:00.000Z' },
      ensembleMsg('m2', 'boss', WALL, { role: 'user' })
    ])
    expect(evaluateBossQuotaSoftUnavailable(chat, ROUND, BOSS)).toBe(false)
  })

  it('is false with no round id or no Boss', () => {
    const chat = chatWith([ensembleMsg('m1', 'boss', WALL)])
    expect(evaluateBossQuotaSoftUnavailable(chat, undefined, BOSS)).toBe(false)
    expect(evaluateBossQuotaSoftUnavailable(chat, ROUND, null)).toBe(false)
  })

  it('bossOwnTerminalContent returns only the Boss own latest terminal text', () => {
    const chat = chatWith([
      ensembleMsg('m1', 'boss', 'first'),
      ensembleMsg('m2', 'peer', 'peer text'),
      ensembleMsg('m3', 'boss', 'second')
    ])
    expect(bossOwnTerminalContent(chat, ROUND, 'boss')).toBe('second')
    expect(bossOwnTerminalContent(chat, ROUND, 'nobody')).toBeUndefined()
  })
})
