import { describe, expect, it } from 'vitest'
import {
  dedupeMemoryProposals,
  defaultScopeForKind,
  normalizeIntrospectionEvidenceItem,
  normalizeMemoryProposal,
  proposalRequiresReview
} from './IntrospectionModel'
import type { IntrospectionEvidenceItem, MemoryProposal } from '../store/types'

function evidence(over: Partial<IntrospectionEvidenceItem> = {}): IntrospectionEvidenceItem {
  return {
    id: 'ev-1',
    source: 'run_event',
    signal: 'tool_failure',
    chatId: 'chat-1',
    runId: 'run-1',
    timestamp: '2026-07-05T12:00:00.000Z',
    summary: 'write_file denied by locked writer lane',
    ...over
  }
}

function proposal(id: string, over: Partial<MemoryProposal> = {}): MemoryProposal {
  const kind = over.kind ?? 'failure_mode'
  return {
    id,
    kind,
    scope: over.scope ?? defaultScopeForKind(kind),
    status: 'proposed',
    title: `Title ${id}`,
    lesson: `Lesson ${id}`,
    confidence: 0.7,
    evidenceRefs: [
      {
        chatId: 'chat-1',
        runId: 'run-1',
        timestamp: '2026-07-05T12:00:00.000Z',
        summary: 'evidence'
      }
    ],
    dedupKey: over.dedupKey ?? `key-${id}`,
    requiresReview: true,
    createdAt: '2026-07-05T12:00:00.000Z',
    updatedAt: '2026-07-05T12:00:00.000Z',
    ...over
  }
}

describe('IntrospectionModel', () => {
  it('normalizes evidence items with required fields', () => {
    const normalized = normalizeIntrospectionEvidenceItem(evidence())
    expect(normalized?.signal).toBe('tool_failure')
    expect(normalized?.chatId).toBe('chat-1')
  })

  it('rejects proposals without evidence refs', () => {
    expect(
      normalizeMemoryProposal({
        id: 'p1',
        kind: 'preference',
        title: 't',
        lesson: 'l',
        dedupKey: 'k',
        evidenceRefs: []
      })
    ).toBeNull()
  })

  it('defaults scope from kind', () => {
    expect(defaultScopeForKind('preference')).toBe('user')
    expect(defaultScopeForKind('skill_patch')).toBe('skill')
    expect(defaultScopeForKind('repo_convention')).toBe('workspace')
  })

  it('requires review for skill_patch and low-confidence preferences', () => {
    expect(proposalRequiresReview('skill_patch', 0.99)).toBe(true)
    expect(proposalRequiresReview('bug', 0.99)).toBe(true)
    expect(proposalRequiresReview('preference', 0.6)).toBe(true)
    expect(proposalRequiresReview('preference', 0.9)).toBe(false)
  })

  it('dedupes proposals by dedupKey with max confidence and union evidence', () => {
    const a = proposal('a', {
      dedupKey: 'K',
      confidence: 0.5,
      evidenceRefs: [
        { chatId: 'c1', timestamp: 't1', summary: 'one' }
      ]
    })
    const b = proposal('b', {
      dedupKey: 'K',
      confidence: 0.9,
      evidenceRefs: [
        { chatId: 'c1', runId: 'r2', timestamp: 't2', summary: 'two' }
      ]
    })
    const [merged] = dedupeMemoryProposals([a, b])
    expect(merged.id).toBe('a')
    expect(merged.confidence).toBe(0.9)
    expect(merged.evidenceRefs).toHaveLength(2)
  })
})