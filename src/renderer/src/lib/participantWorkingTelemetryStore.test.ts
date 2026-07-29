import { afterEach, describe, expect, it } from 'vitest'
import {
  ingestParticipantWorkingTelemetry,
  participantWorkingTokenSnapshot,
  resetParticipantWorkingTelemetryStore,
  subscribeParticipantWorkingTokenSnapshot
} from './participantWorkingTelemetryStore'

afterEach(() => resetParticipantWorkingTelemetryStore())

describe('participantWorkingTelemetryStore', () => {
  it('notifies only the leaf subscribed to the updated run', () => {
    let firstRunNotifications = 0
    let secondRunNotifications = 0
    const stopFirst = subscribeParticipantWorkingTokenSnapshot('run-a', () => {
      firstRunNotifications += 1
    })
    const stopSecond = subscribeParticipantWorkingTokenSnapshot('run-b', () => {
      secondRunNotifications += 1
    })

    ingestParticipantWorkingTelemetry({
      type: 'snapshot',
      chatId: 'chat',
      roundId: 'round',
      participantId: 'participant-b',
      runId: 'run-b',
      startedAt: '2026-07-11T18:00:00.000Z',
      provider: 'claude',
      inputTokens: 120_000,
      outputTokens: 4_000,
      totalTokens: 124_000,
      estimated: false,
      contextUsage: {
        contextTokens: 90_000,
        totalTokens: 90_000,
        inputTokens: 86_000,
        freshInputTokens: 6_000,
        cacheReadInputTokens: 80_000,
        cacheCreationInputTokens: 0,
        outputTokens: 4_000,
        visibleOutputTokens: 1_000,
        reasoningTokens: 3_000,
        toolUsePromptTokens: 0,
        unclassifiedTokens: 0,
        source: 'provider-last-invocation',
        precision: 'exact'
      }
    })

    expect(firstRunNotifications).toBe(0)
    expect(secondRunNotifications).toBe(1)
    expect(participantWorkingTokenSnapshot('run-a')).toBeNull()
    expect(participantWorkingTokenSnapshot('run-b')).toMatchObject({
      totalTokens: 124_000,
      contextUsage: {
        contextTokens: 90_000,
        reasoningTokens: 3_000,
        precision: 'exact'
      }
    })

    ingestParticipantWorkingTelemetry({
      type: 'clear',
      chatId: 'chat',
      roundId: 'round',
      participantId: 'participant-b',
      runId: 'run-b'
    })
    expect(secondRunNotifications).toBe(2)
    expect(participantWorkingTokenSnapshot('run-b')).toBeNull()

    stopFirst()
    stopSecond()
  })

  it('preserves an exact zero context snapshot without relabeling it', () => {
    ingestParticipantWorkingTelemetry({
      type: 'snapshot',
      chatId: 'chat',
      roundId: 'round',
      participantId: 'participant',
      runId: 'run-zero',
      startedAt: '2026-07-11T18:00:00.000Z',
      provider: 'claude',
      inputTokens: 120_000,
      outputTokens: 4_000,
      totalTokens: 124_000,
      estimated: false,
      contextUsage: {
        observedAt: 1,
        contextTokens: 0,
        totalTokens: 0,
        inputTokens: 0,
        freshInputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 0,
        visibleOutputTokens: 0,
        reasoningTokens: 0,
        toolUsePromptTokens: 0,
        unclassifiedTokens: 0,
        source: 'provider-compaction',
        precision: 'exact'
      }
    })

    expect(participantWorkingTokenSnapshot('run-zero')?.contextUsage).toMatchObject({
      observedAt: 1,
      contextTokens: 0,
      source: 'provider-compaction',
      precision: 'exact'
    })
  })
})
