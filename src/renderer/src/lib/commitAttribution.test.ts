import { describe, expect, it } from 'vitest'
import type { ChatRecord, ChatMessage } from '../../../main/store/types'
import type { SeatChangeLink } from '../../../shared/seatChange'
import {
  collectTaskWraithCommitAttributions,
  resolveTaskWraithCommitAttribution
} from './commitAttribution'

const seatLink: SeatChangeLink = {
  participantId: 'seat-1',
  before: {
    provider: 'codex',
    model: 'gpt-5.6',
    role: 'Work1',
    seatNumber: 4
  },
  after: {
    provider: 'codex',
    model: 'gpt-5.6',
    role: 'Work1',
    seatNumber: 4
  }
}

function chat(messages: ChatMessage[]): ChatRecord {
  return {
    id: 'chat-1',
    appChatId: 'chat-1',
    providerMetadata: {},
    messages
  } as unknown as ChatRecord
}

describe('commitAttribution', () => {
  it('collects durable TaskWraith seat evidence and ignores generic commits', () => {
    const attributions = collectTaskWraithCommitAttributions([
      chat([
        {
          id: 'closeout',
          role: 'assistant',
          content: 'Task complete',
          timestamp: Date.now(),
          metadata: {
            closeoutCommits: [
              { hash: 'abc1234', seatLink, participantId: 'seat-1' },
              { hash: 'def5678' }
            ]
          }
        } as ChatMessage
      ])
    ])

    expect(Array.from(attributions)).toEqual([
      [
        'abc1234',
        {
          hash: 'abc1234',
          seatLink,
          participantId: 'seat-1'
        }
      ]
    ])
  })

  it('resolves abbreviated receipts against a full commit hash', () => {
    const attributions = new Map([
      ['abc1234', { hash: 'abc1234', seatLink }],
      ['abc123456', { hash: 'abc123456', seatLink }]
    ])

    expect(
      resolveTaskWraithCommitAttribution(attributions, 'abc1234567890abcdef1234567890abcdef12345')
        ?.hash
    ).toBe('abc123456')
    expect(
      resolveTaskWraithCommitAttribution(attributions, 'ffffffffffffffffffffffffffffffffffffffff')
    ).toBeNull()
  })
})
