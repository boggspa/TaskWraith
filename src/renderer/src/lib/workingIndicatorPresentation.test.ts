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
          model: item.model,
          reasoningEffort: item.reasoningEffort,
          fastModeEnabled: item.fastModeEnabled,
          thinkingEnabled: item.thinkingEnabled,
          serviceTier: item.serviceTier,
          status: item.id === activeParticipantId ? 'running' : 'idle'
        }))
      }
    }
  } as ChatRecord
}

describe('deriveActiveEnsembleWorkingPresentation', () => {
  it('includes the active participant role and model reasoning badge', () => {
    expect(deriveActiveEnsembleWorkingPresentation(ensembleChat([participant()]))).toEqual({
      participantId: 'codex-builder',
      runId: null,
      startedAt: '2026-07-01T00:00:00.000Z',
      tokenAccumulatorBase: 0,
      providerLabel: 'Codex',
      provider: 'codex',
      providerClass: 'codex',
      roleLabel: 'Builder',
      modelBadge: '5.5 Extra High',
      activity: 'working'
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
      participantId: 'local-scout',
      runId: null,
      startedAt: '2026-07-01T00:00:00.000Z',
      tokenAccumulatorBase: 0,
      providerLabel: 'Alibaba',
      provider: 'ollama',
      providerClass: 'alibaba',
      roleLabel: 'Scout',
      modelBadge: 'Qwen 3.5 (9B Param)',
      activity: 'working'
    })
  })

  it('prefers the frozen round participant display over a next-round roster edit', () => {
    const chat = ensembleChat([participant({ role: 'WriteSwift' })])
    chat.ensemble!.participants = chat.ensemble!.participants.map((item) =>
      item.id === 'codex-builder'
        ? {
            ...item,
            provider: 'claude',
            model: 'claude-fable-5-low',
            reasoningEffort: 'low',
            role: 'WriteSwift'
          }
        : item
    )

    expect(deriveActiveEnsembleWorkingPresentation(chat)).toEqual({
      participantId: 'codex-builder',
      runId: null,
      startedAt: '2026-07-01T00:00:00.000Z',
      tokenAccumulatorBase: 0,
      providerLabel: 'Codex',
      provider: 'codex',
      providerClass: 'codex',
      roleLabel: 'WriteSwift',
      modelBadge: '5.5 Extra High',
      activity: 'working'
    })
  })

  it('marks the active participant as compacting while its context compaction is live', () => {
    const chat = ensembleChat([participant()])

    expect(
      deriveActiveEnsembleWorkingPresentation(chat, [
        {
          chatId: 'ensemble-chat',
          participantId: 'codex-builder',
          provider: 'codex',
          status: 'started'
        }
      ])
    ).toMatchObject({
      roleLabel: 'Builder',
      activity: 'compacting'
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

  it('uses each live fan-out lane turn anchor and participant accumulator', () => {
    const chat = ensembleChat([
      participant({
        id: 'claude-planner',
        provider: 'claude',
        role: 'Planner',
        order: 1,
        tokenTotals: { total_tokens: 28_500 }
      }),
      participant({
        id: 'codex-builder',
        provider: 'codex',
        role: 'Builder',
        order: 2,
        tokenTotals: { total_tokens: 14_000 }
      })
    ])
    chat.ensemble!.activeRound!.concurrentMode = true
    chat.ensemble!.activeRound!.fanoutPolicy = 'read_only'
    chat.ensemble!.activeRound!.lanes = {
      planner: {
        laneId: 'planner',
        participantId: 'claude-planner',
        runId: 'claude-live',
        provider: 'claude',
        status: 'running',
        intent: 'read',
        startedAt: '2026-07-01T00:04:00.000Z'
      },
      builder: {
        laneId: 'builder',
        participantId: 'codex-builder',
        runId: 'codex-live',
        provider: 'codex',
        status: 'running',
        intent: 'read',
        startedAt: '2026-07-01T00:05:00.000Z'
      }
    }

    expect(
      deriveActiveEnsembleWorkingPresentations(chat).map((item) => ({
        participantId: item.participantId,
        runId: item.runId,
        startedAt: item.startedAt,
        tokenAccumulatorBase: item.tokenAccumulatorBase
      }))
    ).toEqual([
      {
        participantId: 'claude-planner',
        runId: 'claude-live',
        startedAt: '2026-07-01T00:04:00.000Z',
        tokenAccumulatorBase: 28_500
      },
      {
        participantId: 'codex-builder',
        runId: 'codex-live',
        startedAt: '2026-07-01T00:05:00.000Z',
        tokenAccumulatorBase: 14_000
      }
    ])
  })

  it('marks only the compacting fan-out participant during concurrent work', () => {
    const chat = ensembleChat([
      participant({ id: 'codex-builder', provider: 'codex', role: 'Builder', order: 2 }),
      participant({ id: 'claude-planner', provider: 'claude', role: 'Planner', order: 1 })
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
        status: 'running',
        intent: 'read',
        startedAt: '2026-07-01T00:00:02.000Z'
      }
    }

    expect(
      deriveActiveEnsembleWorkingPresentations(chat, [
        {
          chatId: 'ensemble-chat',
          participantId: 'claude-planner',
          provider: 'claude',
          status: 'started'
        }
      ]).map((item) => ({ role: item.roleLabel, activity: item.activity }))
    ).toEqual([
      { role: 'Planner', activity: 'compacting' },
      { role: 'Builder', activity: 'working' }
    ])
  })

  it('shows a compacting participant during background seat maintenance', () => {
    const chat = ensembleChat(
      [
        participant({ id: 'cursor-writer', provider: 'cursor', role: 'Writer', order: 1 }),
        participant({ id: 'grok-reviewer', provider: 'grok', role: 'Reviewer', order: 2 })
      ],
      'cursor-writer'
    )
    chat.ensemble!.activeRound!.status = 'completed'
    chat.ensemble!.activeRound!.participants = chat.ensemble!.activeRound!.participants.map(
      (item) => ({ ...item, status: 'answered' })
    )

    expect(
      deriveActiveEnsembleWorkingPresentations(chat, [
        {
          chatId: 'ensemble-chat',
          participantId: 'grok-reviewer',
          provider: 'grok',
          status: 'started'
        }
      ]).map((item) => ({
        provider: item.provider,
        role: item.roleLabel,
        activity: item.activity
      }))
    ).toEqual([{ provider: 'grok', role: 'Reviewer', activity: 'compacting' }])
  })

  it('keeps the serial active participant visible while another seat compacts', () => {
    const chat = ensembleChat(
      [
        participant({ id: 'codex-builder', provider: 'codex', role: 'Builder', order: 1 }),
        participant({ id: 'kimi-reviewer', provider: 'kimi', role: 'Reviewer', order: 2 })
      ],
      'codex-builder'
    )

    expect(
      deriveActiveEnsembleWorkingPresentations(chat, [
        {
          chatId: 'ensemble-chat',
          participantId: 'kimi-reviewer',
          provider: 'kimi',
          status: 'started'
        }
      ]).map((item) => ({ role: item.roleLabel, activity: item.activity }))
    ).toEqual([
      { role: 'Builder', activity: 'working' },
      { role: 'Reviewer', activity: 'compacting' }
    ])
  })

  it('keeps the active non-lane participant visible during fan-out', () => {
    const chat = ensembleChat(
      [
        participant({ id: 'boss-captain', provider: 'claude', role: 'Captain', order: 0 }),
        participant({ id: 'swift-worker', provider: 'cursor', role: 'WriteSwift', order: 1 }),
        participant({ id: 'main-worker', provider: 'claude', role: 'WriteMain', order: 2 })
      ],
      'boss-captain'
    )
    chat.ensemble!.activeRound!.concurrentMode = true
    chat.ensemble!.activeRound!.fanoutPolicy = 'read_only'
    chat.ensemble!.activeRound!.lanes = {
      lane1: {
        laneId: 'lane1',
        participantId: 'main-worker',
        provider: 'claude',
        status: 'running',
        intent: 'read',
        startedAt: '2026-07-01T00:00:01.000Z'
      },
      lane2: {
        laneId: 'lane2',
        participantId: 'swift-worker',
        provider: 'cursor',
        status: 'pending',
        intent: 'read',
        startedAt: '2026-07-01T00:00:02.000Z'
      }
    }

    expect(deriveActiveEnsembleWorkingPresentations(chat).map((item) => item.roleLabel)).toEqual([
      'Captain',
      'WriteSwift',
      'WriteMain'
    ])
  })

  it('drops a stale active participant after it yielded during fan-out', () => {
    const chat = ensembleChat(
      [
        participant({ id: 'boss-captain', provider: 'claude', role: 'Captain', order: 0 }),
        participant({ id: 'swift-worker', provider: 'cursor', role: 'WriteSwift', order: 1 })
      ],
      'boss-captain'
    )
    chat.ensemble!.activeRound!.concurrentMode = true
    chat.ensemble!.activeRound!.fanoutPolicy = 'read_only'
    chat.ensemble!.activeRound!.participants = chat.ensemble!.activeRound!.participants.map(
      (item) =>
        item.participantId === 'boss-captain'
          ? { ...item, status: 'yielded', endedAt: '2026-07-01T00:00:03.000Z' }
          : item
    )
    chat.ensemble!.activeRound!.lanes = {
      lane1: {
        laneId: 'lane1',
        participantId: 'swift-worker',
        provider: 'cursor',
        status: 'running',
        intent: 'read',
        startedAt: '2026-07-01T00:00:01.000Z'
      }
    }

    expect(deriveActiveEnsembleWorkingPresentations(chat).map((item) => item.roleLabel)).toEqual([
      'WriteSwift'
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
