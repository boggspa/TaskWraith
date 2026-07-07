import { describe, expect, it } from 'vitest'
import type { ChatRecord, EnsembleRoundState } from '../../../main/store/types'
import {
  isEnsembleParticipantSeatRuntimeLocked,
  resolveEnsembleParticipantSeatMutationState
} from './ensembleParticipantSeatLock'

type EnsembleRound = NonNullable<NonNullable<ChatRecord['ensemble']>['activeRound']>

function round(patch: Partial<EnsembleRoundState> = {}): EnsembleRound {
  return {
    roundId: 'round-1',
    status: 'running',
    prompt: 'go',
    startedAt: '2026-07-01T00:00:00.000Z',
    activeParticipantId: 'p1',
    participants: [
      {
        participantId: 'p1',
        provider: 'codex',
        role: 'Builder',
        order: 0,
        status: 'running'
      },
      {
        participantId: 'p2',
        provider: 'claude',
        role: 'Reviewer',
        order: 1,
        status: 'idle'
      }
    ],
    ...patch
  }
}

describe('isEnsembleParticipantSeatRuntimeLocked', () => {
  it('locks the active participant seat during a live round', () => {
    expect(isEnsembleParticipantSeatRuntimeLocked(round(), 'p1')).toBe(true)
  })

  it('keeps non-active participant seats editable during a live round', () => {
    expect(isEnsembleParticipantSeatRuntimeLocked(round(), 'p2')).toBe(false)
  })

  it('locks seats that are running in participant state even without activeParticipantId', () => {
    expect(
      isEnsembleParticipantSeatRuntimeLocked(
        round({
          activeParticipantId: undefined,
          participants: [
            { ...round().participants[0], participantId: 'p1', status: 'answered' },
            { ...round().participants[1], participantId: 'p2', status: 'running' }
          ]
        }),
        'p2'
      )
    ).toBe(true)
  })

  it('locks seats with live concurrent lanes', () => {
    expect(
      isEnsembleParticipantSeatRuntimeLocked(
        round({
          activeParticipantId: undefined,
          participants: [
            { ...round().participants[0], participantId: 'p1', status: 'answered' },
            { ...round().participants[1], participantId: 'p2', status: 'idle' }
          ],
          lanes: {
            'lane-p2': {
              laneId: 'lane-p2',
              participantId: 'p2',
              provider: 'claude',
              status: 'awaiting-approval',
              intent: 'write',
              startedAt: '2026-07-01T00:00:01.000Z'
            }
          }
        }),
        'p2'
      )
    ).toBe(true)
  })

  it('does not lock terminal lane snapshots or completed rounds', () => {
    expect(
      isEnsembleParticipantSeatRuntimeLocked(
        round({
          activeParticipantId: undefined,
          participants: [
            { ...round().participants[0], participantId: 'p1', status: 'answered' },
            { ...round().participants[1], participantId: 'p2', status: 'idle' }
          ],
          lanes: {
            'lane-p2': {
              laneId: 'lane-p2',
              participantId: 'p2',
              provider: 'claude',
              status: 'completed',
              intent: 'read',
              startedAt: '2026-07-01T00:00:01.000Z',
              endedAt: '2026-07-01T00:00:02.000Z'
            }
          }
        }),
        'p2'
      )
    ).toBe(false)
    expect(
      isEnsembleParticipantSeatRuntimeLocked(round({ status: 'completed' }), 'p1')
    ).toBe(false)
  })
})

describe('resolveEnsembleParticipantSeatMutationState', () => {
  it('marks active runtime seats as queued-at-turn-end mutations', () => {
    expect(resolveEnsembleParticipantSeatMutationState(round(), 'p1')).toEqual({
      locked: true,
      queueAtTurnEnd: true,
      message:
        'This seat is executing. Provider/model changes apply next round; other seat edits queue until turn end.'
    })
  })

  it('keeps idle seats immediately mutable', () => {
    expect(resolveEnsembleParticipantSeatMutationState(round(), 'p2')).toEqual({
      locked: false,
      queueAtTurnEnd: false,
      message: null
    })
  })
})
