import { describe, expect, it } from 'vitest'
import {
  buildMemoryProposalPackInput,
  classifyEvidenceSignal,
  generateProposalsFromEvidence,
  proposalFromEvidenceItem
} from './IntrospectionProposalGenerator'
import type { IntrospectionEvidenceItem } from '../store/types'

function evidence(
  signal: string,
  over: Partial<IntrospectionEvidenceItem> = {}
): IntrospectionEvidenceItem {
  return {
    id: `ev-${signal}`,
    source: 'run_event',
    signal,
    chatId: 'chat-1',
    runId: 'run-1',
    provider: 'cursor',
    timestamp: '2026-07-05T12:00:00.000Z',
    summary: `summary for ${signal}`,
    ...over
  }
}

describe('IntrospectionProposalGenerator', () => {
  it('classifies known signals', () => {
    expect(classifyEvidenceSignal('approval_denied')?.kind).toBe('failure_mode')
    expect(classifyEvidenceSignal('tool_loop')?.kind).toBe('do_not_repeat')
    expect(classifyEvidenceSignal('feedback_down')?.kind).toBe('preference')
    expect(classifyEvidenceSignal('unknown_signal')).toBeNull()
  })

  it('generates proposals with review gates for skill_patch', () => {
    const item = evidence('skill_candidate', {
      detail: 'User prefers scoped Prettier, not repo-wide format.'
    })
    const proposal = proposalFromEvidenceItem(item, {
      nowIso: '2026-07-05T12:00:00.000Z',
      idFactory: () => 'proposal-1'
    })
    expect(proposal?.kind).toBe('skill_patch')
    expect(proposal?.requiresReview).toBe(true)
    expect(proposal?.lesson).toContain('scoped Prettier')
    expect(proposal?.skillPatchDiff).toBeTruthy()
    const parsed = JSON.parse(String(proposal?.skillPatchDiff)) as {
      skillId: string
      body: string
      skillScope: string
    }
    expect(parsed.skillId).toBe('intro-proposal-1')
    expect(parsed.body).toContain('scoped Prettier')
    expect(parsed.skillScope).toBe('user')
  })

  it('dedupes repeated signals across evidence items', () => {
    const items = [
      evidence('tool_failure'),
      evidence('tool_failure', { id: 'ev-2', runId: 'run-2' })
    ]
    const proposals = generateProposalsFromEvidence(items, { minConfidence: 0.5 })
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.evidenceRefs.length).toBeGreaterThanOrEqual(1)
  })

  it('routes approval friction without provider to workspace scope', () => {
    const proposal = proposalFromEvidenceItem(
      evidence('approval_denied', { provider: undefined }),
      { nowIso: '2026-07-05T12:00:00.000Z', idFactory: () => 'proposal-approval' }
    )
    expect(proposal?.scope).toBe('workspace')
    expect(proposal?.providerId).toBeUndefined()
  })

  it('routes provider-specific errors to provider scope', () => {
    const proposal = proposalFromEvidenceItem(
      evidence('provider_error', { provider: 'cursor' }),
      { nowIso: '2026-07-05T12:00:00.000Z', idFactory: () => 'proposal-provider' }
    )
    expect(proposal?.scope).toBe('provider')
    expect(proposal?.providerId).toBe('cursor')
  })

  it('builds pack input with evidence count', () => {
    const pack = buildMemoryProposalPackInput({
      introspectionRunId: 'intro-1',
      windowStart: '2026-07-04T00:00:00.000Z',
      windowEnd: '2026-07-05T00:00:00.000Z',
      evidenceItems: [evidence('repo_convention_hint'), evidence('provider_error')],
      summary: 'Daily introspection report'
    })
    expect(pack.evidenceItemCount).toBe(2)
    expect(pack.proposals.length).toBeGreaterThanOrEqual(1)
    expect(pack.summary).toBe('Daily introspection report')
  })
})