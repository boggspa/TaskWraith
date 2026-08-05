import { describe, expect, it } from 'vitest'
import {
  resolveYieldTargetParticipant,
  yieldTargetDisplayLabel,
  type YieldTargetCandidate
} from './ensembleYieldTarget'

const ROSTER: YieldTargetCandidate[] = [
  { id: 'ensemble-participant-1', role: 'Worker', provider: 'codex' },
  { id: 'ensemble-participant-4', role: 'Builder', provider: 'pi' },
  { id: 'ensemble-participant-7', role: 'Captain K', provider: 'kimi' }
]

describe('yieldTargetDisplayLabel', () => {
  it('reads an opaque roster id as the seat it names', () => {
    // The held-fan-out handoff result hands the model
    // `eligibleManagerParticipantIds`, so models yield to the raw id — which
    // routed fine but printed "@ensemble-participant-4" at the user.
    expect(yieldTargetDisplayLabel('ensemble-participant-4', ROSTER)).toBe('Builder')
    expect(yieldTargetDisplayLabel('@ensemble-participant-1', ROSTER)).toBe('Worker')
  })

  it('resolves the compound and mention forms agents actually emit', () => {
    expect(yieldTargetDisplayLabel('Kimi / Captain K', ROSTER)).toBe('Captain K')
    expect(yieldTargetDisplayLabel('@Builder', ROSTER)).toBe('Builder')
    // A bare provider names exactly one seat here, so it reads as that seat.
    expect(yieldTargetDisplayLabel('pi', ROSTER)).toBe('Builder')
  })

  it('normalises a role the model typed in the wrong case', () => {
    expect(yieldTargetDisplayLabel('builder', ROSTER)).toBe('Builder')
  })

  it('keeps the raw target when the roster cannot say who was meant', () => {
    // Two codex seats: routing picks a winner by its own rules, and naming one
    // of them here would show a role the handoff may not have gone to.
    const ambiguous: YieldTargetCandidate[] = [
      { id: 'ensemble-participant-1', role: 'Worker', provider: 'codex' },
      { id: 'ensemble-participant-2', role: 'Reviewer', provider: 'codex' }
    ]
    expect(yieldTargetDisplayLabel('codex', ambiguous)).toBe('codex')
    expect(resolveYieldTargetParticipant('codex', ambiguous)).toBeUndefined()
  })

  it('never invents a label for a target it cannot place', () => {
    expect(yieldTargetDisplayLabel('SomeoneElse', ROSTER)).toBe('SomeoneElse')
    expect(yieldTargetDisplayLabel('Builder', undefined)).toBe('Builder')
    expect(yieldTargetDisplayLabel('Builder', [])).toBe('Builder')
    expect(yieldTargetDisplayLabel('', ROSTER)).toBe('')
    expect(yieldTargetDisplayLabel(undefined, ROSTER)).toBe('')
  })

  it('falls back to the provider for a seat with no role yet', () => {
    const unnamed: YieldTargetCandidate[] = [
      { id: 'ensemble-participant-3', role: '', provider: 'grok' }
    ]
    expect(yieldTargetDisplayLabel('ensemble-participant-3', unnamed)).toBe('grok')
  })
})

describe('resolveYieldTargetParticipant', () => {
  it('returns the seat so callers can tint the chip with its provider', () => {
    expect(resolveYieldTargetParticipant('ensemble-participant-4', ROSTER)?.provider).toBe('pi')
    expect(resolveYieldTargetParticipant('Captain K', ROSTER)?.provider).toBe('kimi')
    expect(resolveYieldTargetParticipant('nobody', ROSTER)).toBeUndefined()
  })
})
