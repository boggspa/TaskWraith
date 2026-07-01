import { describe, expect, it } from 'vitest'
import type { EnsembleRoundState } from '../main/store/types'
import { isEnsembleRoundDispatchLive } from './ensembleRoundLifecycle'

function makeRound(patch: Partial<EnsembleRoundState> = {}): EnsembleRoundState {
  return {
    roundId: 'round-1',
    status: 'running',
    prompt: 'go',
    startedAt: '2026-07-01T00:00:00.000Z',
    participants: [
      {
        participantId: 'p1',
        provider: 'codex',
        role: 'Worker',
        order: 0,
        status: 'running'
      }
    ],
    ...patch
  }
}

describe('isEnsembleRoundDispatchLive', () => {
  it('does not treat a missing active participant as live by itself', () => {
    expect(
      isEnsembleRoundDispatchLive(
        makeRound({
          activeParticipantId: 'missing-seat',
          participants: [
            {
              participantId: 'p1',
              provider: 'codex',
              role: 'Worker',
              order: 0,
              status: 'answered',
              endedAt: '2026-07-01T00:01:00.000Z'
            }
          ]
        })
      )
    ).toBe(false)
  })

  it('does not treat an empty running snapshot as live without other evidence', () => {
    expect(
      isEnsembleRoundDispatchLive(
        makeRound({
          activeParticipantId: 'missing-seat',
          participants: []
        })
      )
    ).toBe(false)
  })

  it('still treats pending wakeups as live even when no participant is active', () => {
    expect(
      isEnsembleRoundDispatchLive(
        makeRound({
          activeParticipantId: 'missing-seat',
          participants: [],
          pendingWakeupIds: ['wakeup-1']
        })
      )
    ).toBe(true)
  })
})
