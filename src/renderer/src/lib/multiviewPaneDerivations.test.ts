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
})
