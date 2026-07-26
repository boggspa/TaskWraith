import { describe, expect, it } from 'vitest'
import {
  MIN_LIVE_ENSEMBLE_PARTICIPANTS,
  resolveEnsembleCollapseTarget,
  resolveSoleEnsembleSoloCandidate
} from './ensembleRosterFloor'
import type { ChatRecord, EnsembleParticipant } from '../../../main/store/types'

function seat(overrides: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: 'p1',
    provider: 'codex',
    enabled: true,
    role: 'Primary',
    instructions: '',
    order: 1,
    ...overrides
  }
}

function ensembleChat(
  participants: EnsembleParticipant[],
  overrides: Partial<ChatRecord> = {}
): Pick<ChatRecord, 'chatKind' | 'ensemble' | 'provider'> {
  return {
    chatKind: 'ensemble',
    provider: participants[0]?.provider,
    ensemble: {
      enabled: true,
      maxParticipants: 20,
      orchestrationMode: 'turn_bound',
      maxContinuationHops: 6,
      participants,
      updatedAt: '2026-07-26T00:00:00.000Z'
    },
    ...overrides
  }
}

describe('resolveEnsembleCollapseTarget', () => {
  it('absorbs a removal that leaves the roster at or above the floor', () => {
    const participants = [
      seat({ id: 'p1' }),
      seat({ id: 'p2', provider: 'claude', order: 2 }),
      seat({ id: 'p3', provider: 'kimi', order: 3 })
    ]
    expect(resolveEnsembleCollapseTarget(participants, 'p2')).toBeNull()
    expect(participants).toHaveLength(MIN_LIVE_ENSEMBLE_PARTICIPANTS + 1)
  })

  it('hands the thread to the OTHER seat when the removal would leave one', () => {
    const participants = [seat({ id: 'p1' }), seat({ id: 'p2', provider: 'claude', order: 2 })]
    expect(resolveEnsembleCollapseTarget(participants, 'p1')?.id).toBe('p2')
    expect(resolveEnsembleCollapseTarget(participants, 'p2')?.id).toBe('p1')
  })

  it('keeps the sole seat when the last chip on an exempt roster is removed', () => {
    // Removing the last chip means "no more panel", not "no more agent" — the
    // seat's own provider/model carries over rather than being discarded.
    const participants = [seat({ id: 'only', provider: 'claude' })]
    expect(resolveEnsembleCollapseTarget(participants, 'only')?.id).toBe('only')
  })

  it('ignores a removal id that is not in the roster', () => {
    const participants = [seat({ id: 'p1' }), seat({ id: 'p2', provider: 'claude', order: 2 })]
    expect(resolveEnsembleCollapseTarget(participants, 'gone')).toBeNull()
  })
})

describe('resolveSoleEnsembleSoloCandidate', () => {
  it('resolves the lone seat when it matches the thread provider', () => {
    const sole = seat({ id: 'only', provider: 'claude' })
    expect(resolveSoleEnsembleSoloCandidate(ensembleChat([sole]))?.id).toBe('only')
  })

  it('still asks when a two-seat roster shares one provider', () => {
    // Same provider, different configurations — picking either behind the
    // user's back would silently drop the other's model/reasoning.
    const participants = [
      seat({ id: 'p1', provider: 'claude', model: 'claude-opus-5' }),
      seat({ id: 'p2', provider: 'claude', model: 'claude-sonnet-5', order: 2 })
    ]
    expect(resolveSoleEnsembleSoloCandidate(ensembleChat(participants))).toBeNull()
  })

  it('still asks when the thread provider is not the lone seat provider', () => {
    // The modal offers the chat's own provider too, so there are two answers.
    const chat = ensembleChat([seat({ id: 'only', provider: 'claude' })], { provider: 'codex' })
    expect(resolveSoleEnsembleSoloCandidate(chat)).toBeNull()
  })

  it('ignores a solo chat', () => {
    const chat = ensembleChat([seat({ id: 'only' })], { chatKind: 'single' })
    expect(resolveSoleEnsembleSoloCandidate(chat)).toBeNull()
  })
})
