import { describe, expect, it, vi } from 'vitest'
import { EnsembleOrchestrator } from './EnsembleOrchestrator'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type {
  AppSettings,
  ChatRecord,
  EnsembleParticipant,
  EnsembleRoundState
} from '../store/types'

function participant(
  id: string,
  provider: EnsembleParticipant['provider'],
  role: string,
  order: number
): EnsembleParticipant {
  return {
    id,
    provider,
    enabled: true,
    role,
    instructions: `${role}.`,
    order,
    model: `${provider}-model`,
    permissionPresetId: 'read_only'
  }
}

/** A finished round whose Gemini seat failed — the stale-flag scenario. */
function staleFailedRound(): EnsembleRoundState {
  return {
    roundId: 'round-1',
    status: 'completed',
    prompt: 'Investigate.',
    startedAt: '2026-08-05T00:00:00.000Z',
    endedAt: '2026-08-05T00:05:00.000Z',
    participants: [
      {
        participantId: 'gemini',
        provider: 'gemini',
        role: 'GemProW',
        order: 1,
        status: 'failed',
        reason: 'Provider exited with code 1.',
        lastFailureReason: 'Provider exited with code 1.'
      },
      {
        participantId: 'claude',
        provider: 'claude',
        role: 'Reviewer',
        order: 2,
        status: 'answered'
      }
    ],
    lanes: {
      'lane-round-1-gemini-1': {
        laneId: 'lane-round-1-gemini-1',
        participantId: 'gemini',
        provider: 'gemini',
        status: 'failed',
        intent: 'read',
        startedAt: '2026-08-05T00:01:00.000Z',
        reason: 'Lane dispatch failed.'
      }
    }
  }
}

function makeChat(participants: EnsembleParticipant[]): ChatRecord {
  return {
    appChatId: 'ensemble-chat',
    chatKind: 'ensemble',
    scope: 'workspace',
    provider: 'claude',
    title: 'Seat change clears stale failure',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: participants.length,
      participants,
      activeRound: staleFailedRound()
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
  let chat = makeChat(participants)
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
    now: () => counter,
    nowIso: () => `2026-08-05T02:00:0${counter}.000Z`
  })
  return {
    get chat() {
      return chat
    },
    orchestrator
  }
}

describe('authoritative seat change clears a stale participant failure', () => {
  it('resets the failed round state and stamps the failed lane on a model change', async () => {
    const harness = makeHarness([
      participant('gemini', 'gemini', 'GemProW', 1),
      participant('claude', 'claude', 'Reviewer', 2)
    ])

    const result = await harness.orchestrator.requestParticipantSeatChange({
      chatId: 'ensemble-chat',
      participantId: 'gemini',
      participant: { model: 'gemini-3-flash' },
      changedBy: 'user',
      reason: 'Model switch after a failed turn.'
    })
    expect(result).toMatchObject({ ok: true, status: 'applied' })

    const geminiState = harness.chat.ensemble?.activeRound?.participants.find(
      (state) => state.participantId === 'gemini'
    )
    // Post-round, the finished round record keeps its historical display
    // fields (state.model stays what the round ran with; per-turn truth is
    // ChatRun.ensembleSeatSnapshot) — only the stale failure marker clears.
    // Live-round boundary applies additionally sync the display fields via
    // applyRosterEditToActiveRound.
    expect(geminiState?.status).toBe('idle')
    expect(geminiState?.reason).toBeUndefined()
    expect(geminiState?.lastFailureReason).toBeUndefined()
    // The roster seat itself carries the new model.
    expect(
      harness.chat.ensemble?.participants.find((seat) => seat.id === 'gemini')?.model
    ).toBe('gemini-3-flash')
    // Bystander state untouched.
    expect(
      harness.chat.ensemble?.activeRound?.participants.find(
        (state) => state.participantId === 'claude'
      )?.status
    ).toBe('answered')
    // The lane keeps its factual failed status but is marked superseded so
    // the chip strip stops painting it.
    expect(harness.chat.ensemble?.activeRound?.lanes?.['lane-round-1-gemini-1']).toMatchObject({
      status: 'failed',
      failureSupersededBySeatChangeAt: expect.stringMatching(/^2026-/)
    })
  })

  it('leaves the failure standing for identity-only edits (role rename)', async () => {
    const harness = makeHarness([
      participant('gemini', 'gemini', 'GemProW', 1),
      participant('claude', 'claude', 'Reviewer', 2)
    ])

    const result = await harness.orchestrator.requestParticipantSeatChange({
      chatId: 'ensemble-chat',
      participantId: 'gemini',
      participant: { role: 'GemPro Worker' },
      changedBy: 'user',
      reason: 'Rename only.'
    })
    expect(result).toMatchObject({ ok: true })

    const geminiState = harness.chat.ensemble?.activeRound?.participants.find(
      (state) => state.participantId === 'gemini'
    )
    expect(geminiState?.status).toBe('failed')
    expect(geminiState?.lastFailureReason).toBe('Provider exited with code 1.')
    expect(
      harness.chat.ensemble?.activeRound?.lanes?.['lane-round-1-gemini-1']
        ?.failureSupersededBySeatChangeAt
    ).toBeUndefined()
  })
})
