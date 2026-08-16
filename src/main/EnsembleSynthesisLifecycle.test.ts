import { describe, expect, it } from 'vitest'
import type { EnsembleParticipant, EnsembleRoundParticipantState, ProviderId } from './store/types'
import {
  buildFinalSynthesisPrompt,
  electRoundSynthesizer,
  resolveRoundSynthesisStatus,
  roundRequiresSynthesis,
  shouldAttemptFinalSynthesis
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

  it('plans one final synthesis turn only for an unresolved Continuous mission round', () => {
    const round = {
      roundId: 'round-1',
      status: 'running' as const,
      prompt: 'Ship it.',
      startedAt: '2026-08-16T00:00:00.000Z',
      orchestrationMode: 'continuous' as const,
      synthesizerParticipantId: 'a',
      synthesisStatus: 'pending' as const,
      participants: [state('a', 'answered'), state('b', 'answered')]
    }
    const base = {
      round,
      hasStructuredSummary: false,
      attemptedInRuntime: false,
      missionWasActiveAtStart: true,
      cancelled: false,
      returnedControlToUser: false,
      queuedPromptCount: 0
    }

    expect(shouldAttemptFinalSynthesis(base)).toBe(true)
    expect(shouldAttemptFinalSynthesis({ ...base, hasStructuredSummary: true })).toBe(false)
    expect(shouldAttemptFinalSynthesis({ ...base, attemptedInRuntime: true })).toBe(false)
    expect(shouldAttemptFinalSynthesis({ ...base, missionWasActiveAtStart: false })).toBe(false)
    expect(shouldAttemptFinalSynthesis({ ...base, queuedPromptCount: 1 })).toBe(false)
    expect(
      shouldAttemptFinalSynthesis({
        ...base,
        round: { ...round, synthesisAttemptedAt: '2026-08-16T00:01:00.000Z' }
      })
    ).toBe(false)
  })

  it('builds a qualitative bounded close-out prompt with the required receipt labels', () => {
    const prompt = buildFinalSynthesisPrompt('Fix the mission orchestration.')
    expect(prompt).toContain('one bounded close-out turn')
    expect(prompt).toContain('do not start new implementation work')
    expect(prompt).toContain('Original user request:\nFix the mission orchestration.')
    for (const label of [
      'Round summary:',
      'Decisions:',
      'Corrections:',
      'Open risks:',
      'Next action:'
    ]) {
      expect(prompt).toContain(label)
    }
  })
})
