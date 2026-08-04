import { describe, expect, it } from 'vitest'
import {
  configuredEnsembleCaptainParticipantIds,
  isEnsembleAuthorityParticipantAvailable,
  resolveActingCaptainParticipantId
} from './EnsembleAuthorityResolution'

const participants = [
  { id: 'boss', order: 1, enabled: true },
  { id: 'captain-a', order: 2, enabled: true },
  { id: 'captain-b', order: 3, enabled: true },
  { id: 'captain-c', order: 4, enabled: true }
]

describe('EnsembleAuthorityResolution', () => {
  it('canonicalizes configured Captains independently from acting availability', () => {
    expect(
      configuredEnsembleCaptainParticipantIds({
        participants,
        bossmanParticipantId: 'boss',
        captainParticipantIds: ['captain-c', 'captain-a', 'captain-b']
      })
    ).toEqual(['captain-a', 'captain-b', 'captain-c'])
  })

  it('selects one acting Captain after skipping unavailable seats in roster order', () => {
    expect(
      resolveActingCaptainParticipantId({
        participants,
        bossmanParticipantId: 'boss',
        captainParticipantIds: ['captain-a', 'captain-b', 'captain-c'],
        unavailableParticipantIds: new Set(['captain-a']),
        roundLive: true,
        roundParticipantStates: [
          { participantId: 'captain-a', status: 'answered' },
          { participantId: 'captain-b', status: 'failed' },
          { participantId: 'captain-c', status: 'idle' }
        ]
      })
    ).toBe('captain-c')
  })

  it('does not treat a configured but disabled Captain as acting authority', () => {
    expect(
      resolveActingCaptainParticipantId({
        participants: participants.map((participant) =>
          participant.id === 'captain-a' ? { ...participant, enabled: false } : participant
        ),
        bossmanParticipantId: 'boss',
        captainParticipantIds: ['captain-a', 'captain-b']
      })
    ).toBe('captain-b')
  })

  it('requires a live-round state row when round availability is authoritative', () => {
    expect(
      isEnsembleAuthorityParticipantAvailable(
        {
          participants,
          captainParticipantIds: ['captain-a'],
          roundLive: true,
          roundParticipantStates: []
        },
        'captain-a'
      )
    ).toBe(false)
  })

  it('returns no acting Captain when every configured seat is unavailable', () => {
    expect(
      resolveActingCaptainParticipantId({
        participants,
        captainParticipantIds: ['captain-a', 'captain-b'],
        unavailableParticipantIds: ['captain-a', 'captain-b']
      })
    ).toBeUndefined()
  })

  it('reads the legacy scalar when the canonical array is absent', () => {
    expect(
      resolveActingCaptainParticipantId({
        participants,
        bossmanParticipantId: 'boss',
        secondInCommandParticipantId: 'captain-b'
      })
    ).toBe('captain-b')
  })
})
