import { describe, expect, it } from 'vitest'
import {
  canReviewMemoryProposal,
  filterMemoryProposals,
  formatMemoryProposalConfidence,
  memoryProposalKindLabel,
  memoryProposalStatusLabel
} from './memoryProposalDisplay'
import type { MemoryProposal } from '../../../main/store/types'

function proposal(over: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    id: 'p1',
    kind: 'preference',
    scope: 'user',
    status: 'proposed',
    title: 'Concise summaries',
    lesson: 'User prefers concise final summaries after edits.',
    confidence: 0.82,
    evidenceRefs: [],
    dedupKey: 'preference:concise',
    requiresReview: true,
    createdAt: '2026-07-05T12:00:00.000Z',
    updatedAt: '2026-07-05T12:00:00.000Z',
    ...over
  }
}

describe('memoryProposalDisplay', () => {
  it('labels kinds and formats confidence', () => {
    expect(memoryProposalKindLabel('skill_patch')).toBe('Skill patch')
    expect(formatMemoryProposalConfidence(0.826)).toBe('83%')
  })

  it('detects reviewable proposals', () => {
    expect(canReviewMemoryProposal(proposal())).toBe(true)
    expect(canReviewMemoryProposal(proposal({ status: 'approved' }))).toBe(false)
    expect(canReviewMemoryProposal(proposal({ requiresReview: false }))).toBe(false)
  })

  it('filters proposals by kind, scope, status, and search', () => {
    const items = [
      proposal({ id: 'a', kind: 'preference' }),
      proposal({ id: 'b', kind: 'bug', scope: 'bug', status: 'rejected', title: 'Regression' })
    ]
    const filtered = filterMemoryProposals(items, {
      kinds: new Set(['bug']),
      scopes: new Set(['bug']),
      statuses: new Set(['rejected']),
      search: 'regression'
    })
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.id).toBe('b')
    expect(memoryProposalStatusLabel('rejected')).toBe('Rejected')
  })
})