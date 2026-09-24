import { describe, expect, it } from 'vitest'
import type { ConcurrentLane, EnsembleRoundState } from '../../../main/store/types'
import { deriveEnsembleParticipantChipStatus } from './ensembleParticipantChipStatus'

function lane(
  status: ConcurrentLane['status'],
  patch: Partial<ConcurrentLane> = {}
): ConcurrentLane {
  return {
    laneId: `lane-${status}`,
    participantId: 'advisor',
    provider: 'codex',
    status,
    intent: 'read',
    startedAt: '2026-08-16T16:00:00.000Z',
    ...patch
  }
}

function round(patch: Partial<EnsembleRoundState> = {}): EnsembleRoundState {
  return {
    roundId: 'round-1',
    status: 'running',
    prompt: 'Investigate the issue.',
    startedAt: '2026-08-16T16:00:00.000Z',
    participants: [
      {
        participantId: 'advisor',
        provider: 'codex',
        role: 'Advisor',
        order: 1,
        status: 'running'
      }
    ],
    ...patch
  }
}

describe('deriveEnsembleParticipantChipStatus', () => {
  // The composer's first render of any ensemble chat uses the thread-catalogue
  // summary row: `ThreadCatalogueChrome` projects `activeRound` down to a
  // scalar whitelist and drops its `participants`, and `catalogueChatListItem`
  // spreads that chrome onto a `ChatListItem` that `extends ChatRecord`.
  // Hydration only replaces it after paint, so this runs on every open.
  it('falls back to idle on a catalogue summary round with no participants', () => {
    const projectedRound = {
      roundId: 'round-1',
      status: 'running',
      startedAt: '2026-08-16T16:00:00.000Z',
      activeParticipantId: 'advisor'
    } as unknown as EnsembleRoundState

    const speaking = deriveEnsembleParticipantChipStatus(projectedRound, 'advisor')
    expect(speaking.statusLabel).toBe('speaking')
    expect(speaking.participantState).toBeUndefined()

    const other = deriveEnsembleParticipantChipStatus(projectedRound, 'reviewer')
    expect(other.statusLabel).toBe('idle')
    expect(other.active).toBe(false)
  })

  it('keeps a serial speaker live when its earlier fan-out lane completed', () => {
    const projection = deriveEnsembleParticipantChipStatus(
      round({
        activeParticipantId: 'advisor',
        lanes: { completed: lane('completed') }
      }),
      'advisor'
    )

    expect(projection).toMatchObject({
      active: true,
      lane: undefined,
      laneFailureSuperseded: false,
      statusLabel: 'speaking'
    })
  })

  it('keeps a completed lane visible when the participant is not the serial speaker', () => {
    const projection = deriveEnsembleParticipantChipStatus(
      round({
        activeParticipantId: 'somebody-else',
        participants: [
          {
            participantId: 'advisor',
            provider: 'codex',
            role: 'Advisor',
            order: 1,
            status: 'answered'
          }
        ],
        lanes: { completed: lane('completed') }
      }),
      'advisor'
    )

    expect(projection).toMatchObject({ active: false, statusLabel: 'answered' })
    expect(projection.lane?.status).toBe('completed')
  })

  it('uses the newest live lane rather than an older pending attempt', () => {
    const projection = deriveEnsembleParticipantChipStatus(
      round({
        activeParticipantId: undefined,
        lanes: {
          pending: lane('pending', { laneId: 'lane-pending' }),
          running: lane('running', {
            laneId: 'lane-running',
            startedAt: '2026-08-16T16:01:00.000Z'
          })
        }
      }),
      'advisor'
    )

    expect(projection).toMatchObject({ active: true, statusLabel: 'speaking' })
    expect(projection.lane?.laneId).toBe('lane-running')
  })

  it('falls back to cleared participant state for a superseded lane failure', () => {
    const projection = deriveEnsembleParticipantChipStatus(
      round({
        status: 'completed',
        participants: [
          {
            participantId: 'advisor',
            provider: 'codex',
            role: 'Advisor',
            order: 1,
            status: 'idle'
          }
        ],
        lanes: {
          failed: lane('failed', {
            failureSupersededBySeatChangeAt: '2026-08-16T16:02:00.000Z'
          })
        }
      }),
      'advisor'
    )

    expect(projection).toMatchObject({
      active: false,
      laneFailureSuperseded: true,
      statusLabel: 'idle'
    })
  })
})
