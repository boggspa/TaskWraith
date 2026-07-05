import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MemoryProposalReviewPanel } from './MemoryProposalReviewPanel'
import type { MemoryProposalPack } from '../../../main/store/types'

function makePack(over: Partial<MemoryProposalPack> = {}): MemoryProposalPack {
  return {
    schemaVersion: 1,
    id: 'pack-1',
    introspectionRunId: 'run-1',
    workspaceId: 'ws-1',
    windowStart: '2026-07-04T20:00:00.000Z',
    windowEnd: '2026-07-05T20:00:00.000Z',
    evidenceItemCount: 3,
    summary: 'Daily introspection',
    createdAt: '2026-07-05T20:05:00.000Z',
    updatedAt: '2026-07-05T20:05:00.000Z',
    proposals: [
      {
        id: 'prop-1',
        kind: 'preference',
        scope: 'user',
        status: 'proposed',
        title: 'Concise summaries',
        lesson: 'User prefers concise final summaries after edits.',
        confidence: 0.84,
        evidenceRefs: [
          {
            chatId: 'chat-abc',
            runId: 'run-xyz',
            timestamp: '2026-07-05T18:00:00.000Z',
            summary: 'User asked for shorter wrap-up',
            citationToken: '⟦recall:abc⟧'
          }
        ],
        dedupKey: 'preference:concise',
        requiresReview: true,
        createdAt: '2026-07-05T20:05:00.000Z',
        updatedAt: '2026-07-05T20:05:00.000Z'
      },
      {
        id: 'prop-2',
        kind: 'skill_patch',
        scope: 'skill',
        status: 'proposed',
        title: 'Prettier scope rule',
        lesson: 'Do not run repo-wide Prettier.',
        confidence: 0.91,
        evidenceRefs: [],
        skillPatchDiff: '--- a/SKILL.md\n+++ b/SKILL.md\n@@\n+Do not run repo-wide Prettier.',
        suggestedApplyTarget: '.cursor/skills/formatting/SKILL.md',
        dedupKey: 'skill_patch:prettier',
        requiresReview: true,
        createdAt: '2026-07-05T20:05:00.000Z',
        updatedAt: '2026-07-05T20:05:00.000Z'
      }
    ],
    ...over
  }
}

describe('MemoryProposalReviewPanel', () => {
  it('renders proposal rows with kind/scope badges and safety note', () => {
    const html = renderToStaticMarkup(
      <MemoryProposalReviewPanel packs={[makePack()]} onUpdateProposalStatus={() => undefined} />
    )

    expect(html).toContain('Thread introspection')
    expect(html).toContain('untrusted evidence')
    expect(html).toContain('Concise summaries')
    expect(html).toContain('memory-proposal-kind--preference')
    expect(html).toContain('memory-proposal-scope--user')
    expect(html).toContain('84%')
    expect(html).toContain('Approve')
    expect(html).toContain('Reject')
  })

  it('renders an empty state when no packs exist', () => {
    const html = renderToStaticMarkup(<MemoryProposalReviewPanel packs={[]} />)

    expect(html).toContain('No memory proposal packs yet')
  })

  it('shows pack window metadata and pending count', () => {
    const html = renderToStaticMarkup(<MemoryProposalReviewPanel packs={[makePack()]} />)

    expect(html).toContain('Daily introspection')
    expect(html).toContain('awaiting review')
  })
})