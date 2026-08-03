import { describe, expect, it, vi } from 'vitest'
import { AppStore } from './store'
import type { ChatRecord, EnsembleParticipant } from './store/types'

vi.mock('electron', () => ({
  app: {
    getPath: () => `/tmp/taskwraith-ensemble-authority-${process.pid}`
  }
}))

function participant(
  id: string,
  order: number,
  options: { enabled?: boolean; stageRole?: 'background' } = {}
): EnsembleParticipant {
  return {
    id,
    provider: 'codex',
    enabled: options.enabled ?? true,
    role: id,
    instructions: id,
    order,
    ...(options.stageRole ? { stageRole: options.stageRole } : {})
  }
}

function ensembleChat(ensemble: ChatRecord['ensemble']): ChatRecord {
  return {
    appChatId: 'ensemble-authority-chat',
    chatKind: 'ensemble',
    provider: 'codex',
    title: 'Authority',
    scope: 'global',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ensemble
  }
}

describe('AppStore Ensemble authority normalization', () => {
  it('recovers exactly one configured Boss and promotes the legacy Captain scalar', () => {
    const chat = AppStore.normalizeChatRecord(
      ensembleChat({
        enabled: true,
        maxParticipants: 4,
        participants: [
          participant('background', 1, { stageRole: 'background' }),
          participant('recovered-boss', 2, { enabled: false }),
          participant('legacy-captain', 3)
        ],
        bossmanParticipantId: 'missing',
        secondInCommandParticipantId: 'legacy-captain'
      })
    )

    expect(chat.ensemble).toMatchObject({
      bossmanParticipantId: 'recovered-boss',
      captainParticipantIds: ['legacy-captain'],
      secondInCommandParticipantId: 'legacy-captain'
    })
  })

  it('keeps plural Captains canonical and normalizes the active-round snapshot', () => {
    const roster = [
      participant('boss', 1),
      participant('captain-a', 2),
      participant('captain-b', 3),
      participant('captain-c', 4),
      participant('captain-d', 5)
    ]
    const chat = AppStore.normalizeChatRecord(
      ensembleChat({
        enabled: true,
        maxParticipants: 5,
        participants: roster,
        bossmanParticipantId: 'boss',
        captainParticipantIds: ['captain-d', 'captain-b', 'captain-a', 'captain-c'],
        secondInCommandParticipantId: 'captain-d',
        activeRound: {
          roundId: 'round-1',
          status: 'running',
          prompt: 'Work',
          startedAt: '2026-08-03T00:00:00.000Z',
          bossmanParticipantId: 'missing',
          captainParticipantIds: ['captain-c', 'captain-b'],
          secondInCommandParticipantId: 'captain-a',
          participants: roster.map((entry) => ({
            participantId: entry.id,
            provider: entry.provider,
            role: entry.role,
            order: entry.order,
            status: 'idle'
          }))
        }
      })
    )

    expect(chat.ensemble).toMatchObject({
      bossmanParticipantId: 'boss',
      captainParticipantIds: ['captain-a', 'captain-b', 'captain-c'],
      secondInCommandParticipantId: 'captain-a'
    })
    expect(chat.ensemble?.activeRound).toMatchObject({
      bossmanParticipantId: 'boss',
      captainParticipantIds: ['captain-b', 'captain-c'],
      secondInCommandParticipantId: 'captain-b'
    })
  })
})
