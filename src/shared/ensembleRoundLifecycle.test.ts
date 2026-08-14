import { describe, expect, it } from 'vitest'
import type { EnsembleRoundState } from '../main/store/types'
import {
  isEnsembleRoundDispatchLive,
  isEnsembleRoundPresentationLive
} from './ensembleRoundLifecycle'

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

  it('keeps a between-turn transition visible without inventing participant dispatch evidence', () => {
    const round = makeRound({
      activeParticipantId: undefined,
      participants: [
        {
          participantId: 'p1',
          provider: 'codex',
          role: 'Worker',
          order: 0,
          status: 'answered',
          endedAt: '2026-07-01T00:01:00.000Z'
        }
      ],
      turnTransition: {
        phase: 'settling-provider',
        runtimeInstanceId: 'runtime-1',
        sourceParticipantId: 'p1',
        sourceRunId: 'run-1',
        startedAt: '2026-07-01T00:01:00.000Z'
      }
    })

    expect(isEnsembleRoundDispatchLive(round)).toBe(false)
    expect(isEnsembleRoundPresentationLive(round)).toBe(true)
  })

  it('never lets a transition revive a terminal round', () => {
    const round = makeRound({
      status: 'completed',
      turnTransition: {
        phase: 'handoff',
        runtimeInstanceId: 'runtime-1',
        sourceParticipantId: 'p1',
        sourceRunId: 'run-1',
        targetParticipantId: 'p2',
        startedAt: '2026-07-01T00:01:00.000Z'
      }
    })

    expect(isEnsembleRoundPresentationLive(round)).toBe(false)
  })
})
