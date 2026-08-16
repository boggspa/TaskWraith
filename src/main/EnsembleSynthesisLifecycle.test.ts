import { describe, expect, it } from 'vitest'
import type { EnsembleParticipant, EnsembleRoundParticipantState, ProviderId } from './store/types'
import {
  electRoundSynthesizer,
  resolveRoundSynthesisStatus,
  roundRequiresSynthesis
} from './EnsembleSynthesisLifecycle'

function participant(id: string, order: number, overrides: Partial<EnsembleParticipant> = {}) {
  return {
    id,
    provider: 'codex' as ProviderId,
    enabled: true,
    role: id,
    instructions: '',
    order,
    ...overrides
  }
}

function state(
  participantId: string,
  status: EnsembleRoundParticipantState['status']
): EnsembleRoundParticipantState {
  return {
    participantId,
    provider: 'codex',
    role: participantId,
    order: 0,
    status
  }
}

describe('electRoundSynthesizer', () => {
  const participants = [participant('worker', 1), participant('reviewer', 2)]

  it('keeps an eligible configured foreground synthesizer', () => {
    expect(electRoundSynthesizer({ participants, configuredParticipantId: 'worker' })).toEqual({
      participantId: 'worker',
      source: 'configured'
    })
  })

  it('prefers the Boss, then the first eligible Captain', () => {
    expect(
      electRoundSynthesizer({
        participants,
        bossmanParticipantId: 'reviewer',
        captainParticipantIds: ['worker']
      })
    ).toEqual({ participantId: 'reviewer', source: 'boss' })
    expect(
      electRoundSynthesizer({
        participants,
        bossmanParticipantId: 'missing',
        captainParticipantIds: ['missing', 'worker']
      })
    ).toEqual({ participantId: 'worker', source: 'captain' })
  })

  it('falls back to the last foreground seat and never elects a background seat', () => {
    expect(
      electRoundSynthesizer({
        participants: [...participants, participant('background', 3, { stageRole: 'background' })],
        configuredParticipantId: 'background'
      })
    ).toEqual({ participantId: 'reviewer', source: 'roster-fallback' })
  })

  it('does not elect an owner for a single-seat round', () => {
    expect(electRoundSynthesizer({ participants: [participants[0]] })).toBeUndefined()
  })
})

describe('round synthesis state', () => {
  it('requires synthesis only when at least two participants answered or yielded', () => {
    expect(roundRequiresSynthesis([state('a', 'answered'), state('b', 'yielded')])).toBe(true)
    expect(roundRequiresSynthesis([state('a', 'answered'), state('b', 'failed')])).toBe(false)
  })

  it('treats a structured summary as the only proof of completed convergence', () => {
    const participants = [state('a', 'answered'), state('b', 'answered')]
    expect(resolveRoundSynthesisStatus({ participants, hasStructuredSummary: true })).toBe(
      'completed'
    )
    expect(resolveRoundSynthesisStatus({ participants, hasStructuredSummary: false })).toBe(
      'unresolved'
    )
    expect(
      resolveRoundSynthesisStatus({
        participants: [state('a', 'answered'), state('b', 'failed')],
        hasStructuredSummary: false
      })
    ).toBe('not-required')
  })
})
