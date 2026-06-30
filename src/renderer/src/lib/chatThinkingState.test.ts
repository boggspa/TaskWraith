import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import { chatHasInFlightThinkingWork } from './chatThinkingState'

const baseChat = (patch: Partial<ChatRecord> = {}): ChatRecord =>
  ({
    appChatId: 'chat-1',
    provider: 'codex',
    messages: [],
    ...patch
  }) as ChatRecord

describe('chatHasInFlightThinkingWork', () => {
  it('returns true when the chat id is in runningChatIds', () => {
    expect(
      chatHasInFlightThinkingWork({
        chat: baseChat(),
        runningChatIds: new Set(['chat-1'])
      })
    ).toBe(true)
  })

  it('returns true for an ensemble chat with a running activeRound', () => {
    expect(
      chatHasInFlightThinkingWork({
        chat: baseChat({
          chatKind: 'ensemble',
          ensemble: {
            enabled: true,
            maxParticipants: 6,
            participants: [],
            activeRound: {
              roundId: 'round-1',
              status: 'running',
              prompt: 'go',
              startedAt: '2026-06-09T00:00:00.000Z',
              participants: []
            },
            updatedAt: '2026-06-09T00:00:00.000Z'
          }
        }),
        runningChatIds: new Set()
      })
    ).toBe(true)
  })

  it('returns false when the ensemble round has finished', () => {
    expect(
      chatHasInFlightThinkingWork({
        chat: baseChat({
          chatKind: 'ensemble',
          ensemble: {
            enabled: true,
            maxParticipants: 6,
            participants: [],
            activeRound: {
              roundId: 'round-1',
              status: 'completed',
              prompt: 'go',
              startedAt: '2026-06-09T00:00:00.000Z',
              endedAt: '2026-06-09T00:01:00.000Z',
              participants: []
            },
            updatedAt: '2026-06-09T00:01:00.000Z'
          }
        }),
        runningChatIds: new Set()
      })
    ).toBe(false)
  })

  it('returns false for a stale running ensemble round with no live participants', () => {
    expect(
      chatHasInFlightThinkingWork({
        chat: baseChat({
          chatKind: 'ensemble',
          ensemble: {
            enabled: true,
            maxParticipants: 6,
            participants: [],
            activeRound: {
              roundId: 'round-1',
              status: 'running',
              prompt: 'go',
              startedAt: '2026-06-09T00:00:00.000Z',
              participants: [
                {
                  participantId: 'p1',
                  provider: 'codex',
                  role: 'Worker',
                  order: 0,
                  status: 'answered',
                  endedAt: '2026-06-09T00:01:00.000Z'
                }
              ]
            },
            updatedAt: '2026-06-09T00:01:00.000Z'
          }
        }),
        runningChatIds: new Set()
      })
    ).toBe(false)
  })
})
