import { describe, expect, it } from 'vitest'
import {
  reconcileEnsembleTerminalUsage,
  statsFromEnsembleWorkingUsage
} from './EnsembleTerminalUsage'
import type { ChatRecord } from './store/types'

function makeChat(): ChatRecord {
  return {
    appChatId: 'chat-1',
    chatKind: 'ensemble',
    scope: 'workspace',
    provider: 'claude',
    title: 'Usage test',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [
      {
        runId: 'run-1',
        provider: 'claude',
        startedAt: '2026-08-15T18:00:00.000Z',
        endedAt: '2026-08-15T18:01:00.000Z',
        status: 'success',
        ensembleParticipantId: 'seat-1',
        stats: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          _taskwraith_token_count_confidence: 'estimated'
        }
      }
    ],
    ensemble: {
      enabled: true,
      maxParticipants: 1,
      participants: [
        {
          id: 'seat-1',
          provider: 'claude',
          enabled: true,
          role: 'Reviewer',
          instructions: 'Review.',
          order: 1,
          permissionPresetId: 'read_only',
          tokenTotals: {
            input_tokens: 1_100,
            output_tokens: 220,
            total_tokens: 1_320,
            duration_ms: 5_000
          }
        }
      ]
    }
  }
}

describe('EnsembleTerminalUsage', () => {
  it('turns the live snapshot into estimated durable stats when appropriate', () => {
    expect(
      statsFromEnsembleWorkingUsage({
        inputTokens: 100.9,
        outputTokens: 20.8,
        totalTokens: 125.7,
        estimated: true
      })
    ).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 125,
      _taskwraith_token_count_confidence: 'estimated'
    })
  })

  it('replaces provisional stats and corrects already-applied totals by delta', () => {
    const result = reconcileEnsembleTerminalUsage({
      chat: makeChat(),
      runId: 'run-1',
      participantId: 'seat-1',
      provider: 'claude',
      terminalStats: {
        input_tokens: 130,
        output_tokens: 25,
        total_tokens: 155,
        duration_ms: 2_000,
        total_cost_usd: 0.42
      },
      previousTotalsApplied: true,
      nowMs: 2
    })

    expect(result?.chat.runs[0].stats).toEqual({
      input_tokens: 130,
      output_tokens: 25,
      total_tokens: 155,
      duration_ms: 2_000,
      total_cost_usd: 0.42
    })
    expect(result?.chat.ensemble?.participants[0].tokenTotals).toEqual({
      input_tokens: 1_130,
      output_tokens: 225,
      total_tokens: 1_355,
      duration_ms: 7_000
    })
    expect(
      reconcileEnsembleTerminalUsage({
        chat: result!.chat,
        runId: 'run-1',
        participantId: 'seat-1',
        provider: 'claude',
        terminalStats: result!.stats,
        previousTotalsApplied: true,
        nowMs: 3
      })
    ).toBeNull()
  })

  it('applies the full terminal amount when held fan-out totals were not sealed yet', () => {
    const chat = makeChat()
    chat.ensemble!.participants[0].tokenTotals = undefined
    const result = reconcileEnsembleTerminalUsage({
      chat,
      runId: 'run-1',
      participantId: 'seat-1',
      provider: 'claude',
      terminalStats: { input_tokens: 130, output_tokens: 25, total_tokens: 155 },
      previousTotalsApplied: false,
      nowMs: 2
    })

    expect(result?.chat.ensemble?.participants[0].tokenTotals).toEqual({
      input_tokens: 130,
      output_tokens: 25,
      total_tokens: 155
    })
  })
})
