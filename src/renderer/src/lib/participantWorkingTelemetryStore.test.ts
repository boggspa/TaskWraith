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
      estimated: false
    })

    expect(firstRunNotifications).toBe(0)
    expect(secondRunNotifications).toBe(1)
    expect(participantWorkingTokenSnapshot('run-a')).toBeNull()
    expect(participantWorkingTokenSnapshot('run-b')).toMatchObject({
      totalTokens: 124_000
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
})
