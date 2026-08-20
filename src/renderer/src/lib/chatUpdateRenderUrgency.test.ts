import { describe, expect, it } from 'vitest'
import type { ChatRecord, EnsembleRoundState } from '../../../main/store/types'

import {
  CHAT_UPDATE_MAX_RENDER_LATENCY_MS,
  shouldFlushChatUpdateImmediately
} from './chatUpdateRenderUrgency'

function chat(status: EnsembleRoundState['status'], chatKind: ChatRecord['chatKind'] = 'ensemble') {
  return {
    appChatId: 'chat-1',
    title: 'Chat',
    chatKind,
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

describe('chat update render urgency', () => {
  it('defines a bounded fallback below the existing save debounce', () => {
    expect(CHAT_UPDATE_MAX_RENDER_LATENCY_MS).toBeGreaterThan(0)
    expect(CHAT_UPDATE_MAX_RENDER_LATENCY_MS).toBeLessThan(200)
  })

  it.each(['completed', 'cancelled', 'failed'] as const)(
    'immediately flushes a %s Ensemble round',
    (status) => {
      expect(shouldFlushChatUpdateImmediately(chat(status))).toBe(true)
    }
  )

  it('leaves running rounds and solo chats on the coalesced cadence', () => {
    expect(shouldFlushChatUpdateImmediately(chat('running'))).toBe(false)
    expect(shouldFlushChatUpdateImmediately(chat('completed', 'single'))).toBe(false)
  })
})
