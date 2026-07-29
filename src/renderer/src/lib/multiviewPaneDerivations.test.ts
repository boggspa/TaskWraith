import { describe, expect, it } from 'vitest'
import type { ChatRecord, ChatRun, EnsembleRoundState } from '../../../main/store/types'
import {
  cachedPaneContextTelemetry,
  derivePaneContextTelemetry,
  derivePaneLiveOutputTokens
} from './multiviewPaneDerivations'

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    chatKind: 'single',
    messages: [],
    runs: [],
    ...overrides
  } as ChatRecord
}

function run(overrides: Partial<ChatRun> = {}): ChatRun {
  return {
    runId: 'run-1',
    provider: 'claude',
    status: 'running',
    startedAt: '2026-07-19T00:00:00.000Z',
    ...overrides
  } as ChatRun
}

function liveRound(overrides: Partial<EnsembleRoundState> = {}): EnsembleRoundState {
  return {
    roundId: 'round-1',
    status: 'running',
    prompt: 'go',
    startedAt: '2026-07-19T00:00:00.000Z',
    activeParticipantId: 'participant-1',
    participants: [
      {
        participantId: 'participant-1',
        provider: 'claude',
        role: 'Worker',
        order: 0,
        status: 'running'
      }
    ],
    ...overrides
  } as EnsembleRoundState
}

describe('derivePaneLiveOutputTokens', () => {
  it('returns zero for an idle pane without walking historical output into the live meter', () => {
    const source = chat({
      messages: [
        {
          id: 'old',
          role: 'assistant',
          content: 'historical output',
          timestamp: '2026-07-18T23:59:59.000Z'
        }
      ]
    })

    expect(derivePaneLiveOutputTokens(source, { isRunning: false, runId: null })).toBe(0)
  })

  it('counts only unsealed active-run assistant output', () => {
    const source = chat({
      runs: [
        run({ runId: 'done', status: 'success', endedAt: '2026-07-19T00:01:00.000Z' }),
        run({ runId: 'live' })
      ],
      messages: [
        {
          id: 'done-message',
          role: 'assistant',
          runId: 'done',
          content: 'x'.repeat(40),
          timestamp: '2026-07-19T00:00:00.000Z'
        },
        {
          id: 'live-message',
          role: 'assistant',
          runId: 'live',
          content: 'x'.repeat(8),
          timestamp: '2026-07-19T00:00:01.000Z'
        },
        {
          id: 'user-message',
          role: 'user',
          runId: 'live',
          content: 'x'.repeat(40),
          timestamp: '2026-07-19T00:00:02.000Z'
        }
      ]
    })

    expect(derivePaneLiveOutputTokens(source, { isRunning: true, runId: 'live' })).toBe(2)
  })

  it('includes untagged assistant output created after a live ensemble round started', () => {
    const source = chat({
      chatKind: 'ensemble',
      ensemble: {
        enabled: true,
        maxParticipants: 20,
        participants: [],
        activeRound: liveRound()
      },
      messages: [
        {
          id: 'before',
          role: 'assistant',
          content: 'x'.repeat(40),
          timestamp: '2026-07-18T23:59:59.000Z'
        },
        {
          id: 'after',
          role: 'assistant',
          content: 'x'.repeat(8),
          timestamp: '2026-07-19T00:00:01.000Z'
        }
      ]
    })

    expect(derivePaneLiveOutputTokens(source, { isRunning: true, runId: null })).toBe(2)
  })
})

describe('derivePaneContextTelemetry', () => {
  const resolveNoOllamaContext = (): undefined => undefined

  it('adds live output only to a running pane and preserves the solo meter model', () => {
    const source = chat({
      runs: [
        run({
          status: 'success',
          stats: { input_tokens: 1_000, output_tokens: 200, total_tokens: 1_200 }
        })
      ]
    })
    const telemetry = derivePaneContextTelemetry(source, {
      provider: 'claude',
      modelId: 'claude-sonnet-4-6',
      liveOutputTokens: 40,
      isRunning: true,
      resolveOllamaContextLength: resolveNoOllamaContext
    })

    expect(telemetry.meter.solo.usedTokens).toBe(1_240)
    expect(telemetry.meter.solo.usage).toMatchObject({
      contextTokens: 1_240,
      precision: 'derived'
    })
    expect(telemetry.meter.solo.windowTokens).toBe(200_000)
    expect(telemetry.meter.participants).toBeUndefined()
    expect(telemetry.label).toContain('context')
  })

  it('uses the live Ollama context window and caches by chat and dependency identity', () => {
    const source = chat()
    const resolveOllamaContextLength = (): number => 65_536
    const deps = {
      provider: 'ollama' as const,
      modelId: 'custom:latest',
      liveOutputTokens: 0,
      isRunning: false,
      resolveOllamaContextLength
    }

    const first = cachedPaneContextTelemetry(source, deps)
    const second = cachedPaneContextTelemetry(source, deps)
    const changed = cachedPaneContextTelemetry(source, { ...deps, liveOutputTokens: 1 })

    expect(first).toBe(second)
    expect(changed).not.toBe(first)
    expect(first.meter.solo.windowTokens).toBe(65_536)
  })

  it('uses the latest provider-reported token limit like the main context meter', () => {
    const source = chat({
      runs: [
        run({
          status: 'success',
          stats: {
            input_tokens: 40_000,
            output_tokens: 2_000,
            total_tokens: 42_000,
            totalTokenLimit: 1_048_576
          }
        })
      ]
    })

    const telemetry = derivePaneContextTelemetry(source, {
      provider: 'claude',
      modelId: 'claude-sonnet-4-6',
      liveOutputTokens: 0,
      isRunning: false,
      resolveOllamaContextLength: resolveNoOllamaContext
    })

    expect(telemetry.meter.solo.windowTokens).toBe(1_048_576)
    expect(telemetry.usedPercent).toBeCloseTo((42_000 / 1_048_576) * 100)
  })

  it('drives an Ensemble pane donut from its selected participant and denominator', () => {
    const source = chat({
      chatKind: 'ensemble',
      ensemble: {
        enabled: true,
        maxParticipants: 20,
        participants: [
          {
            id: 'participant-1',
            provider: 'claude',
            model: 'claude-sonnet-4-6',
            role: 'Builder',
            instructions: '',
            enabled: true,
            order: 0
          },
          {
            id: 'participant-2',
            provider: 'codex',
            model: 'gpt-5.5',
            role: 'Reviewer',
            instructions: '',
            enabled: true,
            order: 1
          }
        ]
      },
      runs: [
        run({
          runId: 'participant-1-run',
          ensembleParticipantId: 'participant-1',
          stats: { total_tokens: 1_000, totalTokenLimit: 10_000 }
        }),
        run({
          runId: 'participant-2-run',
          provider: 'codex',
          ensembleParticipantId: 'participant-2',
          stats: { total_tokens: 4_000, totalTokenLimit: 20_000 }
        })
      ]
    })

    const telemetry = derivePaneContextTelemetry(source, {
      provider: 'claude',
      modelId: 'claude-sonnet-4-6',
      focusedParticipantId: 'participant-2',
      liveOutputTokens: 0,
      isRunning: false,
      resolveOllamaContextLength: resolveNoOllamaContext
    })

    expect(telemetry.usedPercent).toBe(20)
    expect(telemetry.label).toBe('4k / 20k context')
    expect(telemetry.meter.focusedId).toBe('participant-2')
    expect(telemetry.meter.solo).toMatchObject({
      provider: 'codex',
      modelId: 'gpt-5.5',
      usedTokens: 4_000,
      windowTokens: 20_000
    })
  })
})
