import { describe, expect, it } from 'vitest'
import type { ChatRecord, EnsembleParticipant, ProviderId } from '../../../main/store/types'
import {
  deriveActiveEnsembleWorkingPresentation,
  deriveActiveEnsembleWorkingPresentations
} from './workingIndicatorPresentation'

function participant(patch: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: 'codex-builder',
    provider: 'codex',
    enabled: true,
    role: 'Builder',
    instructions: '',
    order: 0,
    model: 'gpt-5.5',
    reasoningEffort: 'xhigh',
    ...patch
  }
}

function ensembleChat(
  participants: EnsembleParticipant[],
  activeParticipantId = participants[0]?.id
): ChatRecord {
  return {
    appChatId: 'ensemble-chat',
    title: 'Ensemble chat',
    chatKind: 'ensemble',
    provider: 'codex',
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: participants.length,
      participants,
      activeRound: {
        roundId: 'round-1',
        status: 'running',
        prompt: 'go',
        startedAt: '2026-07-01T00:00:00.000Z',
        activeParticipantId,
        participants: participants.map((item) => ({
          participantId: item.id,
          provider: item.provider,
          role: item.role,
          order: item.order,
          status: item.id === activeParticipantId ? 'running' : 'idle'
        }))
      }
    }
  } as ChatRecord
}

describe('deriveActiveEnsembleWorkingPresentation', () => {
  it('includes the active participant role and model reasoning badge', () => {
    expect(deriveActiveEnsembleWorkingPresentation(ensembleChat([participant()]))).toEqual({
      providerLabel: 'Codex',
      provider: 'codex',
      providerClass: 'codex',
      roleLabel: 'Builder',
      modelBadge: '5.5 Extra High'
    })
  })

  it('applies Ollama upstream brand label and hue class from the participant model', () => {
    expect(
      deriveActiveEnsembleWorkingPresentation(
        ensembleChat([
          participant({
            id: 'local-scout',
            provider: 'ollama',
            role: 'Scout',
            model: 'qwen3.5:9b'
          })
        ])
      )
    ).toEqual({
      providerLabel: 'Alibaba',
      provider: 'ollama',
      providerClass: 'alibaba',
      roleLabel: 'Scout',
      modelBadge: 'Qwen 3.5 (9B Param)'
    })
  })

  it('falls back to the live lane participant when activeParticipantId is not set', () => {
    const chat = ensembleChat([
      participant({ id: 'claude-planner', provider: 'claude', role: 'Planner' }),
      participant({ id: 'codex-builder', provider: 'codex', role: 'Builder' })
    ])
    chat.ensemble!.activeRound!.activeParticipantId = undefined
    chat.ensemble!.activeRound!.lanes = {
      lane1: {
        laneId: 'lane1',
        participantId: 'claude-planner',
        provider: 'claude',
        status: 'awaiting-approval',
        intent: 'write',
        startedAt: '2026-07-01T00:00:01.000Z'
      }
    }

    expect(deriveActiveEnsembleWorkingPresentation(chat)).toMatchObject({
      providerLabel: 'Claude',
      providerClass: 'claude',
      roleLabel: 'Planner'
    })
  })

  it('returns all live concurrent fan-out participants in roster order', () => {
    const chat = ensembleChat([
      participant({ id: 'codex-builder', provider: 'codex', role: 'Builder', order: 2 }),
      participant({ id: 'claude-planner', provider: 'claude', role: 'Planner', order: 1 }),
      participant({ id: 'kimi-reviewer', provider: 'kimi', role: 'Reviewer', order: 3 })
    ])
    chat.ensemble!.activeRound!.concurrentMode = true
    chat.ensemble!.activeRound!.fanoutPolicy = 'read_only'
    chat.ensemble!.activeRound!.lanes = {
      lane1: {
        laneId: 'lane1',
        participantId: 'codex-builder',
        provider: 'codex',
        status: 'running',
        intent: 'read',
        startedAt: '2026-07-01T00:00:01.000Z'
      },
      lane2: {
        laneId: 'lane2',
        participantId: 'claude-planner',
        provider: 'claude',
        status: 'pending',
        intent: 'read',
        startedAt: '2026-07-01T00:00:02.000Z'
      },
      lane3: {
        laneId: 'lane3',
        participantId: 'kimi-reviewer',
        provider: 'kimi',
        status: 'completed',
        intent: 'read',
        startedAt: '2026-07-01T00:00:03.000Z',
        endedAt: '2026-07-01T00:00:04.000Z'
      },
      lane4: {
        laneId: 'lane4',
        participantId: 'codex-builder',
        provider: 'codex',
        status: 'awaiting-approval',
        intent: 'read',
        startedAt: '2026-07-01T00:00:05.000Z'
      }
    }

    expect(deriveActiveEnsembleWorkingPresentations(chat).map((item) => item.roleLabel)).toEqual([
      'Planner',
      'Builder'
    ])
  })

  it('does not return a stacked participant list for serial rounds', () => {
    const chat = ensembleChat([participant()])
    chat.ensemble!.activeRound!.lanes = {
      lane1: {
        laneId: 'lane1',
        participantId: 'codex-builder',
        provider: 'codex',
        status: 'running',
        intent: 'read',
        startedAt: '2026-07-01T00:00:01.000Z'
      }
    }

    expect(deriveActiveEnsembleWorkingPresentations(chat)).toEqual([])
  })

  it('returns null for non-ensemble chats', () => {
    expect(
      deriveActiveEnsembleWorkingPresentation({
        appChatId: 'solo',
        title: 'Solo',
        chatKind: 'single',
        provider: 'codex' as ProviderId,
        createdAt: 0,
        updatedAt: 0,
        archived: false,
        messages: [],
        runs: []
      })
    ).toBeNull()
  })
})
