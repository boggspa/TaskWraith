import { describe, expect, it } from 'vitest'
import type { ContinuationDraftProposal } from '../../../main/store/types'
import { deriveComposerSuggestion, type ComposerSuggestionContext } from './composerSuggestion'

function proposal(id: string, text: string): ContinuationDraftProposal {
  return {
    id,
    text,
    intentKind: 'verify',
    evidenceIds: ['e0', 'e2'],
    qualityScore: 0.9,
    explanation: 'Grounded in user request and failed validation.'
  }
}

function context(overrides: Partial<ComposerSuggestionContext> = {}): ComposerSuggestionContext {
  return {
    draft: '',
    busy: false,
    proposals: [proposal('p1', 'Can you fix the focused validation failure?')],
    dismissedIds: new Set(),
    ...overrides
  }
}

describe('deriveComposerSuggestion', () => {
  it('shows only a main-validated semantic proposal', () => {
    expect(deriveComposerSuggestion(context())).toMatchObject({
      id: 'p1',
      trigger: 'semantic-continuation',
      text: 'Can you fix the focused validation failure?'
    })
  })

  it('suppresses proposals while busy or after the user types', () => {
    expect(deriveComposerSuggestion(context({ busy: true }))).toBeNull()
    expect(deriveComposerSuggestion(context({ draft: 'my own request' }))).toBeNull()
  })

  it('advances through generated proposals as ids are dismissed', () => {
    const proposals = [
      proposal('p1', 'Can you fix the focused validation failure?'),
      proposal('p2', 'Can you review the remaining validation risk?')
    ]
    expect(
      deriveComposerSuggestion(context({ proposals, dismissedIds: new Set(['p1']) }))?.id
    ).toBe('p2')
    expect(
      deriveComposerSuggestion(context({ proposals, dismissedIds: new Set(['p1', 'p2']) }))
    ).toBeNull()
  })

  it('has no deterministic commit, retry-model, lane, or raw-goal fallback', () => {
    expect(deriveComposerSuggestion(context({ proposals: [] }))).toBeNull()
  })
})
