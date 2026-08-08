import { describe, expect, it } from 'vitest'
import {
  canApplyMemoryProposal,
  canReviewMemoryProposal,
  filterMemoryProposals,
  formatApplyMemoryProposalBlocked,
  formatMemoryProposalConfidence,
  memoryProposalApplyHint,
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

  it('detects applyable proposals including approved skill_patch', () => {
    expect(canApplyMemoryProposal(proposal({ status: 'approved', kind: 'repo_convention' }))).toBe(
      true
    )
    expect(canApplyMemoryProposal(proposal({ status: 'approved', kind: 'do_not_repeat' }))).toBe(
      true
    )
    expect(canApplyMemoryProposal(proposal({ status: 'approved', kind: 'skill_patch' }))).toBe(
      true
    )
    expect(canApplyMemoryProposal(proposal({ status: 'proposed', kind: 'repo_convention' }))).toBe(
      false
    )
    expect(canApplyMemoryProposal(proposal({ status: 'approved', kind: 'preference' }))).toBe(
      false
    )
    expect(formatApplyMemoryProposalBlocked('skill_patch_path_escape')).toContain('escape')
  })

  it('renders apply hints by status and kind', () => {
    expect(memoryProposalApplyHint(proposal({ status: 'approved', kind: 'repo_convention' }))).toBe(
      'Approved — ready to apply to repo conventions.'
    )
    expect(memoryProposalApplyHint(proposal({ status: 'approved', kind: 'skill_patch' }))).toBe(
      'Approved — ready to apply to TaskWraith skills.'
    )
    expect(
      memoryProposalApplyHint(
        proposal({
          status: 'applied',
          kind: 'repo_convention',
          applyReceipt: {
            appliedAt: '2026-07-05T20:10:00.000Z',
            target: 'RepoConventionIndex',
            conventionEntryId: 'intro-prop-1',
            packId: 'pack-1',
            proposalId: 'p1'
          }
        })
      )
    ).toContain('intro-prop-1')
    expect(
      memoryProposalApplyHint(
        proposal({
          status: 'applied',
          kind: 'skill_patch',
          applyReceipt: {
            appliedAt: '2026-07-05T20:10:00.000Z',
            target: 'TaskWraithSkill',
            skillId: 'intro-p1',
            skillScope: 'user',
            packId: 'pack-1',
            proposalId: 'p1',
            rollbackSnapshot: { previousBody: null }
          }
        })
      )
    ).toContain('intro-p1')
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