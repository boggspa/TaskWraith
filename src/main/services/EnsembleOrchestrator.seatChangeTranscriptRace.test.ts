import { describe, expect, it, vi } from 'vitest'
import { EnsembleOrchestrator } from './EnsembleOrchestrator'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type {
  AppSettings,
  ChatMessage,
  ChatRecord,
  EnsembleParticipant,
  EnsembleRoundState
} from '../store/types'

function participant(
  id: string,
  provider: EnsembleParticipant['provider'],
  role: string,
  order: number,
  stageRole?: EnsembleParticipant['stageRole']
): EnsembleParticipant {
  return {
    id,
    provider,
    enabled: true,
    role,
    instructions: `${role}.`,
    order,
    model: `${provider}-model`,
    permissionPresetId: 'read_only',
    ...(stageRole ? { stageRole } : {})
  }
}

function runningRound(participants: EnsembleParticipant[]): EnsembleRoundState {
  return {
    roundId: 'round-scout-race',
    status: 'running',
    prompt: 'Scout the tree.',
    startedAt: '2026-08-06T19:00:00.000Z',
    participants: participants.map((seat) => ({
      participantId: seat.id,
      provider: seat.provider,
      role: seat.role,
      order: seat.order,
      status: 'idle' as const,
      ...(seat.stageRole ? { stageRole: seat.stageRole } : {})
    }))
  }
}

function dispatchStatus(): ChatMessage {
  return {
    id: 'dispatch-automatic-read',
    role: 'system',
    content:
      'Automatic read stage · 4 participant(s) dispatched concurrently (read-clamped lanes).',
    timestamp: '2026-08-06T19:00:01.000Z',
    metadata: {
      kind: 'ensembleRoundStatus',
      ensembleRoundId: 'round-scout-race',
      ensembleFanoutWaveId: 'dispatch-automatic-read',
      ensembleFanoutCategory: 'orchestrated'
    }
  }
}

function scoutLaneMessage(
  id: string,
  participantId: string,
  provider: EnsembleParticipant['provider']
): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: `SCOUT_LANE_MARKER_${id}`,
    timestamp: '2026-08-06T19:00:02.000Z',
    runId: `run-${id}`,
    metadata: {
      kind: 'ensembleParticipant',
      ensembleRoundId: 'round-scout-race',
      ensembleParticipantId: participantId,
      ensembleLaneId: `lane-${id}`,
      ensembleLaneIntent: 'read',
      ensembleProvider: provider,
      ensembleRole: participantId,
      ensembleStageRole: 'scout',
      ensembleStatus: 'answered',
      ensembleModel: `${provider}-model`
    }
  }
}

function makeSettings(): AppSettings {
  return {
    storeLocalChatHistory: true,
    storeRawEvents: false,
    ensembleModeEnabled: true,
    chatContextTurns: 8
  } as unknown as AppSettings
}

function makeHarness(participants: EnsembleParticipant[]) {
  let chat: ChatRecord = {
    appChatId: 'ensemble-chat',
    chatKind: 'ensemble',
    scope: 'workspace',
    provider: 'claude',
    title: 'Seat change vs scout flush race',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [dispatchStatus()],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: participants.length,
      participants,
      activeRound: runningRound(participants)
    }
  }
  let counter = 0
  const orchestrator = new EnsembleOrchestrator({
    getChat: () => chat,
    saveChat: (next) => {
      chat = next
    },
    getSettings: makeSettings,
    dispatch: vi.fn(async (payload: AgentRunPayload) => ({
      dispatched: true,
      appRunId: payload.appRunId || ''
    })),
    cancelRun: vi.fn(async () => true),
    createRunId: (provider) => `${provider}-run-${++counter}`,
    now: () => 1000 + counter,
    nowIso: () => `2026-08-06T19:01:0${counter}.000Z`
  })
  return {
    get chat() {
      return chat
    },
    set chat(next: ChatRecord) {
      chat = next
    },
    orchestrator
  }
}

describe('seat change vs concurrent scout-lane transcript flush', () => {
  it('keeps fan-out lane cards when a seat change was handed a stale pre-flush chat snapshot', () => {
    const seats = [
      participant('k27', 'kimi', 'K2.7Scout', 1, 'scout'),
      participant('cursor', 'cursor', 'CursorScout', 2, 'scout'),
      participant('mistral', 'mistral', 'MistralReview', 3, 'scout'),
      participant('agy', 'gemini', 'DSeekScout', 4, 'scout'),
      participant('worker', 'claude', 'Worker', 5, 'worker')
    ]
    const harness = makeHarness(seats)
    const staleSnapshot = JSON.parse(JSON.stringify(harness.chat)) as ChatRecord
    const lane = scoutLaneMessage('scout-a', 'k27', 'kimi')
    harness.chat = {
      ...harness.chat,
      messages: [...harness.chat.messages, lane],
      updatedAt: harness.chat.updatedAt + 1
    }

    const before = seats[4]!
    const after = { ...before, stageRole: 'reviewer' as const }
    harness.orchestrator['applyParticipantSeatChangeToChat']({
      chat: staleSnapshot,
      before,
      after,
      changedBy: 'user',
      reason: 'Stage role change on a non-fanout seat while scouts flush.',
      boundary: false,
      updateActiveRound: false
    })

    expect(harness.chat.messages.map((message) => message.id)).toContain('scout-a')
    expect(
      harness.chat.messages.some((message) =>
        message.content?.includes('SCOUT_LANE_MARKER_scout-a')
      )
    ).toBe(true)
    expect(
      harness.chat.ensemble?.participants.find((seat) => seat.id === 'worker')?.stageRole
    ).toBe('reviewer')
  })

  it('rebases onto the in-flight flush overlay so a mid-flush seat change cannot drop sibling lanes', () => {
    const seats = [
      participant('k27', 'kimi', 'K2.7Scout', 1, 'scout'),
      participant('worker', 'claude', 'Worker', 2, 'worker')
    ]
    const harness = makeHarness(seats)
    const staleSnapshot = JSON.parse(JSON.stringify(harness.chat)) as ChatRecord
    const overlayChat: ChatRecord = {
      ...harness.chat,
      messages: [...harness.chat.messages, scoutLaneMessage('scout-overlay', 'k27', 'kimi')]
    }
    harness.orchestrator['flushChatOverlay'] = {
      chatId: 'ensemble-chat',
      chat: overlayChat
    }

    const before = seats[1]!
    const after = { ...before, role: 'Builder' }
    harness.orchestrator['applyParticipantSeatChangeToChat']({
      chat: staleSnapshot,
      before,
      after,
      changedBy: 'user',
      reason: 'Rename while multi-lane flush overlay is open.',
      boundary: false,
      updateActiveRound: false
    })

    expect(harness.chat.messages.map((message) => message.id)).toContain('scout-overlay')
    expect(harness.orchestrator['flushChatOverlay']?.chat.messages.map((m) => m.id)).toContain(
      'scout-overlay'
    )
    expect(harness.chat.ensemble?.participants.find((seat) => seat.id === 'worker')?.role).toBe(
      'Builder'
    )
  })
})
