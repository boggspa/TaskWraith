import { describe, expect, it } from 'vitest'
import type { EnsembleRoundState } from '../main/store/types'
import {
  ensembleTurnTransitionLabel,
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

describe('ensembleTurnTransitionLabel', () => {
  const base = {
    runtimeInstanceId: 'runtime-1',
    sourceParticipantId: 'p1',
    sourceRunId: 'run-1',
    startedAt: '2026-07-01T00:01:00.000Z'
  } as const

  it('names the seat being handed to when one is known', () => {
    expect(
      ensembleTurnTransitionLabel({ ...base, phase: 'handoff', targetParticipantId: 'p2' }, 'Reviewer')
    ).toBe('Handing off to Reviewer')
  })

  it('falls back to a generic handoff when the target has no usable role', () => {
    expect(ensembleTurnTransitionLabel({ ...base, phase: 'handoff' }, undefined)).toBe(
      'Preparing next turn'
    )
    // A whitespace-only role is not a name — the desktop trims before deciding.
    expect(ensembleTurnTransitionLabel({ ...base, phase: 'handoff' }, '   ')).toBe(
      'Preparing next turn'
    )
  })

  it('reports the provider settling interval as finalizing', () => {
    expect(
      ensembleTurnTransitionLabel({ ...base, phase: 'settling-provider' }, 'Reviewer')
    ).toBe('Finalizing turn')
  })

  it('says nothing when there is no transition', () => {
    expect(ensembleTurnTransitionLabel(undefined, 'Reviewer')).toBeUndefined()
  })
})
