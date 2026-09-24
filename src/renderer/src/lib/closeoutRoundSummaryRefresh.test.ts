import { describe, expect, it } from 'vitest'
import type { ChatRecord, EnsembleRoundState } from '../../../main/store/types'

import { roundSummaryRefreshKeyForCloseout } from './closeoutRoundSummaryRefresh'

function chat(status: EnsembleRoundState['status'] = 'completed'): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'Chat',
    chatKind: 'ensemble',
    archived: false,
    messages: [],
    runs: [],
    createdAt: 1,
    updatedAt: 1,
    ensemble: {
      enabled: true,
      maxParticipants: 1,
      participants: [],
      activeRound: {
        roundId: 'round-1',
        status,
        prompt: 'work',
        startedAt: '2026-08-20T00:00:00.000Z',
        participants: []
      }
    }
  } as ChatRecord
}

describe('roundSummaryRefreshKeyForCloseout', () => {
  it('changes when a canonical summary arrives after terminal closeout creation', () => {
    const before = chat()
    const after = chat()
    after.ensemble = {
      ...after.ensemble!,
      roundSummaries: {
        'round-1': {
          roundId: 'round-1',
          participantId: 'p1',
          provider: 'codex',
          summary: 'Canonical result.',
          capturedAt: '2026-08-20T00:10:01.000Z'
        }
      }
    }

    expect(roundSummaryRefreshKeyForCloseout(after)).not.toBe(
      roundSummaryRefreshKeyForCloseout(before)
    )
    expect(roundSummaryRefreshKeyForCloseout(after)).toContain('Canonical result.')
  })

  it('ignores non-terminal and solo chats', () => {
    expect(roundSummaryRefreshKeyForCloseout(chat('running'))).toBe('')
    expect(roundSummaryRefreshKeyForCloseout({ ...chat(), chatKind: 'single' })).toBe('')
  })
})
